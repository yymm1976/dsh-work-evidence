import {eventLog,isUserRequestMessage,textOf} from './runtime.mjs';
import {hasPruneProblem} from './context-pruning.mjs';
import {stageCheckpoints,stageReuseCandidate} from './stage-checkpoints.mjs';
import {messageTokens} from './context-economics.mjs';

const POLICY='kimi-codex-handoff-v10-stub';
const INSTRUCTION='Produce one consolidated continuation checkpoint with these sections: Goal and user decisions; Work and artifacts; Evidence and failed approaches; Open work and next action. Preserve current requirements and corrections, separating user decisions from assistant assumptions. Keep exact paths, symbols, configuration values, input conditions, error strings, job IDs and source event seqs needed to continue. Describe what actually changed in each relevant artifact and what remains unfinished. Preserve unresolved failures, excluded approaches and their reasons; distinguish process success from correctness.\n'+
  'Update the previous checkpoint using newer events. Carry forward still-valid earlier facts, decisions and open questions; explicitly replace corrected claims and remove resolved work from the next action. Do not nest old checkpoints, reproduce old continuation-source wrappers or append a per-edit changelog. Reuse public stage conclusions and evidence without treating their headings as proof of coverage. Do not invent completion or turn assistant judgments into user decisions.\n'+
  'Bounded human excerpts, public checkpoints and current TODOs are appended independently. Preserve relevant decisions and facts absent from those sources, especially omitted middle history. Identify any exact detail that still requires historical recovery. Use historical recovery when available; if it is unavailable, preserve the exact evidence needed for continuation instead of relying on a future lookup. Never rerun an action only to recreate its text. Continue from the next unmet dependency without asking answered questions. Output only the complete text checkpoint, no tools or other actions.';
function summaryPrompt(record,complete=record.humanRequests.requirementsComplete,recallAvailable=record.recovery.available){
  const coverage=complete
    ?'The complete text of all human requests is appended independently. Avoid duplicating their full text; retain the observed work state and decisions.'
    :'The appended human sources are incomplete or include non-text content. Do not assume the full requirements are appended. Preserve the still-relevant requirements, constraints, corrections and exceptions visible in the selected conversation, especially details missing from the excerpts. '+
      (recallAvailable?'Identify missing details and their event locations for later text recovery; historical text recovery does not reproduce non-text content.'
        :'Historical recovery is unavailable. Retain the exact available details needed to continue and explicitly identify gaps that cannot be recovered from the selected conversation.');
  return INSTRUCTION+'\n'+coverage+' Describe the observed code/work state, unresolved failures, and next dependent action. Do not restate completed earlier tasks. Current state: '+JSON.stringify(record.currentState)+'\nRecovery: '+JSON.stringify(record.recovery);
}
// Mirrors the directive and checkpoint frame in the supported DSH basic backend.
// They are measured by the injected token meter so the first early decision does
// not price only the compacted region.
const HOST_SUMMARY_INSTRUCTION=[
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.'
].join('\n');
const CHECKPOINT_PREAMBLE='This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';
const STUB_ROW_MAX_CHARS=240;
const STUB_RECENT_MAX_ROWS=96;
const STUB_PROBLEM_MAX_ROWS=8;
const STUB_HUMAN_MAX_ROWS=32;
const STUB_MAX_CHARS=20000;
function targetFromArguments(value){
  let args=value;
  if(typeof args==='string'){try{args=JSON.parse(args);}catch{return null;}}
  if(!args||typeof args!=='object'||Array.isArray(args))return null;
  const paths=[];
  for(const key of ['file_path','path','file'])if(typeof args[key]==='string'&&args[key].trim())paths.push(args[key]);
  if(Array.isArray(args.files))for(const item of args.files){
    const path=typeof item==='string'?item:item?.path;
    if(typeof path==='string'&&path.trim())paths.push(path);
  }
  const normalized=[...new Set(paths.map(path=>path.replaceAll('\\','/')))].sort();
  const command=typeof args.command==='string'?args.command:typeof args.cmd==='string'?args.cmd:null;
  const cwd=typeof args.cwd==='string'?args.cwd:typeof args.workdir==='string'?args.workdir:null;
  if(!normalized.length&&command===null&&cwd===null)return null;
  return JSON.stringify([normalized,command,cwd]);
}
// Deterministic stub checkpoint: no summarizer model call. Row selection and serialization are
// deterministic for a given event log. Provider cache savings depend on the full request.
// Problem rows get checked markers only
// when a later successful result has the same tool and path/command target.
export function stubCheckpoint(agent){
  const log=eventLog(agent.session),events=[],problems=[],humans=[],problemSeqs=new Set(),targetBySeq=new Map(),callTargets=new Map();
  for(const event of log){
    const message=messageOf(event),data=event.data??{};
    const isTool=['tool/call','tool/result','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type);
    const human=isUserRequestMessage(message);
    if(!isTool&&!human&&!['assistant/message','todo/write','compaction/summary'].includes(event.type))continue;
    const name=data.name??null,callId=message?.source?.callId??message?.toolCallId??data.subCallId??data.callId??null;
    const text=message?textOf(message):event.type==='todo/write'?JSON.stringify(data.todos??[]):
      event.type==='tool/call'?(typeof data.arguments==='string'?data.arguments:JSON.stringify(data.arguments??{})):
      isTool?textOf({content:message?.content??(Array.isArray(data.content)?data.content:[{type:'text',text:String(data.content??'')}])}):
      textOf({content:data.content??data.summary});
    if(!text.trim())continue;
    if(human){
      const row={seq:event.seq,kind:'user',chars:text.length};
      humans.push(row);events.push(row);
      continue;
    }
    const row={seq:event.seq,kind:event.type==='tool/call'||event.type==='tool/ptc-dispatch'||event.type==='tool/code-dispatch'?'call':
      event.type==='tool/result'?'result':event.type==='assistant/message'?'assistant':event.type==='todo/write'?'todos':'prior-compaction',
      ...(isTool||event.type==='assistant/message'?{tool:name}:{}),...(callId?{callId}:{}),head:text.slice(0,STUB_ROW_MAX_CHARS).replace(/\s+/g,' ').trim()};
    events.push(row);
    const target=targetFromArguments(data.arguments);
    if(callId&&target&&row.kind==='call')callTargets.set(callId,target);
    const resolvedTarget=target??(row.kind==='result'&&callId?callTargets.get(callId):null);
    if(resolvedTarget)targetBySeq.set(event.seq,resolvedTarget);
    const isProblem=event.type==='tool/result'&&(message?.isError===true||hasPruneProblem([{type:'text',text}]));
    if(isProblem){problems.push(row);problemSeqs.add(event.seq);}
  }
  const line=row=>'- '+JSON.stringify(row)+'\n  recall: work_recall({kind:"event",seq:'+row.seq+',offset:0})';
  const selectedHumans=humans.slice(-STUB_HUMAN_MAX_ROWS);
  let body=selectedHumans.length?
    'human requests (continuation sources may carry text or bounded excerpts; these entries locate the full originals):\n'+
    selectedHumans.map(row=>'- '+JSON.stringify(row)+
      '\n  continuation: record.humanRequests.requests\n  recall: work_recall({kind:"event",seq:'+row.seq+',offset:0})').join('\n')+'\n'
    :'';
    // Problem rows carry a verification marker; checked ones were later answered by a
    // successful result and only need re-reading after explicit recall.
    const successSeqs=new Set(events.filter(r=>r.kind==='result'&&!problemSeqs.has(r.seq)&&!/error|failed|exception|cannot|undefined|null pointer|traceback/i.test(r.head)).map(r=>r.seq));
    const marked=problems.slice(-STUB_PROBLEM_MAX_ROWS).map(row=>{
      // A retry counts only when tool and target both match.
      const sameTool=r=>r.tool&&row.tool&&r.tool===row.tool;
      const target=targetBySeq.get(row.seq);
      const checked=!!target&&events.some(r=>r.kind==='result'&&successSeqs.has(r.seq)&&r.seq>row.seq&&r.seq<=row.seq+6&&
        sameTool(r)&&targetBySeq.get(r.seq)===target);
      return {...row,checked};
    });
    body+='problem rows (latest '+STUB_PROBLEM_MAX_ROWS+', checked rows need recall before re-reading):\n'+
      marked.map(row=>'- '+JSON.stringify({seq:row.seq,kind:row.kind,tool:row.tool,head:row.head,checked:row.checked})+
        '\n  recall: work_recall({kind:"event",seq:'+row.seq+',offset:0})').join('\n')+
      '\nrecent events (oldest first; bounded rows may shift as the conversation grows):\n';
  const head='[work-evidence stub checkpoint policy='+POLICY+' deterministic=true]\n'+
    'Event rows are bounded pointers to original events. Continuation sources retain human requests where budget permits. Recover original text with work_recall before relying on a head; never rerun an operation only to recreate its text. Problem results are listed regardless of recency. A checked row has a later successful observation of the same tool and target. Continue from the next unmet dependency. Assistant heads are not user decisions.\n\n';
  const rowLines=events.filter(row=>row.kind!=='user').map(line),budget=STUB_MAX_CHARS-head.length-body.length;
  let used=0,end=rowLines.length;
  while(end>0&&used+rowLines[end-1].length+1<=budget){used+=rowLines[end-1].length+1;end--;}
  const tailRows=end<rowLines.length?rowLines.slice(end):[];
  if(!tailRows.length&&rowLines.length)body+='[all events exceed the stub budget; recover from the continuation sources]\n';
  return {text:head+body+tailRows.join('\n'),events:events.length,problemRows:problems.length,
    rows:selectedHumans.length+rowLines.length-end};
}
const clip=(text,max)=>{
  if(text.length<=max)return text;
  const marker='\n[excerpt incomplete; retrieve original event]\n';
  if(max<marker.length)return text.slice(0,Math.max(0,max));
  const remaining=max-marker.length,tail=Math.floor(remaining*.25);
  return text.slice(0,remaining-tail)+marker+(tail?text.slice(-tail):'');
};
const messageOf=event=>event?.data?.message??(event?.data?.role?event.data:null);

/** Exact historical text, including human requests, never a new disk observation. */
export function recallHistory(agent,{seq,kind='event',offset=0,maxChars=16000,filter='all',query='',throughSeq}){
  if(!Number.isSafeInteger(seq)||seq<0||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(maxChars)||maxChars<256||maxChars>64000)throw new Error('Invalid history seq, offset or maxChars');
  if(!['all','human','assistant','tool'].includes(filter)||typeof query!=='string'||query.length>3000)throw new Error('Invalid history filter or query');
  if(throughSeq!==undefined&&(!Number.isSafeInteger(throughSeq)||throughSeq<seq))throw new Error('Invalid history throughSeq');
  let text,nonTextBlocks=[],type;
  if(kind==='history'){
    const log=eventLog(agent.session),ceiling=throughSeq??log.at(-1)?.seq??seq,rows=[];
    const needle=query.toLowerCase();let nextSeq=null,chars=2,legacyChars=0,legacyRows=0,legacyText='';
    const appendLegacy=part=>{
      const start=Math.max(0,offset-legacyChars),end=Math.min(part.length,offset+maxChars-legacyChars);
      if(end>start)legacyText+=part.slice(start,end);
      legacyChars+=part.length;
    };
    if(offset>0)appendLegacy('[');
    for(const event of log){
      if(event.seq<seq||event.seq>ceiling)continue;
      const message=messageOf(event);
      const human=isUserRequestMessage(message),tool=['tool/call','tool/result','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type),assistant=event.type==='assistant/message';
      if(filter==='human'&&!human||filter==='tool'&&!tool||filter==='assistant'&&!assistant)continue;
      const data=event.data??{},dispatch=['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type),
        callText=event.type==='tool/call'||dispatch?(typeof data.arguments==='string'?data.arguments:JSON.stringify(data.arguments??{})):'',
        body=message?textOf(message):event.type==='todo/write'?JSON.stringify(data.todos??[]):
        event.type==='tool/call'?callText:
        textOf({content:data.content??data.summary});
      const at=needle?body.toLowerCase().indexOf(needle):0;
      const argumentAt=needle&&dispatch?callText.toLowerCase().indexOf(needle):-1;
      if(at<0&&argumentAt<0)continue;
      if(!(human||event.type==='todo/write'||event.type==='compaction/summary'||tool||assistant&&body.trim()))continue;
      const previewBody=at>=0?body:callText,previewAt=at>=0?at:argumentAt;
      const row={seq:event.seq,type:event.type,human,callId:message?.source?.callId??message?.toolCallId??data.subCallId??data.callId??null,
        ...(data.name?{tool:data.name}:{}),chars:body.length,
        ...(!tool||query?{preview:previewBody.slice(Math.max(0,previewAt-60),Math.max(0,previewAt-60)+200)}:{}),
        ...(dispatch?{arguments:{kind:'call',seq:event.seq},argumentChars:callText.length}:{}),
        ...(query?{matchIn:at<0?'arguments':argumentAt>=0?'content-and-arguments':event.type==='tool/call'?'arguments':'content'}:{}),
        recover:{kind:event.type==='tool/call'||at<0?'call':'event',seq:event.seq}};
      const serialized=JSON.stringify(row),size=serialized.length+(rows.length?1:0);
      // A legacy positive text offset still reads the original concatenated index.
      // New pages always contain whole JSON rows and continue at an event seq.
      if(offset>0){appendLegacy((legacyRows?',':'')+serialized);legacyRows++;continue;}
      if(rows.length&&chars+size>maxChars){nextSeq=event.seq;break;}
      rows.push(row);chars+=size;
    }
    if(offset===0)return {status:'observed',seq,kind,type:'history-index',historical:true,throughSeq:ceiling,
      rowCount:rows.length,text:JSON.stringify(rows),nextSeq,nextOffset:null,complete:nextSeq===null,textComplete:true,
      pageOverBudget:chars>maxChars,
      note:'Whole index entries. Continue with nextSeq as seq and the same throughSeq, filter and query. Use each recover entry for original text; previews are excerpts.'};
    appendLegacy(']');const end=Math.min(legacyChars,offset+maxChars);
    return {status:'observed',seq,kind,type:'history-index',historical:true,throughSeq:ceiling,offset,totalChars:legacyChars,
      text:legacyText,nextOffset:end<legacyChars?end:null,textComplete:end>=legacyChars,complete:end>=legacyChars,
      note:'Legacy text-offset page. New history requests use offset 0 and continue whole entries with nextSeq and throughSeq.'};
  }else{
    let event;try{event=agent.session.eventAt(seq);}catch{}
    if(!event)return {status:'unavailable',seq,reason:'No such event in this session'};
    type=event.type;const message=messageOf(event);
    if(['user/message','assistant/message','tool/result'].includes(type)&&message){
      text=textOf(message);nonTextBlocks=(message.content??[]).filter(block=>block.type!=='text').map(block=>block.type);
    }else if(type==='tool/call'){
      text=typeof event.data.arguments==='string'?event.data.arguments:JSON.stringify(event.data.arguments??{});
    }else if(['tool/ptc-dispatch','tool/code-dispatch'].includes(type))text=textOf({content:event.data.content});
    else if(type==='todo/write')text=JSON.stringify(event.data.todos);
    else if(type==='compaction/summary')text=textOf({content:event.data.summary});
    else if(['job/registered','job/settled','turn/start','turn/end'].includes(type))text=JSON.stringify(event.data??{});
    else return {status:'unavailable',seq,reason:'Use kind=call for original tool arguments; event recovery supports messages, TODOs, summaries and job/turn lifecycle records'};
  }
  const end=Math.min(text.length,offset+maxChars);
  return {status:'observed',seq,kind,type,historical:true,offset,totalChars:text.length,text:text.slice(offset,end),nextOffset:end<text.length?end:null,
    textComplete:end>=text.length,complete:end>=text.length&&!nonTextBlocks.length,nonTextBlocks,
    note:'Original session record, not current disk state. Assistant text is a historical claim, not a user decision. Non-text contents are listed, not reproduced.'};
}

export function handoffRecord(agent,runtime,taskFlow,input,recallAvailable,{requestBudgetChars}={}){
  const log=eventLog(agent.session),humans=[],judgments=[];let todoSeq=null,todos=null;
  for(const event of log){
    const message=messageOf(event);
    if(isUserRequestMessage(message))humans.push({seq:event.seq,text:textOf(message),nonTextBlocks:(message.content??[]).filter(block=>block.type!=='text').map(block=>block.type)});
    if(event.type==='assistant/message'&&textOf(message).trim()){judgments.push({seq:event.seq,text:clip(textOf(message),550)});if(judgments.length>2)judgments.shift();}
    if(event.type==='todo/write'){todoSeq=event.seq;todos=event.data.todos;}
  }
  // Preserve all original requirements when they fit; only large histories use opening + recent excerpts.
  const regionChars=(input.messages??[]).reduce((sum,message)=>sum+textOf(message).length,0);
  const budget=requestBudgetChars??Math.min(24000,Math.max(4000,Math.floor(regionChars/4)));
  const total=humans.reduce((sum,item)=>sum+item.text.length,0),selected=new Map();
  if(total<=budget)for(const item of humans)selected.set(item.seq,{...item,textComplete:true});
  else if(humans.length===1){const item=humans[0];selected.set(item.seq,{...item,text:clip(item.text,budget),textComplete:false});}
  else{
    let remaining=budget;
    if(humans.length){const opening=humans[0],allowance=Math.min(opening.text.length,Math.floor(budget/4));selected.set(opening.seq,{...opening,text:clip(opening.text,allowance),textComplete:opening.text.length<=allowance});remaining-=allowance;}
    for(let index=humans.length-1;index>0&&remaining>0;index--){
      const item=humans[index],allowance=Math.min(item.text.length,remaining);
      selected.set(item.seq,{...item,text:clip(item.text,allowance),textComplete:item.text.length<=allowance});remaining-=allowance;
    }
  }
  const requests=[...selected.values()].sort((a,b)=>a.seq-b.seq),state=taskFlow.handoff(agent),latestHumanSeq=humans.at(-1)?.seq??null;
  const oldCompleted=todoSeq!==null&&latestHumanSeq!==null&&todoSeq<latestHumanSeq&&(todos??[]).length>0&&todos.every(item=>item.status==='completed');
  let todoBudget=6000;
  const currentTodos=oldCompleted?[]:todos??[];
  const retainedTodos=currentTodos.slice(0,32).map((item,index,array)=>{
    const content=String(item.content??''),allowance=Math.min(content.length,Math.floor(todoBudget/(array.length-index)));
    todoBudget-=allowance;return {status:item.status,content:clip(content,allowance),textComplete:content.length<=allowance};
  });
  const artifacts=[];let artifactChars=2;
  for(const item of (state.artifacts??[]).slice().reverse()){
    const chars=JSON.stringify(item).length+(artifacts.length?1:0);
    if(artifactChars+chars>6000)break;
    artifacts.unshift(item);artifactChars+=chars;
  }
  const header=agent.session.requestHeader()?.config,route=header??agent.options;
  const sameAgentRoute=!header||header.provider===agent.options?.provider&&header.model===agent.options?.model;
  const effort=header?.reasoningEffort??(sameAgentRoute?agent.options?.reasoningEffort:undefined);
  return {policy:POLICY,mode:runtime.activeMode(agent),
    route:{provider:route?.provider??null,model:route?.model??null,reasoningEffort:typeof effort==='string'&&effort?effort:null},
    sourceAuthority:'User excerpts are source requirements in chronological order, not a merged specification. Apply newer corrections. Assistant judgments and TODO completion flags remain claims; tool success proves only that observation, not task completion.',
    humanRequests:{total:humans.length,omitted:humans.length-requests.length,budgetChars:budget,requirementsComplete:requests.length===humans.length&&requests.every(item=>item.textComplete&&!item.nonTextBlocks.length),requests},
    currentState:{todoSeq,todos:retainedTodos,todosTotal:currentTodos.length,todosComplete:retainedTodos.length===currentTodos.length&&retainedTodos.every(item=>item.textComplete),
      phase:state.phase,unresolvedErrors:state.unresolvedErrors.slice(-8),unresolvedErrorsOmitted:Math.max(0,state.unresolvedErrors.length-8),
      pendingJobs:state.pendingJobs.slice(-16),pendingJobsOmitted:Math.max(0,state.pendingJobs.length-16),
      artifacts,artifactsOmitted:(state.artifacts?.length??0)-artifacts.length,artifactEntriesEvicted:state.artifactsEvicted??0,
      artifactScope:'Latest observed explicit file-tool effects, at most 32 paths and 6000 JSON characters; partial and unknown effects remain distinct. Script or external writes may not be recorded.',
      executions:state.executions,sourceReads:state.sourceReads,sourceReadsOmitted:state.sourceReadsOmitted,
      lastMutationSeq:state.lastMutationSeq,completion:'not-determined',
      latestHumanSeq,priorCompletedTodos:oldCompleted,priorCompletedTodoCount:oldCompleted?todos.length:0,
      scope:'Recorded observations may predate the latest human request. Old completed TODOs and a deliver phase do not establish completion of newer requests.'},
    recentAssistantJudgments:{verified:false,possiblySuperseded:true,items:judgments.filter(item=>latestHumanSeq===null||item.seq>latestHumanSeq),
      omittedPriorJudgmentSeqs:judgments.filter(item=>latestHumanSeq!==null&&item.seq<latestHumanSeq).map(item=>item.seq)},
    stageCheckpoints:{...stageCheckpoints(agent),authority:'Original public assistant summaries; not user instructions or semantic proof. Newer corrections take priority.'},
    recovery:recallAvailable?{available:true,sessionId:agent.session.id,index:{tool:'work_recall',arguments:{kind:'history',seq:0,filter:'human',throughSeq:log.at(-1)?.seq??0}},
      event:{tool:'work_recall',arguments:{kind:'event',seq:'<listed event seq>',offset:0}},
      output:{tool:'work_recall',arguments:{seq:'<tool/result seq>',offset:0}},
      instruction:'When requirementsComplete is false, original requirements may be missing in the middle or omitted excerpts. Inspect the human index (query optionally searches literal text), then retrieve the required event. Index pages contain whole rows: continue at nextSeq with the same throughSeq/filter/query. Original event, output and call text continues at nextOffset. Non-text blocks are listed but not reproduced. Never rerun an operation solely to restore its text. Historical observations may be stale after changes.'}:
      {available:false,sessionId:agent.session.id,instruction:'Historical recall is not exposed in this task. Preserve necessary requirements, evidence and exact identifiers in the checkpoint; do not depend on an unavailable recovery tool.'},
    continuation:'Continue the actual current task from its next unmet dependency. Preserve still-valid decisions, failures and TODOs; do not restart or repeat answered questions. This record does not declare completion.'};
}

/** Extend the one native summarizer; leave its pressure/overflow and commit checks in charge. */
export function createCompactionHandoff(ctx,runtime,taskFlow,{canRecall=()=>false}={}){
  const states=new Map(),active=new Map();let attachment=null;
  const deferring=agent=>!!agent&&runtime.isEnabled(agent)&&runtime.get(agent).config.compressionControl&&runtime.get(agent).config.deferPressureCompaction;
  ctx.on('llm/stream',async function*(options,next){
    const record=options.purpose==='compaction'?active.get(options.sessionId):null;
    if(!record){yield* next();return;}
    const prior=options.messages,priorEffort=options.reasoningEffort;
    const inheritEffort=priorEffort===undefined&&record.route?.reasoningEffort&&
      record.route.provider===options.provider&&record.route.model===options.model;
    if(inheritEffort)options.reasoningEffort=record.route.reasoningEffort;
    options.messages=[...prior,{role:'user',content:[{type:'text',text:summaryPrompt(record)}]}];
    try{yield* next();}finally{
      options.messages=prior;
      if(inheritEffort)delete options.reasoningEffort;
    }
  },{prepend:true});
  const get=agent=>{let s=states.get(agent.session.id);if(!s){s={prepared:0,summariesReturned:0,reusedStageSummaries:0,stubSummaries:0,nativeSummaryCalls:0,committed:0,failed:0,last:null};states.set(agent.session.id,s);}return s;};
  function pressureBudget(agent){
    try{
      const service=attachment?.service,header=agent.session.requestHeader?.()?.config,context=agent.session.requestContext?.();
      const policy=service?.config,override=policy?.modelPolicies?.find(p=>p.provider===header?.provider&&p.model===header?.model);
      const window=context?.contextWindow,reserve=header?.maxTokens??context?.defaultMaxTokens;
      const ratio=override?.thresholdRatio??policy?.thresholdRatio,headroom=override?.headroomTokens??policy?.headroomTokens;
      if(![window,reserve,ratio,headroom].every(Number.isFinite))return {status:'unavailable'};
      return {status:'observed-configuration',contextWindow:window,outputReservation:reserve,headroomTokens:headroom,
        nativeThresholdTokens:Math.floor(Math.min(window*ratio,window-reserve-headroom)),
        requestViewAvailable:runtime.hasRequestBudgetView?.(agent)===true,
        note:'Declared route capacity and native policy; not proof of the upstream model limit.'};
    }catch{return {status:'unavailable'};}
  }
  function summaryOverheadTokens(agent,meter){
    if(typeof meter?.estimateMessage!=='function')return null;
    try{
      if(runtime.get(agent).config.stubSummary){
        // Stub mode makes no summarizer request; the checkpoint text is deterministic, so its
        // price is the framed block itself plus the always-present continuation sources.
        const messages=(agent.session.surface?.nodes??[]).flatMap(seq=>{
          const event=agent.session.eventAt(seq),message=event?agent.session.deriveEventMessage(event):null;
          return message?[message]:[];
        });
        const record=handoffRecord(agent,runtime,taskFlow,{messages},canRecall(agent));
        const estimate=text=>meter.estimateMessage({role:'user',content:[{type:'text',text}]});
        return {stub:true,inputTokens:0,
          framedOverheadTokens:estimate(CHECKPOINT_PREAMBLE+'\n\n<compacted-summary>\n[Work Evidence continuation sources]\n'+JSON.stringify(record)+'\n\n'+stubCheckpoint(agent).text+'\n</compacted-summary>'),
          method:'stub-summary: no model call; framed deterministic checkpoint priced via injected meter'};
      }
      const messages=(agent.session.surface?.nodes??[]).flatMap(seq=>{
        const event=agent.session.eventAt(seq),message=event?agent.session.deriveEventMessage(event):null;
        return message?[message]:[];
      });
      const record=handoffRecord(agent,runtime,taskFlow,{messages},canRecall(agent));
      const estimate=text=>meter.estimateMessage({role:'user',content:[{type:'text',text}]});
      const pluginTokens=Math.max(estimate(summaryPrompt(record,true,true)),estimate(summaryPrompt(record,false,true)),estimate(summaryPrompt(record,false,false)));
      return {stub:false,inputTokens:estimate(HOST_SUMMARY_INSTRUCTION)+pluginTokens,
        framedOverheadTokens:estimate(CHECKPOINT_PREAMBLE+'\n\n<compacted-summary>\n</compacted-summary>'),
        method:'injected-token-meter over the supported host directive, handoff record and checkpoint frame'};
    }catch{return null;}
  }
  function attach(service){
    if(!service||typeof service.summarize!=='function'||typeof service.regionDependencies!=='function')return ()=>{};
    const original=service.summarize,descriptor=Object.getOwnPropertyDescriptor(service,'summarize');
    const originalCompact=typeof service.compactIfNeeded==='function'?service.compactIfNeeded:null,
      compactDescriptor=Object.getOwnPropertyDescriptor(service,'compactIfNeeded');
    // Canonical events include bodies already omitted from the request. Skip only
    // when complete observed usage supports a smaller view below the native threshold.
    const compactIfNeeded=async function(agent,trigger,signal){
      if(trigger!=='pressure'||!deferring(agent)||!runtime.hasRequestBudgetView?.(agent))return originalCompact.call(this,agent,trigger,signal);
      let total=null,effective=null,nativeThreshold=null;
      try{
        const header=agent.session.requestHeader()?.config;
        const selected=runtime.currentSelection?.(agent);
        if(!header||!selected||['provider','model','reasoningEffort'].some(key=>selected[key]!==header[key])||
          selected.maxTokens!==undefined&&selected.maxTokens!==header.maxTokens||
          !runtime.contextControl?.lastSuccessfulUsage(agent,header))return originalCompact.call(this,agent,trigger,signal);
        const info=header?await ctx.llm.resolveModelInfo(header.provider,header.model,signal):null;
        const window=info?.context?.contextWindow;
        const reserve=header.maxTokens??info?.defaultMaxTokens??0,budget=window-reserve;
        const policy=service.config,override=policy?.modelPolicies?.find(p=>p.provider===header?.provider&&p.model===header?.model);
        const ratio=override?.thresholdRatio??policy?.thresholdRatio,headroom=override?.headroomTokens??policy?.headroomTokens;
        if(!(budget>0)||!Number.isFinite(ratio)||!Number.isFinite(headroom))return originalCompact.call(this,agent,trigger,signal);
        nativeThreshold=Math.floor(Math.min(window*ratio,budget-headroom));
        if(nativeThreshold<=0)return originalCompact.call(this,agent,trigger,signal);
        total=service.regionDependencies()?.meter?.measure(agent.session)?.totalTokens??null;
        if(!Number.isFinite(total)||total<nativeThreshold)return originalCompact.call(this,agent,trigger,signal);
        const canonical=agent.session.deriveMessages(),view=runtime.projectedMessages?.(agent);
        if(!view||canonical.reduce((n,m)=>n+messageTokens(m),0)-view.reduce((n,m)=>n+messageTokens(m),0)<512)return originalCompact.call(this,agent,trigger,signal);
        effective=runtime.contextControl.pressure(agent,info.context,reserve).tokens;
      }catch{}
      if(!Number.isFinite(total)||!Number.isFinite(effective))return originalCompact.call(this,agent,trigger,signal);
      const state=get(agent);
      if(effective<nativeThreshold*.95){
        state.deferredPressure=(state.deferredPressure??0)+1;
        state.lastDeferral={canonicalPromptTokens:total,effectivePromptTokens:effective,nativeThresholdTokens:nativeThreshold,
          method:'observed request usage plus effective-view growth; native threshold retained with 5% estimation margin'};
        return null;
      }
      return originalCompact.call(this,agent,trigger,signal);
    };
    // The host rejects a checkpoint that is not smaller than the span it replaces.
    // Size the appended sources against the span so a doomed summary call is not paid for.
    const sizing=input=>{
      const meter=service.regionDependencies()?.meter;
      if(typeof meter?.estimateMessage!=='function')return null;
      const region=(input.messages??[]).filter((message,index)=>!(index===0&&message.role==='system'))
        .reduce((sum,message)=>sum+meter.estimateMessage(message),0);
      const framed=summary=>meter.estimateMessage({role:'user',content:[{type:'text',text:CHECKPOINT_PREAMBLE+'\n\n<compacted-summary>'},...summary,{type:'text',text:'</compacted-summary>'}]});
      return {region,framed};
    };
    const wrapped=async function(input,agent,signal){
      let state,prepared;
      const prepare=async()=>{
      await runtime.init(agent,signal);
      if(!runtime.isEnabled(agent)||!runtime.get(agent).config.compressionControl)return null;
      state=get(agent);
      const record=handoffRecord(agent,runtime,taskFlow,input,canRecall(agent)),text='[Work Evidence continuation sources]\n'+JSON.stringify(record);
      const start=eventLog(agent.session).findLast(event=>event.type==='compaction/start');
      state.prepared++;state.last={policy:POLICY,compactionId:start?.data?.compactionId??null,preparedAtSeq:agent.session.seq,sourceChars:text.length,mode:runtime.activeMode(agent),status:'preparing'};
      runtime.effects?.decide(agent,'compactionHandoff','applied','native-summary-extension',{policy:POLICY,sourceChars:text.length});
      let reuse;
      try{reuse=stageReuseCandidate(agent,input,record,service.regionDependencies()?.meter);}
      catch(error){reuse={applicable:false,reason:'stage-reuse-unavailable'};state.last.stageReuseError=String(error.message??error).slice(0,300);}
      const {summary:stageSummary,...reuseDetails}=reuse;state.last.stageReuse=reuseDetails;
      if(reuse.applicable){
        signal?.throwIfAborted();
        state.reusedStageSummaries++;state.summariesReturned++;state.last.status='prepared-awaiting-native-commit';state.last.method='stage-checkpoint-reuse';
        runtime.get(agent).dirty=true;
        runtime.effects?.decide(agent,'compactionHandoff','applied','existing-stage-checkpoint-reused',{policy:POLICY,checkpointSeq:reuse.checkpointSeq,newModelCall:false});
        return {result:{summary:stageSummary,provider:'work-evidence',model:'stage-checkpoint-reuse',llmStreamCall:false}};
      }
      const stubPolicy=runtime.get(agent).config.stubSummary;
      if(stubPolicy){
        signal?.throwIfAborted();
        const stub=stubCheckpoint(agent),text='[Work Evidence continuation sources]\n'+JSON.stringify(record)+'\n\n'+stub.text;
        state.stubSummaries++;state.summariesReturned++;state.last.status='prepared-awaiting-native-commit';
        state.last.method='deterministic-stub-summary';state.last.stub={events:stub.events,problemRows:stub.problemRows,rows:stub.rows,chars:text.length};
        runtime.get(agent).dirty=true;
        runtime.effects?.decide(agent,'compactionHandoff','applied','deterministic-stub-summary',{policy:POLICY,newModelCall:false,stubChars:stub.text.length,events:stub.events,problemRows:stub.problemRows});
        return {result:{summary:[{type:'text',text}],provider:'work-evidence',model:'deterministic-stub',llmStreamCall:false}};
      }
      state.last.method='native-summary-with-stage-sources';
      let size=null;try{size=sizing(input);}catch{}
      // The native part is not known before the call; use this session's last native
      // summary size, or a third of the span before any summary exists.
      const sourceTokens=size?size.framed([{type:'text',text}]):null;
      const nativeEstimate=size?(state.lastNativeSummaryTokens??Math.ceil(size.region/3)):null;
      // Sources that cannot fit are left out so the host summary can still shrink the span;
      // only a span too small for the summary itself skips the paid call.
      const sourcesFit=!size||sourceTokens+nativeEstimate<size.region;
      if(size&&!sourcesFit&&nativeEstimate*1.25>=size.region){
        state.failed++;state.last.status='failed';state.last.method='span-smaller-than-sources';
        state.last.sizing={regionTokensEstimate:size.region,sourceTokensEstimate:sourceTokens,nativeSummaryTokensEstimate:nativeEstimate};
        state.skippedSmallSpans=(state.skippedSmallSpans??0)+1;
        runtime.effects?.decide(agent,'compactionHandoff','not-applicable','span-smaller-than-continuation-sources',state.last.sizing);
        runtime.get(agent).dirty=true;
        throw Object.assign(new Error('work-evidence: the selected span is smaller than its continuation sources; no summary call was made'),{workEvidenceSmallSpan:true});
      }
      // When the full sources do not fit, keep the human requests: they are the part a
      // host summary is most likely to paraphrase away.
      let appended=text;
      if(!sourcesFit){
        const requestsOnly='[Work Evidence continuation sources]\n'+JSON.stringify({policy:record.policy,sourceAuthority:record.sourceAuthority,
          humanRequests:record.humanRequests,recovery:record.recovery,continuation:record.continuation});
        appended=size.framed([{type:'text',text:requestsOnly}])+nativeEstimate<size.region?requestsOnly:null;
        state.last.sourcesOmitted=appended?'state':'all';state.sourcesOmitted=(state.sourcesOmitted??0)+1;
      }
      return {record,size,appended,sourcesFit};
      };
      try{prepared=await prepare();}
      catch(error){
        signal?.throwIfAborted();
        if(error?.workEvidenceSmallSpan)throw error;
        // Only plugin preparation can fall back. A host failure must never trigger a second call.
        try{
          if(state){state.failed++;state.nativeFallbacks=(state.nativeFallbacks??0)+1;state.last={...state.last,status:'native-fallback',reason:'preparation-failed'};}
          runtime.problem(runtime.get(agent),'compaction-handoff-preparation',String(error?.message??error));
        }catch{}
        return original.call(this,input,agent,signal);
      }
      if(!prepared)return original.call(this,input,agent,signal);
      if(prepared.result)return prepared.result;
      const {record,size,appended,sourcesFit}=prepared;
      // Without appended sources the host's own directive (verbatim user goals) applies unchanged.
      const previous=active.get(agent.session.id);if(sourcesFit)active.set(agent.session.id,record);
      try{
        state.nativeSummaryCalls++;
        const result=await original.call(this,input,agent,signal);
        signal?.throwIfAborted();
        if(!Array.isArray(result?.summary)||!result.summary.length||result.summary.some(block=>block.type!=='text'||typeof block.text!=='string')||!result.summary.some(block=>block.text.trim()))throw new Error('Native compaction returned an empty or non-text summary');
        state.summariesReturned++;state.last.status='prepared-awaiting-native-commit';
        if(size)try{state.lastNativeSummaryTokens=size.framed(result.summary);}catch{}
        const combined=appended?[...result.summary,{type:'text',text:appended}]:result.summary;
        if(size&&appended&&size.framed(combined)>=size.region&&state.lastNativeSummaryTokens<size.region){
          state.last.sourcesOmitted='all';
          runtime.effects?.decide(agent,'compactionHandoff','applied','continuation-sources-omitted-to-fit-span',{regionTokensEstimate:size.region});
          return result;
        }
        return {...result,summary:combined};
      }catch(error){state.failed++;state.last.status='failed';throw error;}
      finally{if(previous)active.set(agent.session.id,previous);else active.delete(agent.session.id);runtime.get(agent).dirty=true;}
    };
    service.summarize=wrapped;attachment={service,wrapped};
    if(originalCompact)service.compactIfNeeded=compactIfNeeded;
    return ()=>{
      if(Object.getOwnPropertyDescriptor(service,'summarize')?.value===wrapped){if(descriptor)Object.defineProperty(service,'summarize',descriptor);else delete service.summarize;}
      if(originalCompact&&Object.getOwnPropertyDescriptor(service,'compactIfNeeded')?.value===compactIfNeeded){if(compactDescriptor)Object.defineProperty(service,'compactIfNeeded',compactDescriptor);else delete service.compactIfNeeded;}
      if(attachment?.wrapped===wrapped)attachment=null;
    };
  }
  // Optional service lifecycle: the plugin still works without a native basic backend.
  const fiber=ctx.inject(['compaction'],scope=>{scope.effect(()=>attach(scope.compaction));});
  ctx.on('session/event',(session,event)=>{
    const state=states.get(session.id);if(!state?.last)return;
    if(event.type==='compaction/summary'&&(state.last.status==='prepared-awaiting-native-commit'||textOf({content:event.data?.summary}).includes('[Work Evidence continuation sources]'))){
      state.last.compactionId=event.data.compactionId;state.last.summarySeq=event.seq;state.last.status='summary-recorded';
    }
    if(event.type==='compaction/end'&&event.data?.compactionId===state.last.compactionId){
      if(event.data.error){if(state.last.status!=='failed')state.failed++;state.last.status='failed';}
      else{state.committed++;state.last.status='committed';}
    }
  });
  ctx.on('agent/disposed',({agent})=>states.delete(agent.session.id));
  return {summaryOverheadTokens,
    metrics(agent){return {enabled:runtime.isEnabled(agent)&&runtime.get(agent).config.compressionControl,policy:POLICY,
      nativeSummarizerAttached:!!attachment&&Object.getOwnPropertyDescriptor(attachment.service,'summarize')?.value===attachment.wrapped,automaticTrigger:'host-pressure-or-overflow-only; no-additional-schedule',
      ...get(agent),pressureBudget:pressureBudget(agent),note:'Prepared summaries remain subject to native shrink, stability and commit checks. No claim that semantic requirements or judgments were verified.'};},
    async dispose(){await fiber?.dispose?.();states.clear();active.clear();}};
}
