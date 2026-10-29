import {canonicalUsage} from './context-economics.mjs';

const fields=['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','reasoningTokens','totalTokens'];
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const key=data=>String(data.turn)+':'+String(data.step);
export function summarizeAttempts(events){
  const attempts=[],retries=[],starts=new Map(),scheduled=new Map(),ordinals=new Map();
  let header=null,route=null;
  for(const event of events){
    const data=event.data||{},at=number(event.time),stepKey=key(data);
    if(event.type==='request/header'){
      const config=data.header?.config;
      route=config?{provider:config.provider||null,model:config.model||null,reasoningEffort:config.reasoningEffort||null,maxTokens:number(config.maxTokens)}:route;
      header={at,sourceSeq:event.seq??null};
    }
    if(event.type==='step/start')header=null;
    if(event.type==='llm/retry'){
      const record={sourceSeq:event.seq??null,turn:data.turn??null,step:data.step??null,retryId:data.retryId??null,retry:data.retry??null,
        scheduledAt:at,startedAt:null,scheduledDelayMs:number(data.delayMs),observedWaitMs:null,failure:data.failure||null};
      retries.push(record);scheduled.set(String(data.retryId)+':'+String(data.retry),record);
    }else if(event.type==='llm/retry-started'){
      const retry=scheduled.get(String(data.retryId)+':'+String(data.retry));
      if(retry){retry.startedAt=at;retry.observedWaitMs=at!==null&&retry.scheduledAt!==null?Math.max(0,at-retry.scheduledAt):null;}
      starts.set(stepKey,{at,kind:'retry-started-event',sourceSeq:event.seq??null});
    }else if(['assistant/message','assistant/attempt'].includes(event.type)){
      const stream=data.stream||[],usage=data.usage||stream.findLast(item=>item.type==='chunk'&&item.chunk?.type==='usage')?.chunk?.usage||null;
      const canonical=canonicalUsage(usage),cleaned=canonical.usage??Object.fromEntries(fields.map(field=>[field,null])),reported=Object.values(cleaned).filter(value=>value!==null);
      const usageState=!reported.length?'missing':reported.every(value=>value===0)?'explicit-zero':'reported-positive';
      const finish=stream.findLast(item=>item.type==='chunk'&&item.chunk?.type==='finish')?.chunk?.reason||null;
      const ordinal=(ordinals.get(stepKey)||0)+1;ordinals.set(stepKey,ordinal);
      const begin=starts.get(stepKey)||(header?{at:header.at,kind:'request-header-boundary',sourceSeq:header.sourceSeq}:null);
      const noSurfaceAttempt=event.type==='assistant/attempt';
      attempts.push({sourceSeq:event.seq??null,turn:data.turn??null,step:data.step??null,ordinal,route,noSurfaceAttempt,interrupted:!!data.interrupted,
        startedAt:begin?.at??null,startSource:begin?.kind||null,endedAt:at,elapsedMs:at!==null&&begin?.at!=null?Math.max(0,at-begin.at):null,
        usage:cleaned,usageSources:canonical.sources,usageConsistent:canonical.consistent,usageComplete:canonical.complete,usageState,
        consumptionUnknown:!canonical.complete||(noSurfaceAttempt&&(usageState==='explicit-zero'||!['stop','tool-calls','max-tokens','length'].includes(finish?.kind))),
        failure:finish?.failure||data.failure||null,finishReason:finish?.kind||null});
      starts.delete(stepKey);header=null;
    }
  }
  const knownTokens=Object.fromEntries(fields.map(field=>[field,attempts.reduce((n,attempt)=>n+(attempt.usage[field]??0),0)]));
  const counts={observedAttempts:attempts.length,surfaceMessages:attempts.filter(item=>!item.noSurfaceAttempt).length,failedAttempts:attempts.filter(item=>item.noSurfaceAttempt).length,
    explicitZeroAttempts:attempts.filter(item=>item.usageState==='explicit-zero').length,missingUsageAttempts:attempts.filter(item=>item.usageState==='missing').length,
    unknownConsumptionAttempts:attempts.filter(item=>item.consumptionUnknown).length,retryEvents:retries.length,measuredRetryWaits:retries.filter(item=>item.observedWaitMs!==null).length,unsettledRetryStarts:starts.size};
  return {schema:'work-evidence.attempts.v1',counts,knownTokens,attempts,retries,
    tokenCoverage:Object.fromEntries(fields.map(field=>[field,{reportedAttempts:attempts.filter(item=>item.usage[field]!==null).length,missingAttempts:attempts.filter(item=>item.usage[field]===null).length}])),
    scheduledRetryDelayMs:retries.reduce((n,item)=>n+(item.scheduledDelayMs??0),0),observedRetryWaitMs:retries.reduce((n,item)=>n+(item.observedWaitMs??0),0),
    scope:'Recorded assistant messages/attempts only, not actual HTTP request count or billing. Explicit zero on a failed attempt does not prove free consumption. Initial durations start at request-header assembly; retry durations start at durable retry-started events. Observed retry wait includes scheduling and is not pure sleep. Unpublished adapter-internal requests and costs remain unknown.'};
}
