import fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalUsage,usageCost} from './context-economics.mjs';
import {summarizeAttempts} from './experiment-attempts.mjs';
import {isUserRequestMessage,argsOf} from './runtime.mjs';
import {resultText,parseResult} from './visible-results.mjs';
import {recordedProcessCompletion} from './execution-evidence.mjs';

export const AUDIT_SCHEMA='work-evidence.trajectory-audit.v1';
export const ASSESSMENT_SCHEMA='work-evidence.task-assessment.v1';
export const AUDIT_LABELS=Object.freeze(['W1','W2','W3','W4','W5','W6','W7','W8','Q1','Q2','Q3','Q4','Q5']);
const READ=new Set(['read','ops_read_files','ops_inspect_local_file','project_evidence','fastedit_java']);
const STATIC_RESULTS=new Set([...READ,'glob','grep','ops_glob','ops_grep']);
const WRITE=new Set(['write','edit','ops_write_file','ops_edit_file','verified_exec','str_replace_editor','fastedit_java']);
const messageOf=event=>event.data?.message??(event.data?.role?event.data:null);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const routeOf=value=>({provider:value?.provider??null,model:value?.model??null,reasoningEffort:value?.reasoningEffort??value?.effort??null});
const forecastRoute=value=>Object.fromEntries(['provider','model','reasoningEffort'].map(key=>
  [key,typeof value?.[key]==='string'&&value[key].trim()?value[key]:null]));
const completeRoute=value=>['provider','model','reasoningEffort'].every(key=>typeof value?.[key]==='string'&&value[key].trim());
const fileOf=args=>args.file_path??args.path??args.file??null;
const normalizeFile=value=>{
  if(typeof value!=='string'||!value.trim())return null;
  const windows=/^[A-Za-z]:[\\/]/u.test(value)||value.includes('\\');
  const flavor=windows?path.win32:path.posix;
  const absolute=flavor.isAbsolute(value);value=flavor.normalize(value);
  return {value:(windows?value.toLowerCase():value).replaceAll('\\','/'),absolute};
};
const OPAQUE=new Set(['pwsh','ops_bash','bash','run_code','work_exec','work_probe','verified_exec']);

/** Compare recorded forecasts with identified main usage without claiming cache causation. */
export function auditCacheTransitions(events,requestAccounting=null){
  const attempts=summarizeAttempts(events).attempts;
  const complete=row=>row?.consumptionUnknown!==true&&row?.usageComplete===true&&row?.usageConsistent!==false&&
    ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].every(key=>Number.isSafeInteger(row.usage?.[key])&&row.usage[key]>=0);
  const comparableAttempt=row=>complete(row)&&!row?.noSurfaceAttempt&&!row?.interrupted&&!row?.failure&&
    row?.ordinal===1&&
    typeof row?.route?.provider==='string'&&row.route.provider&&typeof row.route.model==='string'&&row.route.model&&
    Object.hasOwn(row.route,'reasoningEffort');
  const additions=requestAccounting?.requests?.map(row=>({seq:row.sourceSeq,kind:row.requestKind,complete:row.complete===true}))??[];
  const mainRequestLinks=Array.isArray(requestAccounting?.mainRequestLinks)?requestAccounting.mainRequestLinks:[];
  const eventBySeq=new Map(events.map(event=>[event.seq,event])),plans=new Map();
  for(const event of events){
    const message=messageOf(event),plan=message?.source?.workingSet;
    if(event.type!=='user/message'||message?.source?.kind!=='work-evidence-working-set'||plan?.action!=='project'||!Number.isSafeInteger(event.seq))continue;
    const entries=Array.isArray(plan.entries)?plan.entries:null;
    const resultSeqs=entries?.map(entry=>entry?.seq)??[];
    const valid=plan.version===1&&!!entries?.length&&entries.every(entry=>{
      const original=eventBySeq.get(entry?.seq);
      return Number.isSafeInteger(entry?.seq)&&entry.seq<event.seq&&original?.type==='tool/result'&&
        typeof entry.id==='string'&&entry.id&&messageOf(original)?.id===entry.id;
    })&&new Set(resultSeqs).size===resultSeqs.length;
    plans.set(event.seq,{messageId:typeof message.id==='string'?message.id:null,entryCount:entries?.length??null,resultSeqs:valid?resultSeqs:null});
  }
  const observations=new Map(),invalidRequestIds=new Set(),verifiedMainSeqs=new Set();
  for(const row of mainRequestLinks)if(row&&typeof row.requestId==='string'&&Number.isSafeInteger(row.sourceSeq))verifiedMainSeqs.add(row.sourceSeq);
  for(const row of mainRequestLinks){
    if(!row||typeof row.requestId!=='string'||!row.requestId||row.sourceSeq!==null&&!Number.isSafeInteger(row.sourceSeq))continue;
    if(observations.has(row.requestId)||invalidRequestIds.has(row.requestId)){
      const first=observations.get(row.requestId);if(first)first.projectionObservation={
        status:'unknown',planSeq:null,planMessageId:null,resultSeqs:[],reason:'duplicate-request-identity'};
      invalidRequestIds.add(row.requestId);continue;
    }
    const observation=row.projectionObservation;
    if(observation===null)continue;
    if(!observation||!['matched','unknown'].includes(observation.status))continue;
    const valid=observation.status==='unknown'||(Number.isSafeInteger(observation.planSeq)&&typeof observation.planMessageId==='string'&&observation.planMessageId&&
      Array.isArray(observation.resultSeqs)&&observation.resultSeqs.length>0&&observation.resultSeqs.every(Number.isSafeInteger));
    const item={...row,projectionObservation:valid?observation:{status:'unknown',planSeq:null,planMessageId:null,resultSeqs:[],reason:'invalid-projection-observation'}};
    if(!Number.isSafeInteger(observation.planSeq)&&observation.status==='unknown')continue;
    observations.set(row.requestId,item);
    if(!valid)continue;
    const plan=plans.get(observation.planSeq),actual=observation.resultSeqs,expected=new Set(plan?.resultSeqs??[]);
    const subset=plan?.resultSeqs!==null&&actual.every(seq=>expected.has(seq));
    if(!plan||plan.messageId!==observation.planMessageId||!subset||new Set(actual).size!==actual.length){
      item.projectionObservation={...observation,status:'unknown',resultSeqs:[],
        reason:observation.status==='matched'?'projection-plan-or-results-unmatched':observation.reason};
      continue;
    }
  }
  const items=[];
  const append=(event,link=null)=>{
    const plan=messageOf(event)?.source?.workingSet;
    const observation=link?.projectionObservation??null;
    const candidateTarget=link&&Number.isSafeInteger(link.sourceSeq)?attempts.find(row=>row.sourceSeq===link.sourceSeq):null;
    const target=candidateTarget?.sourceSeq>event.seq?candidateTarget:null;
    const targetInvalid=!!link&&Number.isSafeInteger(link.sourceSeq)&&!target;
    const previous=target?attempts.findLast(row=>row.sourceSeq<target.sourceSeq):null;
    const next=target??attempts.find(row=>row.sourceSeq>event.seq);
    const previousIdentityConfirmed=!!previous&&verifiedMainSeqs.has(previous.sourceSeq)&&comparableAttempt(previous);
    const targetComparable=comparableAttempt(target),attemptsIdentified=attempts.every(row=>verifiedMainSeqs.has(row.sourceSeq));
    const retriesInvolved=!!previous&&!!target&&[previous,target].some(current=>attempts.some(row=>row.turn===current.turn&&row.step===current.step&&row.ordinal>1));
    const reasons=[];
    if(link&&(!observation||observation.status!=='matched'||!Number.isSafeInteger(link.sourceSeq)))reasons.push('applied-request-identity-unknown');
    if(link&&observation?.reason&&observation.reason!=='no-replaced-result')reasons.push(observation.reason);
    if(targetInvalid)reasons.push('applied-request-target-unavailable');
    if(!previous||!next)reasons.push('adjacent-main-request-unavailable');
    if(link&&!previous&&target)reasons.push('previous-request-unavailable-for-first-projection');
    if(previousIdentityConfirmed&&targetComparable&&['provider','model','reasoningEffort'].some(key=>previous.route[key]!==next.route[key]))reasons.push('route-or-effort-changed');
    if(previous&&!complete(previous)||next&&!complete(next))reasons.push('usage-incomplete');
    if(target&&!targetComparable)reasons.push('applied-request-not-comparable');
    if(previous&&!previousIdentityConfirmed)reasons.push('previous-request-not-comparable');
    if(retriesInvolved)reasons.push('same-step-retry-present');
    if(!target&&additions.some(row=>row.kind!=='main'&&row.seq>previous?.sourceSeq&&row.seq<next?.sourceSeq))reasons.push('interleaved-nonmain-request');
    const multipleRewrites=!target&&events.some(other=>other.seq>event.seq&&other.seq<(next?.sourceSeq??Infinity)&&
      (other.surfaceOp?.op==='replace'||other.type==='user/message'&&messageOf(other)?.source?.workingSet?.action==='project'));
    if(multipleRewrites)reasons.push('multiple-rewrites-before-next-main');
    const assessment=plan.decision;
    const predicted=assessment&&typeof assessment==='object'?{
      savedTokens:Number.isSafeInteger(assessment.savedTokensEstimate)?assessment.savedTokensEstimate:null,
      refillTokens:Number.isSafeInteger(assessment.cachedSuffixTokensEstimate)?assessment.cachedSuffixTokensEstimate:null,
      refillCost:typeof assessment.refillCostEstimate==='number'&&Number.isFinite(assessment.refillCostEstimate)?assessment.refillCostEstimate:null,
      currency:typeof assessment.currency==='string'?assessment.currency:null,
      method:typeof assessment.cachedExposureMethod==='string'?assessment.cachedExposureMethod:null,
      route:forecastRoute(assessment.route),envelope:assessment.envelope??null}:null;
    const identityConfirmed=!!link&&observation?.status==='matched'&&Number.isSafeInteger(link.sourceSeq)&&!!target;
    const predictedRoute=forecastRoute(assessment?.route),targetRoute=forecastRoute(target?.route);
    const routeComparison=!identityConfirmed||!completeRoute(predictedRoute)||!completeRoute(targetRoute)?'unknown':
      ['provider','model','reasoningEffort'].every(key=>predictedRoute[key]===targetRoute[key])?'same':'different';
    if(!identityConfirmed)reasons.push('applied-request-identity-unrecorded');
    const orderUnknown=additions.some(row=>row.kind!=='main'&&previous&&next&&
      (row.seq>=previous.sourceSeq&&row.seq<event.seq||target&&row.seq>=event.seq&&row.seq<=next.sourceSeq||
        !target&&row.seq>event.seq&&row.seq<=next.sourceSeq));
    if(!multipleRewrites&&orderUnknown)
      reasons.push('interleaved-request-order-unknown');
    const comparable=identityConfirmed&&previousIdentityConfirmed&&targetComparable&&!reasons.length;
    const coverageUnknown=!requestAccounting||!Array.isArray(requestAccounting.mainRequestLinks)||!attemptsIdentified;
    const priorLinks=target?mainRequestLinks.filter(row=>Number.isSafeInteger(row?.sourceSeq)&&row.sourceSeq>event.seq&&row.sourceSeq<target.sourceSeq):[];
    const observationByRequestId=new Map(mainRequestLinks.map(row=>[row?.requestId,row?.projectionObservation]));
    const earlierMatching=[...observations.values()].filter(row=>row.projectionObservation.planSeq===event.seq&&row.projectionObservation.status==='matched'&&
      Number.isSafeInteger(row.sourceSeq)&&row.sourceSeq>event.seq&&row.sourceSeq<target?.sourceSeq&&observationByRequestId.get(row.requestId)===row.projectionObservation);
    const earlierUnknown=priorLinks.some(row=>row.projectionObservation===null||row.projectionObservation?.status==='unknown'&&
      observationByRequestId.get(row.requestId)!==row.projectionObservation);
    const applicationOrder=!identityConfirmed||coverageUnknown?'unknown':priorLinks.length===0?'first-recorded-projection':
      earlierMatching.length&&!earlierUnknown?'subsequent-request':'unknown';
    const projectedResultSeqs=observation?.status==='matched'?observation.resultSeqs:[];
    const plannedResultSeqs=plans.get(event.seq)?.resultSeqs??null;
    const resultScope=observation?.status==='matched'?(projectedResultSeqs.length===plannedResultSeqs.length?'full-plan':'partial-plan'):'unknown';
    const observationKind=!link?'no-request-observation':observation?.status==='matched'?'projection-matched':
      observation?.reason==='no-replaced-result'?'no-projection-in-request':'projection-observation-unknown';
    items.push({kind:'request-projection',appliedAtSeq:event.seq,previousMainSeq:previous?.sourceSeq??null,nextMainSeq:next?.sourceSeq??null,
      requestId:link?.requestId??null,appliedMainSeq:target?.sourceSeq??null,
      applicationOrder,resultScope,projectedResultSeqs,plannedResultCount:plans.get(event.seq)?.entryCount??null,observationKind,
      predicted,forecastEnvironment:assessment?{route:predictedRoute,routeComparison,
        envelope:Object.hasOwn(assessment,'envelope')?assessment.envelope:null,
        comparison:'unavailable; route equality does not establish equal request content, model build, cache attribution or savings; request deltas are not a controlled forecast-environment comparison'}:null,
      observed:!comparable?null:{inputDelta:next.usage.inputTokens-previous.usage.inputTokens,
        cacheReadDelta:next.usage.cacheReadTokens-previous.usage.cacheReadTokens,
        cacheWriteDelta:next.usage.cacheWriteTokens-previous.usage.cacheWriteTokens},
      reasons:[...new Set(reasons)],attribution:'not-established',comparison:comparable?'adjacent-main-usage':'not-established',
      candidateAssessment:plan.candidateAssessment?{eligible:plan.candidateAssessment.eligible??null,plansEvaluated:plan.candidateAssessment.plansEvaluated??null}:null,
      meaning:'Adjacent main usage changes may include other work, retries and envelope changes. These deltas are not cache-position measurements, realized savings or causal refill attribution.'});
  };
  const linkedPlans=new Set(),orphanLinks=[];
  for(const link of observations.values()){
    const event=eventBySeq.get(link.projectionObservation.planSeq);
    if(!event){
      if(Number.isSafeInteger(link.projectionObservation.planSeq))orphanLinks.push({
        kind:'request-projection',appliedAtSeq:null,previousMainSeq:null,nextMainSeq:null,requestId:link.requestId,appliedMainSeq:null,
        applicationOrder:'unknown',resultScope:'unknown',projectedResultSeqs:[],plannedResultCount:null,observationKind:'projection-observation-unknown',
        predicted:null,forecastEnvironment:null,observed:null,reasons:[link.projectionObservation.status==='matched'?'projection-plan-unavailable':'applied-request-identity-unknown',
          ...(link.projectionObservation.reason?[link.projectionObservation.reason]:[])],attribution:'not-established',comparison:'not-established',candidateAssessment:null,
        meaning:'The recorded request association has no matching source plan. No usage difference or saving is inferred.'});
      continue;
    }
    linkedPlans.add(event.seq);append(event,link);
  }
  for(const event of events){
    const plan=messageOf(event)?.source?.workingSet;
    if(event.type==='user/message'&&plan?.action==='project'&&Number.isSafeInteger(event.seq)&&!linkedPlans.has(event.seq))append(event);
  }
  items.push(...orphanLinks);
  items.sort((a,b)=>(a.appliedAtSeq??Infinity)-(b.appliedAtSeq??Infinity)||String(a.requestId).localeCompare(String(b.requestId)));
  const unplannedObservationReasons={};
  for(const row of mainRequestLinks){
    const observation=row?.projectionObservation;
    if(observation?.status!=='unknown'||Number.isSafeInteger(observation.planSeq))continue;
    const reason=typeof observation.reason==='string'&&observation.reason?observation.reason:'unspecified';
    unplannedObservationReasons[reason]=(unplannedObservationReasons[reason]??0)+1;
  }
  return {basis:'recorded-projection-plan-and-source-bound-main-usage',items,
    compared:items.filter(item=>!item.reasons.length).length,unknown:items.filter(item=>item.reasons.length).length,
    comparedByApplicationOrder:{first:items.filter(item=>!item.reasons.length&&item.applicationOrder==='first-recorded-projection').length,
      subsequent:items.filter(item=>!item.reasons.length&&item.applicationOrder==='subsequent-request').length},
    unplannedObservationReasons};
}

export async function readAuditInput(file){
  const info=await fs.stat(file);
  if(!info.isFile()||info.size>256*1024*1024)throw Error('Audit input must be a file no larger than 256 MiB.');
  const raw=new TextDecoder('utf-8',{fatal:true}).decode(await fs.readFile(file));
  try{return {input:JSON.parse(raw),problems:[]};}catch{}
  const rows=[],problems=[];
  for(const [index,line]of raw.split(/\r?\n/u).entries()){
    if(!line.trim())continue;
    try{rows.push(JSON.parse(line));}catch{problems.push({line:index+1,reason:'invalid-json-row'});}
  }
  if(!rows.length)throw Error('Audit input contains no readable JSON events.');
  return {input:rows,problems};
}

/** Read-only projection of recorded events. No event, file or model is changed. */
export function normalizeDshEvents(input){
  const events=Array.isArray(input)?input:input?.events;
  if(!Array.isArray(events)||events.some(event=>!event||typeof event.type!=='string'))throw Error('Expected DSH events or an object containing events.');
  const seqs=new Set(),problems=[],calls=[],callsById=new Map(),requests=summarizeAttempts(events).attempts,changes=[],humans=[];
  const attempts=new Map(requests.map(request=>[request.sourceSeq,request]));
  let requestSeq=null,userSeq=null,mutationEpoch=0,opaqueEpoch=0,throughSeq=null;
  const addCall=(id,name,args,event,nested=false,rootCallId=null,settlement=false)=>{
    if(typeof id!=='string'||!id||typeof name!=='string')return null;
    const key=(nested?'nested:':'root:')+id;
    if(callsById.has(key)){
      if(settlement)return callsById.get(key);
      problems.push({seq:event.seq,reason:'duplicate-tool-call-id',id});
    }
    const call={id,name,arguments:argsOf(args),callSeq:event.seq??null,resultSeq:null,requestSeq,userSeq,nested,rootCallId,
      mutationEpoch,opaqueEpoch,outcome:'unknown',resultText:null};
    calls.push(call);callsById.set(key,call);return call;
  };
  for(const event of events){
    const data=event.data??{},message=messageOf(event);
    if(!integer(event.seq))problems.push({seq:event.seq??null,reason:'missing-or-invalid-source-seq'});
    else if(seqs.has(event.seq))problems.push({seq:event.seq,reason:'duplicate-source-seq'});
    else {seqs.add(event.seq);throughSeq=throughSeq===null?event.seq:Math.max(throughSeq,event.seq);}
    if(event.type==='user/message'&&isUserRequestMessage(message)){
      userSeq=event.seq;humans.push({seq:userSeq,textChars:resultText(message.content).length});
    }
    if(attempts.has(event.seq))requestSeq=event.seq;
    if(event.type==='tool/call')addCall(data.callId,data.name,data.arguments,event);
    if(['tool/ptc-dispatch-start','tool/code-dispatch-start'].includes(event.type))
      addCall(data.subCallId??data.callId,data.name,data.arguments,event,true,data.rootCallId??null);
    if(['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)){
      const call=addCall(data.subCallId??data.callId,data.name,data.arguments,event,true,data.rootCallId??null,true);
      if(call)settle(call,event,data.content,data.isError,data.value);
    }
    if(event.type==='tool/result'&&event.surfaceOp?.op!=='replace'){
      const id=message?.source?.callId??message?.toolCallId,call=callsById.get('root:'+id);
      if(call)settle(call,event,message.content,message.isError,data.value);
      else problems.push({seq:event.seq,reason:'unmatched-tool-result'});
    }
  }
  function settle(call,event,content,isError,nativeValue){
    call.resultSeq=event.seq??null;call.resultText=resultText(content);
    const raw=nativeValue??parseResult(call.resultText),value=raw?.data??raw;
    const exit=value?.exitCode??value?.exit_code;
    const explicitFailure=isError===true||Number.isInteger(exit)&&exit!==0||value?.success===false||value?.ok===false||
      ['failed','killed','cancelled','error'].includes(value?.status);
    call.outcome=explicitFailure?'failed':isError===false?'succeeded':'unknown';
    call.outputIncomplete=!!(value?.truncated||value?.partial||value?.outputPartial||value?.complete===false||
      /\.\.\. \(line truncated to \d+ chars\)$/mu.test(call.resultText));
    call.exitCode=Number.isInteger(exit)?exit:null;
    const readOnlyJava=call.name==='fastedit_java'&&['read','find','locate'].includes(call.arguments.mode??call.arguments.action);
    const effect=value?.effectState;
    if(WRITE.has(call.name)&&!readOnlyJava&&(call.outcome==='succeeded'||['applied','partial','unknown'].includes(effect))&&effect!=='none'){
    mutationEpoch++;changes.push({seq:call.resultSeq,callSeq:call.callSeq,path:fileOf(call.arguments),tool:call.name,
        status:effect??'native-operation-succeeded',currentState:'not-inferred'});
    }
    if(call.name==='run_code')opaqueEpoch++;
  }
  const nestedRoots=new Set(calls.filter(call=>call.nested&&call.rootCallId).map(call=>call.rootCallId));
  for(const call of calls){
    call.toolOutcome=call.outcome;call.processOutcome='unknown';
    if(call.resultSeq===null||!['pwsh','ops_bash','bash','run_code','work_exec','work_probe','verified_exec','job_output'].includes(call.name))continue;
    if(Number.isInteger(call.exitCode))call.processOutcome=call.exitCode===0?'exited-zero':'exited-nonzero';
    const completion=recordedProcessCompletion(events,{seq:call.resultSeq},throughSeq+1);
    if(!completion)continue;
    call.completionObservation=completion;
    if(call.exitCode!==null&&call.exitCode!==completion.exitCode){
      call.processOutcome='unknown';problems.push({seq:call.resultSeq,reason:'contradictory-process-exit-code',completionSeq:completion.seq});continue;
    }
    call.exitCode=completion.exitCode;call.processOutcome=completion.exitCode===0?'exited-zero':'exited-nonzero';
    if(call.outcome!=='failed')call.outcome=completion.exitCode===0?'succeeded':'failed';
  }
  for(const call of calls)if(call.nested){
    const root=callsById.get('root:'+call.rootCallId);
    call.enclosingResultSeq=root?.resultSeq??null;call.enclosingOutcome=root?.outcome??'unknown';
    call.deliveryVisibility='not-inferred-from-inner-return';
  }
  const leaf=calls.filter(call=>call.nested||!nestedRoots.has(call.id));
  return {events,requests,calls,leaf,changes,humans,problems,seqs,throughSeq,
    coverage:{originalEvents:true,modelTurns:requests.length,rootCalls:calls.filter(call=>!call.nested).length,nestedCalls:calls.filter(call=>call.nested).length,
      opaquePrograms:calls.filter(call=>call.name==='run_code').length,fileState:'successful recorded file operations only; external and arbitrary program effects remain unobserved'}};
}

function checkedJudgmentReviews(input,normal,sourceId,throughSeq,sourceCurrent,sourceProblems){
  if(input===undefined)return {status:'not-reviewed',items:[],authority:'reviewer-judgment',
    meaning:'Literal quote matching confirms only recorded source text, not semantic correctness or current disk applicability.'};
  if(!Array.isArray(input)||input.length>1000)throw Error('judgmentReviews must be an array of at most 1000 entries');
  const bySeq=new Map(normal.events.map(event=>[event.seq,event])),humans=new Set(normal.humans.map(row=>row.seq)),ids=new Set();
  const address=seq=>sourceId+'#event:'+seq;
  const textOf=event=>{
    const message=messageOf(event);
    return ['tool/ptc-dispatch','tool/code-dispatch'].includes(event?.type)?resultText(event.data?.content):resultText(message?.content);
  };
  const reference=(event,seq,quote,roles)=>{
    const type=event?.type??null,message=messageOf(event),human=event?.type==='user/message'&&isUserRequestMessage(message);
    const roleAccepted=roles==='claim'?type==='assistant/message':roles==='replacement'?type==='assistant/message':
      ['tool/result','tool/ptc-dispatch','tool/code-dispatch'].includes(type)||human;
    const quoteMatched=event?.surfaceOp?.op!=='replace'&&typeof quote==='string'&&quote.trim().length>0&&roleAccepted&&textOf(event).includes(quote);
    return {seq,eventType:type,roleAccepted,quoteMatched,quoteChars:typeof quote==='string'?quote.length:0,source:address(seq)};
  };
  const items=input.map((row,index)=>{
    if(!row||typeof row.id!=='string'||!row.id.trim()||row.id.length>128||ids.has(row.id)||
      !['challenged','superseded','unknown'].includes(row.declaredStatus)||!Array.isArray(row.requirementSeqs)||!row.requirementSeqs.length||
      !integer(row.claimSeq)||!integer(row.counterSeq)||row.requirementSeqs.some(seq=>!humans.has(seq)||seq>=row.claimSeq)||
      !bySeq.has(row.claimSeq)||!bySeq.has(row.counterSeq)||row.claimSeq>throughSeq||row.counterSeq>throughSeq||
      !Array.isArray(row.scopePaths)||row.scopePaths.length>64||row.scopePaths.some(file=>typeof file!=='string'||!file.trim()||file.length>2048)||
      typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>2048||
      ['claimQuote','counterQuote','replacementQuote'].some(key=>typeof row[key]==='string'&&row[key].length>8000))throw Error('Invalid judgment review at index '+index);
    ids.add(row.id);
    const hasReplacement=row.replacementSeq!==undefined;
    if(hasReplacement&&(!integer(row.replacementSeq)||!bySeq.has(row.replacementSeq)||row.replacementSeq>throughSeq))
      throw Error('Invalid judgment review replacement at index '+index);
    if(row.replacementQuote!==undefined&&!hasReplacement)throw Error('Invalid judgment review replacement at index '+index);
    const claim=reference(bySeq.get(row.claimSeq),row.claimSeq,row.claimQuote,'claim');
    const counter=reference(bySeq.get(row.counterSeq),row.counterSeq,row.counterQuote,'counter');
    const replacement=hasReplacement?reference(bySeq.get(row.replacementSeq),row.replacementSeq,row.replacementQuote,'replacement'):null;
    const reasons=[];
    if(!sourceCurrent)reasons.push('events-after-review');
    if(sourceProblems.length)reasons.push('incomplete-source');
    if(!claim.roleAccepted)reasons.push('claim-not-assistant-text');
    if(!claim.quoteMatched)reasons.push('claim-quote-not-matched');
    if(!counter.roleAccepted)reasons.push('counter-not-tool-or-human-text');
    if(!counter.quoteMatched)reasons.push('counter-quote-not-matched');
    if(row.claimSeq>=row.counterSeq)reasons.push('claim-counter-order-invalid');
    if(row.declaredStatus==='superseded'&&!replacement)reasons.push('replacement-required');
    if(replacement){
      if(!replacement.roleAccepted)reasons.push('replacement-not-assistant-text');
      if(!replacement.quoteMatched)reasons.push('replacement-quote-not-matched');
      if(row.counterSeq>=row.replacementSeq)reasons.push('counter-replacement-order-invalid');
    }
    const counterHuman=isUserRequestMessage(messageOf(bySeq.get(row.counterSeq)));
    const unrelatedRequest=normal.humans.some(human=>human.seq>row.claimSeq&&human.seq<=throughSeq&&
      !(counterHuman&&human.seq===row.counterSeq));
    if(unrelatedRequest)reasons.push('later-human-request');
    const scopes=row.scopePaths.map(file=>normalizeFile(file));
    const lastEvidence=replacement?.seq??counter.seq;
    if(scopes.length){
      for(const change of normal.changes){
        if(change.seq<=lastEvidence)continue;
        const changed=normalizeFile(change.path);
        if(!changed){reasons.push('file-scope-unresolved');break;}
        const comparable=scopes.some(scope=>scope.value===changed.value);
        if(comparable){reasons.push('file-changed-after-evidence');break;}
        if(scopes.some(scope=>scope.absolute!==changed.absolute)){reasons.push('file-scope-unresolved');break;}
      }
      const opaque=normal.calls.some(call=>call.callSeq<=throughSeq&&(call.resultSeq===null||call.resultSeq>lastEvidence)&&
        OPAQUE.has(call.name));
      if(opaque)reasons.push('opaque-execution-after-evidence');
      for(const call of normal.calls){
        if(call.callSeq>throughSeq||call.resultSeq!==null||!WRITE.has(call.name))continue;
        const changed=normalizeFile(fileOf(call.arguments));
        if(!changed){reasons.push('file-scope-unresolved');break;}
        if(scopes.some(scope=>scope.value===changed.value)){reasons.push('unsettled-mutation');break;}
        if(scopes.some(scope=>scope.absolute!==changed.absolute)){reasons.push('file-scope-unresolved');break;}
      }
    }
    const status=!reasons.length?row.declaredStatus:'unknown';
    return {id:row.id,declaredStatus:row.declaredStatus,status,requirementSeqs:[...new Set(row.requirementSeqs)],
      claim,counter,...(replacement?{replacement}:{}),scopePaths:row.scopePaths.map(file=>normalizeFile(file).value),
      ...(reasons.length?{reasons:[...new Set(reasons)]}:{}),reason:row.reason,authority:'reviewer-judgment',currentApplicability:'historical-events-only'};
  });
  return {status:'reviewed',items,authority:'reviewer-judgment',currentApplicability:'historical-events-only',
    meaning:'Literal quote matching confirms only recorded source text, not semantic correctness or current disk applicability.'};
}

function auditedUsage(input,normalized,pricing,requestAccounting){
  const recorded=Array.isArray(input?.requests)?input.requests:null;
  if(recorded&&requestAccounting)throw Error('Saved request lists and an observation ledger are alternative accounting sources.');
  const entries=recorded??[...normalized.requests.map(request=>({...request,purpose:'main',consumptionComplete:!request.consumptionUnknown,finish:{kind:request.finishReason}})),
    ...(requestAccounting?.requests??[]).map(request=>({...request,purpose:request.requestKind,consumptionComplete:request.complete,finish:{kind:request.finishReason}}))];
  const rows=entries.map((request,index)=>{
    const canonical=canonicalUsage(request.usage),finish=request.finish?.kind??request.finishReason;
    const rejectedFields=Object.entries(request.usageSources??{}).filter(([,source])=>source==='invalid-adapter-value').map(([field])=>field);
    for(const field of rejectedFields)if(Object.hasOwn(canonical.usage,field))canonical.usage[field]=null;
    const failedZero=canonical.complete&&canonical.usage.totalTokens===0&&!['stop','tool-calls','max-tokens','length'].includes(finish);
    // Exported observation rows already rejected invalid counters or an unsettled stream.
    // Re-reading their normalized nulls must not turn the original unknown into a proven zero.
    const sourceUnknown=request.consumptionComplete===false||request.usageComplete===false||request.usageConsistent===false||
      request.unknownConsumption===true||rejectedFields.length>0;
    const complete=!sourceUnknown&&canonical.complete&&!failedZero;
    const route=routeOf(request.route??request),price=pricing.find(row=>row.provider===route.provider&&row.model===route.model);
    return {index,sourceSeq:request.sourceSeq??null,purpose:request.purpose??'main',route,usage:canonical.usage,complete,
      ...(sourceUnknown?{incompleteReason:'source-record-consumption-unknown'}:{}),
      referenceCost:complete&&price?{amount:usageCost(canonical.usage,price),currency:price.currency??'unspecified',basis:'supplied-reference-price'}:null};
  });
  const knownTokens=rows.reduce((sum,row)=>sum+(row.complete?row.usage.totalTokens:0),0),unknownRequests=rows.filter(row=>!row.complete).length;
  const currencies=[...new Set(rows.map(row=>row.referenceCost?.currency).filter(Boolean))];
  const byCurrency=Object.fromEntries(currencies.map(currency=>[currency,rows.filter(row=>row.referenceCost?.currency===currency).reduce((sum,row)=>sum+(row.referenceCost.amount??0),0)]));
  const coverageComplete=!requestAccounting||requestAccounting.complete;
  return {source:recorded?'saved-request-records':requestAccounting?'native-plus-observed-nonmain':'native-recorded-attempts',requests:rows,knownTokens,unknownRequests,
    totalTokens:rows.length&&!unknownRequests&&coverageComplete?knownTokens:null,
    knownReferenceCostByCurrency:byCurrency,costComplete:coverageComplete&&rows.length>0&&rows.every(row=>row.complete&&row.referenceCost?.amount!=null),
    auxiliaryCoverage:recorded?'purposes present in saved request list; completeness requires recorder provenance':requestAccounting?
      requestAccounting.status:'native agent attempts only; auxiliary consumption not established'};
}

function checkedAnnotations(input,seqs,requestSeqs){
  if(!Array.isArray(input)||input.length>10000)throw Error('annotations must be an array of at most 10000 entries');
  return input.map((row,index)=>{
    if(!row||typeof row.reason!=='string'||!row.reason.trim()||!Array.isArray(row.eventSeqs)||!row.eventSeqs.length||
      row.eventSeqs.some(seq=>!seqs.has(seq))||!Array.isArray(row.labels)||!row.labels.length||row.labels.some(label=>!AUDIT_LABELS.includes(label))||
      !['candidate','confirmed-issue','confirmed-waste','rejected','unknown'].includes(row.classification)||
      row.requestSeqs!==undefined&&(!Array.isArray(row.requestSeqs)||row.requestSeqs.some(seq=>!requestSeqs.has(seq))))throw Error('Invalid annotation or unavailable source event at index '+index);
    if(row.classification!=='candidate'&&(typeof row.reviewer!=='string'||!row.reviewer.trim()||typeof row.counterexample!=='string'||!row.counterexample.trim()))throw Error('Reviewed annotations require reviewer and counterexample at index '+index);
    return {...row,id:row.id??'annotation-'+index,source:'explicit-audit-annotation'};
  });
}

function checkedAssessment(input,normal,sourceId){
  if(input===null)return null;
  const sameSource=typeof input?.sourceId==='string'&&typeof sourceId==='string'&&
    (input.sourceId===sourceId||path.isAbsolute(input.sourceId)&&path.isAbsolute(sourceId)&&path.resolve(input.sourceId)===path.resolve(sourceId));
  if(!input||input.schema!==ASSESSMENT_SCHEMA||!sameSource||typeof input.reviewer!=='string'||!input.reviewer.trim()||
    !integer(input.throughSeq)||!normal.seqs.has(input.throughSeq)||
    typeof input.allExplicitRequirementsCovered!=='boolean'||!Array.isArray(input.criteria)||!input.criteria.length||input.criteria.length>10000)
    throw Error('Assessment requires the matching sourceId, throughSeq, schema, reviewer, explicit coverage and criteria.');
  const sourceCurrent=input.throughSeq===normal.throughSeq;
  const humans=new Set(normal.humans.map(row=>row.seq)),covered=new Set(),ids=new Set();
  const evidenceSeqs=(value,label)=>{
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.some(seq=>!normal.seqs.has(seq)||seq>input.throughSeq))throw Error('Unavailable assessment event in '+label);
    return [...new Set(value)];
  };
  const criteria=input.criteria.map((row,index)=>{
    const declarations=['description','reason','counterexample'];
    if(!row||typeof row.id!=='string'||!row.id.trim()||row.id.length>128||ids.has(row.id)||
      !['pass','fail','unknown'].includes(row.outcome)||!Array.isArray(row.requirementSeqs)||!row.requirementSeqs.length||
      row.requirementSeqs.some(seq=>!humans.has(seq))||
      declarations.some(key=>row[key]!==undefined&&(typeof row[key]!=='string'||!row[key].trim()||row[key].length>2048)))
      throw Error('Invalid assessment criterion or human requirement at index '+index);
    ids.add(row.id);for(const seq of row.requirementSeqs)covered.add(seq);
    const seqs=evidenceSeqs(row.eventSeqs,'criterion '+row.id),outcome=sourceCurrent&&seqs.length?row.outcome:'unknown';
    const artifactRefs=row.artifactRefs??[];
    if(!Array.isArray(artifactRefs)||artifactRefs.length>64||artifactRefs.some(file=>typeof file!=='string'||file.length>2048||!path.isAbsolute(file)))
      throw Error('Assessment artifactRefs must be absolute local file references.');
    return {id:row.id,requirementSeqs:[...new Set(row.requirementSeqs)],declaredOutcome:row.outcome,outcome,eventSeqs:seqs,
      evidence:seqs.map(seq=>sourceId+'#event:'+seq),artifactRefs:[...new Set(artifactRefs)],
      ...Object.fromEntries(declarations.filter(key=>row[key]!==undefined).map(key=>['declared'+key[0].toUpperCase()+key.slice(1),row[key]])),
      ...(outcome!==row.outcome?{reason:sourceCurrent?'missing-outcome-evidence':'events-after-review'}:{})};
  });
  const raw=input.consumption,consumption={complete:false,scope:'unknown',eventSeqs:[]};
  if(raw!==undefined){
    if(!raw||typeof raw.complete!=='boolean'||!['all-task-requests','recorded-native-attempts','unknown'].includes(raw.scope))
      throw Error('Assessment consumption requires explicit completeness and scope.');
    consumption.eventSeqs=evidenceSeqs(raw.eventSeqs,'consumption');consumption.scope=raw.scope;
    if(raw.complete&&(raw.scope!=='all-task-requests'||!consumption.eventSeqs.length))
      throw Error('Complete consumption review requires all-task-requests and source events.');
    consumption.complete=raw.complete&&sourceCurrent;
  }
  const unassessedRequirementSeqs=[...humans].filter(seq=>!covered.has(seq));
  return {schema:ASSESSMENT_SCHEMA,sourceId,throughSeq:input.throughSeq,currentThroughSeq:normal.throughSeq,sourceCurrent,
    reviewer:input.reviewer.trim(),judgmentSource:'explicit-source-linked-review',
    declaredAllExplicitRequirementsCovered:input.allExplicitRequirementsCovered,
    allExplicitRequirementsCovered:sourceCurrent&&input.allExplicitRequirementsCovered&&unassessedRequirementSeqs.length===0,
    unassessedRequirementSeqs,criteria,consumption};
}

function reviewedCheckCoverage(input,review,normal,sourceId,sourceProblems){
  const declarations=input?.checks??[];
  if(!Array.isArray(declarations)||declarations.length>1000)throw Error('Assessment checks must be an array of at most 1000 recorded operations.');
  const criteria=new Map((review?.criteria??[]).map(row=>[row.id,row])),ids=new Set(),operationKeys=new Set(),operations=new Map();
  for(const call of normal.calls){
    const key=call.callSeq+':'+call.resultSeq;
    if(!operations.has(key))operations.set(key,[]);
    operations.get(key).push(call);
  }
  let relationCount=0;
  const checks=declarations.map((row,index)=>{
    if(!row||typeof row.id!=='string'||!row.id.trim()||row.id.length>128||ids.has(row.id)||
      !integer(row.callSeq)||!integer(row.resultSeq)||row.resultSeq<row.callSeq||row.resultSeq>review.throughSeq||
      !Array.isArray(row.coverage)||!row.coverage.length||row.coverage.length>1000)
      throw Error('Invalid source-linked check at index '+index);
    ids.add(row.id);
    const operationKey=row.callSeq+':'+row.resultSeq;
    if(operationKeys.has(operationKey))throw Error('A recorded check operation cannot be counted twice.');
    operationKeys.add(operationKey);
    const matches=operations.get(operationKey)??[];
    if(matches.length!==1)throw Error('Check must identify one recorded call and its exact result at index '+index);
    const call=matches[0],linked=new Set();
    const unavailable=!review.sourceCurrent?'events-after-review':sourceProblems.length?'incomplete-source':
      call.outcome==='unknown'?'execution-outcome-unknown':call.outputIncomplete?'incomplete-check-result':null;
    const coverage=row.coverage.map(item=>{
      if(++relationCount>10000||!item||!criteria.has(item.criterionId)||linked.has(item.criterionId)||
        !['addresses','misses','unknown'].includes(item.reach)||typeof item.reason!=='string'||!item.reason.trim()||item.reason.length>2048||
        item.scopePaths!==undefined&&(!Array.isArray(item.scopePaths)||item.scopePaths.length>64||
          item.scopePaths.some(file=>typeof file!=='string'||!file.trim()||file.length>2048)))
        throw Error('Invalid check coverage relation in '+row.id);
      linked.add(item.criterionId);
      const criterion=criteria.get(item.criterionId),reason=unavailable??
        (criterion.requirementSeqs.some(seq=>seq>=call.callSeq)?'check-before-linked-requirement':null);
      const fileReasons=[],scopes=item.scopePaths?.map(file=>normalizeFile(file))??null;
      if(item.scopePaths!==undefined){
        if(!scopes.length)fileReasons.push('file-scope-unresolved');
        else for(const change of normal.changes){
          if(change.seq<=row.resultSeq||change.seq>review.throughSeq)continue;
          const changed=normalizeFile(change.path);
          if(!changed){fileReasons.push('file-scope-unresolved');break;}
          if(scopes.some(scope=>scope.value===changed.value)){fileReasons.push('file-changed-after-check');break;}
          if(scopes.some(scope=>scope.absolute!==changed.absolute)){fileReasons.push('file-scope-unresolved');break;}
        }
        const opaque=normal.calls.some(other=>other.callSeq<=review.throughSeq&&OPAQUE.has(other.name)&&
          (other.resultSeq===null?other.callSeq>row.resultSeq:other.resultSeq>row.resultSeq));
        if(opaque)fileReasons.push('opaque-execution-after-check');
        for(const pending of normal.calls){
          if(pending.resultSeq!==null||pending.callSeq<=row.resultSeq||pending.callSeq>review.throughSeq||!WRITE.has(pending.name))continue;
          const changed=normalizeFile(fileOf(pending.arguments));
          if(!changed){fileReasons.push('file-scope-unresolved');break;}
          if(scopes?.some(scope=>scope.value===changed.value)){fileReasons.push('unsettled-mutation');break;}
          if(scopes?.some(scope=>scope.absolute!==changed.absolute)){fileReasons.push('file-scope-unresolved');break;}
        }
      }
      const reasons=[...new Set([reason,...fileReasons].filter(Boolean))],effectiveReason=reasons[0]??null;
      return {criterionId:item.criterionId,declaredReach:item.reach,reach:effectiveReason?'unknown':item.reach,reason:item.reason,
        ...(scopes?{scopePaths:scopes.map(scope=>scope.value)}:{}),
        ...(effectiveReason?{unavailableReason:effectiveReason,unavailableReasons:reasons}:{})};
    });
    return {id:row.id,callSeq:row.callSeq,resultSeq:row.resultSeq,tool:call.name,callId:call.id,nested:call.nested,rootCallId:call.rootCallId,
      evidence:[sourceId+'#event:'+row.callSeq,sourceId+'#event:'+row.resultSeq],toolOutcome:call.toolOutcome,processOutcome:call.processOutcome,
      exitCode:call.exitCode,outputIncomplete:call.outputIncomplete,requestSeq:call.requestSeq,
      ...(call.completionObservation?{completionObservation:call.completionObservation}:{}),
      ...(call.nested?{deliveryVisibility:call.deliveryVisibility,enclosingOutcome:call.enclosingOutcome}:{}),coverage};
  });
  const relations=new Map([...criteria.keys()].map(id=>[id,[]]));
  for(const check of checks)for(const relation of check.coverage)relations.get(relation.criterionId).push({...relation,checkId:check.id});
  const rows=[...criteria.values()].map(criterion=>{
    const linked=relations.get(criterion.id),addresses=linked.filter(row=>row.reach==='addresses').map(row=>row.checkId),
      misses=linked.filter(row=>row.reach==='misses').map(row=>row.checkId),unknown=linked.filter(row=>row.reach==='unknown').map(row=>row.checkId);
    return {criterionId:criterion.id,requirementSeqs:criterion.requirementSeqs,outcome:criterion.outcome,
      coverage:addresses.length?'addresses':misses.length&&!unknown.length?'misses':'unknown',addresses,misses,unknown};
  });
  const addressed=rows.filter(row=>row.coverage==='addresses').length,missed=rows.filter(row=>row.coverage==='misses').length;
  return {basis:'explicit-source-linked-check-review',status:!checks.length?'not-reviewed':!review.sourceCurrent?'stale':sourceProblems.length?'incomplete-source':'reviewed',
    checks,criteria:rows,listedCriteria:rows.length,addressedCriteria:addressed,missedCriteria:missed,unknownCriteria:rows.length-addressed-missed,
    allListedCriteriaAddressed:rows.length>0&&addressed===rows.length,
    meaning:'Coverage is the reviewer\'s scoped risk judgment, independent of execution success and task outcome. Unlisted requirements, model visibility and savings are not inferred.'};
}

function constraintObservations(normal){
  const items=[];
  for(const human of normal.humans){
    const event=normal.events.find(row=>row.seq===human.seq),message=messageOf(event);
    const requirement=resultText(message?.content);
    if(!/(?:不得|不要|禁止|不)[^。；\n]{0,40}读取项目外文件/u.test(requirement))continue;
    for(const call of normal.calls){
      if(call.callSeq<human.seq||call.name!=='work_exec'||typeof call.arguments?.code!=='string')continue;
      if(normal.humans.some(next=>next.seq>human.seq&&next.seq<=call.callSeq))continue;
      const code=call.arguments.code;
      if(!/tempfile\.(?:mkdtemp|mkstemp|TemporaryDirectory)\b/u.test(code)||!/\bopen\s*\(/u.test(code))continue;
      const text=call.resultText??'',match=/[A-Za-z]:(?:\\|\/)[^\r\n"']*?AppData(?:\\|\/)+Local(?:\\|\/)+Temp(?:\\|\/)+[^\r\n"']+/u.exec(text);
      const location=match?.[0].replace(/\\r\\n.*$/su,'')
        .replace(/\\[rn](?=$|[^A-Za-z0-9_.\\/-]).*$/su,'').split(/\s+(?=[A-Za-z_][\w.-]*\s*[=:])/u)[0]
        .replace(/\b(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization|credential)\s*[=:]\s*\S+/giu,'[redacted]')
        .replace(/[,\]}].*$/su,'');
      const evidence=location?.length>240?location.slice(0,120)+'…'+location.slice(-117):location;
      items.push({kind:'outside-workspace-temporary-file-read-candidate',requirementSeqs:[human.seq],callSeq:call.callSeq,resultSeq:call.resultSeq,
        evidence:evidence??'work_exec source uses a system temporary-directory API and open()',classification:'candidate',violation:'not-inferred',
        reason:'The original request explicitly forbids reading files outside the project. The recorded script uses a system temporary-directory API and open(). A system Temp path is also visible in the result when present.',
        counterexample:'The path may only be printed or used for an unrelated operation. Review the original call and result before treating this as a confirmed violation.'});
    }
  }
  return {items,status:items.length?'candidates':'no-matching-candidates',automaticCoverage:'Explicit no-outside-file-reading requirement plus work_exec tempfile/open source; a system Temp result path is retained when present but is not required',
    meaning:'Candidates only. No command is blocked and no task outcome, complete coverage, model visibility or savings is inferred.'};
}

function checkedChangeScopeReviews(input,normal,sourceId,sourceProblems){
  const declarations=input?.scopeReviews;
  if(declarations===undefined)return {status:'not-reviewed',items:[],coverage:'declared-reviews-only',
    meaning:'No change-scope review was supplied. Recorded changes are not complete file-effect coverage.'};
  if(!Array.isArray(declarations)||declarations.length>1000)throw Error('Assessment scopeReviews must be an array of at most 1000 recorded file changes.');
  const humans=new Set(normal.humans.map(row=>row.seq)),operations=new Map(),ids=new Set(),changeKeys=new Set();
  for(const call of normal.calls){
    const key=call.callSeq+':'+call.resultSeq;
    if(!operations.has(key))operations.set(key,[]);
    operations.get(key).push(call);
  }
  const samePath=(left,right)=>left&&right&&left.absolute===right.absolute&&left.value===right.value;
  const matchedChanges=new Set();
  const items=declarations.map((row,index)=>{
    if(!row||typeof row.id!=='string'||!row.id.trim()||row.id.length>128||ids.has(row.id)||
      !integer(row.callSeq)||!integer(row.resultSeq)||row.resultSeq<row.callSeq||row.resultSeq>input.throughSeq||
      !normal.seqs.has(row.callSeq)||!normal.seqs.has(row.resultSeq)||
      !['direct-requirement','necessary-dependency','unsupported','unknown'].includes(row.declaredRelation)||
      !Array.isArray(row.requirementSeqs)||row.declaredRelation==='direct-requirement'&&!row.requirementSeqs.length||
      row.requirementSeqs.some(seq=>!humans.has(seq)||seq>=row.callSeq)||
      !Array.isArray(row.dependencyEvidenceSeqs)||row.dependencyEvidenceSeqs.some(seq=>!normal.seqs.has(seq)||seq>=row.callSeq)||
      typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>2048||
      typeof row.counterexample!=='string'||!row.counterexample.trim()||row.counterexample.length>2048||
      typeof row.reviewer!=='string'||!row.reviewer.trim())throw Error('Invalid change-scope review at index '+index);
    ids.add(row.id);
    const requestedPath=normalizeFile(row.path),changeKey=row.callSeq+':'+row.resultSeq+':'+requestedPath?.value;
    if(changeKeys.has(changeKey))throw Error('A recorded file change cannot be reviewed twice.');
    changeKeys.add(changeKey);
    const matches=operations.get(row.callSeq+':'+row.resultSeq)??[];
    if(matches.length!==1)throw Error('Change-scope review must identify one recorded call and its exact result at index '+index);
    const call=matches[0],reasons=[],callPath=normalizeFile(fileOf(call.arguments));
    if(sourceId===null||!normal.seqs.has(input.throughSeq))throw Error('Change-scope review requires the matching source snapshot.');
    if(sourceProblems.length)reasons.push('incomplete-source');
    if(OPAQUE.has(call.name))reasons.push('program-internal-file-effect-unobserved');
    if(!WRITE.has(call.name)||OPAQUE.has(call.name))reasons.push('not-a-recorded-file-mutation-operation');
    if(call.outcome==='failed'&&!['partial','unknown'].includes(normal.changes.find(change=>change.callSeq===row.callSeq&&change.seq===row.resultSeq)?.status))
      reasons.push('operation-failed');
    if(call.outcome==='unknown')reasons.push('operation-outcome-unknown');
    if(call.outputIncomplete)reasons.push('incomplete-operation-result');
    if(!requestedPath||!callPath||!samePath(requestedPath,callPath))reasons.push('file-path-unresolved');
    const changes=normal.changes.filter(change=>change.callSeq===row.callSeq&&change.seq===row.resultSeq);
    if(!changes.length)reasons.push('no-recorded-file-effect');
    if(changes.length>1)reasons.push('file-effect-not-unique');
    const change=changes[0],changePath=normalizeFile(change?.path);
    if(!changePath||!requestedPath||!samePath(requestedPath,changePath))reasons.push('file-path-unresolved');
    const recordMatched=changes.length===1&&requestedPath&&changePath&&samePath(requestedPath,changePath)&&
      !OPAQUE.has(call.name)&&['native-operation-succeeded','applied'].includes(change.status);
    if(recordMatched)matchedChanges.add(change);
    if(['partial','unknown'].includes(change?.status))reasons.push(change.status+'-file-effect');
    if(change&&!['native-operation-succeeded','applied','partial','unknown'].includes(change.status))reasons.push('file-effect-unconfirmed');
    if(row.declaredRelation==='direct-requirement'&&!row.requirementSeqs.length)reasons.push('direct-requirement-source-missing');
    if(row.declaredRelation==='necessary-dependency'&&!row.dependencyEvidenceSeqs.length)reasons.push('dependency-evidence-missing');
    if(row.declaredRelation==='unsupported'&&(row.requirementSeqs.length||row.dependencyEvidenceSeqs.length))reasons.push('conflicting-support-basis');
    const currentReasons=[];
    for(const later of normal.changes){
      if(later.seq<=row.resultSeq)continue;
      const laterPath=normalizeFile(later.path);
      if(!laterPath||!requestedPath||laterPath.absolute!==requestedPath.absolute)currentReasons.push('later-file-scope-unresolved');
      else if(samePath(laterPath,requestedPath))currentReasons.push('file-changed-after-review');
    }
    for(const later of normal.calls){
      if(later.resultSeq===null&&later.callSeq>row.resultSeq&&WRITE.has(later.name)){
        const laterPath=normalizeFile(fileOf(later.arguments));
        if(!laterPath||!requestedPath||laterPath.absolute!==requestedPath.absolute||samePath(laterPath,requestedPath))currentReasons.push('unsettled-mutation');
      }
      if(later.resultSeq>row.resultSeq&&OPAQUE.has(later.name))currentReasons.push('opaque-execution-after-review');
    }
    if(normal.humans.some(seq=>seq>row.resultSeq))currentReasons.push('later-human-request');
    return {id:row.id,callSeq:row.callSeq,resultSeq:row.resultSeq,path:requestedPath?.value??row.path,
      tool:call.name,callId:call.id,nested:call.nested,rootCallId:call.rootCallId,
      evidence:[sourceId+'#event:'+row.callSeq,sourceId+'#event:'+row.resultSeq],
      requirementSeqs:[...new Set(row.requirementSeqs)],dependencyEvidenceSeqs:[...new Set(row.dependencyEvidenceSeqs)],
      dependencyEvidence:row.dependencyEvidenceSeqs.map(seq=>sourceId+'#event:'+seq),
      reviewer:row.reviewer.trim(),reason:row.reason,counterexample:row.counterexample,
      declaredRelation:row.declaredRelation,relation:[...new Set(reasons)].length?'unknown':row.declaredRelation,
      effectStatus:change?.status??'unobserved',currentState:'not-inferred',
      currentApplicability:currentReasons.length?'unknown':'historical-events-only',
      ...(reasons.length?{unknownReasons:[...new Set(reasons)]}:{}),
      ...(currentReasons.length?{currentUnknownReasons:[...new Set(currentReasons)]}:{}),
      ...(call.nested?{enclosingResultSeq:call.enclosingResultSeq,enclosingOutcome:call.enclosingOutcome,
        deliveryVisibility:call.deliveryVisibility}:{}),
      authority:'reviewer-judgment',violation:'not-inferred'};
  });
  return {basis:'explicit-source-linked-change-review',status:!items.length?'not-reviewed':sourceProblems.length?'incomplete-source':input.throughSeq!==normal.throughSeq?'stale':'reviewed',items,
    coverage:'declared-reviews-only',recordedChangeCount:normal.changes.length,declaredReviewCount:items.length,
    matchedRecordedChanges:matchedChanges.size,
    unreviewedRecordedChanges:normal.changes.filter(change=>!matchedChanges.has(change)).length,
    allFileEffectsComplete:false,
    meaning:'Each relation is a historical reviewer judgment about one recorded operation. Unsupported means no supplied requirement or dependency basis, not a violation. Unreviewed changes, program-internal effects and external changes remain unobserved; current file state and task outcome are not inferred.'};
}

export function auditDshSession(input,{sourceId=null,annotations=[],pricing=[],problems=[],assessment=null,tokenBudget=null,requestAccounting=null}={}){
  const normal=normalizeDshEvents(input),candidates=[],seen=new Map(),failed=new Map();
  const add=(labels,call,prior,reason)=>candidates.push({id:'event-'+call.resultSeq+'-'+labels.join('-'),labels,classification:'candidate',
    eventSeqs:[prior.resultSeq,call.resultSeq],requestSeqs:[...new Set([prior.requestSeq,call.requestSeq].filter(integer))],reason,
    counterexample:'Repeated calls can answer a new question or confirm an external change. No avoidable cost is inferred.',
    fileValidity:call.opaqueEpoch===prior.opaqueEpoch?'no-intervening-opaque-program-observed':'arbitrary-program-or-external-effects-untracked',
    sameRecordedBody:call.resultText===prior.resultText,realizableSaving:null});
  for(const call of normal.leaf){
    if(call.resultSeq===null)continue;
    const key=stable([call.userSeq,call.name,call.arguments]),prior=seen.get(key);
    if(STATIC_RESULTS.has(call.name)&&prior&&call.outcome==='succeeded'&&prior.outcome==='succeeded'&&call.mutationEpoch===prior.mutationEpoch&&
      call.resultText===prior.resultText&&!call.outputIncomplete&&!prior.outputIncomplete)
      add(READ.has(call.name)?['W2','W5']:['W5'],call,prior,'identical-successful-call-and-recorded-text');
    seen.set(key,call);
    if(call.outcome==='failed'){
      const signature=call.resultText.split(/\r?\n/u).find(line=>line.trim())?.slice(0,240)??'';
      const failureKey=stable([call.userSeq,call.name,call.arguments,call.mutationEpoch,signature]),previous=failed.get(failureKey);
      if(previous)add(['W3','W8'],call,previous,'same-recorded-failure-and-arguments-without-observed-file-mutation');
      failed.set(failureKey,call);
    }
  }
  if(!Array.isArray(pricing))throw Error('pricing must be an array of explicit route prices');
  const reviewed=checkedAnnotations(annotations,normal.seqs,new Set(normal.requests.map(request=>request.sourceSeq))),byId=new Map(candidates.map(row=>[row.id,row]));
  for(const annotation of reviewed){
    const detection=byId.get(annotation.id);
    if(detection&&!detection.eventSeqs.every(seq=>annotation.eventSeqs.includes(seq)))throw Error('A candidate review must retain its original event addresses.');
    byId.set(annotation.id,{...detection,...annotation});
  }
  const all=[...byId.values()];
  const automaticScopes={
    W2:'identical successful static reads with the same user request, tool, arguments, mutation epoch and complete recorded result text',
    W5:'identical successful static results with the same user request, tool, arguments, mutation epoch and complete recorded result text',
    W3:'repeated failures with the same user request, tool, arguments, mutation epoch and first non-empty result line',
    W8:'repeated failures with the same user request, tool, arguments, mutation epoch and first non-empty result line'
  };
  const labelCoverage=Object.fromEntries(AUDIT_LABELS.map(label=>[label,{
    automatic:automaticScopes[label]??'none',
    automaticCandidates:candidates.filter(row=>row.labels.includes(label)).length,
    explicitAnnotations:reviewed.filter(row=>row.labels.includes(label)).length,
    reviewedAnnotations:reviewed.filter(row=>row.labels.includes(label)&&row.classification!=='candidate').length,
    manualCoverage:'unknown; no source-bound coverage declaration is available',
    zeroMeaning:'A zero count means no matching merged record, not zero occurrences. Unreviewed or unobserved occurrences remain unknown.',
    associatedTokens:'not-savings'
  }]));
  const requestsBySeq=new Map(normal.requests.map(request=>[request.sourceSeq,request]));
  const associated=new Set(all.filter(row=>row.classification!=='rejected').flatMap(row=>row.requestSeqs??[]));
  const associatedRows=[...associated].map(seq=>requestsBySeq.get(seq)).filter(Boolean);
  const routes=[...new Map(normal.requests.map(row=>[stable(row.route),row.route])).values()].filter(Boolean);
  const declaredFlash1017=normal.requests.every(request=>{
    const route=request.route;
    return typeof route?.provider==='string'&&route.provider.trim()&&typeof route?.model==='string'&&
      route.model.split('/').at(-1).toLowerCase()==='deepseek-v4.1-flash-1017';
  });
  const missingRouteSeqs=normal.requests.filter(request=>!request.route||typeof request.route.provider!=='string'||!request.route.provider.trim()||
    typeof request.route.model!=='string'||!request.route.model.trim()).map(request=>request.sourceSeq).filter(integer);
  const modelBuildCoverage={scope:'recorded-assistant-attempts',requests:normal.requests.length,
    missingRoutes:missingRouteSeqs.length,missingRouteSeqs:missingRouteSeqs.slice(0,32),
    missingRouteSeqsOmitted:Math.max(0,missingRouteSeqs.length-32),
    source:'native request/header route carried forward to the attempt; a missing header leaves the route unknown',
    meaning:'Route values are name declarations only and do not prove the provider’s actual model build.'};
  const eventBySeq=new Map(normal.events.map(event=>[event.seq,event]));
  const echoRows=normal.requests.map(request=>{
    const source=messageOf(eventBySeq.get(request.sourceSeq))?.source,replay=source?.replayState,response=replay?.response??replay;
    const reported=typeof response?.responseModel==='string'?response.responseModel.trim():'';
    const status=response?.kind==='deepseek-messages'?'unsupported-by-adapter':
      reported&&reported.length<=200&&!/[\x00-\x1f\x7f]/u.test(reported)?'reported':response?'not-reported':'unknown';
    return {seq:request.sourceSeq,status,...(status==='reported'?{responseModel:reported}:{})};
  });
  const reportedEchoes=echoRows.filter(row=>row.status==='reported');
  const echoValues=[...new Map(reportedEchoes.map(row=>[row.responseModel,row.responseModel])).values()];
  const responseModelEcho={scope:'same-recorded-assistant-attempt',requests:echoRows.length,
    counts:Object.fromEntries(['reported','not-reported','unsupported-by-adapter','unknown'].map(status=>[status,echoRows.filter(row=>row.status===status).length])),
    reported:reportedEchoes.slice(0,32),reportedOmitted:Math.max(0,reportedEchoes.length-32),
    reportedValues:echoValues.slice(0,16),reportedValuesOmitted:Math.max(0,echoValues.length-16),
    source:'assistant/message source.replayState.response.responseModel, with flat replayState accepted for older records; only scalar model names are read',
    meaning:'A reported value is a provider-declared response name that differed from the requested identity. Not reported can mean equal or unrecorded; adapter support varies. No value or name proves actual model weights.'};
  if(requestAccounting&&(requestAccounting.schema!=='work-evidence.session-request-accounting.v1'||
    requestAccounting.throughSeq!==normal.throughSeq||requestAccounting.nativeRequests!==normal.requests.length||
    input?.sessionId&&requestAccounting.sessionId!==input.sessionId))throw Error('Request accounting does not match this native source snapshot.');
  const sourceProblems=[...problems,...normal.problems],usage=auditedUsage(input,normal,pricing,requestAccounting),review=checkedAssessment(assessment,normal,sourceId);
  const verification=reviewedCheckCoverage(assessment,review,normal,sourceId,sourceProblems);
  const changeScopeReviews=checkedChangeScopeReviews(assessment,normal,sourceId,sourceProblems);
  const constraints=constraintObservations(normal);
  const cacheTransitions=auditCacheTransitions(normal.events,requestAccounting);
  const judgmentReviews=checkedJudgmentReviews(assessment?.judgmentReviews,normal,sourceId,assessment?.throughSeq,review?.sourceCurrent===true,sourceProblems);
  const taskOutcome=!review||sourceProblems.length?'unknown':review.criteria.some(row=>row.outcome==='fail')?'fail':
    review.allExplicitRequirementsCovered&&review.criteria.every(row=>row.outcome==='pass')?'pass':'unknown';
  const budgetResult=tokenBudget===null?null:fullSuccessAtBudget([{assessment:review,problems:sourceProblems,
    usage:{totalTokens:review?.consumption.complete?usage.totalTokens:null}}],{tokenBudget});
  return {schema:AUDIT_SCHEMA,sourceId,sessionId:input?.sessionId??input?.header?.id??null,sourceEventCount:normal.events.length,sourceThroughSeq:normal.throughSeq,
    routes,modelBuild:normal.requests.length&&declaredFlash1017?'declared-1017':'unconfirmed',modelBuildCoverage,responseModelEcho,
    coverage:normal.coverage,problems:sourceProblems,usage,
    events:{humanRequests:normal.humans,changes:normal.changes,toolCalls:normal.calls.map(({resultText,arguments:args,...call})=>({...call,
      path:fileOf(args),argumentChars:JSON.stringify(args).length,resultChars:resultText?.length??null})),
      compactions:normal.events.filter(event=>event.type==='compaction/summary').map(event=>({seq:event.seq}))},
    findings:all,detectionCounts:{automaticCandidates:candidates.length,reviewedAnnotations:reviewed.length,remainingCandidates:all.filter(row=>row.classification==='candidate').length,
      confirmedIssues:all.filter(row=>['confirmed-issue','confirmed-waste'].includes(row.classification)).length,confirmedWaste:all.filter(row=>row.classification==='confirmed-waste').length},
    labels:Object.fromEntries(AUDIT_LABELS.map(label=>[label,all.filter(row=>row.labels.includes(label)).length])),labelCoverage,
    associatedConsumption:{requestSeqs:[...associated],knownTokens:associatedRows.filter(row=>!row.consumptionUnknown).reduce((sum,row)=>sum+row.usage.totalTokens,0),
      unknownRequests:associatedRows.filter(row=>row.consumptionUnknown).length,realizableSaving:null,
      meaning:'Each associated request is counted once across W/Q labels. Association is not causal waste or possible savings.'},
    assessment:review,verification,changeScopeReviews,judgmentReviews,constraints,taskOutcome,fullSuccessAtBudget:budgetResult,requestAccounting,cacheTransitions,
    limitations:['Only recorded exact repetitions and failures are automatic candidates. W1/W4/W6/W7 and Q1–Q5 require source-based review.',
      'No candidate stops a model, skips a check, changes permissions, adds a prompt or calls a model.',
      'Task judgments and complete consumption coverage require explicit source-linked review. Semantic correctness, external file changes and actual billing are not inferred.']};
}

export function fullSuccessAtBudget(rows,{tokenBudget}={}){
  if(!integer(tokenBudget)||tokenBudget===0)throw Error('tokenBudget must be a positive safe integer');
  let success=0,failed=0,unknown=0;
  for(const row of rows){
    const assessment=row.assessment;
    if(typeof assessment?.allExplicitRequirementsCovered!=='boolean'||assessment.sourceCurrent===false||typeof assessment.reviewer!=='string'||!assessment.reviewer.trim()||!Array.isArray(assessment.criteria)||!assessment.criteria.length||row.problems?.length){unknown++;continue;}
    if(assessment.criteria.some(item=>!['pass','fail','unknown'].includes(item.outcome)||!Array.isArray(item.evidence)||
      item.outcome!=='unknown'&&!item.evidence.length||item.evidence.some(source=>typeof source!=='string'||!source.trim()))){unknown++;continue;}
    if(assessment.criteria.some(item=>item.outcome==='fail')){failed++;continue;}
    if(!assessment.allExplicitRequirementsCovered||assessment.criteria.some(item=>item.outcome!=='pass')||!integer(row.usage?.totalTokens)){unknown++;continue;}
    if(row.usage.totalTokens<=tokenBudget)success++;else failed++;
  }
  return {tokenBudget,tasks:rows.length,success,failed,unknown,rate:rows.length&&!unknown?success/rows.length:null,
    lowerBound:rows.length?success/rows.length:null,upperBound:rows.length?(success+unknown)/rows.length:null};
}
