import {compactionActive} from './visible-results.mjs';
import {eventLog} from './runtime.mjs';
import {canonicalUsage} from './context-economics.mjs';

export const POLICY='adaptive-break-even-v7';

const MIN_REGION_TOKENS=32768,MIN_MAIN_HISTORY=4,MAX_HISTORY_DELTA_SAMPLES=8,
  SAFETY_FACTOR=1.25,
  PHASE_HORIZON=Object.freeze({investigate:4,modify:6,execute:8,mixed:8});

const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const positiveInteger=value=>Number.isSafeInteger(value)&&value>0;
const nonNegativeInteger=value=>Number.isSafeInteger(value)&&value>=0;
const validRatio=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=1;
const validPrice=price=>price&&finite(price.input)&&finite(price.cacheRead)&&finite(price.output)&&
  (price.cacheWrite===undefined||finite(price.cacheWrite));
const usagePrompt=usage=>usage&&finite(usage.inputTokens)&&finite(usage.cacheReadTokens)&&finite(usage.cacheWriteTokens)
  ?usage.inputTokens+usage.cacheReadTokens+usage.cacheWriteTokens:null;
const median=values=>{
  const sorted=[...values].sort((a,b)=>a-b);
  if(sorted.length===0)return null;
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
};
const quantile=(values,fraction)=>{
  const sorted=[...values].sort((a,b)=>a-b);
  if(sorted.length===0)return null;
  return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*fraction)-1)];
};
const usageCost=(usage,price)=>{
  if(!usage||!price||!finite(usage.inputTokens)||!finite(usage.cacheReadTokens)||
    !finite(usage.cacheWriteTokens)||!finite(usage.outputTokens))return null;
  if(usage.cacheWriteTokens>0&&!finite(price.cacheWrite))return null;
  return (usage.inputTokens*price.input+usage.cacheReadTokens*price.cacheRead+
    usage.cacheWriteTokens*(price.cacheWrite??0)+usage.outputTokens*price.output)/1e6;
};

/**
 * Move profitable compaction earlier without weakening host safety.
 *
 * The host remains responsible at and above its native threshold and during
 * capacity emergencies. Below the threshold this module may compact early
 * only when observed request growth, remaining task work, cache-refill cost
 * and a conservatively priced summary request predict a positive payoff.
 */
export function createCompactionTiming(ctx,runtime,contextEconomics,{taskFlow=null,summaryOverhead=null}={}){
  const states=new Map();let attachment=null,engine=null,tokenMeter=null;

  const config=agent=>runtime.get(agent).config;
  const state=agent=>{
    let value=states.get(agent.session.id);
    if(!value){
      value={decisions:[],earlyCompactions:0,hostDelegations:0,nativeCompactions:0,
        compactionFailures:0,deferred:0,waited:0,skips:{},summaryObservations:[],
        summaryObservedThrough:-1,summaryPendingIndex:null,last:null};
      states.set(agent.session.id,value);
    }
    return value;
  };
  const skip=(value,reason)=>{value.skips[reason]=(value.skips[reason]??0)+1;};

  function route(agent){
    const configured=agent.session.requestHeader?.()?.config??{};
    return {provider:configured.provider??null,
      model:configured.model??null,
      reasoningEffort:configured.reasoningEffort??null,
      maxTokens:configured.maxTokens??null};
  }

  /** Mirror the native retained-tail rule and keep every tool result with its call. */
  function selectRange(session,measurement,retainTokens){
    const priced=measurement?.nodes,nodes=session.surface.nodes;
    if(!Array.isArray(priced)||priced.length===0||priced.length!==nodes.length)return null;
    if(priced.some(item=>!item||!finite(item.tokens)))return null;
    for(let index=0;index<nodes.length;index+=1)if(nodes[index]!==priced[index]?.seq)return null;
    const firstIdx=session.eventAt(nodes[0])?.type==='system/message'?1:0;
    let accumulated=0,keepFromIdx=priced.length;
    for(let index=priced.length-1;index>=0;index-=1){
      accumulated+=priced[index].tokens;
      keepFromIdx=index;
      if(accumulated>=retainTokens)break;
    }
    const balanced=[true];let openCalls=0;
    for(const seq of nodes){
      const event=session.eventAt(seq);
      if(!event||event.seq!==seq)return null;
      if(event.type==='assistant/message'){
        if(!Array.isArray(event.data?.message?.content))return null;
        openCalls+=event.data.message.content.filter(block=>block.type==='tool-call').length;
      }else if(event.type==='tool/result')openCalls--;
      if(openCalls<0)return null;
      balanced.push(openCalls===0);
    }
    if(!balanced[firstIdx])return null;
    while(keepFromIdx>firstIdx&&!balanced[keepFromIdx])keepFromIdx-=1;
    if(keepFromIdx<=firstIdx)return null;
    let retainedTokens=0;
    for(let index=keepFromIdx;index<priced.length;index+=1)retainedTokens+=priced[index].tokens;
    const regionTokens=priced.slice(firstIdx,keepFromIdx).reduce((sum,item)=>sum+item.tokens,0);
    return {start:nodes[firstIdx],end:nodes[keepFromIdx-1],retainedTokens,regionTokens,
      prefixTokens:priced.slice(0,keepFromIdx).reduce((sum,item)=>sum+item.tokens,0)};
  }

  function measure(agent){
    try{return tokenMeter?.measure?.(agent.session)??null;}catch{return null;}
  }

  function resolveSpec(routeValue,info){
    const policy=engine?.config,overrideRows=policy?.modelPolicies;
    if(!policy||!Array.isArray(overrideRows))return {reason:'compaction-policy-unavailable'};
    const contextWindow=info?.context?.contextWindow;
    if(!positiveInteger(contextWindow))return {reason:'model-context-unavailable'};
    const reserved=routeValue.maxTokens??info.defaultMaxTokens??0;
    if(!nonNegativeInteger(reserved))return {reason:'completion-budget-unavailable'};
    const override=overrideRows.find(item=>
      item?.provider===routeValue.provider&&item?.model===routeValue.model)??{};
    const ratio=override.thresholdRatio??policy.thresholdRatio;
    const headroom=override.headroomTokens??policy.headroomTokens;
    if(!validRatio(ratio))return {reason:'invalid-threshold-ratio'};
    if(!nonNegativeInteger(headroom))return {reason:'invalid-headroom'};
    const messageBudget=contextWindow-reserved;
    const pressureBudget=messageBudget-headroom;
    if(messageBudget<=0||pressureBudget<=0)return {reason:'invalid-pressure-budget'};
    const thresholdTokens=Math.floor(Math.min(contextWindow*ratio,pressureBudget));
    if(!positiveInteger(thresholdTokens))return {reason:'invalid-threshold'};
    if(override.retainTokens!==undefined&&override.retainRatio!==undefined)return {reason:'conflicting-retention-policy'};
    let retainTokens;
    if(override.retainTokens!==undefined){
      if(!nonNegativeInteger(override.retainTokens))return {reason:'invalid-retain-tokens'};
      retainTokens=override.retainTokens;
    }else if(override.retainRatio!==undefined){
      if(!validRatio(override.retainRatio))return {reason:'invalid-retain-ratio'};
      retainTokens=Math.floor(messageBudget*override.retainRatio);
    }else if(policy.retainTokens!==undefined){
      if(!nonNegativeInteger(policy.retainTokens))return {reason:'invalid-retain-tokens'};
      retainTokens=policy.retainTokens;
    }else{
      if(!validRatio(policy.retainRatio))return {reason:'invalid-retain-ratio'};
      retainTokens=Math.floor(messageBudget*policy.retainRatio);
    }
    if(!nonNegativeInteger(retainTokens)||retainTokens>=thresholdTokens)return {reason:'invalid-retention-budget'};
    const summarizeProvider=override.summarizationProvider??policy.summarizationProvider??'';
    const summarizeModel=override.summarizationModel??policy.summarizationModel??'';
    if(typeof summarizeProvider!=='string'||typeof summarizeModel!=='string'||
      (summarizeProvider.length===0)!==(summarizeModel.length===0))return {reason:'invalid-summary-route'};
    const summaryMaxTokens=override.maxTokens??policy.maxTokens;
    if(!positiveInteger(summaryMaxTokens))return {reason:'invalid-summary-max-tokens'};
    return {
      contextWindow,reserved,messageBudget,pressureBudget,thresholdTokens,retainTokens,
      summaryRoute:summarizeProvider&&summarizeModel
        ?{provider:summarizeProvider,model:summarizeModel}
        :{provider:routeValue.provider,model:routeValue.model},
      summaryMaxTokens
    };
  }

  function recentSummary(agent,summaryRoute){
    const observations=state(agent).summaryObservations,
      native=observations.findLast(item=>!item.localReuse&&
        item.provider===summaryRoute.provider&&item.model===summaryRoute.model),
      latestLocal=observations.findLast(item=>item.localReuse);
    // Local stage reuse proves only that a prior summary cost zero. A later
    // region has to pass the stage selector again, so the conservative
    // forecast prices the next compaction as a normal model summary.
    if(native)return {...native,priorLocalReuse:!!latestLocal&&
      observations.indexOf(latestLocal)>observations.indexOf(native)};
    return latestLocal?{...latestLocal,localReuseHistoryOnly:true}:null;
  }

  /**
   * Default summary cost deliberately ignores a possible cache hit. The
   * native summary request also carries system text, tool schemas and a
   * directive, so pricing only the compacted region caused v3 to compact too
   * eagerly. Actual summary usage replaces the floor once it is observed.
   */
  function evaluate(agent,{measurement,range,mainRoute,summaryRoute,mainPrice,summaryPrice,usage,summaryHistory,summaryMaxTokens,overhead}){
    const prompt=usagePrompt(usage);
    if(prompt===null||prompt<=0||!validPrice(mainPrice)||!validPrice(summaryPrice)||
      mainPrice.currency!==summaryPrice.currency)return {available:false,reason:'forecast-pricing-unavailable'};
    if(usage.cacheWriteTokens>0&&mainPrice.cacheWrite===undefined)
      return {available:false,reason:'main-cache-write-price-unavailable'};
    if(!overhead||!positiveInteger(overhead.inputTokens)||!positiveInteger(overhead.framedOverheadTokens))
      return {available:false,reason:'summary-overhead-unavailable'};
    const nodeTokens=measurement.nodes.reduce((sum,item)=>sum+item.tokens,0);
    const envelopeTokens=Math.max(0,prompt-nodeTokens);
    const observed=summaryHistory?.localReuseHistoryOnly?null:summaryHistory;
    if(observed&&observed.usageComplete!==true)
      return {available:false,reason:'summary-usage-unavailable'};
    const summaryPromptTokens=Math.max(range.regionTokens,
      range.prefixTokens+envelopeTokens+overhead.inputTokens);
    const summaryOutputTokens=observed?.outputTokens??summaryMaxTokens;
    const framedSummaryTokens=Math.max(summaryOutputTokens+overhead.framedOverheadTokens,
      observed?.framedTokens??0);
    if(!positiveInteger(framedSummaryTokens))
      return {available:false,reason:'summary-framed-size-unavailable'};
    const sameSummaryRoute=mainRoute.provider===summaryRoute.provider&&mainRoute.model===summaryRoute.model;
    const observedCacheRatio=usage.cacheReadTokens/prompt;
    // The native summary replays a prefix of the latest main request. Apply
    // only three quarters of the observed cache hit rate; a route change gets
    // no cache discount.
    const summaryCacheRatio=sameSummaryRoute?Math.max(0,Math.min(1,observedCacheRatio*.75)):0;
    const summaryCacheMissRate=Math.max(summaryPrice.input,summaryPrice.cacheWrite??0);
    const summaryInputPerToken=summaryPrice.cacheRead*summaryCacheRatio+
      summaryCacheMissRate*(1-summaryCacheRatio);
    const currentSummaryCost=summaryPromptTokens*summaryInputPerToken/1e6+
      summaryOutputTokens*summaryPrice.output/1e6;
    const observedSummaryCost=observed?usageCost(observed,summaryPrice):null;
    if(observed&&observedSummaryCost===null)
      return {available:false,reason:'summary-usage-pricing-unavailable'};
    const observedInputCost=observed
      ?(observed.inputTokens*summaryPrice.input+observed.cacheReadTokens*summaryPrice.cacheRead+
        observed.cacheWriteTokens*(summaryPrice.cacheWrite??0))/1e6
      :null;
    const scaledObservedCost=observed&&positiveInteger(observed.promptTokens)
      ?observedInputCost*summaryPromptTokens/observed.promptTokens+
        observed.outputTokens*summaryPrice.output/1e6
      :null;
    const summaryCost=Math.max(currentSummaryCost,observedSummaryCost??0,scaledObservedCost??0);
    const carryPerRequest=(usage.inputTokens*mainPrice.input+usage.cacheReadTokens*mainPrice.cacheRead+
      usage.cacheWriteTokens*(mainPrice.cacheWrite??0))/prompt;
    const freedTokens=Math.max(0,range.regionTokens-framedSummaryTokens);
    const savedPerRequest=freedTokens*carryPerRequest/1e6;
    const refillTokens=range.retainedTokens+framedSummaryTokens;
    const refillUnitRate=Math.max(0,Math.max(mainPrice.input,mainPrice.cacheWrite??0)-mainPrice.cacheRead);
    const refillTax=refillTokens*refillUnitRate/1e6;
    const breakEvenRequests=savedPerRequest>0?Math.ceil((summaryCost+refillTax)/savedPerRequest):null;
    return {
      available:true,summaryPromptTokens,summaryOutputTokens,framedSummaryTokens,
      summaryMaxTokens,
      summaryCost,currentSummaryCost,observedSummaryCost,scaledObservedCost,
      summaryPromptTokensObserved:observed?.promptTokens??null,
      carryPerRequest,refillTokens,refillTax,savedPerRequest,
      mainPromptTokens:prompt,mainInputTokens:usage.inputTokens,
      mainCacheReadTokens:usage.cacheReadTokens,mainCacheWriteTokens:usage.cacheWriteTokens,
      summaryCacheRatio,summaryCacheRate:`${Math.round(summaryCacheRatio*10000)/100}%`,
      breakEvenRequests,requiredHorizon:breakEvenRequests===null?null:
        Math.ceil(breakEvenRequests*SAFETY_FACTOR),
      regionTokens:range.regionTokens,retainedTokens:range.retainedTokens,
      pricing:{main:mainPrice.currency,summary:summaryPrice.currency},
      summaryPricingMethod:'observed prefix cache ratio with 25% pass-through discount; route changes use full input price',
      summaryCostMethod:'maximum of current prompt estimate, historical summary cost and historical input scaled to the current prompt',
      summaryUsageSource:observed?'scaled-and-observed-summary-usage-with-current-prompt-floor':
        'host-max-output-envelope-estimate'
    };
  }

  /**
   * Estimate remaining main requests from observed prompt growth and current
   * task work. Capacity is measured only up to the next native threshold; past
   * it the host owns the decision even if a larger workload remains.
   */
  function forecastHorizon(agent,measurement,thresholdTokens,routeValue){
    const history=contextEconomics.mainHistory?.(agent,routeValue)??[];
    let handoff;
    try{handoff=taskFlow?.handoff?.(agent)??null;}
    catch{return {available:false,reason:'task-state-unavailable'};}
    const userSeq=handoff?.userSeq,task=runtime.modeStatus(agent).task;
    if(!Number.isSafeInteger(userSeq)||task?.requestId&&task.requestId!==handoff?.userId)
      return {available:false,reason:'current-request-not-recorded'};
    const currentHistory=history.filter(item=>Number.isSafeInteger(item.sourceSeq)&&item.sourceSeq>userSeq);
    if(!currentHistory.length)return {available:false,reason:'current-request-usage-unavailable'};
    if(history.length<MIN_MAIN_HISTORY)return {available:false,reason:'insufficient-main-history',
      observations:history.length};
    const promptSizes=history.map(item=>item.promptTokens)
      .filter(value=>positiveInteger(value)).slice(-(MAX_HISTORY_DELTA_SAMPLES+1));
    const deltas=[];
    for(let index=1;index<promptSizes.length;index+=1){
      const delta=promptSizes[index]-promptSizes[index-1];
      if(delta>0)deltas.push(delta);
    }
    if(deltas.length<2)return {available:false,reason:'main-growth-unavailable',
      observations:history.length,positiveDeltas:deltas.length};
    const growthP50=median(deltas),growthP90=quantile(deltas,.9);
    const remainingCapacityTokens=Math.max(0,thresholdTokens-measurement.totalTokens);
    const capacityP50=Math.floor(remainingCapacityTokens/growthP50);
    const capacityP90=Math.floor(remainingCapacityTokens/growthP90);
    let taskP50=null,taskP90=null,remainingTodos=null,completedTodos=null,phase=null,horizonSource=null;
    const lastFinishReason=currentHistory.at(-1)?.finishReason??null;
    let todos;
    try{
      todos=Number.isSafeInteger(handoff.todoSeq)&&handoff.todoSeq>userSeq?handoff.todos:null;
      const phaseSeq=handoff.phase?.observedSeq??handoff.phase?.seq;
      phase=Number.isSafeInteger(phaseSeq)&&phaseSeq>userSeq?handoff.phase?.name??null:null;
      if(Array.isArray(todos)){
        completedTodos=todos.filter(item=>item?.status==='completed').length;
        remainingTodos=todos.filter(item=>item?.status!=='completed').length;
        horizonSource='todos';
        if(todos.length===0||remainingTodos===0)taskP50=1;
        else{
          const requestsPerCompletedTodo=completedTodos>0?currentHistory.length/completedTodos:2;
          taskP50=Math.ceil(remainingTodos*requestsPerCompletedTodo);
          taskP90=Math.ceil(taskP50*1.5);
        }
      }else if(lastFinishReason==='stop'||phase==='deliver'){
        horizonSource='phase-finishReason';
        taskP50=1;
        taskP90=1;
      }else if(lastFinishReason==='tool-calls'&&PHASE_HORIZON[phase]){
        horizonSource='phase-finishReason';
        taskP50=PHASE_HORIZON[phase];
        taskP90=Math.ceil(taskP50*1.5);
      }else{
        return {available:false,reason:'task-horizon-unavailable',
          observations:history.length,positiveDeltas:deltas.length,lastFinishReason,phase,todosAvailable:false};
      }
    }catch{return {available:false,reason:'task-state-unavailable',
      observations:history.length,positiveDeltas:deltas.length,lastFinishReason,phase,todosAvailable:Array.isArray(todos)};}
    const horizonP50=Math.min(capacityP50,taskP50??1);
    const horizonP90=Math.min(capacityP90,taskP90??1);
    return {available:true,horizon:horizonP50,horizonP50,horizonP90,growthP50,growthP90,
      remainingCapacityTokens,capacityP50,capacityP90,taskP50,taskP90,
      remainingTodos,completedTodos,phase,lastFinishReason,todosAvailable:Array.isArray(todos),horizonSource,
      observations:history.length,currentRequestObservations:currentHistory.length,positiveDeltas:deltas.length,
      method:'P50 capacity horizon uses recent route growth; remaining work uses only TODOs, task phase and requests observed after the current human request; P90 growth recorded separately'};
  }

  async function decide(agent,signal){
    const routeValue=route(agent);
    if(typeof routeValue.provider!=='string'||!routeValue.provider||
      typeof routeValue.model!=='string'||!routeValue.model)return {action:'native',reason:'route-unavailable'};
    const mainPrice=contextEconomics.pricingFor?.(agent,routeValue)??null;
    if(!validPrice(mainPrice))return {action:'native',reason:'route-pricing-unavailable'};
    let info;
    try{info=await ctx.llm.resolveModelInfo(routeValue.provider,routeValue.model,signal);}
    catch{return {action:'native',reason:'model-info-error'};}
    const spec=resolveSpec(routeValue,info);
    if(!spec.thresholdTokens)return {action:'native',reason:spec.reason};
    const policyKey=JSON.stringify(engine?.config);
    const summaryPrice=contextEconomics.pricingFor?.(agent,spec.summaryRoute)??null;
    if(!validPrice(summaryPrice))return {action:'native',reason:'summary-route-pricing-unavailable',spec};
    const measurement=measure(agent);
    if(!measurement||!finite(measurement.totalTokens)||!Array.isArray(measurement.nodes))
      return {action:'native',reason:'measurement-unavailable',spec};
    const pressure=contextEconomics.pressure?.(agent)??{};
    if(pressure.emergency===true)return {action:'native',reason:'capacity-emergency',spec};
    if(measurement.totalTokens>=spec.thresholdTokens)
      return {action:'native',reason:'native-threshold-reached',spec};
    const range=selectRange(agent.session,measurement,spec.retainTokens);
    if(!range)return {action:'native',reason:'no-compactable-range',spec};
    if(range.regionTokens<MIN_REGION_TOKENS)
      return {action:'wait',reason:'below-minimum-region',range,spec,routeValue,policyKey,
        measurementKey:JSON.stringify(measurement)};
    observeSummaries(agent,0,null);
    const usage=contextEconomics.lastSuccessfulUsage?.(agent,routeValue)??null;
    if(usagePrompt(usage)===null)return {action:'native',reason:'main-usage-unavailable',range,spec};
    const overhead=summaryOverhead?.(agent,tokenMeter);
    if(!overhead||!positiveInteger(overhead.inputTokens)||!positiveInteger(overhead.framedOverheadTokens))
      return {action:'native',reason:'summary-overhead-unavailable',range,spec};
    const economics=evaluate(agent,{measurement,range,mainRoute:routeValue,summaryRoute:spec.summaryRoute,
      mainPrice,summaryPrice,usage,
      summaryHistory:recentSummary(agent,spec.summaryRoute),summaryMaxTokens:spec.summaryMaxTokens,overhead});
    if(!economics.available)return {action:'native',reason:economics.reason,range,spec,economics};
    const horizon=forecastHorizon(agent,measurement,spec.thresholdTokens,routeValue);
    if(!horizon.available)return {action:'native',reason:horizon.reason,range,spec,economics,horizon};
    const profitable=economics.requiredHorizon!==null&&horizon.horizonP50>=economics.requiredHorizon;
    return {action:profitable?'compact':'wait',measurementKey:JSON.stringify(measurement),routeValue,policyKey,
      reason:profitable?'break-even-horizon-reached':'break-even-horizon-not-reached',
      range,spec,economics,horizon};
  }

  function observeSummaries(agent,fromIndex,summaryPrice){
    const log=eventLog(agent.session),value=state(agent);
    const start=value.summaryPendingIndex??Math.max(0,fromIndex,value.summaryObservedThrough+1);
    let observedThrough=start-1;
    value.summaryPendingIndex=null;
    for(let index=start;index<log.length;index+=1){
      const event=log[index];
      if(event.type!=='compaction/summary'){observedThrough=index;continue;}
      const data=event.data??{},canonical=canonicalUsage(data.usage),usage=canonical.usage;
      const checkpoint=log[index+1],end=log[index+2];
      if(!checkpoint||!end){value.summaryPendingIndex=index;break;}
      const message=checkpoint.data?.message??(checkpoint.data?.role?checkpoint.data:null);
      if(checkpoint.type!=='user/message'||checkpoint.surfaceOp?.op!=='replace'||
        message?.source?.kind!=='compact-checkpoint'||message.source.compactionId!==data.compactionId||
        !checkpoint.sourceEventSeqs?.includes?.(event.seq)||end.type!=='compaction/end'||
        end.data?.compactionId!==data.compactionId||end.data?.error){observedThrough=index;continue;}
      const promptTokens=canonical.complete?usagePrompt(usage):null;
      let framedTokens=null;
      try{framedTokens=tokenMeter?.estimateMessage?.(message)??null;}catch{}
      const localReuse=data.provider==='work-evidence'&&data.model==='stage-checkpoint-reuse';
      const observation={
        at:event.at??new Date().toISOString(),compactionId:data.compactionId??null,
        provider:data.provider??null,model:data.model??null,localReuse,
        usageComplete:localReuse||(canonical.complete&&promptTokens!==null&&finite(usage?.outputTokens)),
        promptTokens:localReuse?0:promptTokens,
        inputTokens:usage?.inputTokens??null,cacheReadTokens:usage?.cacheReadTokens??null,cacheWriteTokens:usage?.cacheWriteTokens??null,
        outputTokens:localReuse?0:usage?.outputTokens,framedTokens,
        shadowedTokens:finite(data.shadowedTokenCount)?data.shadowedTokenCount:null,
        maxTokens:positiveInteger(data.maxTokens)?data.maxTokens:null,
        costUSD:localReuse?0:usageCost(usage,summaryPrice)
      };
      const duplicate=observation.compactionId===null?-1:value.summaryObservations.findIndex(item=>
        item.compactionId===observation.compactionId);
      if(duplicate>=0)value.summaryObservations.splice(duplicate,1);
      value.summaryObservations.push(observation);
      if(value.summaryObservations.length>8)value.summaryObservations.shift();
      observedThrough=index;
    }
    value.summaryObservedThrough=Math.max(value.summaryObservedThrough,observedThrough);
  }

  function attach(service,meter){
    if(!service||typeof service.compactIfNeeded!=='function'||typeof service.compactRegion!=='function')return ()=>{};
    engine=service;tokenMeter=meter;
    const original=service.compactIfNeeded,descriptor=Object.getOwnPropertyDescriptor(service,'compactIfNeeded');

    const callHost=async(agent,trigger,signal,reason,summaryRoute=null)=>{
      const value=state(agent),fromIndex=eventLog(agent.session).length;
      value.hostDelegations++;
      try{
        return await original.call(service,agent,trigger,signal);
      }finally{
        const summaryPrice=summaryRoute?contextEconomics.pricingFor?.(agent,summaryRoute)??null:null;
        observeSummaries(agent,fromIndex,summaryPrice);
      }
    };

    const wrapped=async function(agent,trigger,signal){
      if(trigger!=='pressure'||!agent||!runtime.isEnabled(agent)||
        config(agent).compactionTiming!=='adaptive'||compactionActive(agent.session))return original.call(this,agent,trigger,signal);
      const value=state(agent);let decision;
      try{decision=await decide(agent,signal);}
      catch(error){
        skip(value,'decision-error');
        value.last={policy:POLICY,action:'native',reason:'decision-error',
          error:String(error?.message??error).slice(0,240)};
        return callHost(agent,trigger,signal,'decision-error');
      }
      signal?.throwIfAborted();
      if(compactionActive(agent.session)){
        value.last={policy:POLICY,action:'defer',reason:'compaction-became-active'};
        value.decisions.push(value.last);if(value.decisions.length>16)value.decisions.shift();
        value.deferred++;
        return null;
      }
      if(decision.action==='native'){
        skip(value,decision.reason);
        value.last={policy:POLICY,action:'native',reason:decision.reason};
        return callHost(agent,trigger,signal,decision.reason,decision.spec?.summaryRoute??null);
      }
      const fresh=measure(agent),currentRoute=route(agent);
      if(!fresh||JSON.stringify(fresh)!==decision.measurementKey||
        JSON.stringify(currentRoute)!==JSON.stringify(decision.routeValue)||
        JSON.stringify(engine?.config)!==decision.policyKey){
        skip(value,'context-changed-during-decision');
        value.last={policy:POLICY,action:'native',reason:'context-changed-during-decision'};
        return callHost(agent,trigger,signal,'context-changed-during-decision',decision.spec?.summaryRoute??null);
      }
      value.last={policy:POLICY,action:decision.action,reason:decision.reason,
        ...(decision.economics??{}),...(decision.horizon??{}),
        ...(decision.range?{start:decision.range.start,end:decision.range.end}:{})};
      if(decision.action!=='compact'){
        value.decisions.push(value.last);if(value.decisions.length>16)value.decisions.shift();
        if(decision.action==='defer')value.deferred++;else value.waited++;
        return null;
      }

      const fromIndex=eventLog(agent.session).length;
      let result;
      try{
        result=await service.compactRegion(decision.range.start,decision.range.end,agent,signal);
      }catch(error){
        value.compactionFailures++;
        skip(value,'early-compaction-failed');
        value.last={policy:POLICY,action:'native',reason:'early-compaction-failed',
          error:String(error?.message??error).slice(0,240)};
        return callHost(agent,trigger,signal,'early-compaction-failed',decision.spec?.summaryRoute??null);
      }
      observeSummaries(agent,fromIndex,decision.spec?.summaryRoute
        ?contextEconomics.pricingFor?.(agent,decision.spec.summaryRoute)??null:null);
      value.earlyCompactions++;
      value.decisions.push({...value.last,compactionId:result?.compactionId??null});
      if(value.decisions.length>16)value.decisions.shift();
      runtime.effects?.decide(agent,'compactionTiming','applied',
        'break-even-horizon-reached',value.decisions.at(-1));

      const after=measure(agent);
      if(!after){
        const hostResult=await callHost(agent,trigger,signal,'native-post-early-unmeasured',
          decision.spec?.summaryRoute??null);
        value.nativeCompactions++;
        return hostResult??result;
      }
      if(after&&finite(after.totalTokens)&&decision.spec&&after.totalTokens>=decision.spec.thresholdTokens){
        const hostResult=await callHost(agent,trigger,signal,'native-post-early-threshold',
          decision.spec.summaryRoute);
        value.nativeCompactions++;
        return hostResult??result;
      }
      return result;
    };
    service.compactIfNeeded=wrapped;
    attachment={service,original,wrapped};
    return ()=>{
      if(Object.getOwnPropertyDescriptor(service,'compactIfNeeded')?.value===wrapped){
        if(descriptor)Object.defineProperty(service,'compactIfNeeded',descriptor);
        else delete service.compactIfNeeded;
      }
      if(attachment?.wrapped===wrapped)attachment=null;
      if(engine===service){engine=null;tokenMeter=null;}
    };
  }

  const fiber=ctx.inject(['compaction','tokenMeter'],scope=>{
    scope.effect(()=>attach(scope.compaction,scope.tokenMeter));
  });
  ctx.on('agent/disposed',({agent})=>states.delete(agent.session.id));

  return {metrics(agent){
    const value=state(agent),attached=Boolean(attachment&&
      Object.getOwnPropertyDescriptor(attachment.service,'compactIfNeeded')?.value===attachment.wrapped);
    return {enabled:runtime.isEnabled(agent)&&config(agent).compactionTiming==='adaptive',policy:POLICY,attached,
      automaticTrigger:'native pressure check; early compactions never pass the host threshold',
      method:'host-owned above threshold and pruning; below threshold require exact-route successful usage, observed growth, a TODO or finish-reason/task-phase horizon, measured current summary overhead, conservatively estimated summary cost, and cache refill payoff',
      tokenMeterSource:'injected-tokenMeter-service',
      limits:{minRegionTokens:MIN_REGION_TOKENS,minMainHistory:MIN_MAIN_HISTORY,
        safetyFactor:SAFETY_FACTOR},
      ...value,recentDecisions:value.decisions.slice(-6),
      recentSummaryObservations:value.summaryObservations.slice(-3)};
  },async dispose(){await fiber?.dispose?.();states.clear();}};
}
