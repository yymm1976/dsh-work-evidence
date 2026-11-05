import fs from 'node:fs/promises';
import {canonicalUsage,requestKindOf} from './context-economics.mjs';
import {summarizeAttempts} from './experiment-attempts.mjs';
import {tokenFields} from './experiment-store.mjs';

export const REQUEST_ACCOUNTING_SCHEMA='work-evidence.session-request-accounting.v1';
const schemas=new Set(['work-evidence.request-start.v1','work-evidence.request-effects.v1','work-evidence.request-link.v1']);
const emptyTokens=()=>Object.fromEntries(tokenFields.map(field=>[field,{known:0,reportedRequests:0}]));
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
const signature=value=>JSON.stringify(value);

export async function readRequestAccounting(file,events,options){
  try{
    const stat=await fs.stat(file);
    if(!stat.isFile()||stat.size>64*1024*1024)throw Error('Request observation file must be at most 64 MiB.');
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(await fs.readFile(file)),rows=[],problems=[];
    for(const [index,line]of raw.split(/\r?\n/u).entries())if(line.trim()){
      try{rows.push(JSON.parse(line));}catch{problems.push({line:index+1,reason:'invalid-json-row'});}
    }
    return accountSessionRequests(events,rows,{...options,sourceFile:file,problems});
  }catch(error){
    return accountSessionRequests(events,[],{...options,sourceFile:file,
      problems:[{reason:error.code==='ENOENT'?'observation-file-missing':'observation-file-unavailable'}]});
  }
}

/** Add only source-bound auxiliary/compaction streams; native main usage stays authoritative. */
export function accountSessionRequests(events,rows,{sessionId,sourceFile=null,inherited=0,problems=[]}={}){
  if(typeof sessionId!=='string'||!sessionId||!Array.isArray(events)||!Array.isArray(rows)||!nonnegative(inherited)||inherited>events.length)
    throw Error('Request accounting needs a session identity and explicit native event range.');
  const own=events.slice(inherited),native=summarizeAttempts(own).attempts;
  const throughSeq=own.reduce((last,event)=>nonnegative(event.seq)?Math.max(last??event.seq,event.seq):last,null);
  const firstSeq=own.find(event=>nonnegative(event.seq))?.seq??null;
  const issues=problems.slice(),records=new Map(),legacy=[],nativeBySeq=new Map(native.map(row=>[row.sourceSeq,row]));
  let exactDuplicates=0;
  for(const [index,row]of rows.entries()){
    if(!row||!schemas.has(row.schema)){issues.push({index,reason:'unsupported-observation-row'});continue;}
    if(typeof row.requestId!=='string'||!row.requestId||row.requestId.length>256){issues.push({index,reason:'invalid-request-id'});continue;}
    if(row.sessionId===undefined){legacy.push({requestId:row.requestId,schema:row.schema});continue;}
    if(row.sessionId!==sessionId){issues.push({index,reason:'observation-session-mismatch'});continue;}
    const bucket=records.get(row.requestId)??{};
    if(bucket[row.schema]){
      if(signature(bucket[row.schema])===signature(row)){exactDuplicates++;continue;}
      issues.push({requestId:row.requestId,reason:'conflicting-observation-row'});bucket.conflict=true;
    }else bucket[row.schema]=row;
    records.set(row.requestId,bucket);
  }
  if(legacy.length)issues.push({reason:'legacy-observation-identity-missing',rows:legacy.length});
  const groups={auxiliary:{requests:0,unknownRequests:0,tokens:emptyTokens()},compaction:{requests:0,unknownRequests:0,tokens:emptyTokens()}};
  const matched=new Map(),nativeClaims=new Map(),additionalRequests=[],unsettled=[],unmatched=[],mainRequestLinks=[];
  for(const [requestId,bucket]of records){
    const start=bucket['work-evidence.request-start.v1'],end=bucket['work-evidence.request-effects.v1'],link=bucket['work-evidence.request-link.v1'];
    const row=end??start;
    if(!row){issues.push({requestId,reason:'orphan-request-link'});continue;}
    if(nonnegative(row.sourceSeq)&&firstSeq!==null&&row.sourceSeq<firstSeq)continue;
    // sourceSeq is the next event cursor; an auxiliary stream may finish at the tail without appending a native event.
    if(!nonnegative(row.sourceSeq)||throughSeq===null||row.sourceSeq>throughSeq+1){issues.push({requestId,reason:'request-outside-native-snapshot'});continue;}
    const kind=requestKindOf(row);
    if(row.requestKind!==kind||!['main','auxiliary','compaction'].includes(kind))issues.push({requestId,reason:'invalid-request-kind'});
    if(start&&end&&['requestKind','provider','model','sourceSeq'].some(key=>start[key]!==end[key])){
      issues.push({requestId,reason:'request-start-end-mismatch'});bucket.conflict=true;
    }
    if(!start||end?.startRecorded!==true)issues.push({requestId,reason:'request-start-not-recorded'});
    if(!end)unsettled.push(requestId);
    const canonical=canonicalUsage(end?.usage),rejected=Object.values(end?.usageSources??{}).includes('invalid-adapter-value');
    const complete=!!end&&!bucket.conflict&&end.settled===true&&end.unknownConsumption!==true&&end.usageComplete!==false&&
      end.usageConsistent!==false&&!rejected&&canonical.complete&&['stop','tool-calls','max-tokens','length'].includes(end.finishReason);
    if(kind==='main'){
      if(link?.outcome==='committed'&&nonnegative(link.sourceSeq)){
        const claims=nativeClaims.get(link.sourceSeq)??[];claims.push(requestId);nativeClaims.set(link.sourceSeq,claims);
      }
      const attempt=link?.outcome==='committed'?nativeBySeq.get(link.sourceSeq):null;
      const position=start?.nativeAttempt;
      const samePosition=attempt&&typeof position?.attemptId==='string'&&position.attemptId&&nonnegative(position.turn)&&nonnegative(position.step)&&
        ['attemptId','turn','step'].every(key=>position[key]===link?.nativeAttempt?.[key])&&position.turn===attempt.turn&&position.step===attempt.step&&
        link.eventType===(attempt.noSurfaceAttempt?'assistant/attempt':'assistant/message');
      const sameEffort=start&&Object.hasOwn(start,'reasoningEffort')&&end&&Object.hasOwn(end,'reasoningEffort')&&
        attempt?.route&&Object.hasOwn(attempt.route,'reasoningEffort')&&start.reasoningEffort===end.reasoningEffort&&end.reasoningEffort===attempt.route.reasoningEffort;
      const sameRoute=attempt&&attempt.route?.provider===row.provider&&attempt.route?.model===row.model;
      const sameUsage=attempt&&tokenFields.every(field=>attempt.usage[field]===canonical.usage[field]);
      const duplicate=matched.has(link?.sourceSeq),reason=duplicate?'native-request-counted-twice':'native-request-link-unverified';
      const verified=!!(samePosition&&sameRoute&&sameUsage&&complete&&!duplicate);
      const projectionIdentityVerified=verified&&start&&end?.startRecorded===true&&sameEffort;
      let observation=null;
      if(end?.projectionObservation!==undefined){
        const observed=end.projectionObservation,valid=observed&&typeof observed==='object'&&!Array.isArray(observed)&&
          ['matched','unknown'].includes(observed.status)&&(observed.planSeq===null||nonnegative(observed.planSeq))&&
          (observed.planMessageId===null||typeof observed.planMessageId==='string')&&
          Array.isArray(observed.resultSeqs)&&observed.resultSeqs.every(nonnegative)&&(observed.status!=='matched'||observed.resultSeqs.length>0)&&
          (observed.reason===null||typeof observed.reason==='string');
        observation=valid?{status:observed.status,planSeq:observed.planSeq,planMessageId:observed.planMessageId,
          resultSeqs:[...observed.resultSeqs],reason:observed.reason}:{
          status:'unknown',planSeq:null,planMessageId:null,resultSeqs:[],reason:'invalid-projection-observation'};
      }
      if(observation&&!projectionIdentityVerified){observation.status='unknown';observation.reason=reason;}
      mainRequestLinks.push({requestId,sourceSeq:(observation?projectionIdentityVerified:verified)?link.sourceSeq:null,projectionObservation:observation});
      if(!verified){
        unmatched.push(requestId);issues.push({requestId,reason});
      }else matched.set(link.sourceSeq,requestId);
      continue;
    }
    if(!groups[kind])continue;
    // A committed native assistant event is already in native totals, whatever its label says.
    if(link?.outcome==='committed'){
      issues.push({requestId,reason:'nonmain-request-has-native-settlement'});continue;
    }
    const group=groups[kind];group.requests++;
    if(!complete)group.unknownRequests++;
    else for(const field of tokenFields)if(nonnegative(canonical.usage[field])){
      group.tokens[field].known+=canonical.usage[field];group.tokens[field].reportedRequests++;
    }
    additionalRequests.push({requestId,requestKind:kind,provider:row.provider??null,model:row.model??null,
      sourceSeq:row.sourceSeq,usage:canonical.usage,complete,finishReason:end?.finishReason??null});
  }
  for(const [seq,requestIds]of nativeClaims)if(requestIds.length>1){
    matched.delete(seq);
    for(const requestId of requestIds){
      if(!unmatched.includes(requestId))unmatched.push(requestId);
      if(!issues.some(issue=>issue.requestId===requestId&&issue.reason==='native-request-counted-twice'))
        issues.push({requestId,reason:'native-request-counted-twice'});
    }
  }
  for(const link of mainRequestLinks){
    if((nativeClaims.get(link.sourceSeq)?.length??0)<=1)continue;
    matched.delete(link.sourceSeq);link.sourceSeq=null;
    if(link.projectionObservation){link.projectionObservation.status='unknown';link.projectionObservation.reason='native-request-counted-twice';}
  }
  const missingNative=native.filter(row=>!matched.has(row.sourceSeq)).map(row=>row.sourceSeq);
  const additionalTokens=emptyTokens();
  for(const group of Object.values(groups))for(const field of tokenFields){
    additionalTokens[field].known+=group.tokens[field].known;additionalTokens[field].reportedRequests+=group.tokens[field].reportedRequests;
  }
  const additionalCount=groups.auxiliary.requests+groups.compaction.requests;
  const complete=!!records.size&&native.length>0&&!issues.length&&!missingNative.length&&!unsettled.length&&
    Object.values(groups).every(group=>group.unknownRequests===0);
  return {schema:REQUEST_ACCOUNTING_SCHEMA,sessionId,sourceFile,throughSeq,status:complete?'recorded-local-streams-covered':'unknown',complete,
    nativeRequests:native.length,matchedNativeRequests:matched.size,missingNativeSourceSeqs:missingNative,
    additionalRequests:additionalCount,additionalUnknownRequests:groups.auxiliary.unknownRequests+groups.compaction.unknownRequests,
    additionalTokens,byKind:groups,requests:additionalRequests,mainRequestLinks,unsettledRequestIds:unsettled,unmatchedRequestIds:unmatched,
    exactDuplicateRows:exactDuplicates,legacyRows:legacy.length,problems:issues,
    scope:'Explicit session-local stream records plus exact native settlements. Main observation rows are never added to native totals. Coverage excludes external executions, other sessions, bypassed streams, adapter-internal HTTP retries and billing.'};
}

/** Merge explicitly imported local records by their session and original request identity. */
export function taskRequestConsumption(parts){
  const unique=new Map(),problems=[],sessions=[];
  const add=(key,row)=>{
    const prior=unique.get(key);
    if(prior){
      if(signature(prior.row)!==signature(row)){prior.conflict=true;problems.push({request:key,reason:'conflicting-task-request'});}
    }else unique.set(key,{row,conflict:false});
  };
  for(const part of parts){
    const accounting=part.requestAccounting,valid=accounting?.schema===REQUEST_ACCOUNTING_SCHEMA&&accounting.sessionId===part.sessionId&&
      typeof accounting.complete==='boolean'&&Array.isArray(accounting.requests)&&Array.isArray(accounting.problems)&&nonnegative(accounting.additionalRequests);
    sessions.push({sessionId:part.sessionId,status:valid?accounting.status:'unknown',sourceFile:valid?accounting.sourceFile:null,
      additionalRequests:valid?accounting.additionalRequests:null,problems:valid?accounting.problems:[{reason:'request-accounting-missing'}]});
    if(!valid||!accounting.complete)problems.push({sessionId:part.sessionId,reason:'session-request-coverage-unknown'});
    const native=part.attemptAccounting?.attempts;
    if(!Array.isArray(native)||native.length!==part.requests.started){
      problems.push({sessionId:part.sessionId,reason:'native-request-identities-incomplete'});
    }else for(const attempt of native){
      if(!nonnegative(attempt.sourceSeq)){problems.push({sessionId:part.sessionId,reason:'native-request-identity-missing'});continue;}
      add(JSON.stringify([part.sessionId,'native',attempt.sourceSeq]),{kind:'main',usage:attempt.usage,route:attempt.route,
        unknown:attempt.consumptionUnknown===true||attempt.usageComplete===false||attempt.usageConsistent===false,
        rejected:Object.values(attempt.usageSources??{}).includes('invalid-adapter-value')});
    }
    if(valid)for(const row of accounting.requests){
      if(typeof row?.requestId!=='string'||!row.requestId||!['auxiliary','compaction'].includes(row.requestKind)){
        problems.push({sessionId:part.sessionId,reason:'additional-request-identity-missing'});continue;
      }
      add(JSON.stringify([part.sessionId,'observed',row.requestId]),{
        kind:row.requestKind,usage:row.usage,route:{provider:row.provider,model:row.model},unknown:row.complete!==true,rejected:false});
    }
  }
  const tokens=emptyTokens(),byKind={main:0,auxiliary:0,compaction:0};let unknownRequests=0;
  for(const {row,conflict}of unique.values()){
    const canonical=canonicalUsage(row.usage),known=!conflict&&!row.unknown&&!row.rejected&&canonical.complete;
    if(!known){unknownRequests++;continue;}
    byKind[row.kind]=(byKind[row.kind]??0)+1;
    for(const field of tokenFields)if(nonnegative(canonical.usage[field])){
      tokens[field].known+=canonical.usage[field];tokens[field].reportedRequests++;
    }
  }
  return {requests:unique.size,tokens,byKind,unknownRequests,unknown:!!problems.length||unknownRequests>0,
    sessions,problems,scope:'Unique requests in explicitly imported native sessions and their source-bound nonmain streams; legacy aggregate counts remain native-only diagnostics.'};
}
