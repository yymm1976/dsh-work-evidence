import {eventLog,isUserRequestMessage,textOf} from './runtime.mjs';
import {isDeepStrictEqual} from 'node:util';
import {hasPruneProblem,historyReferences,planContextPrune,readDispatch} from './context-pruning.mjs';
import {surfaceReferences} from './visible-results.mjs';

export const STAGE_CHECKPOINT_GUIDANCE='需要报告关键阶段时，用“阶段摘要”依次写“当前目标：”“约束与决定：”“已完成与依据：”“未完成：”“下一步：”，只写实际结论、准确来源位置和待办，不写内部思考。摘要是中途进度；尚有可执行未完成工作时，同一回复附上下一项实际工具调用，不得单独结束或等待用户发送“继续”。保留文件修改状态、仍在运行的任务 ID、下一项依赖和排除理由；新结论标明替代关系。任务完成、用户要求暂停或存在无法自行处理的真实阻碍时，可用纯文本说明状态。没有新事实不重复。用户禁止中途输出或要求仅最终工件时遵守用户格式。';
const FIELDS=['当前目标','约束与决定','已完成与依据','未完成','下一步'];
const MAX_CHECKPOINT_CHARS=8000,MAX_TAIL_CHARS=12000;
const READ_ONLY=new Set(['read','glob','grep','ops_read_files','ops_inspect_local_file','ops_glob','ops_grep']);
const HISTORY_MARKER='[Work Evidence anchored history]\n';
const HISTORY_SCHEMA='work-evidence.anchored-history.v1';
const messageOf=event=>event?.data?.message??(event?.data?.role?event.data:null);
function historyMessage(message){
  if(message.source?.replayState===undefined)return message;
  // Provider replay state belongs to its transport, never a text checkpoint.
  const {replayState,...source}=message.source;
  return {...message,source,sourceReplayStateOmitted:true};
}

// Recognize an explicit public checkpoint, never hidden reasoning or tool output.
export function stageCheckpointOf(event){
  if(event?.type!=='assistant/message')return null;
  const message=messageOf(event),text=textOf(message).trim();
  if(!Number.isSafeInteger(event.seq)||!text||text.length>MAX_CHECKPOINT_CHARS||
    !/^(?:#{1,6}\s*)?(?:\*\*)?阶段摘要(?:\*\*)?\s*[：:]?\s*$/u.test(text.split(/\r?\n/u)[0]))return null;
  const sections=[...text.matchAll(/^[\t ]*(?:[-*]\s+|\d+[.、]\s*)?(?:\*\*)?(当前目标|约束与决定|已完成与依据|未完成|下一步)(?:\*\*)?[：:]\s*(?:\*\*)?/gmu)];
  if(sections.length!==FIELDS.length||sections.some((section,index)=>section[1]!==FIELDS[index]))return null;
  if(sections.some((section,index)=>!text.slice(section.index+section[0].length,sections[index+1]?.index??text.length).trim()))return null;
  return {seq:event.seq,text,messageId:message?.id??null,verified:false};
}

export function stageCheckpoints(agent){
  let latestHumanSeq=null;const items=[];
  for(const event of eventLog(agent.session)){
    if(isUserRequestMessage(messageOf(event)))latestHumanSeq=event.seq;
    const item=stageCheckpointOf(event);if(item)items.push({...item,requestSeq:latestHumanSeq});
  }
  // Keep whole checkpoints. Never present a truncated paragraph as a complete checkpoint.
  let remaining=12000;const selected=[];
  const relevant=items.filter(item=>item.requestSeq===latestHumanSeq);
  for(const item of relevant.slice().reverse()){
    if(selected.length>=3)break;
    if(item.text.length>remaining)continue;
    selected.push(item);remaining-=item.text.length;
  }
  return {latestHumanSeq,total:relevant.length,omitted:relevant.length-selected.length,items:selected.reverse()};
}

// Expand only our own persisted typed history, correlated with the host transaction.
// Generic model summaries remain opaque; never infer original facts from their wording.
function expandPriorHistory(region,log){
  const summaries=new Map(log.filter(event=>event.type==='compaction/summary').map(event=>[event.data.compactionId,event]));
  const items=[],omittedReasoning=new Set();let expanded=0;
  for(const item of region){
    const source=item.message.source,event=summaries.get(source?.compactionId);
    const block=event?.data?.summary?.[0];
    if(source?.kind!=='compact-checkpoint'||event?.data?.provider!=='work-evidence'||event.data.model!=='stage-checkpoint-reuse'||
      block?.type!=='text'||!block.text.startsWith(HISTORY_MARKER)){items.push({...item});continue;}
    let saved;try{saved=JSON.parse(block.text.slice(HISTORY_MARKER.length));}catch{return null;}
    if(saved.schema!==HISTORY_SCHEMA||!Array.isArray(saved.messages)||!saved.messages.length||
      saved.selectedStartSeq!==event.data.shadowedRange?.start||saved.selectedEndSeq!==event.data.shadowedRange?.end)return null;
    for(const {seq,...message} of saved.messages){
      if(!Number.isSafeInteger(seq)||seq<0||seq>=item.event.seq||!['user','assistant','tool'].includes(message.role)||
        !Array.isArray(message.content)||message.content.some(block=>!['text','tool-call'].includes(block.type)))return null;
      items.push({event:{seq},message});
    }
    for(const seq of saved.reasoningOmittedFromSeqs??[])if(Number.isSafeInteger(seq))omittedReasoning.add(seq);
    expanded++;
  }
  if(new Set(items.map(item=>item.event.seq)).size!==items.length)return null;
  return {items,expanded,omittedReasoning};
}

/** Only older, successful native reads can lose their body; all other context stays exact. */
function anchoredPrefix(region,checkpointIndex,log,record,maxChars,pins){
  if(pins.opaque)return {reason:'opaque-existing-references'};
  const originals=new Map(log.map(event=>[event.seq,event])),calls=new Map(),nested=new Map(),recalled=new Set(),protectedResults=new Set(record.currentState.unresolvedErrors.map(item=>item.seq));
  const callKey=(turn,step,id)=>Number.isSafeInteger(turn)&&Number.isSafeInteger(step)&&typeof id==='string'&&id
    ?JSON.stringify([turn,step,id]):null;
  let currentStep=null;
  for(const event of log){
    const data=event.data??{};
    if(event.type==='step/start')currentStep={turn:data.turn,step:data.step};
    if(event.type==='tool/call'){
      const key=callKey(data.turn,data.step,data.callId);
      if(key)calls.set(key,calls.has(key)?null:{seq:event.seq,name:data.name});
    }
    if(['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)&&data.rootCallId){
      const key=callKey(currentStep?.turn,currentStep?.step,data.rootCallId);
      if(key){const children=nested.get(key)??[];children.push(data);nested.set(key,children);}
    }
    if(['tool/call','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)){
      let args=data.arguments;if(typeof args==='string'){try{args=JSON.parse(args);}catch{args=null;}}
      if((data.name==='work_recall'&&args?.kind!=='history'||data.name==='work_state'&&args?.mode==='recall')&&Number.isSafeInteger(args?.seq))recalled.add(args.seq);
    }
    if(event.type==='step/end')currentStep=null;
  }
  const references=[...record.stageCheckpoints.items.map(item=>item.text??''),...record.currentState.todos.map(item=>item.content??'')].join('\n');
  for(const match of references.matchAll(/(?:\bseq["']?\s*[:=]\s*|事件\s*[#：:]?\s*)(\d+)\b/giu)){
    const seq=Number(match[1]);if(Number.isSafeInteger(seq))protectedResults.add(seq);
  }
  for(const seq of pins.targets)protectedResults.add(seq);
  // Protect the last three assistant exchanges with results, including parallel results.
  const recentExchanges=new Set();let exchange=null;
  for(const {message,event} of region){
    if(message.role==='assistant')exchange=event.seq;
    if(message.role==='tool')recentExchanges.add(exchange);
  }
  const recent=new Set([...recentExchanges].slice(-3));
  const anchors=[],masked=[],dedupStats=[];let chars=2;exchange=null;
  for(const item of region.slice(0,checkpointIndex)){
    let message=historyMessage(item.message);const {event}=item;
    if((recalled.has(event.seq)||protectedResults.has(event.seq))&&historyReferences(message).some(ref=>ref.seq===event.seq)){
      const original=messageOf(originals.get(event.seq));
      if(!original||original.role!=='tool'||!Array.isArray(original.content)||original.content.some(block=>block.type!=='text'))return {reason:'protected-history-unavailable'};
      message=historyMessage(original);
    }
    if(message.role==='assistant')exchange=event.seq;
    const callId=message.source?.callId??message.toolCallId,resultEvent=originals.get(event.seq);
    const key=resultEvent?.type==='tool/result'?callKey(resultEvent.data?.turn,resultEvent.data?.step,callId):null;
    const call=key?calls.get(key):null,children=key?nested.get(key)??[]:[],reads=children.map(readDispatch).filter(Boolean);
    const nativeRead=call&&READ_ONLY.has(call.name)&&!['ops_read_files','ops_inspect_local_file'].includes(call.name);
    const programRead=call?.name==='run_code'&&reads.length>0&&children.every(data=>READ_ONLY.has(data.name)&&!data.isError&&!hasPruneProblem(data.content??[],data.value));
    // A compound program's computed output is retained; only exactly matched file windows can shrink.
    const mayMask=message.role==='tool'&&(nativeRead||programRead)&&!recent.has(exchange)&&
      !recalled.has(event.seq)&&!protectedResults.has(event.seq)&&!message.isError&&!hasPruneProblem(message.content??[]);
    if(mayMask){
      const plan=planContextPrune(message,programRead?reads:[],{seq:event.seq,thresholdChars:8000,headChars:4096,tailChars:1024});
      if(plan){
        const anchor={...message,content:plan.content,seq:event.seq};chars+=JSON.stringify(anchor).length+1;
        if(chars>maxChars)return {reason:'exact-prefix-anchors-too-large'};
        anchors.push(anchor);masked.push(event.seq);dedupStats.push(...(plan.dedupStats??[]));continue;
      }
    }
    const anchor={...message,seq:event.seq};chars+=JSON.stringify(anchor).length+1;
    if(chars>maxChars)return {reason:'exact-prefix-anchors-too-large'};
    anchors.push(anchor);
  }
  return {anchors,masked,dedupStats};
}

/** A public checkpoint helps navigation; its headings alone never justify dropping prior facts. */
export function stageReuseCandidate(agent,input,record,meter){
  const skip=reason=>({applicable:false,reason});
  if(!record.recovery.available)return skip('historical-recall-unavailable');
  if(!record.humanRequests.requirementsComplete)return skip('incomplete-human-sources');
  if(!record.currentState.todosComplete||record.currentState.unresolvedErrorsOmitted||record.currentState.pendingJobsOmitted)return skip('incomplete-current-state');
  const stages=stageCheckpoints(agent);
  if(stages.latestHumanSeq===null||!stages.items.length)return skip('no-current-stage-checkpoint');
  const log=eventLog(agent.session),bySeq=new Map(log.map(event=>[event.seq,event]));
  const byId=new Map(),ambiguous=new Set(),surfaceMessages=[];
  for(const seq of agent.session.surface.nodes){
    const event=bySeq.get(seq);if(!event)continue;
    const derived=agent.session.deriveEventMessage(event);
    if(!derived?.id)continue;
    surfaceMessages.push({message:derived,event});
    if(byId.has(derived.id))ambiguous.add(derived.id);
    else byId.set(derived.id,{event,message:derived,index:surfaceMessages.length-1});
  }
  const region=[];
  for(const [messageIndex,message] of (input.messages??[]).entries()){
    if(messageIndex===0&&message.role==='system')continue;
    if(!['user','assistant','tool'].includes(message.role))return skip('selected-region-has-instruction-role');
    if(!message.id||ambiguous.has(message.id)||!byId.has(message.id))return skip('selected-region-not-identifiable');
    if((message.content??[]).some(block=>!['text','tool-call','reasoning'].includes(block.type)||block.type==='reasoning'&&message.role!=='assistant'))return skip('selected-region-has-unsupported-content');
    const selected=byId.get(message.id);
    if(!isDeepStrictEqual(message,selected.message))return skip('selected-region-changed');
    region.push({message,event:selected.event,surfaceIndex:selected.index});
  }
  if(!region.length||new Set(region.map(item=>item.event.seq)).size!==region.length)return skip('invalid-selected-region-order');
  if(region.some((item,index)=>index&&item.surfaceIndex!==region[index-1].surfaceIndex+1))return skip('selected-region-not-contiguous');
  const expanded=expandPriorHistory(region,log);
  if(!expanded)return skip('prior-history-not-expandable');
  const history=expanded.items,pending=new Set(),seenCalls=new Set();
  for(const {message,event} of history){
    const original=bySeq.get(event.seq),turn=original?.data?.turn,step=original?.data?.step;
    const scoped=id=>Number.isSafeInteger(turn)&&Number.isSafeInteger(step)&&typeof id==='string'&&id
      ?JSON.stringify([turn,step,id]):null;
    for(const block of message.content??[])if(block.type==='tool-call'){
      const key=scoped(block.id);
      if(message.role!=='assistant'||!key||seenCalls.has(key))return skip('invalid-selected-tool-call');
      pending.add(key);seenCalls.add(key);
    }
    if(message.role==='tool'){
      const key=scoped(message.source?.callId??message.toolCallId);
      if(!key||!pending.delete(key))return skip('selected-tool-result-without-call');
    }
  }
  if(pending.size)return skip('selected-region-has-open-tool-calls');
  // A newer checkpoint outside the selected prefix stays on the live surface.
  // Reuse the newest one inside this prefix and keep that live suffix untouched.
  const selectedSeqs=new Set(region.map(item=>item.event.seq));
  const checkpoint=stages.items.findLast(item=>selectedSeqs.has(item.seq));
  if(!checkpoint||checkpoint.requestSeq!==stages.latestHumanSeq)return skip('no-current-checkpoint-in-selected-region');
  const index=history.findIndex(item=>item.event.seq===checkpoint.seq);
  if(history.slice(index+1).some(item=>item.message.content.some(block=>block.type==='reasoning')))return skip('uncheckpointed-reasoning-in-tail');
  // Closed-phase private reasoning stays in canonical events. Keep the public
  // state and observed actions/results, without turning reasoning into visible prose.
  for(const item of history.slice(0,index+1))if(item.message.content.some(block=>block.type==='reasoning')){
    expanded.omittedReasoning.add(item.event.seq);
    item.message={...item.message,content:item.message.content.filter(block=>block.type!=='reasoning')};
  }
  const anchorBudgetChars=JSON.stringify(input.messages).length;
  const prefix=anchoredPrefix(history,index,log,record,anchorBudgetChars,surfaceReferences(agent.session));
  if(prefix.reason)return skip(prefix.reason);
  const {anchors,masked}=prefix,tail=[];
  for(const {message,event} of history.slice(index+1))tail.push({...historyMessage(message),seq:event.seq});
  // TODOs are not necessarily message-shaped; the source record independently carries current state.
  const tailText=JSON.stringify(tail);
  if(tailText.length>MAX_TAIL_CHARS)return skip('unabridged-tail-too-large');
  if(typeof meter?.estimateMessage!=='function')return skip('native-meter-unavailable');
  const retainedSeqs=new Set(history.map(item=>item.event.seq));
  const retainedHumans=new Set(history.filter(item=>isUserRequestMessage(item.message)).map(item=>item.event.seq));
  const sources={...record,humanRequests:{...record.humanRequests,
    requests:record.humanRequests.requests.map(item=>retainedHumans.has(item.seq)?(({text,...meta})=>({...meta,textLocation:'anchored-history'}))(item):item)},
    recentAssistantJudgments:{...record.recentAssistantJudgments,
      items:record.recentAssistantJudgments.items.map(item=>retainedSeqs.has(item.seq)?(({text,...meta})=>({...meta,textLocation:'anchored-history'}))(item):item)},
    stageCheckpoints:{...record.stageCheckpoints,
    items:(record.stageCheckpoints?.items??[]).map(item=>retainedSeqs.has(item.seq)?(({text,...meta})=>meta)(item):item),
    textLocation:'Checkpoints in the selected history appear verbatim in anchored history. Checkpoints outside that history retain their text here.'}};
  const saved={schema:HISTORY_SCHEMA,selectedStartSeq:region[0].event.seq,selectedEndSeq:region.at(-1).event.seq,
    checkpointSeq:checkpoint.seq,requestSeq:checkpoint.requestSeq,
    reasoningOmittedFromSeqs:[...expanded.omittedReasoning],
    authority:'Original message roles and source seqs; assistant checkpoints remain claims. Apply newer human corrections. Read excerpts identify missing text and its original recovery location.',
    messages:[...anchors,{...historyMessage(history[index].message),seq:checkpoint.seq},...tail]};
  const summary=[{type:'text',text:HISTORY_MARKER+JSON.stringify(saved)},
    {type:'text',text:'[Work Evidence continuation sources]\n'+JSON.stringify(sources)}];
  const sourceTokens=region.reduce((sum,item)=>sum+meter.estimateMessage(item.message),0);
  const replacementTokens=meter.estimateMessage({role:'user',content:summary});
  // Reserve framing room; the native backend still makes the final shrink/commit decision.
  if(!Number.isFinite(sourceTokens)||!Number.isFinite(replacementTokens)||replacementTokens+1024>=sourceTokens)return {
    ...skip('stage-reuse-does-not-save-enough-context'),estimatedSourceTokens:sourceTokens,estimatedReplacementTokens:replacementTokens};
  // Cline continuation data showed that a small shrink can cost more cached
  // input than the eliminated summary call. Require room for sustained work.
  if(replacementTokens>sourceTokens*.35)return {...skip('stage-reuse-retains-too-much-context'),
    estimatedSourceTokens:sourceTokens,estimatedReplacementTokens:replacementTokens,maxReplacementRatio:.35};
  return {applicable:true,reason:'stage-with-exact-anchors-and-tail',checkpointSeq:checkpoint.seq,
    selectedStartSeq:region[0].event.seq,selectedEndSeq:region.at(-1).event.seq,tailMessages:tail.length,
    anchoredMessages:anchors.length,anchorBudgetChars,maskedReadResults:masked,dedupStats:prefix.dedupStats,expandedPriorCheckpoints:expanded.expanded,reasoningMessagesOmitted:expanded.omittedReasoning.size,
    replayStatesOmitted:saved.messages.filter(message=>message.sourceReplayStateOmitted).length,
    estimatedSourceTokens:sourceTokens,estimatedReplacementTokens:replacementTokens,summary};
}
