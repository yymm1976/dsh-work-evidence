const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const validCount=value=>Number.isSafeInteger(value)&&value>=0;
const sumCounts=values=>{
  let total=0;
  for(const value of values){if(!validCount(value)||!Number.isSafeInteger(total+value))return null;total+=value;}
  return total;
};
const usageFields=['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','reasoningTokens','totalTokens'];

/**
 * Normalize the adapter's disjoint usage representation. The installed DSH
 * adapter deliberately omits zero cache fields, so an omitted zero is provable
 * only when the separately reported total has no unexplained remainder.
 */
export function canonicalUsage(raw){
  if(raw===null||raw===undefined)return {usage:null,sources:Object.fromEntries(usageFields.map(key=>[key,'missing'])),consistent:true,complete:false,
    method:'disjoint-adapter-usage; no usage was reported'};
  const usage=Object.fromEntries(usageFields.map(key=>[key,validCount(raw[key])?raw[key]:null]));
  const sources=Object.fromEntries(usageFields.map(key=>[key,usage[key]!==null?'adapter-reported':
    raw[key]===null||raw[key]===undefined?'missing':'invalid-adapter-value']));
  const cacheKeys=['cacheReadTokens','cacheWriteTokens'];
  if(usage.inputTokens!==null&&usage.outputTokens!==null&&usage.totalTokens!==null){
    const knownSum=sumCounts([usage.inputTokens,usage.outputTokens,...cacheKeys.map(key=>usage[key]??0)]);
    if(knownSum!==null&&knownSum===usage.totalTokens)for(const key of cacheKeys)if(sources[key]==='missing'){usage[key]=0;sources[key]='zero-proven-by-reported-disjoint-total';}
  }
  const sumKeys=['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'];
  let complete=sumKeys.every(key=>usage[key]!==null);
  const sum=complete?sumCounts(sumKeys.map(key=>usage[key])):null;
  // A reported total cannot be smaller than the fields already known, even when the
  // usage is incomplete: nonnegative output could never make input+cache+output equal a
  // smaller total. Accepting that contradiction fed a 6000-token prompt into the totals
  // and advanced projection reviews on impossible data.
  const knownSubtotal=sumCounts([usage.inputTokens??0,usage.cacheReadTokens??0,usage.cacheWriteTokens??0,...(usage.outputTokens===null?[]:[usage.outputTokens])]);
  const totalContradicts=usage.totalTokens!==null&&knownSubtotal!==null&&usage.totalTokens<knownSubtotal;
  const consistent=!Object.values(sources).includes('invalid-adapter-value')&&!totalContradicts&&
    (!complete||sum!==null&&(usage.totalTokens===null||sum===usage.totalTokens));
  if(complete&&sum!==null&&sources.totalTokens==='missing'){usage.totalTokens=sum;sources.totalTokens='sum-of-reported-disjoint-fields';}
  complete=complete&&consistent;
  return {usage,sources,consistent,complete,method:'disjoint-adapter-usage; omitted-zero-cache-fields require exact total equality'};
}
export const promptTokens=usage=>usage?sumCounts(['inputTokens','cacheReadTokens','cacheWriteTokens'].map(key=>usage[key])):null;
export function usageCost(usage,price){
  if(!price||!usage||sumCounts(['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].map(key=>usage[key]))===null||
    usage.cacheWriteTokens>0&&!finite(price.cacheWrite))return null;
  const cost=(usage.inputTokens*price.input+usage.cacheReadTokens*price.cacheRead+
    usage.cacheWriteTokens*(price.cacheWrite??0)+usage.outputTokens*price.output)/1e6;
  return finite(cost)?cost:null;
}
export function usageCostLowerBound(usage,price){
  if(!price||!usage)return null;
  let cost=0,known=0;
  for(const [usageKey,priceKey] of [['inputTokens','input'],['cacheReadTokens','cacheRead'],
    ['cacheWriteTokens','cacheWrite'],['outputTokens','output']]){
    if(!finite(usage[usageKey])||usage[usageKey]===0)continue;
    if(!finite(price[priceKey]))continue;
    cost+=usage[usageKey]*price[priceKey]/1e6;known++;
  }
  return known?cost:null;
}

// Estimates guide a decision; only adapter usage is reported as observed tokens.
export function textTokens(text){
  text=String(text??'');
  const wide=(text.match(/[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/g)??[]).length;
  return Math.ceil(wide+(text.length-wide)/3.5);
}
const textBlockWeights=new WeakMap();
function textBlockTokens(block){
  const text=block.text;
  if(typeof text!=='string')return textTokens(text);
  const cached=textBlockWeights.get(block);
  if(cached?.text===text)return cached.tokens;
  const tokens=textTokens(text);
  textBlockWeights.set(block,{text,tokens});
  return tokens;
}
export function messageTokens(message){
  let total=4;
  for(const block of message.content??[]){
    if(block.type==='text'||block.type==='reasoning')total+=textBlockTokens(block);
    else if(block.type==='tool-call')total+=textTokens(JSON.stringify({name:block.name,arguments:block.arguments,id:block.id}));
    else total+=textTokens(JSON.stringify(block));
  }
  return total;
}
export function requestKindOf(record){
  if(record.purpose==='compaction'||record.requestKind==='compaction')return 'compaction';
  return record.auxiliary===true||record.requestKind==='auxiliary'||!!record.purpose&&record.purpose!=='main'?'auxiliary':'main';
}
const modelKey=message=>JSON.stringify({role:message.role,content:message.content,toolCallId:message.toolCallId,isError:message.isError});
const textProjection=messages=>messages.every(message=>(message.content??[]).every(block=>['text','reasoning','tool-call'].includes(block.type)));
const envelopeKey=value=>JSON.stringify({tools:value.tools??[],system:value.system??null});
const sameRoute=(a,b)=>a?.provider===b?.provider&&a?.model===b?.model;
const effortKey=value=>value===undefined||value===null?null:value;
const sameObservedRoute=(a,b)=>Boolean(a&&b)&&sameRoute(a,b)&&
  effortKey(a.reasoningEffort)===effortKey(b.reasoningEffort);
const forecastRoute=route=>Object.fromEntries(['provider','model','reasoningEffort'].map(key=>
  [key,typeof route?.[key]==='string'&&route[key].trim()?route[key]:null]));
const successfulFinish=new Set(['stop','tool-calls','max-tokens','length']);

function suffixWeightForId(observation,id){
  if(!observation.suffixWeights){
    const weights=new Map();
    let suffix=0;
    for(let index=observation.ids.length-1;index>=0;index--){
      suffix+=observation.weights[index];
      weights.set(observation.ids[index],suffix);
    }
    observation.suffixWeights=weights;
  }
  return observation.suffixWeights.get(id)??null;
}

// The shipped default config leaves projectionPricing empty, so every price-gated
// rewrite answered route-pricing-unavailable: historyHygiene alone was blocked
// 10,112 times across measured sessions while the switch read "on". DeepSeek
// publishes one off-peak rate card for the V4.1 Flash family, so use it as a
// fallback for that family only, and label the source so an operator can tell a
// published rate from an exact route setting.
const PUBLISHED_FLASH_PRICE={input:1,cacheRead:0.02,cacheWrite:0,output:4,currency:'CNY'};
export const isDeepSeekV41Flash=model=>typeof model==='string'&&/deepseek-v4[._-]1-flash/iu.test(model);
function publishedPrice(route){
  const model=typeof route?.model==='string'?route.model.toLowerCase():'';
  return isDeepSeekV41Flash(model)
    ?{...PUBLISHED_FLASH_PRICE,publishedRate:true,basis:'reference-rate'}:null;
}

export function createContextEconomics(ctx,runtime){
  const states=new Map();
  const get=agent=>{
    let state=states.get(agent.session.id);
    if(!state){state={last:null,latestPrompt:null,previousAttempt:null,lastSuccessfulMain:null,mainHistory:[],mainAttempts:[],decisions:[],skips:{},requests:0,reportedPromptTokens:0,reportedMainPromptTokens:0,mainPromptRequests:0,reportedOutputTokens:0,
      missingUsage:0,missingCacheUsage:0,pricedRequests:0,publishedRateUsed:false,costByCurrency:Object.create(null),auxiliaryRequests:0,compactionRequests:0,mainFinished:0,
      failedKnownCostByCurrency:Object.create(null),failedKnownCostRequests:0,
      referenceCostByCurrency:Object.create(null),referencePricedRequests:0,referenceRateUsed:false,
      costLowerBoundByCurrency:Object.create(null),costLowerBoundRequests:0,
      referenceLowerBoundByCurrency:Object.create(null),referenceLowerBoundRequests:0,
      surfaceChanges:0,cacheResetCount:0,uncachedInputAtReset:0,resetTaxByCurrency:Object.create(null),
      effortChanges:0,cacheResetAfterEffortChange:0,effortResetExposureByCurrency:Object.create(null),
      taskProgress:null,pendingReviews:[],reviewedOutcomes:[],
      };states.set(agent.session.id,state);}
    return state;
  };
  function pricing(agent,route){
    const configured=runtime.get(agent).config.projectionPricing.find(row=>sameRoute(row,route));
    // An explicit exact-route row always wins; the published rate card is only a
    // fallback, and its source stays distinguishable in the returned object.
    return configured?{...configured,basis:'exact-route'}:publishedPrice(route);
  }
  function assess(agent,{messages,proposedMessages,savedChars=0,savedTokensEstimate=null,changedSeq=null,changedMessageId=null,route=null,tools,system,emergency=false,horizon,
    auxiliaryUsage=null,auxiliaryMargin=1.5,revisitCostTokens=0}={}){
    const state=get(agent),config=runtime.get(agent).config;
    route??=agent.session.requestHeader()?.config??{};
    const old=state.last,observedPrice=pricing(agent,route),price=observedPrice?.basis==='exact-route'?observedPrice:null,
      same=old&&sameObservedRoute(old,route);
    const rawSaving=messages&&proposedMessages
      ?messages.reduce((sum,message)=>sum+messageTokens(message),0)-proposedMessages.reduce((sum,message)=>sum+messageTokens(message),0)
      :finite(savedTokensEstimate)?savedTokensEstimate:Math.ceil(Math.max(0,savedChars)/3.5);
    const firstReplayAssistant=Boolean(same&&changedMessageId&&
      messages?.some(message=>message.id===changedMessageId&&message.role==='assistant')&&!old.ids.includes(changedMessageId));
    const beforeOutput=firstReplayAssistant?messages.reduce((sum,message)=>sum+messageTokens(message),0):null;
    const factor=firstReplayAssistant&&finite(old.usage?.outputTokens)
      ?Math.max(.25,Math.min(8,old.usage.outputTokens/Math.max(1,beforeOutput))):same?old.factor:1;
    const savedTokens=Math.max(0,Math.floor(rawSaving*factor));
    // A new human request gives no evidence that it will run as long as the previous one.
    // Completed main steps can raise the configured estimate only within their own task.
    const requestId=runtime.currentRequest?.(agent)?.id;
    const completedSteps=requestId&&state.taskProgress?.requestId===requestId?state.taskProgress.completedSteps:0;
    const remainingSteps=Math.max(1,Math.min(64,horizon??Math.max(config.projectionHorizonSteps,completedSteps)));
    let cachedSuffixTokens=null,prefixMessages=0,oldSuffixTokens=null,exposureMethod='conservative previous-request prompt';
    // An aborted/errored attempt reports zero usage. Its zero cache read is an
    // absence of evidence, not proof that no cached prefix exists; treating it
    // as "no exposure" approves a rewrite that then pays a full cache refill.
    const previousAttemptUsable=Boolean(old?.usage)&&promptTokens(old.usage)>0&&
      !['error','aborted'].includes(String(old.finishReason??''))&&!old.failureCode&&old.usageComplete!==false;
    if(same&&old?.usage&&promptTokens(old.usage)!==null&&previousAttemptUsable){
      // A preceding miss can populate the next request's cache. Treat the
      // previously dispatched prompt as potentially warm; low/missing hits
      // never establish that a new projection is free.
      const cached=promptTokens(old.usage);
      // DeepSeek also persists a cache prefix at the generated output end.
      // An assistant message need not have appeared in a prior input to be warm.
      if(firstReplayAssistant){
        oldSuffixTokens=finite(old.usage.outputTokens)?old.usage.outputTokens:null;
        cachedSuffixTokens=oldSuffixTokens===null?null:Math.max(0,Math.ceil(oldSuffixTokens-savedTokens));
        exposureMethod='previous generated output may already be warm; retained assistant output included in refill';
      }else if(cached===0)cachedSuffixTokens=0;
      else if(proposedMessages&&old.envelope===envelopeKey({tools,system})&&old.alignmentSafe&&textProjection(messages??[])&&textProjection(proposedMessages)){
        const currentKeys=new Set((messages??[]).map(modelKey)),oldKeys=new Set(old.keys),oldIds=new Set(old.ids.filter(Boolean));
        const exposure=target=>{
          let prefix=0;
          while(prefix<old.keys.length&&prefix<target.length&&old.keys[prefix]===modelKey(target[prefix]))prefix++;
          // Charge surviving prior content and newly introduced replacements.
          // Unchanged, newly appended current messages were never cached yet.
          const retained=target.slice(prefix).reduce((sum,message)=>{
            const key=modelKey(message);
            return sum+(oldIds.has(message.id)||oldKeys.has(key)||!currentKeys.has(key)?messageTokens(message):0);
          },0);
          return {prefix,tokens:Math.min(cached,retained*old.factor)};
        };
        const proposed=exposure(proposedMessages),existing=exposure(messages??[]);prefixMessages=proposed.prefix;
        oldSuffixTokens=Math.ceil(Math.min(cached,old.weights.slice(proposed.prefix).reduce((sum,value)=>sum+value,0)*old.factor));
        // A committed backend change may already expose a suffix. Charge only
        // the additional suffix this projection changes, without assuming the
        // backend event or a route change made the entire request cold.
        const baselineAligned=existing.prefix===Math.min(old.keys.length,(messages??[]).length)&&proposed.prefix<=old.keys.length;
        cachedSuffixTokens=Math.ceil(Math.max(0,proposed.tokens-(baselineAligned?existing.tokens:0)));
        exposureMethod='rewritten surviving suffix plus new replacements; unchanged unsent tail excluded; existing baseline exposure subtracted only when the current request is a complete continuation of the previous request';
      }else if(proposedMessages){cachedSuffixTokens=cached;}
      else if(changedMessageId||Number.isSafeInteger(changedSeq)){
        let weight=null,located=Boolean(changedMessageId);
        if(changedMessageId)weight=suffixWeightForId(old,changedMessageId);
        else{
          const nodes=agent.session.surface.nodes,index=nodes.indexOf(changedSeq);
          if(index>=0){
            located=true;
            const ids=new Set(nodes.slice(index).map(seq=>{
              const event=agent.session.eventAt(seq);return (event?.data?.message??event?.data)?.id;
            }).filter(Boolean));
            const first=old.ids.findIndex(id=>ids.has(id));
            if(first>=0)weight=suffixWeightForId(old,old.ids[first]);
          }
        }
        if(located){
          oldSuffixTokens=weight===null?null:Math.ceil(Math.min(cached,weight*old.factor));
          cachedSuffixTokens=oldSuffixTokens===null?null:Math.max(0,oldSuffixTokens-savedTokens);
          exposureMethod=weight===null?'history location not found in previous prompt; exposure unproven':'previously sent suffix less net removed tokens; pointer overhead included in net saving';
        }
      }
    }
    let allowed=false,reason='usage-or-cache-exposure-unavailable',refillCost=null,futureSaving=null,breakEvenSteps=null;
    const auxiliaryCost=auxiliaryUsage?usageCost(auxiliaryUsage,price):0;
    // cachedSuffixTokens===0 is only meaningful when a usable prior observation
    // exists. Without one the value is unproven, so a free rewrite must not be
    // assumed and the pricing path below decides.
    const exposureProven=previousAttemptUsable&&cachedSuffixTokens!==null;
    if(savedTokens<=0)reason='no-request-reduction';
    else if(emergency&&!auxiliaryUsage){allowed=true;reason='context-capacity';}
    else if(auxiliaryUsage&&auxiliaryCost===null)reason='auxiliary-price-or-usage-unavailable';
    else if (exposureProven && cachedSuffixTokens === 0 && auxiliaryUsage === null &&
      // A zero-refill shortcut is only free when the session has not already been
      // re-reading the body: a large revisit cost means the hidden middle comes back,
      // and approving here would bypass the priced path entirely.
      !(revisitCostTokens>0)) {allowed=true;reason='no-additional-previous-request-prefix-exposure';refillCost=0;breakEvenSteps=0;
      if(price)futureSaving=savedTokens*Math.min(price.input,price.cacheRead)*remainingSteps/1e6;}
    else if(cachedSuffixTokens!==null&&price){
      if(old?.usage?.cacheWriteTokens>0&&!finite(price.cacheWrite))reason='cache-write-price-unavailable';
      else if(price.input===0&&price.cacheRead===0&&(price.cacheWrite??0)===0&&auxiliaryCost===0){allowed=true;reason='zero-priced-route';refillCost=0;futureSaving=0;breakEvenSteps=0;}
      else{
        refillCost=cachedSuffixTokens*Math.max(0,Math.max(price.input,price.cacheWrite??price.input)-price.cacheRead)/1e6;
        // A rewrite of a body the session keeps re-reading is not a one-off refill: the
        // forecaster measured 50 prunes saving 832,846 chars while the model re-read
        // 737,310 chars of the same middle. Charge that observed revisit rate so a
        // rewrite whose own subject is still being read is refused on its own numbers.
        const revisitCost=Math.max(0,revisitCostTokens)*Math.max(0,price.input)/1e6;
        refillCost+=revisitCost;
        const perStep=savedTokens*Math.min(price.input,price.cacheRead)/1e6;
        futureSaving=perStep*remainingSteps;
        const required=refillCost*1.25+auxiliaryCost*auxiliaryMargin;
        breakEvenSteps=perStep>0?Math.ceil(required/perStep):null;
        allowed=perStep>0&&futureSaving>required;
        reason=allowed?'predicted-cache-cost-positive':'predicted-cache-cost-insufficient';
      }
    }else if(!previousAttemptUsable)reason='prior-observation-unusable';
    else if(observedPrice?.basis==='reference-rate')reason='reference-rate-without-exact-route';
    else if(cachedSuffixTokens!==null)reason='route-pricing-unavailable';
    return {allowed,reason,savedTokensEstimate:savedTokens,cachedSuffixTokensEstimate:cachedSuffixTokens,
      oldSuffixTokensEstimate:oldSuffixTokens,
      cachedExposureMethod:exposureMethod+'; prior misses may populate cache; not a cache-position measurement',
      horizonSteps:remainingSteps,refillCostEstimate:refillCost,futureSavingEstimate:futureSaving,breakEvenStepsEstimate:breakEvenSteps,
      revisitCostTokensEstimate:Math.max(0,revisitCostTokens),
      auxiliaryCostEstimate:auxiliaryCost,auxiliaryMargin:auxiliaryUsage?auxiliaryMargin:null,
      currency:observedPrice?.currency??null,
      pricingSource:!observedPrice?'unavailable':observedPrice.basis==='reference-rate'?'reference-rate':'exact-route',
      tokenMethod:firstReplayAssistant?'text-density calibrated to previous generated output':same?'text-density calibrated to previous adapter usage':'text-density estimate',
      forecast:true,emergency,route:forecastRoute(route)};
  }
  function remember(agent,decision,kind){
    const state=get(agent);state.decisions.push({kind,...decision});if(state.decisions.length>16)state.decisions.shift();
    if(!decision.allowed)state.skips[decision.reason]=(state.skips[decision.reason]??0)+1;
    return decision;
  }
  function reviewAdoption(agent,{kind,appliedAtStep,expectedSavedChars=0,expectedSavedTokens=null,expectedRefillTokens=0}){
    const state=get(agent);
    state.pendingReviews.push({kind,appliedAtStep,expectedSavedChars,expectedSavedTokens,expectedRefillTokens,
      baselineMainPromptRequests:state.mainPromptRequests,baselineMainPromptTokens:state.reportedMainPromptTokens,
      referencePromptTokens:promptTokens(state.last?.usage)??promptTokens(state.lastSuccessfulMain?.usage),
      baselineAt:new Date().toISOString()});
    if(state.pendingReviews.length>8)state.pendingReviews.shift();
  }
  function reviewOutcomes(agent,currentStep=null){
    const state=get(agent),results=[];
    for(const review of state.pendingReviews){
      const observedRequests=state.mainPromptRequests-review.baselineMainPromptRequests;
      if(observedRequests<3)continue;
      const expectedRemovedTokensPerRequest=finite(review.expectedSavedTokens)?review.expectedSavedTokens:Math.max(0,review.expectedSavedChars/3.5);
      const expectedPromptTokensPerRequest=review.referencePromptTokens===null?null:
        Math.max(0,review.referencePromptTokens-expectedRemovedTokensPerRequest);
      const observedPromptTokens=state.reportedMainPromptTokens-review.baselineMainPromptTokens;
      const observedPerRequest=observedPromptTokens/observedRequests;
      const drift=expectedPromptTokensPerRequest>0?observedPerRequest/expectedPromptTokensPerRequest:null;
      const plausible=expectedPromptTokensPerRequest===null?null:
        observedPerRequest<=Math.max(1,review.referencePromptTokens)*2.5;
      results.push({kind:review.kind,appliedAtStep:review.appliedAtStep,observedRequests,expectedRemovedCharsPerRequest:review.expectedSavedChars,
        expectedRemovedTokensPerRequest,referencePromptTokens:review.referencePromptTokens,
        expectedPromptTokensPerRequest,observedPromptTokens,observedPromptTokensPerRequest:Math.round(observedPerRequest*100)/100,
        expectedRefillTokens:review.expectedRefillTokens,plausible,
        drift:drift===null?null:Math.round(drift*100)/100,
        reason:plausible===null?'reference-prompt-usage-unavailable':plausible?
          'observed-prompt-within-baseline-window':'observed-prompt-above-baseline-window',
        settledAtStep:currentStep,method:'main requests with complete prompt usage only; auxiliary and missing-usage requests excluded'});
    }
    if(results.length)state.pendingReviews=state.pendingReviews.filter(review=>state.mainPromptRequests-review.baselineMainPromptRequests<3);
    if(results.length){
      state.reviewedOutcomes.push(...results);
      if(state.reviewedOutcomes.length>16)state.reviewedOutcomes.splice(0,state.reviewedOutcomes.length-16);
    }
    return results;
  }
  function requestFinished(agent,options,record){
    const state=get(agent),canonical=record.usageSources!==undefined?{usage:record.usage,sources:record.usageSources,
      consistent:record.usageConsistent===true,complete:record.usageComplete===true}:canonicalUsage(record.usage),
      usage=canonical.consistent?canonical.usage:null,total=promptTokens(usage),price=pricing(agent,options);
    record.usage=canonical.usage;record.usageSources=canonical.sources;record.usageConsistent=canonical.consistent;record.usageComplete=canonical.complete;
    state.requests++;
    const requestKind=requestKindOf(record);
    if(requestKind==='auxiliary')state.auxiliaryRequests++;
    if(requestKind==='compaction')state.compactionRequests++;
    if(usage&&(!finite(usage.cacheReadTokens)||!finite(usage.cacheWriteTokens)))state.missingCacheUsage++;
    if(total===null)state.missingUsage++;
    else state.reportedPromptTokens+=total;
    // A reported output count is its own observation. Requiring a prompt total to
    // read it dropped the output of any request whose prompt fields were incomplete.
    if(finite(usage?.outputTokens))state.reportedOutputTokens+=usage.outputTokens;
    const billingComplete=record.settled&&['stop','tool-calls','max-tokens','length'].includes(record.finishReason);
    const cacheWritePriced=usage?.cacheWriteTokens===0||finite(price?.cacheWrite);
    const usageFieldsComplete=usage&&['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].every(key=>finite(usage[key]));
    const knownCost=price&&usage&&usageFieldsComplete&&cacheWritePriced
      ?(usage.inputTokens*price.input+usage.cacheReadTokens*price.cacheRead+
        usage.cacheWriteTokens*(price.cacheWrite??0)+usage.outputTokens*price.output)/1e6:null;
    const lowerBound=price&&usage?usageCostLowerBound(usage,price):null;
    const exactPrice=price?.basis==='exact-route';
    if(knownCost!==null&&exactPrice&&canonical.complete&&billingComplete){
      state.costByCurrency[price.currency]=(state.costByCurrency[price.currency]??0)+knownCost;
      state.pricedRequests++;
    }else if(knownCost!==null&&canonical.complete&&billingComplete&&price?.basis==='reference-rate'){
      state.referenceCostByCurrency[price.currency]=(state.referenceCostByCurrency[price.currency]??0)+knownCost;
      state.referencePricedRequests++;state.referenceRateUsed=true;
    }else if(knownCost!==null){
      state.failedKnownCostByCurrency[price.currency]=(state.failedKnownCostByCurrency[price.currency]??0)+knownCost;
      state.failedKnownCostRequests++;
    }else if(price){const reason=!billingComplete?'incomplete-request-billing':!cacheWritePriced?'cache-write-price-unavailable':'missing-usage-fields';state.skips[reason]=(state.skips[reason]??0)+1;}
    if(lowerBound!==null){
      if(exactPrice){state.costLowerBoundByCurrency[price.currency]=(state.costLowerBoundByCurrency[price.currency]??0)+lowerBound;state.costLowerBoundRequests++;}
      else if(price?.basis==='reference-rate'){
        state.referenceLowerBoundByCurrency[price.currency]=(state.referenceLowerBoundByCurrency[price.currency]??0)+lowerBound;
        state.referenceLowerBoundRequests++;
      }
    }
    if(requestKind!=='main')return;
    state.mainFinished++;
    // Only a positive prompt count is an observation of the request's size. A
    // failed attempt reports zero usage, and counting those toward the review
    // threshold let three failures look like three observed requests with a
    // per-request average of zero. That made the projection review report
    // observedPromptTokensPerRequest=0 and plausible=true on no evidence.
    if(total!==null&&total>0){state.reportedMainPromptTokens+=total;state.mainPromptRequests++;}
    const successfulMain=record.settled&&!record.aborted&&!record.failureCode&&successfulFinish.has(record.finishReason),
      completeSuccess=successfulMain&&canonical.complete&&total>0;
    if(successfulMain&&record.taskRequestId){
      if(state.taskProgress?.requestId!==record.taskRequestId)state.taskProgress={requestId:record.taskRequestId,completedSteps:0};
      state.taskProgress.completedSteps++;
    }
    state.mainAttempts.push({at:record.at??new Date().toISOString(),provider:options.provider,model:options.model,
      reasoningEffort:options.reasoningEffort??null,completeSuccess,promptTokens:total,
      // The usage travels with the attempt so a per-route query reads that route's
      // own observation. lastSuccessfulMain keeps only the newest success on any
      // route, so using it for a route query returned null after a later success
      // elsewhere even though this route had succeeded.
      usage:completeSuccess?{...usage}:null,
      finishReason:record.finishReason,usageComplete:canonical.complete});
    if(state.mainAttempts.length>16)state.mainAttempts.shift();
    if(completeSuccess){
      state.lastSuccessfulMain={provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort??null,
        usage:{...usage},finishReason:record.finishReason,at:record.at??new Date().toISOString()};
      state.mainHistory.push({at:record.at??new Date().toISOString(),sourceSeq:record.sourceSeq??null,provider:options.provider,model:options.model,
        reasoningEffort:options.reasoningEffort??null,promptTokens:total,
        inputTokens:usage.inputTokens,cacheReadTokens:usage.cacheReadTokens,cacheWriteTokens:usage.cacheWriteTokens,
        outputTokens:usage.outputTokens,finishReason:record.finishReason});
      if(state.mainHistory.length>16)state.mainHistory.shift();
    }
    // Transition counters describe the step between adjacent attempts, so they
    // belong on the immediately previous attempt, not on the retained exposure
    // baseline: that baseline skips failed or partial attempts by design, which
    // would make one effort change count twice when a retry follows a failure.
    const previousAttempt=state.previousAttempt;
    const previousBaseline=state.last;
    const envelope=envelopeKey(options);
    if(previousAttempt)state.surfaceChanges+=previousAttempt.envelope!==envelope?1:0;
    // An omitted effort and an explicit null are the same setting (effortKey says so),
    // so comparing the raw values reported a change that did not happen.
    if(previousAttempt)state.effortChanges+=effortKey(previousAttempt.reasoningEffort)!==effortKey(options.reasoningEffort)?1:0;
    state.previousAttempt={provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort,envelope};
    // Captured before this attempt replaces it: the reset check below compares with
    // the previous measured attempt, not with the one being recorded now.
    const resetPrevious=state.previousMeasured;
    // A failed attempt still observed its own usage, so it becomes the next comparison
    // point: the drop it saw is a real drop, and the retry that follows must not report
    // the same transition again.
    //
    // The comparison point therefore needs the SAME fields the reset branch reads, or the
    // two disagree about what a measurement is. An attempt reporting inputTokens=6000 and
    // cacheReadTokens=0 but no totalTokens has `total===null`, so the old guard left
    // `previousMeasured` untouched while the reset branch still accepted it — the drop was
    // counted, the comparison point was not advanced, and the complete retry with the same
    // counts counted the same drop again. Both sides now require a reported cache-read
    // count and a positive prompt size.
    if(usage&&finite(usage.cacheReadTokens)&&(total>0||usage.inputTokens>0)){
      state.previousMeasured={provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort,
        envelope,cacheReadTokens:usage.cacheReadTokens,inputTokens:usage.inputTokens,sourceSeq:record.sourceSeq??null,ordinal:record.ordinal??null};}
    const previous=previousBaseline,same=previous&&sameRoute(previous,options);
    const effortChanged=same&&effortKey(previous.reasoningEffort)!==effortKey(options.reasoningEffort);
    // An incomplete observation can leave cacheReadTokens null. `null < x*.5` is
    // true in JavaScript, so an omitted count would read as a cache reset and would
    // also consume the transition-dedupe key. A reset needs a reported count, and
    // it needs both observations on the same route: switching provider or model
    // changes the cache namespace, so a smaller count there is not a reset.
    const resetObserved=Boolean(same)&&finite(usage?.cacheReadTokens)&&finite(previous?.usage?.cacheReadTokens);
    // Reset counters describe an observed transition, so they compare with the
    // previous attempt rather than the retained exposure baseline. That baseline skips
    // failed attempts, and comparing with it counted one drop twice when an error and
    // its successful retry both matched it, doubling uncachedInputAtReset and the tax.
    const resetSame=Boolean(resetPrevious)&&sameRoute(resetPrevious,options);
    const resetComparable=resetSame&&finite(usage?.cacheReadTokens)&&finite(resetPrevious?.cacheReadTokens);
    // One transition is counted once. The key records the last COUNTED transition, and the
    // reset branch below and the marker update at the end of this block agree on it.
    // The effort comparison uses `resetPrevious`, the attempt the drop is actually measured
    // against: `previous` is the retained baseline, which skips failed attempts, so an
    // error on a new effort followed by a success on the same effort would otherwise be
    // attributed to an effort change that did not cause it.
    const effortTransitionKey=JSON.stringify([effortKey(resetPrevious?.reasoningEffort),effortKey(options.reasoningEffort)]);
    const repeatedEffortTransition=Boolean(resetPrevious)&&resetSame&&
      effortKey(resetPrevious.reasoningEffort)!==effortKey(options.reasoningEffort)&&state.countedEffortTransition===effortTransitionKey;
    // The tax answers "did a surface change make this attempt re-read its prefix?", so it must
    // compare the envelopes of the two attempts the drop is measured BETWEEN. `previous` is
    // the retained exposure baseline and can be several attempts old: if A succeeded on
    // envelope X, B failed on envelope Y, and C succeeded on Y after a drop, comparing with A
    // charges a surface change that did not cause that transition. `resetPrevious` is B.
    const resetEnvelopeChanged=Boolean(resetSame)&&resetPrevious.envelope!==envelope;
    if(resetComparable&&resetPrevious.cacheReadTokens>0&&usage.cacheReadTokens<resetPrevious.cacheReadTokens*.5&&usage?.inputTokens>2000){
      state.cacheResetCount++;state.uncachedInputAtReset+=usage.inputTokens;
      if(resetEnvelopeChanged&&price){const extra=Math.max(0,Math.min(usage.inputTokens-resetPrevious.inputTokens,resetPrevious.cacheReadTokens-usage.cacheReadTokens));
        state.resetTaxByCurrency[price.currency]=(state.resetTaxByCurrency[price.currency]??0)+extra*Math.max(0,price.input-price.cacheRead)/1e6;}
      if(resetPrevious&&effortKey(resetPrevious.reasoningEffort)!==effortKey(options.reasoningEffort)&&!repeatedEffortTransition){
        state.cacheResetAfterEffortChange++;
        state.countedEffortTransition=effortTransitionKey;
        if(price){const extra=Math.max(0,Math.min(usage.inputTokens-resetPrevious.inputTokens,resetPrevious.cacheReadTokens-usage.cacheReadTokens));
          state.effortResetExposureByCurrency[price.currency]=(state.effortResetExposureByCurrency[price.currency]??0)+extra*Math.max(0,price.input-price.cacheRead)/1e6;}
      }
    }
    // The key marks the last COUNTED transition only. An unmeasured transition (a failed
    // attempt with no usage, or a step that saw no drop) leaves the key untouched, so the
    // following real drop still counts; an unchanged effort clears it so the next change
    // is treated as new.
    // Clear the marker only when there is no transition at all relative to the attempt the
    // next drop will be measured against. Using `previous` here would clear it while a
    // pending effort change is still unmeasured on the measured chain.
    if(!resetPrevious||effortKey(resetPrevious.reasoningEffort)===effortKey(options.reasoningEffort))state.countedEffortTransition=null;
    const weights=options.messages.map(messageTokens),systemTokens=textTokens(typeof options.system==='string'?options.system:JSON.stringify(options.system??null)),
      toolSchemaTokens=textTokens(JSON.stringify(options.tools??[])),
      envelopeTokens=textTokens(JSON.stringify({tools:options.tools??[],system:options.system??null}));
    // A failed or aborted attempt carries no observable prompt/cache usage, so it
    // must not replace the last usable observation. Otherwise the next economics
    // decision reads a zero prompt as "nothing was cached". A partly reported
    // usage has the same problem: a positive prompt with a missing output field
    // still yields canonical.complete=false, and accepting it would let `assess`
    // take an incomplete observation as the exposure baseline. Keep the flag on
    // the observation so the later check can read it.
    const usageComplete=canonical.complete===true;
    const finishAccepted=successfulFinish.has(record.finishReason);
    // Capacity pressure needs the newest positive prompt count even when the same
    // response omitted output usage and therefore cannot become the exposure baseline.
    if(total>0&&!record.failureCode&&!record.aborted&&finishAccepted)
      state.latestPrompt={provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort,
        usage,usageComplete,weights,systemTokens,toolSchemaTokens,envelopeTokens,at:record.at};
    const usableForExposure=total>0&&!record.failureCode&&!record.aborted&&usageComplete&&finishAccepted;
    if(usableForExposure)state.last={provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort,usage,usageComplete,
      generation:record.generation,alignmentSafe:textProjection(options.messages),
      envelope,keys:options.messages.map(modelKey),ids:options.messages.map(message=>message.id),weights,
      systemTokens,toolSchemaTokens,envelopeTokens,
      factor:Math.max(0.25,Math.min(8,total/Math.max(1,weights.reduce((sum,value)=>sum+value,0)+envelopeTokens))),
      finishReason:record.finishReason,at:record.at,measurement:state.previousMeasured};
    else state.lastUnusable={reason:record.failureCode?'failed-attempt':record.aborted?'aborted':
        !usageComplete?'incomplete-usage':!finishAccepted?'unusable-finish-reason':'no-prompt-usage',
      finishReason:record.finishReason??null,at:record.at??null};
    if(resetComparable&&usage.cacheReadTokens<resetPrevious.cacheReadTokens&&
      finite(usage.inputTokens)&&finite(resetPrevious.inputTokens)&&usage.inputTokens>resetPrevious.inputTokens&&
      runtime.get(agent).config.requestAccounting){
      let messagePrefix=null;
      // The exposure view skips failed attempts. Use its message keys only when
      // they describe the same measured attempt as the usage comparison.
      if(usableForExposure&&previous?.measurement===resetPrevious){
        const before=previous.keys,after=state.last.keys;
        let equalMessages=0;
        while(equalMessages<before.length&&equalMessages<after.length&&before[equalMessages]===after[equalMessages])equalMessages++;
        messagePrefix={equalMessages,previousMessages:before.length,currentMessages:after.length};
      }
      record.cacheReadDrop={previousSourceSeq:resetPrevious.sourceSeq,previousOrdinal:resetPrevious.ordinal,
        envelopeChanged:resetEnvelopeChanged,effortChanged:effortKey(resetPrevious.reasoningEffort)!==effortKey(options.reasoningEffort),
        messagePrefix,scope:'assembled system, tools, message role and content; provider transport and replay metadata unobserved'};
    }
    const reviews=reviewOutcomes(agent);
    for(const review of reviews)runtime.effects?.decide(agent,'projection',
      review.plausible===false?'review-implausible':review.plausible===null?'review-unavailable':'reviewed','projection-outcome',review);
  }
  function pressure(agent,routeContext=null,maxTokens=null){
    const context=routeContext??agent.session.requestContext(),limit=context?.contextWindow;
    const state=get(agent),header=agent.session.requestHeader()?.config;
    // Only an observation from this exact route and effort may inform this route's
    // pressure: another route's prompt count includes a different model's tokenization
    // and would report a false emergency here.
    const latestPrompt=state.latestPrompt&&sameObservedRoute(state.latestPrompt,header)?state.latestPrompt:null;
    const last=state.last&&sameObservedRoute(state.last,header)?state.last:null;
    const observed=latestPrompt??last,reported=promptTokens(observed?.usage);
    const projected=runtime.projectedMessages?.(agent);
    let tokens,method;
    if(projected){
      const requestHeader=agent.session.requestHeader(),messagesTokens=projected.reduce((sum,message)=>sum+messageTokens(message),0),
        // The current envelope counts the LIVE tool schema, because a surface that grew
        // after the observed request carries those tokens now. The previous envelope uses
        // the stored schema weight, so an unchanged surface yields a zero delta and the
        // existing estimate is preserved.
        system=observed?.systemTokens??0,
        liveTools=textTokens(JSON.stringify(requestHeader?.tools??[])),
        previousTools=observed?.toolSchemaTokens??liveTools,
        current=messagesTokens+system+liveTools;
      if(reported!==null&&observed){
        // The growth since the observed request is measured against THAT request's own
        // footprint. Using an older baseline would count the same growth twice when the
        // newer prompt already includes it. Only the calibration factor from `last` is
        // reused, because an incomplete observation has no usable output total.
        const previous=(observed.weights??[]).reduce((sum,value)=>sum+value,0)+system+previousTools;
        const factor=last?.factor??observed.factor??1;
        tokens=Math.max(0,reported+(current-previous)*factor);
      }else tokens=Math.max(reported??0,current);
      method='actual-request usage plus estimated effective-view growth; original surface meter excluded';
    }else{
      let measured=null;
      try{
        const measurement=(ctx.get?ctx.get('tokenMeter'):ctx.tokenMeter)?.measure(agent.session);
        measured=measurement?.totalTokens??measurement?.projectedTokens??null;
      }catch{}
      tokens=Math.max(reported??0,measured??0);
      method='actual usage and host surface meter';
    }
    const reserve=maxTokens??agent.session.requestHeader()?.config?.maxTokens??0;
    return {emergency:finite(limit)&&limit>0&&(tokens>=limit*0.9||tokens+reserve>=limit*0.95),
      tokens:tokens||null,limit:limit??null,reserveTokens:reserve,method};
  }
  function summary(agent){
    const state=get(agent),route=agent.session.requestHeader()?.config,currencies=Object.keys(state.costByCurrency);
    return {route:route?{provider:route.provider,model:route.model}:null,pricing:route?pricing(agent,route):null,
      mainHistory:state.mainHistory.slice(-8),
      usageMeaning:'DSH adapter input/cacheRead/cacheWrite are disjoint; reasoning is included in output',
      requests:state.requests,mainRequests:state.requests-state.auxiliaryRequests-state.compactionRequests,auxiliaryRequests:state.auxiliaryRequests,compactionRequests:state.compactionRequests,
      surfaceChanges:state.surfaceChanges,cacheResetCount:state.cacheResetCount,uncachedInputAtReset:state.uncachedInputAtReset,resetTaxUSD:state.resetTaxByCurrency.USD??0,resetTaxByCurrency:{...state.resetTaxByCurrency},
      effortChanges:state.effortChanges,cacheResetAfterEffortChange:state.cacheResetAfterEffortChange,effortResetExposureUSD:state.effortResetExposureByCurrency.USD??0,effortResetExposureByCurrency:{...state.effortResetExposureByCurrency},
      effortResetScope:'Observed cache drops immediately after effort changes; exposure uses configured prices and does not establish causation or add to the billed total.',
      reportedPromptTokens:state.reportedPromptTokens,reportedOutputTokens:state.reportedOutputTokens,
      mainPromptRequests:state.mainPromptRequests,
      missingUsageRequests:state.missingUsage,missingCacheUsageRequests:state.missingCacheUsage,pricedRequests:state.pricedRequests,
      lastUnusableAttempt:state.lastUnusable??null,
      reportedCost:currencies.length===1&&state.pricedRequests===state.requests?state.costByCurrency[currencies[0]]:null,knownReportedCost:currencies.length===1?state.costByCurrency[currencies[0]]:null,costComplete:state.pricedRequests===state.requests,costByCurrency:{...state.costByCurrency},
      failedKnownCostRequests:state.failedKnownCostRequests,failedKnownCostByCurrency:{...state.failedKnownCostByCurrency},
      failedKnownCostLowerBound:Object.keys(state.failedKnownCostByCurrency).length===1?Object.values(state.failedKnownCostByCurrency)[0]:null,
      costLowerBoundByCurrency:{...state.costLowerBoundByCurrency},costLowerBound:
        Object.keys(state.costLowerBoundByCurrency).length===1?Object.values(state.costLowerBoundByCurrency)[0]:null,
      costLowerBoundRequests:state.costLowerBoundRequests,
      referenceLowerBoundByCurrency:{...state.referenceLowerBoundByCurrency},referenceLowerBound:
        Object.keys(state.referenceLowerBoundByCurrency).length===1?Object.values(state.referenceLowerBoundByCurrency)[0]:null,
      referenceLowerBoundRequests:state.referenceLowerBoundRequests,
      referencePricedRequests:state.referencePricedRequests,referenceCostByCurrency:{...state.referenceCostByCurrency},
      referenceCostLowerBound:Object.keys(state.referenceCostByCurrency).length===1?Object.values(state.referenceCostByCurrency)[0]:null,
      costObservation:{basis:state.pricedRequests&&state.referencePricedRequests?'mixed':
        state.pricedRequests?'exact-route':state.referencePricedRequests?'reference-rate':'unavailable',
        coverage:{requests:state.requests,exactRoute:state.pricedRequests,referenceRate:state.referencePricedRequests,
          failedKnown:state.failedKnownCostRequests,lowerBound:state.costLowerBoundRequests,referenceLowerBound:state.referenceLowerBoundRequests,
          unpriced:Math.max(0,state.requests-state.pricedRequests-state.referencePricedRequests-state.failedKnownCostRequests)},
        actualCharge:null,allowanceConsumption:null,budgetEnforcement:'none'},
      currency:currencies.length===1?currencies[0]:null,skips:{...state.skips},recentDecisions:state.decisions.slice(-6),
      projectionReviews:state.reviewedOutcomes.slice(-6),pendingProjectionReviews:state.pendingReviews.length,
      note:'Observed usage and configured-price cost are totals, not causal savings; forecast decisions predict reuse and do not prove a global cost optimum.'};
  }
  return {assess,remember,reviewAdoption,reviewOutcomes,pressure,summary,requestFinished,
    mainHistory:(agent,route=null)=>get(agent).mainHistory
      .filter(item=>!route||sameObservedRoute(item,route))
      .map(item=>({...item})),
    pricingFor:(agent,route)=>pricing(agent,route??agent.session.requestHeader()?.config??{}),
    lastSuccessfulUsage:(agent,route)=>{
      const state=get(agent),latest=state.mainAttempts.findLast(item=>sameObservedRoute(item,route));
      if(!latest?.completeSuccess||!latest.usage)return null;
      return {...latest.usage};
    },
    lastUsage:agent=>get(agent).last?.usage??null,
    clear:agent=>states.delete(agent.session.id),dispose:()=>states.clear()};
}
