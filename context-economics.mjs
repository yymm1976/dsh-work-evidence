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
export const contextMessageFingerprint=message=>modelKey(message);
const textProjection=messages=>messages.every(message=>(message.content??[]).every(block=>['text','reasoning','tool-call'].includes(block.type)));
const envelopeKey=value=>JSON.stringify({tools:value.tools??[],system:value.system??null});
const sameRoute=(a,b)=>a?.provider===b?.provider&&a?.model===b?.model;
const effortKey=value=>value===undefined||value===null?null:value;
const sameObservedRoute=(a,b)=>Boolean(a&&b)&&sameRoute(a,b)&&
  effortKey(a.reasoningEffort)===effortKey(b.reasoningEffort);
const routeKey=route=>JSON.stringify([route?.provider??null,route?.model??null,effortKey(route?.reasoningEffort)]);
const priceKey=price=>price?JSON.stringify([price.currency,price.input,price.cacheRead,price.cacheWrite??null]):null;
const readWeight=price=>price&&price.input>0&&finite(price.cacheRead)&&price.cacheRead<=price.input?price.cacheRead/price.input:null;
const successfulFinish=new Set(['stop','tool-calls','max-tokens','length']);

export function createContextEconomics(ctx,runtime){
  const states=new Map();
  const get=agent=>{
    let state=states.get(agent.session.id);
    if(!state){state={last:null,lastSuccessfulMain:null,mainHistory:[],mainAttempts:[],decisions:[],skips:{},requests:0,reportedPromptTokens:0,reportedOutputTokens:0,
      missingUsage:0,missingCacheUsage:0,pricedRequests:0,costByCurrency:Object.create(null),auxiliaryRequests:0,mainFinished:0,
      surfaceChanges:0,cacheResetCount:0,uncachedInputAtReset:0,resetTaxUSD:0,
      effortChanges:0,cacheResetAfterEffortChange:0,effortResetExposureUSD:0,
      lastBatchCarrier:null,batchRoute:null,batchRouteKey:null,batchPriceKey:null,batchItems:new Map(),batchLastDecision:null,
      batchCommittedItems:0};states.set(agent.session.id,state);}
    return state;
  };
  function pricing(agent,route){
    return runtime.get(agent).config.projectionPricing.find(row=>sameRoute(row,route))??null;
  }
  function candidateFingerprint(candidate){
    if(typeof candidate.fingerprint==='string'&&candidate.fingerprint)return candidate.fingerprint;
    return candidate.beforeMessage?contextMessageFingerprint(candidate.beforeMessage):null;
  }
  function candidateIdentity(route,candidate){
    const messageId=candidate.messageId??candidate.beforeMessage?.id??null;
    const fingerprint=candidateFingerprint(candidate);
    if(typeof messageId!=='string'||!messageId||typeof fingerprint!=='string'||!fingerprint)return null;
    return JSON.stringify([routeKey(route),Number.isSafeInteger(candidate.seq)?candidate.seq:null,messageId,fingerprint,
      candidate.afterMessage?modelKey(candidate.afterMessage):null]);
  }
  function normalizeBatch(agent,{candidates=[],route=null}={}){
    route??=agent.session.requestHeader()?.config??{};
    const routeSignature=routeKey(route),items=[];let invalid=null;
    for(const candidate of Array.isArray(candidates)?candidates:[]){
      const key=candidateIdentity(route,candidate);
      const messageId=candidate.messageId??candidate.beforeMessage?.id??null;
      const fingerprint=candidateFingerprint(candidate);
      const before=candidate.beforeMessage,after=candidate.afterMessage;
      if(!key){invalid=messageId?'candidate-fingerprint-unavailable':'candidate-message-id-unavailable';break;}
      if(!before||!after){invalid='candidate-projection-unavailable';break;}
      const savedChars=finite(candidate.savedChars)?candidate.savedChars:null;
      const savedTokensEstimate=Math.max(0,messageTokens(before)-messageTokens(after));
      items.push({key,seq:Number.isSafeInteger(candidate.seq)?candidate.seq:null,messageId,fingerprint,
        savedChars,savedTokensEstimate,afterTokensEstimate:messageTokens(after),reason:candidate.reason??null});
    }
    return {route,routeKey:routeSignature,items,invalid};
  }
  function syncBatch(agent,{candidates=[],route=null}={}){
    const state=get(agent),batch=normalizeBatch(agent,{candidates,route});
    const currentPriceKey=priceKey(pricing(agent,batch.route));
    if(state.batchRouteKey&&state.batchRouteKey!==batch.routeKey||state.batchPriceKey!==currentPriceKey){
      state.batchItems.clear();state.batchLastDecision=null;
    }
    state.batchPriceKey=currentPriceKey;
    state.batchRoute=batch.route;state.batchRouteKey=batch.routeKey;
    const keys=new Set(batch.items.map(item=>item.key));
    for(const key of state.batchItems.keys())if(!keys.has(key))state.batchItems.delete(key);
    const items=batch.items.map(candidate=>{
      let item=state.batchItems.get(candidate.key);
      if(!item){
        item={...candidate,waitingLossTokens:0,waitingMainRequests:0,estimatedCandidateCarryUSD:0,
          lastWaitIncrementTokens:0,lastWaitCarryUSD:0,lastCarriedAt:null};
        state.batchItems.set(candidate.key,item);
      }else Object.assign(item,candidate);
      return item;
    });
    return {...batch,items,waitingLossTokens:items.reduce((sum,item)=>sum+item.waitingLossTokens,0)};
  }
  function batchSnapshot(state,route=state.batchRoute){
    const items=[...state.batchItems.values()],counts=items.map(item=>item.waitingMainRequests);
    return {batchSize:items.length,waitingLossTokens:items.reduce((sum,item)=>sum+item.waitingLossTokens,0),
      waitingMainRequestsMin:counts.length?Math.min(...counts):0,waitingMainRequestsMax:counts.length?Math.max(...counts):0,
      estimatedCandidateCarryUSD:items.reduce((sum,item)=>sum+item.estimatedCandidateCarryUSD,0),
      savedChars:items.reduce((sum,item)=>sum+(item.savedChars??0),0),
      savedTokensEstimate:items.reduce((sum,item)=>sum+item.savedTokensEstimate,0),
      route:route?{provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort??null}:null};
  }
  function batchCandidateSeen(agent,candidate,route=null){
    const state=get(agent),carrier=state.lastBatchCarrier;
    route??=agent.session.requestHeader()?.config??{};
    return !!carrier&&promptTokens(carrier.usage)>0&&sameObservedRoute(carrier,route)&&
      carrier.ids.some((id,index)=>id===candidate.messageId&&carrier.keys[index]===candidate.fingerprint);
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
  function assessBatch(agent,{candidates=[],route=null,emergency=false}={}){
    const state=get(agent),synced=syncBatch(agent,{candidates,route}),currentRoute=synced.route,price=pricing(agent,currentRoute);
    const G=synced.items.reduce((sum,item)=>sum+item.savedTokensEstimate,0);
    const savedChars=synced.items.reduce((sum,item)=>sum+(item.savedChars??0),0);
    const W=synced.waitingLossTokens,batchSize=synced.items.length;
    const carrier=state.lastBatchCarrier,warm=carrier&&promptTokens(carrier.usage)>0&&carrier.mainOrdinal===state.mainFinished&&
      sameObservedRoute(carrier,currentRoute)?carrier:null;
    let Hshared=null,newestMessageId=null,newestCarrierIndex=null,earliestCarrierIndex=null;
    if(warm&&synced.items.length){
      const positions=synced.items.map(item=>{
        const matches=[];
        for(let index=0;index<warm.ids.length;index++)if(warm.ids[index]===item.messageId&&warm.keys[index]===item.fingerprint)matches.push(index);
        return {item,index:matches.length===1?matches[0]:-1};
      });
      if(positions.every(value=>value.index>=0)&&new Set(positions.map(value=>value.index)).size===positions.length){
        const newest=positions.reduce((best,value)=>value.index>best.index?value:best);
        newestMessageId=newest.item.messageId;newestCarrierIndex=newest.index;
        earliestCarrierIndex=Math.min(...positions.map(value=>value.index));
        const replacements=new Map(positions.map(value=>[value.index,value.item.afterTokensEstimate]));
        // A prefix change can expose all retained content after the earliest
        // replacement, including the replacements themselves and gaps between them.
        Hshared=warm.weights.slice(earliestCarrierIndex).reduce((sum,value,offset)=>
          sum+(replacements.get(earliestCarrierIndex+offset)??value),0);
      }
    }
    const wr=readWeight(price);
    const rebuildWeight=wr===null?null:(Math.max(price.input,price.cacheWrite??price.input)-price.cacheRead)/price.input;
    const F0=0,comparisonLeft=wr===null?null:W+wr*G;
    const reconstructionQ=rebuildWeight===null||Hshared===null?null:F0+rebuildWeight*Hshared;
    let allowed=false,reason='batch-candidates-unavailable';
    if(!batchSize)reason='no-batch-candidates';
    else if(G<=0)reason='no-request-token-reduction';
    else if(emergency){allowed=true;reason='context-capacity';}
    else if(synced.invalid)reason=synced.invalid;
    else if(!price)reason='route-pricing-unavailable';
    else if(wr===null)reason='cache-price-ratio-unavailable';
    else if(!warm)reason='successful-carrier-usage-unavailable';
    else if(warm.usage.cacheWriteTokens>0&&!finite(price.cacheWrite))reason='cache-write-price-unavailable';
    else if(Hshared===null)reason='shared-warm-suffix-unavailable';
    else if(comparisonLeft>=reconstructionQ){allowed=true;reason='online-batch-economic-crossing';}
    else reason='online-batch-waiting';
    const scale=price?price.input/1e6:null;
    const decision={allowed,reason,batchSize,mode:'online-batch',forecast:false,emergency,
      W,waitingLossTokensEstimate:W,G,savedTokensEstimate:G,savedChars,wr,rebuildWeight,F0,Hshared,
      comparisonLeftEstimate:comparisonLeft,reconstructionQEstimate:reconstructionQ,
      sharedReconstructionTokensEstimate:Hshared,earliestCarrierIndex,newestMessageId,newestCarrierIndex,
      waitingMainRequestsMin:synced.items.length?Math.min(...synced.items.map(item=>item.waitingMainRequests)):0,
      waitingMainRequestsMax:synced.items.length?Math.max(...synced.items.map(item=>item.waitingMainRequests)):0,
      estimatedCandidateCarryUSD:synced.items.reduce((sum,item)=>sum+item.estimatedCandidateCarryUSD,0),
      estimatedWaitingLossUSD:scale===null?null:W*scale,
      estimatedShorteningBenefitUSD:scale===null||wr===null?null:wr*G*scale,
      estimatedSharedReconstructionUSD:scale===null||reconstructionQ===null?null:reconstructionQ*scale,
      commitRule:'W + wr*G >= F0 + rebuildWeight*Hshared',
      cacheWeight:wr,cachedSuffixTokensEstimate:Hshared,
      cacheWeightMethod:'wr = cacheRead / input; rebuildWeight = (max(input, cacheWrite) - cacheRead) / input; independent of observed cache hit rate',
      observedCacheHitRate:warm?warm.usage.cacheReadTokens/promptTokens(warm.usage):null,
      waitingLossMethod:'W advances only after a successful main request whose assembled messages still contain each candidate by message id and body fingerprint',
      sharedSuffixMethod:'Hshared estimates the retained suffix from the earliest pending candidate, including replacement messages and unchanged gaps; it infers potential warmth and does not measure cache position',
      usageSource:warm?'latest successful main request adapter usage':'unavailable',
      pricingSource:price?'explicit-exact-route-setting':'unavailable',
      currency:price?.currency??null,
      tokenMethod:'G is the sum of planContextPrune before/after message-token estimates; savedChars is the actual net character reduction',
      economicsScope:'candidate scheduling decision under changing history; not a proof of global cost optimum',
      route:currentRoute?{provider:currentRoute.provider,model:currentRoute.model,reasoningEffort:currentRoute.reasoningEffort??null}:null};
    state.batchLastDecision=decision;
    return decision;
  }
  function consumeBatchItem(agent,candidate,route=null){
    const state=get(agent);route??=candidate.route??state.batchRoute??agent.session.requestHeader()?.config??{};
    const key=candidate.key??candidateIdentity(route,candidate),removed=key?state.batchItems.delete(key):false;
    if(removed)state.batchCommittedItems++;
    return removed;
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
    const successfulMain=record.settled&&!record.aborted&&!record.failureCode&&successfulFinish.has(record.finishReason),
      completeSuccess=successfulMain&&canonical.complete&&total>0;
    state.mainAttempts.push({at:record.at??new Date().toISOString(),provider:options.provider,model:options.model,
      reasoningEffort:options.reasoningEffort??null,completeSuccess,promptTokens:total,
      finishReason:record.finishReason,usageComplete:canonical.complete});
    if(state.mainAttempts.length>16)state.mainAttempts.shift();
    const routeChanged=state.batchRouteKey&&state.batchRouteKey!==routeKey(options),currentPriceKey=priceKey(price);
    if(routeChanged||state.batchPriceKey!==currentPriceKey){state.batchItems.clear();state.batchLastDecision=null;state.batchRoute=options;state.batchRouteKey=routeKey(options);}
    state.batchPriceKey=currentPriceKey;
    if(completeSuccess){
      state.lastSuccessfulMain={provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort??null,
        usage:{...usage},finishReason:record.finishReason,at:record.at??new Date().toISOString()};
      state.mainHistory.push({at:record.at??new Date().toISOString(),sourceSeq:record.sourceSeq??null,provider:options.provider,model:options.model,
        reasoningEffort:options.reasoningEffort??null,promptTokens:total,
        inputTokens:usage.inputTokens,cacheReadTokens:usage.cacheReadTokens,cacheWriteTokens:usage.cacheWriteTokens,
        outputTokens:usage.outputTokens,finishReason:record.finishReason});
      if(state.mainHistory.length>16)state.mainHistory.shift();
    }
    if(successfulMain&&canonical.complete&&total>0&&readWeight(price)!==null&&Array.isArray(options.messages)){
      const wr=readWeight(price);
      for(const item of state.batchItems.values()){
        const carried=options.messages.findLast(message=>message?.id===item.messageId&&modelKey(message)===item.fingerprint);
        if(!carried)continue;
        const increment=wr*item.savedTokensEstimate,carryUSD=price.cacheRead*item.savedTokensEstimate/1e6;
        item.waitingLossTokens+=increment;item.waitingMainRequests++;item.lastWaitIncrementTokens=increment;
        item.lastWaitCarryUSD=carryUSD;if(carryUSD!==null)item.estimatedCandidateCarryUSD+=carryUSD;
        item.lastCarriedAt=record.at??new Date().toISOString();
      }
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
    if(successfulMain&&canonical.complete&&total>0){
      state.lastBatchCarrier={provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort??null,usage,mainOrdinal:state.mainFinished,
        generation:record.generation,envelope,keys:options.messages.map(modelKey),ids:options.messages.map(message=>message.id),weights,
        factor:Math.max(0.25,Math.min(8,total/Math.max(1,weights.reduce((sum,value)=>sum+value,0)+envelopeTokens))),
        finishReason:record.finishReason,at:record.at};
    }
  }
  function pressure(agent,routeContext=null,maxTokens=null){
    const context=routeContext??agent.session.requestContext(),limit=context?.contextWindow;
    const last=get(agent).last,reported=promptTokens(last?.usage);
    let measured=null;
    try{measured=(ctx.tokenMeter??ctx.get?.('tokenMeter'))?.measure(agent.session)?.projectedTokens??null;}catch{}
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
    const state=get(agent),route=agent.session.requestHeader()?.config,currencies=Object.keys(state.costByCurrency),batch=batchSnapshot(state,route);
    return {route:route?{provider:route.provider,model:route.model}:null,pricing:route?pricing(agent,route):null,
      mainHistory:state.mainHistory.slice(-8),
      usageMeaning:'DSH adapter input/cacheRead/cacheWrite are disjoint; reasoning is included in output',
      requests:state.requests,mainRequests:state.requests-state.auxiliaryRequests,auxiliaryRequests:state.auxiliaryRequests,
      surfaceChanges:state.surfaceChanges,cacheResetCount:state.cacheResetCount,uncachedInputAtReset:state.uncachedInputAtReset,resetTaxUSD:state.resetTaxUSD,
      effortChanges:state.effortChanges,cacheResetAfterEffortChange:state.cacheResetAfterEffortChange,effortResetExposureUSD:state.effortResetExposureUSD,
      effortResetScope:'Observed cache drops immediately after effort changes; exposure uses configured prices and does not establish causation or add to the billed total.',
      reportedPromptTokens:state.reportedPromptTokens,reportedOutputTokens:state.reportedOutputTokens,
      missingUsageRequests:state.missingUsage,missingCacheUsageRequests:state.missingCacheUsage,pricedRequests:state.pricedRequests,
      reportedCost:currencies.length===1&&state.pricedRequests===state.requests?state.costByCurrency[currencies[0]]:null,knownReportedCost:currencies.length===1?state.costByCurrency[currencies[0]]:null,costComplete:state.pricedRequests===state.requests,costByCurrency:{...state.costByCurrency},
      currency:currencies.length===1?currencies[0]:null,skips:{...state.skips},recentDecisions:state.decisions.slice(-6),
      onlineBatch:{...batch,currentBatchKey:state.batchRouteKey,committedItems:state.batchCommittedItems,lastDecision:state.batchLastDecision,
        WMeaning:'CADOC normalized cache-read waiting loss; advances only on observed successful main requests carrying the candidate',
        wrMeaning:'configured cache-read price / uncached-input price; cache hit rate is a separate observation',
        HsharedMeaning:'estimated retained suffix from the earliest pending candidate in the latest successful main prompt; not a measured cache position',
        scope:'online candidate scheduling metric; no global-optimum claim'},
      note:'Observed usage and configured-price cost are totals, not causal savings; forecast decisions predict reuse, while online-batch decisions estimate a candidate schedule and do not prove a global cost optimum.'};
  }
  return {assess,assessBatch,syncBatch,batchCandidateSeen,consumeBatchItem,remember,pressure,summary,requestFinished,
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
