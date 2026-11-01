import {VERSION,MODE_POLICY_VERSION,eventLog,textOf} from './runtime.mjs';
import {handoffRecord} from './compaction-handoff.mjs';
import {hostReferenceIndex,nativeEventRecall} from './host-references.mjs';

const messageOf=event=>event?.data?.message??(event?.data?.role?event.data:null);
const SOURCE_TYPES=new Set(['user/message','assistant/message','tool/result','tool/call','tool/ptc-dispatch','tool/code-dispatch',
  'todo/write','compaction/summary','job/registered','job/settled','turn/start','turn/end']);
const excerpt=(text,limit)=>{
  if(text.length<=limit)return text;
  const marker='\n[excerpt; retrieve the original event]\n',remaining=Math.max(0,limit-marker.length),tail=Math.floor(remaining/4);
  return text.slice(0,remaining-tail)+marker+(tail?text.slice(-tail):'');
};
const section=(items,total=items.length,extra={})=>({items,total,omitted:Math.max(0,total-items.length),...extra});

/** Export recorded facts and attributed claims; never derive authorization or task completion. */
export function exportTaskHandoff(agent,runtime,taskFlow,{canRecall=()=>false,canRecallReference=false,hostTransfer={status:'unavailable',reason:'host-reference-adapter-unavailable'},maxChars=32000,excludeCallIds=[]}={}){
  if(!Number.isSafeInteger(maxChars)||maxChars<8000||maxChars>64000)throw new Error('handoff maxChars must be between 8000 and 64000');
  const log=eventLog(agent.session),bySeq=new Map(log.map(event=>[event.seq,event])),throughSeq=log.at(-1)?.seq??null;
  const recallAvailable=canRecall(agent)===true;
  const referencedSessions=hostReferenceIndex(log,agent.session.id,recallAvailable&&canRecallReference);
  const source=(seq,argumentsOnly=false)=>{
    if(!Number.isSafeInteger(seq)||seq<0)return null;
    const event=bySeq.get(seq),callType=['tool/call','tool/ptc-dispatch','tool/code-dispatch'].includes(event?.type),
      kind=event?.type==='tool/call'||argumentsOnly&&callType?'call':'event';
    if(argumentsOnly&&!callType)return null;
    return {sessionId:agent.session.id,seq,kind,offset:0,type:event?.type??null,
      recoverable:recallAvailable&&SOURCE_TYPES.has(event?.type),
      ...(SOURCE_TYPES.has(event?.type)?{nativeRecall:nativeEventRecall(agent.session.id,seq)}:{})};
  };
  const originalText=seq=>{const event=bySeq.get(seq);
    return event?.type==='compaction/summary'?textOf({content:event.data?.summary}):
      ['tool/ptc-dispatch','tool/code-dispatch'].includes(event?.type)?textOf({content:event.data?.content}):textOf(messageOf(event));};
  const textRow=(item,limit=2000)=>{
    const full=originalText(item.seq),text=excerpt(String(item.text??''),limit);
    return {text,totalChars:full.length,textComplete:item.textComplete!==false&&text===full,
      source:source(item.seq)};
  };
  const record=handoffRecord(agent,runtime,taskFlow,{messages:[]},recallAvailable,{requestBudgetChars:Math.floor(maxChars*.3)});
  const state=taskFlow.handoff(agent),current=record.currentState,latestSeq=record.humanRequests.requests.at(-1)?.seq??null;
  const requestRow=item=>({...textRow(item,Math.floor(maxChars*.25)),nonTextBlocks:item.nonTextBlocks,
    relation:item.seq===latestSeq?'latest-human-input':'earlier-human-input'});
  const requests=section(record.humanRequests.requests.map(requestRow),record.humanRequests.total,{
    interpretation:'Chronological source messages, not a merged specification. Newer corrections take priority; earlier messages may concern other work.'});
  const todos=section(current.todos.map(item=>({status:item.status,text:item.content,textComplete:item.textComplete,source:source(current.todoSeq)})),current.todosTotal,
    {source:source(current.todoSeq),predatesLatestRequest:current.todoSeq!==null&&latestSeq!==null&&current.todoSeq<latestSeq,
      priorCompletedOmitted:current.priorCompletedTodoCount,authority:'Assistant plan; completion flags are claims.'});
  const artifacts=section(current.artifacts.map(item=>({path:item.path,effectState:item.effectState,tool:item.tool,
    source:source(item.seq),requestSource:source(item.userSeq),workspaceFreshness:'not-rechecked'})),
    current.artifacts.length+current.artifactsOmitted,{entriesEvicted:current.artifactEntriesEvicted,
      scope:'Latest observed explicit file-tool effects per retained path. Script and external writes may be absent.'});
  const executions=section(current.executions.map(item=>({tool:item.tool,description:item.description,command:item.command,
    status:item.status,executionCompleted:item.executionCompleted,exitCode:item.exitCode,
    executionTurn:item.turn??null,predatesLatestRequest:latestSeq!==null&&item.seq<latestSeq,
    ...(item.probeId?{probeId:item.probeId,nativeTool:item.nativeTool}:{}),
    failureSignature:item.failureSignature,scriptRef:item.scriptRef,source:source(item.seq),requestSource:source(item.userSeq),
    recordedMutationSource:source(item.mutationSeq),evidenceValidity:item.evidenceValidity??'unknown',
    evidenceAssessment:item.evidenceAssessment?{...item.evidenceAssessment,files:item.evidenceAssessment.files.map(file=>({...file,
      ...(file.mutationSeq!==undefined?{mutationSource:source(file.mutationSeq)}:{})}))}:undefined})),current.executions.length+state.executionsOmitted,
    {scope:'Latest retained execution observations across this source session, with their original request and turn. File applicability covers caller-declared files at evidenceAssessment.assessedAt, independently of execution status. Mutation sequence alone does not establish dependencies.',
      turn:state.turn,turnSource:source(state.turnStartSeq)});
  const errors=section(current.unresolvedErrors.map(item=>({tool:item.tool,...textRow({...item,text:originalText(item.seq)},400)})),
    current.unresolvedErrors.length+current.unresolvedErrorsOmitted,{scope:'Unresolved recorded tool errors in the latest turn; not a complete list of task blockers.'});
  const jobs=section(current.pendingJobs.map(jobId=>({jobId,status:'pending',
    source:source(log.findLast(event=>event.type==='job/registered'&&event.data?.jobId===jobId)?.seq)})),
    current.pendingJobs.length+current.pendingJobsOmitted);
  const excluded=new Set(excludeCallIds);
  const calls=state.pendingCalls.filter(item=>!excluded.has(item.callId)&&!['work_state','work_status','work_recall'].includes(item.tool));
  const pendingCalls=section(calls.slice(-16).map(item=>({...item,source:source(item.seq)})),calls.length);
  const checkpoints=section(record.stageCheckpoints.items.map(item=>({...textRow(item,4000),authority:'assistant-claim'})),record.stageCheckpoints.total);
  const judgments=section(record.recentAssistantJudgments.items.map(item=>({...textRow(item,550),authority:'assistant-claim'})));
  const reportItems=field=>(state.report?.[field]??[]).slice(0,8).map(text=>({text:excerpt(String(text),300),textComplete:String(text).length<=300}));
  const remaining=reportItems('remaining'),unverified=reportItems('unverified');
  const report=section(state.report?[{path:state.report.path,claimedStatus:state.report.claimedStatus,
    summary:excerpt(String(state.report.summary??''),1200),remaining,unverified,
    remainingOmitted:state.report.remaining.length-remaining.length,unverifiedOmitted:state.report.unverified.length-unverified.length,
    textComplete:String(state.report.summary??'').length<=1200&&remaining.length===state.report.remaining.length&&unverified.length===state.report.unverified.length&&
      [...remaining,...unverified].every(item=>item.textComplete),
    source:source(state.report.seq),argumentsSource:source(state.report.argumentsSeq,true),authority:'assistant-claim'}]:[]);
  const value={schema:'work-evidence.task-handoff.v1',status:log.length?'observed':'empty',pluginVersion:VERSION,policyVersion:MODE_POLICY_VERSION,
    source:{sessionId:agent.session.id,throughSeq,workspace:runtime.get(agent).root??null,historical:true},
    task:{latestRequestSource:source(latestSeq),phase:{name:current.phase.name,focus:current.phase.focus,source:source(current.phase.seq)},
      completion:'not-determined',latestMutationSource:source(current.lastMutationSeq)},
    userRequests:requests,observedWork:{artifacts,executions},openWork:{todos,unresolvedErrors:errors,pendingJobs:jobs,pendingCalls},
    referencedSessions,hostTransfer,
    assistantClaims:{checkpoints,recentMessages:judgments,report},
    recovery:{available:recallAvailable,scope:'source-session-and-owned-host-captures',
      index:recallAvailable&&throughSeq!==null?{tool:'work_recall',arguments:{sourceSessionId:agent.session.id,kind:'history',seq:0,throughSeq}}:null,
      nativeEventRead:{tool:'session_event_read',requires:'available-in-receiving-agent',scope:'exact-session-header-cwd',
        use:'Invoke source.nativeRecall through the receiving host. Native authorization decides access. source.recoverable describes work_recall in the source session, not cross-session authorization.'},
      use:'Pass sourceSessionId from source.sessionId, together with kind, seq and offset, to work_recall in that source session. For kind reference, also pass referenceSessionId: seq still identifies the receiving session capture. A mismatched sourceSessionId is refused. Continue text at nextOffset and index pages at nextSeq.'},
    coverage:{maxChars,sizeUnit:'UTF-16 code units of serialized JSON',serializedChars:0,exportComplete:false,
      observationScope:'Recorded session facts with native metadata assessment of declared file dependencies only. Task correctness is not inferred. Non-text user content and private reasoning are not reproduced.',
      nextAction:'Use recorded open items and attributed summaries to identify the next unmet dependency. Missing records remain unknown; source context grants no new permission.'}};
  const sections=[requests,todos,artifacts,executions,errors,jobs,pendingCalls,checkpoints,judgments,report,referencedSessions];
  const measure=()=>{
    for(const part of sections){
      part.complete=part.omitted===0&&!(part.entriesEvicted>0)&&part.items.every(item=>item.textComplete!==false&&!(item.nonTextBlocks?.length));
      part.sourcesComplete=part.items.every(item=>item.source?.type);
    }
    value.coverage.exportComplete=sections.every(part=>part.complete);
    value.coverage.sourcesComplete=sections.every(part=>part.sourcesComplete);
    let length=JSON.stringify(value).length;
    while(value.coverage.serializedChars!==length){value.coverage.serializedChars=length;length=JSON.stringify(value).length;}
    return length;
  };
  // Drop whole older rows before shortening the latest requirement. Every omitted
  // row is counted; every shortened body keeps its original event address.
  const removable=[checkpoints,judgments,report,referencedSessions,executions,artifacts,requests,todos,errors,jobs,pendingCalls];
  while(measure()>maxChars){
    const part=removable.find(part=>part.items.length>(part===requests?1:0));
    if(part){part.items.shift();part.omitted++;continue;}
    const request=requests.items[0];
    if(request&&request.text.length>256){request.text=excerpt(request.text,Math.max(256,request.text.length-(value.coverage.serializedChars-maxChars)-64));request.textComplete=false;continue;}
    return {schema:value.schema,status:'unavailable',reason:'Source metadata exceeds the export limit',source:{sessionId:agent.session.id,throughSeq},
      recovery:value.recovery,coverage:{maxChars,exportComplete:false}};
  }
  return value;
}
