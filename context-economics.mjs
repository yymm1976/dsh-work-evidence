const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const validCount=value=>Number.isSafeInteger(value)&&value>=0;
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
    const remainder=usage.totalTokens-usage.inputTokens-usage.outputTokens-cacheKeys.reduce((sum,key)=>sum+(usage[key]??0),0);
    if(remainder===0)for(const key of cacheKeys)if(sources[key]==='missing'){usage[key]=0;sources[key]='zero-proven-by-reported-disjoint-total';}
  }
  const sumKeys=['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'];
  let complete=sumKeys.every(key=>usage[key]!==null);
  const sum=complete?sumKeys.reduce((total,key)=>total+usage[key],0):null;
  const consistent=!Object.values(sources).includes('invalid-adapter-value')&&(!complete||usage.totalTokens===null||sum===usage.totalTokens);
  if(complete&&sources.totalTokens==='missing'){usage.totalTokens=sum;sources.totalTokens='sum-of-reported-disjoint-fields';}
  complete=complete&&consistent;
  return {usage,sources,consistent,complete,method:'disjoint-adapter-usage; omitted-zero-cache-fields require exact total equality'};
}
export const promptTokens=usage=>usage&&['inputTokens','cacheReadTokens','cacheWriteTokens'].every(key=>finite(usage[key]))
  ?usage.inputTokens+usage.cacheReadTokens+usage.cacheWriteTokens:null;
export function usageCost(usage,price){
  if(!price||!usage||!['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].every(key=>finite(usage[key]))||
    usage.cacheWriteTokens>0&&!finite(price.cacheWrite))return null;
  return (usage.inputTokens*price.input+usage.cacheReadTokens*price.cacheRead+
    usage.cacheWriteTokens*(price.cacheWrite??0)+usage.outputTokens*price.output)/1e6;
}

// Estimates guide a decision; only adapter usage is reported as observed tokens.
export function textTokens(text){
  text=String(text??'');
  const wide=(text.match(/[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/g)??[]).length;
  return Math.ceil(wide+(text.length-wide)/3.5);
}
export function messageTokens(message){
  let total=4;
  for(const block of message.content??[]){
    if(block.type==='text'||block.type==='reasoning')total+=textTokens(block.text);
    else if(block.type==='tool-call')total+=textTokens(JSON.stringify({name:block.name,arguments:block.arguments,id:block.id}));
    else total+=textTokens(JSON.stringify(block));
  }
  return total;
}
const modelKey=message=>JSON.stringify({role:message.role,content:message.content,toolCallId:message.toolCallId,isError:message.isError});
const textProjection=messages=>messages.every(message=>(message.content??[]).every(block=>['text','reasoning','tool-call'].includes(block.type)));
const envelopeKey=value=>JSON.stringify({tools:value.tools??[],system:value.system??null});
const sameRoute=(a,b)=>a?.provider===b?.provider&&a?.model===b?.model;
const effortKey=value=>value===undefined||value===null?null:value;
const sameObservedRoute=(a,b)=>Boolean(a&&b)&&sameRoute(a,b)&&
  effortKey(a.reasoningEffort)===effortKey(b.reasoningEffort);
const successfulFinish=new Set(['stop','tool-calls','max-tokens','length']);

export function createContextEconomics(ctx,runtime){
  const states=new Map();
  const get=agent=>{
    let state=states.get(agent.session.id);
    if(!state){state={last:null,lastSuccessfulMain:null,mainHistory:[],mainAttempts:[],decisions:[],skips:{},requests:0,reportedPromptTokens:0,reportedMainPromptTokens:0,mainPromptRequests:0,reportedOutputTokens:0,
      missingUsage:0,missingCacheUsage:0,pricedRequests:0,costByCurrency:Object.create(null),auxiliaryRequests:0,mainFinished:0,
      surfaceChanges:0,cacheResetCount:0,uncachedInputAtReset:0,resetTaxUSD:0,
      effortChanges:0,cacheResetAfterEffortChange:0,effortResetExposureUSD:0,
      pendingReviews:[],reviewedOutcomes:[],
      };states.set(agent.session.id,state);}
    return state;
  };
  function pricing(agent,route){
    return runtime.get(agent).config.projectionPricing.find(row=>sameRoute(row,route))??null;
  }
  function assess(agent,{messages,proposedMessages,savedChars=0,changedSeq=null,changedMessageId=null,route=null,tools,system,emergency=false,horizon,
    auxiliaryUsage=null,auxiliaryMargin=1.5}={}){
    const state=get(agent),config=runtime.get(agent).config;
    route??=agent.session.requestHeader()?.config??{};
    const old=state.last,price=pricing(agent,route),same=old&&sameObservedRoute(old,route);
    const rawSaving=messages&&proposedMessages
      ?messages.reduce((sum,message)=>sum+messageTokens(message),0)-proposedMessages.reduce((sum,message)=>sum+messageTokens(message),0)
      :Math.ceil(Math.max(0,savedChars)/3.5);
    const firstReplayAssistant=Boolean(same&&changedMessageId&&!old.ids.includes(changedMessageId)&&
      messages?.some(message=>message.id===changedMessageId&&message.role==='assistant'));
    const beforeOutput=firstReplayAssistant?messages.reduce((sum,message)=>sum+messageTokens(message),0):null;
    const factor=firstReplayAssistant&&finite(old.usage?.outputTokens)
      ?Math.max(.25,Math.min(8,old.usage.outputTokens/Math.max(1,beforeOutput))):same?old.factor:1;
    const savedTokens=Math.max(0,Math.floor(rawSaving*factor));
    const remainingSteps=Math.max(1,Math.min(64,horizon??config.projectionHorizonSteps));
    let cachedSuffixTokens=null,prefixMessages=0,oldSuffixTokens=null,exposureMethod='conservative previous-request prompt';
    if(same&&old.usage&&promptTokens(old.usage)!==null){
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
        cachedSuffixTokens=Math.ceil(Math.max(0,proposed.tokens-existing.tokens));
        exposureMethod='rewritten surviving suffix plus new replacements; unchanged unsent tail excluded; existing baseline exposure subtracted';
      }else if(proposedMessages){cachedSuffixTokens=cached;}
      else if(changedMessageId||Number.isSafeInteger(changedSeq)){
        const nodes=agent.session.surface.nodes,index=nodes.indexOf(changedSeq);
        if(changedMessageId||index>=0){
          const ids=changedMessageId?new Set([changedMessageId]):new Set(nodes.slice(index).map(seq=>{
            const event=agent.session.eventAt(seq);return (event?.data?.message??event?.data)?.id;
          }).filter(Boolean));
          const first=old.ids.findIndex(id=>ids.has(id));
          oldSuffixTokens=first<0?null:Math.ceil(Math.min(cached,old.weights.slice(first).reduce((sum,value)=>sum+value,0)*old.factor));
          cachedSuffixTokens=oldSuffixTokens===null?null:Math.max(0,oldSuffixTokens-savedTokens);
          exposureMethod=first<0?'history location not found in previous prompt; exposure unproven':'previously sent suffix less net removed tokens; pointer overhead included in net saving';
        }
      }
    }
    let allowed=false,reason='usage-or-cache-exposure-unavailable',refillCost=null,futureSaving=null,breakEvenSteps=null;
    const auxiliaryCost=auxiliaryUsage?usageCost(auxiliaryUsage,price):0;
    if(savedTokens<=0)reason='no-request-reduction';
    else if(emergency&&!auxiliaryUsage){allowed=true;reason='context-capacity';}
    else if(auxiliaryUsage&&auxiliaryCost===null)reason='auxiliary-price-or-usage-unavailable';
    else if (cachedSuffixTokens === 0 && auxiliaryUsage === null) {allowed=true;reason='no-additional-previous-request-prefix-exposure';refillCost=0;breakEvenSteps=0;
      if(price)futureSaving=savedTokens*Math.min(price.input,price.cacheRead)*remainingSteps/1e6;}
    else if(cachedSuffixTokens!==null&&price){
      if(old?.usage?.cacheWriteTokens>0&&!finite(price.cacheWrite))reason='cache-write-price-unavailable';
      else if(price.input===0&&price.cacheRead===0&&(price.cacheWrite??0)===0&&auxiliaryCost===0){allowed=true;reason='zero-priced-route';refillCost=0;futureSaving=0;breakEvenSteps=0;}
      else{
        refillCost=cachedSuffixTokens*Math.max(0,Math.max(price.input,price.cacheWrite??price.input)-price.cacheRead)/1e6;
        const perStep=savedTokens*Math.min(price.input,price.cacheRead)/1e6;
        futureSaving=perStep*remainingSteps;
        const required=refillCost*1.25+auxiliaryCost*auxiliaryMargin;
        breakEvenSteps=perStep>0?Math.ceil(required/perStep):null;
        allowed=perStep>0&&futureSaving>required;
        reason=allowed?'predicted-cache-cost-positive':'predicted-cache-cost-insufficient';
      }
    }else if(cachedSuffixTokens!==null)reason='route-pricing-unavailable';
    return {allowed,reason,savedTokensEstimate:savedTokens,cachedSuffixTokensEstimate:cachedSuffixTokens,
      oldSuffixTokensEstimate:oldSuffixTokens,
      cachedExposureMethod:exposureMethod+'; prior misses may populate cache; not a cache-position measurement',
      horizonSteps:remainingSteps,refillCostEstimate:refillCost,futureSavingEstimate:futureSaving,breakEvenStepsEstimate:breakEvenSteps,
      auxiliaryCostEstimate:auxiliaryCost,auxiliaryMargin:auxiliaryUsage?auxiliaryMargin:null,
      currency:price?.currency??null,pricingSource:price?'explicit-exact-route-setting':'unavailable',
      tokenMethod:firstReplayAssistant?'text-density calibrated to previous generated output':same?'text-density calibrated to previous adapter usage':'text-density estimate',
      forecast:true,emergency};
  }
  function remember(agent,decision,kind){
    const state=get(agent);state.decisions.push({kind,...decision});if(state.decisions.length>16)state.decisions.shift();
    if(!decision.allowed)state.skips[decision.reason]=(state.skips[decision.reason]??0)+1;
    return decision;
  }
  function reviewAdoption(agent,{kind,appliedAtStep,expectedSavedChars=0,expectedRefillTokens=0}){
    const state=get(agent);
    state.pendingReviews.push({kind,appliedAtStep,expectedSavedChars,expectedRefillTokens,
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
      const expectedRemovedTokensPerRequest=Math.max(0,review.expectedSavedChars/3.5);
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
    const state=get(agent),canonical=canonicalUsage(record.usage),usage=canonical.usage,total=promptTokens(usage),price=pricing(agent,options);
    record.usage=usage;record.usageSources=canonical.sources;record.usageConsistent=canonical.consistent;record.usageComplete=canonical.complete;
    state.requests++;
    if(record.auxiliary)state.auxiliaryRequests++;
    if(usage&&(!finite(usage.cacheReadTokens)||!finite(usage.cacheWriteTokens)))state.missingCacheUsage++;
    if(total===null)state.missingUsage++;
    else{state.reportedPromptTokens+=total;state.reportedOutputTokens+=usage.outputTokens??0;}
    const billingComplete=record.settled&&['stop','tool-calls','max-tokens','length'].includes(record.finishReason);
    const cacheWritePriced=usage?.cacheWriteTokens===0||finite(price?.cacheWrite);
    if(price&&usage&&total!==null&&finite(usage.outputTokens)&&billingComplete&&cacheWritePriced){
      state.costByCurrency[price.currency]=(state.costByCurrency[price.currency]??0)+(usage.inputTokens*price.input+(usage.cacheReadTokens??0)*price.cacheRead+
        usage.cacheWriteTokens*(price.cacheWrite??0)+usage.outputTokens*price.output)/1e6;
      state.pricedRequests++;
    }else if(price){const reason=!billingComplete?'incomplete-request-billing':!cacheWritePriced?'cache-write-price-unavailable':'missing-usage-fields';state.skips[reason]=(state.skips[reason]??0)+1;}
    if(record.auxiliary)return;
    state.mainFinished++;
    if(total!==null){state.reportedMainPromptTokens+=total;state.mainPromptRequests++;}
    const successfulMain=record.settled&&!record.aborted&&!record.failureCode&&successfulFinish.has(record.finishReason),
      completeSuccess=successfulMain&&canonical.complete&&total>0;
    state.mainAttempts.push({at:record.at??new Date().toISOString(),provider:options.provider,model:options.model,
      reasoningEffort:options.reasoningEffort??null,completeSuccess,promptTokens:total,
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
    const previous=state.last,envelope=envelopeKey(options),same=previous&&sameRoute(previous,options),changed=same&&previous.envelope!==envelope;
    const effortChanged=same&&previous.reasoningEffort!==options.reasoningEffort;
    if(changed)state.surfaceChanges++;
    if(effortChanged)state.effortChanges++;
    if(previous?.usage?.cacheReadTokens>0&&usage?.cacheReadTokens<previous.usage.cacheReadTokens*.5&&usage?.inputTokens>2000){
      state.cacheResetCount++;state.uncachedInputAtReset+=usage.inputTokens;
      if(changed&&price){const extra=Math.max(0,Math.min(usage.inputTokens-previous.usage.inputTokens,previous.usage.cacheReadTokens-usage.cacheReadTokens));
        state.resetTaxUSD+=extra*Math.max(0,price.input-price.cacheRead)/1e6;}
      if(effortChanged){
        state.cacheResetAfterEffortChange++;
        if(price){const extra=Math.max(0,Math.min(usage.inputTokens-previous.usage.inputTokens,previous.usage.cacheReadTokens-usage.cacheReadTokens));
          state.effortResetExposureUSD+=extra*Math.max(0,price.input-price.cacheRead)/1e6;}
      }
    }
    const weights=options.messages.map(messageTokens),envelopeTokens=textTokens(JSON.stringify({tools:options.tools??[],system:options.system??null}));
    state.last={provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort,usage,
      generation:record.generation,alignmentSafe:textProjection(options.messages),
      envelope,keys:options.messages.map(modelKey),ids:options.messages.map(message=>message.id),weights,
      envelopeTokens,
      factor:total===null?1:Math.max(0.25,Math.min(8,total/Math.max(1,weights.reduce((sum,value)=>sum+value,0)+envelopeTokens))),
      finishReason:record.finishReason,at:record.at};
    const reviews=reviewOutcomes(agent);
    for(const review of reviews)runtime.effects?.decide(agent,'projection',
      review.plausible===false?'review-implausible':review.plausible===null?'review-unavailable':'reviewed','projection-outcome',review);
  }
  function pressure(agent,routeContext=null,maxTokens=null){
    const context=routeContext??agent.session.requestContext(),limit=context?.contextWindow;
    const last=get(agent).last,reported=promptTokens(last?.usage);
    let measured=null;
    try{const measurement=(ctx.tokenMeter??ctx.get?.('tokenMeter'))?.measure(agent.session);measured=measurement?.totalTokens??measurement?.projectedTokens??null;}catch{}
    const projected=runtime.projectedMessages?.(agent);
    let tokens,method;
    if(projected){
      const header=agent.session.requestHeader(),envelope=textTokens(JSON.stringify({tools:header?.tools??[],system:null})),
        current=projected.reduce((sum,message)=>sum+messageTokens(message),0)+envelope;
      if(reported!==null&&last){
        const previous=last.weights.reduce((sum,value)=>sum+value,0)+(last.envelopeTokens??0);
        tokens=Math.max(0,reported+(current-previous)*last.factor);
      }else tokens=current;
      method='actual-request usage plus estimated effective-view growth; original surface meter excluded';
    }else{tokens=Math.max(reported??0,measured??0);method='actual usage and host surface meter';}
    const reserve=maxTokens??agent.session.requestHeader()?.config?.maxTokens??0;
    return {emergency:finite(limit)&&limit>0&&(tokens>=limit*0.9||tokens+reserve>=limit*0.95),
      tokens:tokens||null,limit:limit??null,reserveTokens:reserve,method};
  }
  function summary(agent){
    const state=get(agent),route=agent.session.requestHeader()?.config,currencies=Object.keys(state.costByCurrency);
    return {route:route?{provider:route.provider,model:route.model}:null,pricing:route?pricing(agent,route):null,
      mainHistory:state.mainHistory.slice(-8),
      usageMeaning:'DSH adapter input/cacheRead/cacheWrite are disjoint; reasoning is included in output',
      requests:state.requests,mainRequests:state.requests-state.auxiliaryRequests,auxiliaryRequests:state.auxiliaryRequests,
      surfaceChanges:state.surfaceChanges,cacheResetCount:state.cacheResetCount,uncachedInputAtReset:state.uncachedInputAtReset,resetTaxUSD:state.resetTaxUSD,
      effortChanges:state.effortChanges,cacheResetAfterEffortChange:state.cacheResetAfterEffortChange,effortResetExposureUSD:state.effortResetExposureUSD,
      effortResetScope:'Observed cache drops immediately after effort changes; exposure uses configured prices and does not establish causation or add to the billed total.',
      reportedPromptTokens:state.reportedPromptTokens,reportedOutputTokens:state.reportedOutputTokens,
      mainPromptRequests:state.mainPromptRequests,
      missingUsageRequests:state.missingUsage,missingCacheUsageRequests:state.missingCacheUsage,pricedRequests:state.pricedRequests,
      reportedCost:currencies.length===1&&state.pricedRequests===state.requests?state.costByCurrency[currencies[0]]:null,knownReportedCost:currencies.length===1?state.costByCurrency[currencies[0]]:null,costComplete:state.pricedRequests===state.requests,costByCurrency:{...state.costByCurrency},
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
      if(!latest?.completeSuccess)return null;
      const value=state.lastSuccessfulMain;
      return value&&sameObservedRoute(value,route)?{...value.usage}:null;
    },
    lastUsage:agent=>get(agent).last?.usage??null,
    clear:agent=>states.delete(agent.session.id),dispose:()=>states.clear()};
}
