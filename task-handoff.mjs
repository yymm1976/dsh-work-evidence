import {VERSION,MODE_POLICY_VERSION,eventLog,textOf} from './runtime.mjs';
import {handoffRecord} from './compaction-handoff.mjs';
import {hostReferenceIndex,nativeEventRecall,subagentResultIndex} from './host-references.mjs';
import {randomUUID} from 'node:crypto';

const messageOf=event=>event?.data?.message??(event?.data?.role?event.data:null);
const SOURCE_TYPES=new Set(['user/message','assistant/message','tool/result','tool/call','tool/ptc-dispatch','tool/code-dispatch',
  'todo/write','compaction/summary','job/registered','job/settled','turn/start','turn/end','subagent/catalog']);
const excerpt=(text,limit)=>{
  if(text.length<=limit)return text;
  const marker='\n[excerpt; retrieve the original event]\n',remaining=Math.max(0,limit-marker.length),tail=Math.floor(remaining/4);
  return text.slice(0,remaining-tail)+marker+(tail?text.slice(-tail):'');
};
const section=(items,total=items.length,extra={})=>({items,total,omitted:Math.max(0,total-items.length),...extra});

/** Export recorded facts and attributed claims; never derive authorization or task completion. */
export function exportTaskHandoff(agent,runtime,taskFlow,{canRecall=()=>false,canRecallReference=false,canSearchChildEvents=false,hostTransfer={status:'unavailable',reason:'host-reference-adapter-unavailable'},maxChars=32000,excludeCallIds=[],delivery}={}){
  if(!Number.isSafeInteger(maxChars)||maxChars<8000||maxChars>64000)throw new Error('handoff maxChars must be between 8000 and 64000');
  const log=eventLog(agent.session),bySeq=new Map(log.map(event=>[event.seq,event])),throughSeq=log.at(-1)?.seq??null;
  const recallAvailable=canRecall(agent)===true;
  const referencedSessions=hostReferenceIndex(log,agent.session.id,recallAvailable&&canRecallReference);
  const subagentResults=subagentResultIndex(log,agent.session.id,{recallAvailable,searchAvailable:canSearchChildEvents,
    inherited:agent.session.inheritedEventCount??(agent.session.header?.isSeeded?null:0)});
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
  const sourceReads=section((state.sourceReads??[]).map(({seq,callSeq,userSeq,...item})=>({...item,
    source:source(seq),argumentsSource:source(callSeq,true),requestSource:source(userSeq),
    predatesLatestRequest:latestSeq!==null&&seq<latestSeq})),(state.sourceReads?.length??0)+(state.sourceReadsOmitted??0),
    {scope:'Observed native event reads and local work_recall/work_state recall outcomes. Pages, index completion, complete-source return and captured-snapshot completeness are distinct. Tool return does not prove visibility or correct use by the model. Access is decided per call; source bodies are not copied.'});
  const jobs=section(current.pendingJobs.map(jobId=>({jobId,status:'pending',
    source:source(log.findLast(event=>event.type==='job/registered'&&event.data?.jobId===jobId)?.seq)})),
    current.pendingJobs.length+current.pendingJobsOmitted);
  const excluded=new Set(excludeCallIds);
  const names=new Map(log.filter(event=>event.type==='tool/call').map(event=>[event.data?.callId,{name:event.data?.name,seq:event.seq}]));
  const recentResults=log.filter(event=>event.type==='tool/result'&&(latestSeq===null||event.seq>latestSeq)).flatMap(event=>{
    const message=messageOf(event),callId=message?.source?.callId??message?.toolCallId,call=names.get(callId);
    if(excluded.has(callId)||['work_state','work_status','work_recall'].includes(call?.name))return [];
    const full=textOf(message);let parsed;
    try{parsed=JSON.parse(full);}catch{}
    if([parsed,parsed?.value,parsed?.result].some(value=>typeof value?.schema==='string'&&value.schema.startsWith('work-evidence.task-handoff')))return [];
    if(!full.trim())return [];
    return [{seq:event.seq,text:full,textComplete:!(message.content??[]).some(block=>block.type!=='text'),tool:call?.name??null,callSeq:call?.seq??null,isError:message.isError===true}];
  });
  const recentToolResults=section(recentResults.slice(-2).map(item=>({...textRow(item,2000),tool:item.tool,isError:item.isError,
    argumentsSource:source(item.callSeq,true)})),recentResults.length,
    {scope:'Latest two non-handoff tool text results after the latest direct user input. Excerpts are historical observations, not current workspace proof. Retrieve the original when textComplete is false.'});
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
    userRequests:requests,observedWork:{artifacts,executions,sourceReads,recentToolResults,subagentResults},openWork:{todos,unresolvedErrors:errors,pendingJobs:jobs,pendingCalls},
    referencedSessions,hostTransfer,
    assistantClaims:{checkpoints,recentMessages:judgments,report},...(delivery?{delivery}:{}),
    recovery:{available:recallAvailable,scope:'source-session-and-owned-host-captures',
      index:recallAvailable&&throughSeq!==null?{tool:'work_recall',arguments:{sourceSessionId:agent.session.id,kind:'history',seq:0,throughSeq}}:null,
      nativeEventRead:{tool:'session_event_read',requires:'available-in-receiving-agent',scope:'exact-session-header-cwd',
        use:'Invoke source.nativeRecall through the receiving host. Native authorization decides access. source.recoverable describes work_recall in the source session, not cross-session authorization.'},
      use:'Pass sourceSessionId from source.sessionId, together with kind, seq and offset, to work_recall in that source session. For kind reference, also pass referenceSessionId: seq still identifies the receiving session capture. A mismatched sourceSessionId is refused. Continue text at nextOffset and index pages at nextSeq.'},
    coverage:{maxChars,sizeUnit:'UTF-16 code units of serialized JSON',serializedChars:0,exportComplete:false,
      observationScope:'Recorded session facts with native metadata assessment of declared file dependencies only. Task correctness is not inferred. Non-text user content and private reasoning are not reproduced.',
      nextAction:'Use recorded open items and attributed summaries to identify the next unmet dependency. Missing records remain unknown; source context grants no new permission.'}};
  const sections=[requests,todos,artifacts,executions,sourceReads,recentToolResults,subagentResults,errors,jobs,pendingCalls,checkpoints,judgments,report,referencedSessions];
  const measure=()=>{
    for(const part of sections){
      part.complete=part.scopeComplete!==false&&part.omitted===0&&!(part.entriesEvicted>0)&&part.items.every(item=>item.textComplete!==false&&!(item.nonTextBlocks?.length));
      part.sourcesComplete=part.scopeComplete!==false&&part.items.every(item=>item.source?.type);
    }
    value.coverage.exportComplete=sections.every(part=>part.complete);
    value.coverage.sourcesComplete=sections.every(part=>part.sourcesComplete);
    let length=JSON.stringify(value).length;
    while(value.coverage.serializedChars!==length){value.coverage.serializedChars=length;length=JSON.stringify(value).length;}
    return length;
  };
  // Drop whole older rows before shortening the latest requirement. Every omitted
  // row is counted; every shortened body keeps its original event address.
  const removable=[checkpoints,judgments,report,referencedSessions,subagentResults,executions,sourceReads,artifacts,recentToolResults,requests,todos,errors,jobs,pendingCalls];
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

export function handoffPatch(before,after){
  const patch=[],pointer=(parent,key)=>parent+'/'+String(key).replaceAll('~','~0').replaceAll('/','~1');
  const visit=(previous,next,location)=>{
    if(JSON.stringify(previous)===JSON.stringify(next))return;
    if(Array.isArray(previous)&&Array.isArray(next)){
      for(let index=0;index<Math.min(previous.length,next.length);index++)visit(previous[index],next[index],pointer(location,index));
      for(let index=previous.length-1;index>=next.length;index--)patch.push({op:'remove',path:pointer(location,index)});
      for(let index=previous.length;index<next.length;index++)patch.push({op:'add',path:location+'/-',value:next[index]});
    }else if(previous&&next&&typeof previous==='object'&&typeof next==='object'&&!Array.isArray(previous)&&!Array.isArray(next)){
      for(const key of Object.keys(previous))if(!Object.hasOwn(next,key))patch.push({op:'remove',path:pointer(location,key)});
      for(const [key,value]of Object.entries(next))if(Object.hasOwn(previous,key))visit(previous[key],value,pointer(location,key));
      else patch.push({op:'add',path:pointer(location,key),value});
    }else patch.push({op:'replace',path:location,value:next});
  };
  // Optional undefined fields disappear from JSON; compare the delivered values.
  visit(JSON.parse(JSON.stringify(before)),JSON.parse(JSON.stringify(after)),'');return patch;
}

export function createTaskHandoffDelivery(){
  const delivered=new WeakMap();
  const visible=(messages,value)=>{
    const expected=JSON.stringify(value);
    for(const message of messages??[])if(message.role==='tool'&&!message.isError){
      for(const block of message.content??[])if(block.type==='text'&&typeof block.text==='string'){
        if(!block.text.includes(value.delivery.id))continue;
        let parsed;try{parsed=JSON.parse(block.text);}catch{continue;}
        const queue=[{value:parsed,depth:0}];let visited=0;
        while(queue.length&&visited++<64){
          const current=queue.shift();
          if(current.value&&typeof current.value==='object'){
            if(current.value.schema===value.schema&&JSON.stringify(current.value)===expected)return true;
            if(current.depth<6)for(const child of Object.values(current.value))if(child&&typeof child==='object')queue.push({value:child,depth:current.depth+1});
          }
        }
      }
    }
    return false;
  };
  return {deliver(agent,{incremental=false,baseDeliveryId,maxChars=32000,messages,build}){
    if(!incremental&&baseDeliveryId===undefined)return build();
    const previous=delivered.get(agent);
    let reason='full-delivery-requested';
    if(baseDeliveryId!==undefined){
      if(!previous||previous.value.delivery.id!==baseDeliveryId)reason='base-delivery-unavailable';
      else if(previous.value.source.sessionId!==agent.session.id||previous.value.coverage.maxChars!==maxChars)reason='base-context-changed';
      else if(!visible(messages?.(),previous.value))reason='base-not-fully-visible';
      else{
        const next=build({kind:'reconstructed',baseDeliveryId});
        if(next.status==='observed'&&next.schema===previous.value.schema&&next.pluginVersion===previous.value.pluginVersion&&
          next.policyVersion===previous.value.policyVersion&&next.source.workspace===previous.value.source.workspace){
          const delta={schema:'work-evidence.task-handoff-delta.v1',source:next.source,baseDeliveryId,
            patch:handoffPatch(previous.value,next),reconstructedCoverage:next.coverage,
            use:'Apply this RFC 6902 JSON Patch to the complete full delivery identified by baseDeliveryId. Each delta uses that full delivery; deltas do not chain. If it is missing, request handoff without baseDeliveryId.'};
          const fullChars=JSON.stringify(next).length,deltaChars=JSON.stringify(delta).length;
          if(fullChars-deltaChars>=4096&&deltaChars<=fullChars*.6)return delta;
          reason='delta-not-smaller-enough';
        }else reason='base-context-changed';
      }
    }
    const value=build({kind:'full',id:randomUUID(),reason});
    if(value.status==='observed')delivered.set(agent,{value:structuredClone(value)});else delivered.delete(agent);
    return value;
  },clear:agent=>delivered.delete(agent)};
}
