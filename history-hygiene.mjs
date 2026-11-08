import path from 'node:path';
import {argsOf,eventLog} from './runtime.mjs';
import {planContextPrune,readDispatch,hasPruneProblem} from './context-pruning.mjs';
import {resultText,surfaceReferences} from './visible-results.mjs';
import {renderedReads} from './observation-ledger.mjs';
import {messageTokens} from './context-economics.mjs';
import {reportedCheckFailure} from './recovery.mjs';

const AGE=2,MIN_SAVING=512;
const TEST_MIN_CHARS=4000,TEST_TAIL_CHARS=1800,TEST_DIGEST_MAX=4000;
const TEST_COMMAND=/^(?:python(?:\.exe)?\s+-m\s+(?:pytest|compileall)|node\s+--test|ruff\s+check|(?:\.\\|\.\/)?gradlew(?:\.bat)?|gradle(?:\.bat)?|mvn(?:\.cmd)?)\b/iu;
const messageOf=event=>event.data?.message??(event.data?.role?event.data:null);
const callIdOf=message=>message?.source?.callId??message?.toolCallId;
const fileKey=(root,file)=>{
  const value=path.resolve(root??'.',file).replaceAll('\\','/');
  return process.platform==='win32'?value.toLowerCase():value;
};

export function recallCall(agent,{seq,offset=0,maxChars=16000}={}){
  if(!Number.isSafeInteger(seq)||seq<0||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(maxChars)||maxChars<256||maxChars>64000)throw new Error('Invalid historical call window');
  const event=agent.session.eventAt(seq),data=event?.data;
  if(!['tool/call','tool/ptc-dispatch-start','tool/ptc-dispatch','tool/code-dispatch-start','tool/code-dispatch'].includes(event?.type))return {status:'unavailable',seq,reason:'This event is not a recorded tool call.'};
  const text=typeof data.arguments==='string'?data.arguments:JSON.stringify(data.arguments??{}),end=Math.min(text.length,offset+maxChars);
  return {status:'observed',historical:true,kind:'call',seq,tool:data.name,offset,totalChars:text.length,text:text.slice(offset,end),nextOffset:end<text.length?end:null,
    complete:end>=text.length,...(event.type.endsWith('-start')?{executionOutcome:'not-observed-from-call-start'}:{}),note:'Original recorded arguments. The operation was not rerun.'};
}

/** Compact request-view receipt for a completed test/check run; canonical output stays exact. */
export function testOutputDigest(command,text,{seq=null,truncated=false}={}){
  if(typeof command!=='string'||!TEST_COMMAND.test(command.trim()))return null;
  if(typeof text!=='string'||text.length<TEST_MIN_CHARS||truncated||!Number.isSafeInteger(seq))return null;
  // A spill marker means this request view never held the complete output;
  // work_recall cannot recover a host-spilled body, so it must not be hidden.
  if(/\[output truncated; full output:|\[truncated\]/iu.test(text))return null;
  const failure=reportedCheckFailure(text),summary=failure?.summary??null,entries=failure?.failureEntries??[];
  if(!failure&&!/(?:^|\n)\s*(?:\d+\s+)?(?:passed|failed|ok|tests?|checks?)\b|(?:passed|failed|ok)\s+in\s+[\d.]+s/iu.test(text))return null;
  const failedLines=text.split(/\r?\n/u).filter(line=>/^\s*(?:FAILED|ERROR|not ok|\d+\s+(?:failed|failures))\b/iu.test(line)).slice(0,8);
  const detailLines=failure?[]:text.split(/\r?\n/u).filter(line=>/(?:Error|Exception|assert|AssertionError|File "|line \d+|Traceback)/iu.test(line)).slice(-10);
  const tail=text.slice(-TEST_TAIL_CHARS).split(/\r?\n/u).filter(line=>line.trim()).slice(-18).join('\n');
  const lines=['[work-evidence test receipt] command='+command.trim().slice(0,180)];
  if(summary&&Number.isInteger(summary.failed))lines.push('result: '+(summary.passed??'?')+' passed, '+summary.failed+' failed'+(summary.total?(' of '+summary.total):''));
  else if(entries.length)lines.push('result: '+entries.length+' named failures');
  if(entries.length)lines.push('failing: '+entries.slice(0,8).join(' | '));
  else if(failedLines.length)lines.push('failing: '+failedLines.join(' | '));
  if(detailLines.length)lines.push('details: '+detailLines.join(' | '));
  if(tail)lines.push('tail:\n'+tail);
  lines.push('The canonical output is unchanged and recoverable with work_recall kind=result'+(seq!==null?(' seq='+seq):'')+'.');
  const digest=lines.join('\n');
  return {text:digest.length<=TEST_DIGEST_MAX?digest:digest.slice(0,TEST_DIGEST_MAX-40)+'\n[receipt truncated; use work_recall for the full output]',
    signature:failure?.signature??null,summary,originalChars:text.length};
}

/** A request view only; canonical events and reasoning remain complete. */
export function createHistoryHygiene(runtime,taskFlow,{isProtected=()=>false,retainedSource=()=>false,canRecall=()=>false,referenceContext=null}={}){
  const states=new Map();
  function get(agent){
    let state=states.get(agent.session.id);
    if(!state){state={cursor:0,step:0,results:new Map(),failures:new Set(),pinnedCalls:new Set(),pinnedResults:new Set(),retainedSources:new Set(),
      outputPlans:new Map(),hiddenResults:new Set(),omittedSources:new Set(),liveReads:new Map(),observedPaths:new Map(),commands:new Map(),fullOutputRequested:false,requests:0,outputs:0,chars:0,testOutputViews:0,testOutputChars:0,restores:0,rereadPromotions:0};states.set(agent.session.id,state);}
    return state;
  }
  function rememberRead(state,root,read){
    if(!root||!read)return;
    const reads=state.liveReads.get(root)??new Map();
    if(reads.size<33&&!reads.has(read.callId))reads.set(read.callId,read);
    state.liveReads.set(root,reads);
  }
  function observe(exec,result){
    if(!exec.agent||!runtime.isEnabled(exec.agent)||!runtime.get(exec.agent).config.historyHygiene)return;
    const state=get(exec.agent),root=exec.rootCallId??exec.callId;
    rememberRead(state,root,readDispatch({...exec,subCallId:exec.callId,...result}));
    if(result.isError||hasPruneProblem(result.content??[],result.value))state.failures.add(root);
  }
  function sync(agent){
    const state=get(agent),events=eventLog(agent.session);
    while(state.cursor<events.length){
      const event=events[state.cursor++],data=event.data??{},message=messageOf(event);
      referenceContext?.consume(agent,event);
      if(event.type==='user/message'&&message)state.fullOutputRequested=/完整输出|全部输出|原始输出|full output/iu.test(resultText(message.content));
      if(event.type==='step/start')state.step++;
      if(['tool/call','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)){
        const args=argsOf(data.arguments);
        if(['pwsh','bash','ops_bash'].includes(data.name)&&typeof args?.command==='string'){
          if(state.commands.size>=64)state.commands.delete(state.commands.keys().next().value);
          state.commands.set(data.callId,{name:data.name,command:args.command});
        }
        if((data.name==='work_recall'&&args.kind!=='reference'&&(args.sourceSessionId===undefined||args.sourceSessionId===agent.session.id))||data.name==='work_state'&&args.mode==='recall'){
          const pins=args.kind==='call'?state.pinnedCalls:state.pinnedResults;
          if(Number.isSafeInteger(args.seq)&&!pins.has(args.seq)){
            pins.add(args.seq);state.restores++;
            if(args.kind!=='call'){
              const entry=[...state.results.values()].find(entry=>entry.seq===args.seq);
              const paths=[...(entry?.paths??[]),...(entry?.reads??[]).flatMap(read=>[read.meta?.path,read.value?.path,read.arguments?.file_path,read.arguments?.path])];
              for(const file of paths)if(typeof file==='string')state.retainedSources.add(fileKey(runtime.get(agent).root,file));
            }
          }
        }
      }
      if(['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)){
        const root=data.rootCallId;
        if(!root)continue;
        rememberRead(state,root,readDispatch(data));
        if(data.isError||hasPruneProblem(data.content??[],data.value))state.failures.add(root);
        const args=argsOf(data.arguments),paths=state.observedPaths.get(root)??new Set();
        for(const field of ['file_path','path','file'])if(typeof args[field]==='string'&&paths.size<12)paths.add(args[field]);
        state.observedPaths.set(root,paths);
      }
      if(event.type==='tool/result'&&event.surfaceOp?.op!=='replace'&&message){
        const id=callIdOf(message),text=resultText(message.content),command=state.commands.get(id)?.command??null;
        const digest=command?testOutputDigest(command,text,{seq:event.seq,truncated:event.data?.meta?.truncated===true}):null;
        state.commands.delete(id);
        const failed=!!message.isError||hasPruneProblem(message.content??[])||state.failures.has(id)||isProtected(agent,id);
        const record={seq:event.seq,step:state.step,callId:id,failed,reads:[...(state.liveReads.get(id)?.values()??[])],
          paths:[...(state.observedPaths.get(id)??[])],testDigest:digest?.text??null,testSignature:digest?.signature??null,testOriginalChars:digest?.originalChars??0};
        state.results.set(message.id,record);
        if(!failed&&record.reads.length){
          const printed=renderedReads(record.reads,resultText(message.content));
          for(const window of printed?.value?.items??[]){
            const key=fileKey(runtime.get(agent).root,window.path);
            if(state.omittedSources.has(key)&&!state.retainedSources.has(key)){state.retainedSources.add(key);state.rereadPromotions++;}
          }
        }
        state.liveReads.delete(id);state.observedPaths.delete(id);
      }
    }
    return state;
  }
  function project(agent,messages,{record=true}={}){
    if(!runtime.isEnabled(agent)||!runtime.get(agent).config.historyHygiene)return messages;
    if(!canRecall(agent)){if(record)get(agent).hiddenResults.clear();return messages;}
    const allowed=(feature,before,after,seq)=>{
      const economics=runtime.contextControl?.assess(agent,{messages:[before],proposedMessages:undefined,
        savedChars:JSON.stringify(before.content).length-JSON.stringify(after.content).length,changedSeq:seq,changedMessageId:before.id,
        savedTokensEstimate:Math.max(0,messageTokens(before)-messageTokens(after)),
        ...(feature==='referenceContext'?{route:runtime.currentSelection?.(agent)??null}:{})});
      if(record&&economics){runtime.contextControl.remember(agent,economics,feature);
        runtime.effects?.decide(agent,feature,economics.allowed?'approved':'deferred',economics.reason,{sourceSeq:seq,economics});}
      return economics?.allowed===true;
    };
    const config=runtime.get(agent).config;
    const pruneSettings={thresholdChars:config.contextPruneMinChars,headChars:config.contextPruneHeadChars,tailChars:config.contextPruneTailChars};
    const settingsKey=JSON.stringify(pruneSettings),state=sync(agent),pins=surfaceReferences(agent.session),root=runtime.get(agent).root,flow=taskFlow.phase(agent),focus=new Set((flow.focus??[]).map(file=>fileKey(root,file)));
    if(state.settingsKey!==settingsKey){state.outputPlans.clear();state.settingsKey=settingsKey;}
    let outputs=0,saved=0,testViews=0,testSaved=0;const hidden=new Set();
    const result=messages.map(message=>{
      if(message.role!=='tool')return message;
      const entry=state.results.get(message.id);
      if(entry?.testDigest&&state.step-entry.step>=1&&!state.fullOutputRequested&&!state.pinnedResults.has(entry.seq)&&!pins.opaque&&!pins.targets.has(entry.seq)){
        const reduction=resultText(message.content).length-entry.testDigest.length;
        if(reduction>=MIN_SAVING){
          const after={...message,content:[{type:'text',text:entry.testDigest}]};
          outputs++;saved+=reduction;testViews++;testSaved+=reduction;hidden.add(entry.seq);
          if(record){
            state.outputPlans.set(entry.seq,{test:true,content:after.content});
            runtime.effects?.rewrite(agent,{feature:'historyTestOutput',afterMessage:after,beforeMessages:[message],sourceSeqs:[entry.seq]});
            runtime.effects?.decide(agent,'historyTestOutput','applied','test-output-receipt',{seq:entry.seq,saved});
          }
          return after;
        }
      }
      if(!entry||entry.failed||isProtected(agent,entry.callId)||state.step-entry.step<AGE||state.pinnedResults.has(entry.seq)||pins.opaque||pins.targets.has(entry.seq))return message;
      // Reading is not evidence that the middle of a source is disposable.
      // Leave source windows to the existing larger, recoverable protocol.
      if(entry.reads.length)return message;
      const protect=file=>retainedSource(agent,file)||state.retainedSources.has(fileKey(root,file))||focus.has(fileKey(root,file));
      const original=agent.session.eventAt(entry.seq)?.data?.message;
      if(!original)return message;
      const existing=state.outputPlans.get(entry.seq);
      const planned=existing??planContextPrune(original,entry.reads,{seq:entry.seq,...pruneSettings,retainSource:protect});
      if(!planned)return message;
      const reduction=resultText(message.content).length-resultText(planned.content).length;
      if(reduction<MIN_SAVING)return message;
      const after={...message,content:planned.content};
      if(!existing&&!allowed('historyOutput',message,after,entry.seq))return message;
      outputs++;saved+=reduction;
      hidden.add(entry.seq);
      if(record){
        state.outputPlans.set(entry.seq,planned);
        for(const range of planned.ranges)if(range.path)state.omittedSources.add(fileKey(root,range.path));
        runtime.effects?.rewrite(agent,{feature:'historyOutput',afterMessage:after,beforeMessages:[message],sourceSeqs:[entry.seq]});
        runtime.effects?.decide(agent,'historyOutput','applied','message-rewrite-recorded',{seq:entry.seq});
        if(planned.dedupStats?.length)runtime.effects?.decide(agent,'historyBlockDedup','applied','history-output-segments',{seq:entry.seq,segments:planned.dedupStats});
      }
      return after;
    });
    if(record){state.hiddenResults=hidden;state.requests++;state.outputs+=outputs;state.chars+=saved;state.testOutputViews+=testViews;state.testOutputChars+=testSaved;}
    const toolView=outputs?result:messages;
    return referenceContext?.project(agent,toolView,{record,allowed})??toolView;
  }
  return {project(agent,messages,options){
      if(get(agent).suspended)return messages;
      try{return project(agent,messages,options);}catch(error){get(agent).suspended=true;get(agent).hiddenResults.clear();runtime.problem?.(runtime.get(agent),'history-hygiene',String(error.message));return messages;}
    },observe,hasRequestView(agent){const s=sync(agent);return runtime.isEnabled(agent)&&runtime.get(agent).config.historyHygiene&&!s.suspended&&(s.hiddenResults.size>0||referenceContext?.hasRequestView(agent)===true);},
    needsRecall(agent){
      if(!runtime.isEnabled(agent)||!runtime.get(agent).config.historyHygiene)return false;
      const s=sync(agent);if(s.suspended)return false;
      return [...s.results.values()].some(entry=>!entry.failed&&!entry.reads.length&&s.step-entry.step>=1&&
        resultText(agent.session.eventAt(entry.seq)?.data?.message?.content).length>=runtime.get(agent).config.contextPruneMinChars);
    },
    bodyVisible(agent,seq){return !runtime.isEnabled(agent)||!runtime.get(agent).config.historyHygiene||get(agent).suspended||!get(agent).hiddenResults.has(seq)&&referenceContext?.bodyVisible(agent,seq)!==false;},
    manages(agent,seq){return runtime.isEnabled(agent)&&runtime.get(agent).config.historyHygiene&&!get(agent).suspended&&(get(agent).hiddenResults.has(seq)||referenceContext?.manages(agent,seq)===true);},
    retainsSource(agent,file){return get(agent).retainedSources.has(fileKey(runtime.get(agent).root,file));},
    summary(agent){const s=sync(agent),references=referenceContext?.summary(agent)??null;return {enabled:runtime.isEnabled(agent)&&runtime.get(agent).config.historyHygiene,requestViews:s.requests,outputViews:s.outputs,testOutputViews:s.testOutputViews,
      charsRemovedAcrossViews:s.chars+(references?.charsRemovedAcrossViews??0),toolOutputCharsRemovedAcrossViews:s.chars-s.testOutputChars,testOutputCharsRemoved:s.testOutputChars,
      explicitRecoveries:s.restores,rereadPromotions:s.rereadPromotions,retainedCalls:s.pinnedCalls.size,retainedResults:s.pinnedResults.size,suspended:!!s.suspended,
      referenceContext:references,reasoning:'unchanged',canonicalHistory:'unchanged'};},
    disposeAgent(agent){referenceContext?.disposeAgent(agent);states.delete(agent.session.id);},dispose(){referenceContext?.dispose();states.clear();}};
}
