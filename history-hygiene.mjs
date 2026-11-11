import path from 'node:path';
import {argsOf,eventLog} from './runtime.mjs';
import {planContextPrune,readDispatch,hasPruneProblem} from './context-pruning.mjs';
import {resultText,surfaceReferences} from './visible-results.mjs';
import {renderedReads} from './observation-ledger.mjs';
import {messageTokens} from './context-economics.mjs';
import {reportedCheckFailure} from './recovery.mjs';

const AGE=2,MIN_SAVING=512;
const TEST_MIN_CHARS=4000,TEST_TAIL_CHARS=1800,TEST_DIGEST_MAX=4000,TOOL_MIN_CHARS=12000,TOOL_DIGEST_MAX=5000;
const FULL_OUTPUT_REQUEST=/完整输出|全部输出|原始输出|full output|full canonical output/iu;
/** TAP (`node --test`) reports its own exact counts; require all three so a
 *  truncated or unrelated body is never hidden behind a receipt. */
function tapCheckFailure(text){
  const tests=/^# tests (\d+)\s*$/mu.exec(text),pass=/^# pass (\d+)\s*$/mu.exec(text),fail=/^# fail (\d+)\s*$/mu.exec(text);
  if(!tests||!pass||!fail)return null;
  const total=Number(tests[1]),passed=Number(pass[1]),failed=Number(fail[1]);
  if(![total,passed,failed].every(Number.isSafeInteger)||passed+failed>total)return null;
  const entries=text.split(/\r?\n/u).filter(line=>/^not ok \d+ - /u.test(line)).slice(0,8).map(line=>line.slice(0,180));
  // Keep the first distinct error causes: without them a receipt hides why the
  // suite is unusable and the model re-runs the whole suite to find out.
  // Node TAP puts the cause either on a `XxxError: message` line or inside the
  // YAML diagnostic as `name: 'AssertionError'` plus an `error: |-` block.
  const seen=new Set(),causes=[];
  const addCause=(name,message)=>{
    let body=message??'';
    if(body&&name&&(body.startsWith(name+':')||body.startsWith(name+' ')))body=body.slice(name.length).replace(/^[:\s]+/u,'').trim();
    const text=(body?name+': '+body:name).replace(/\s+/gu,' ').trim().slice(0,200);
    if(!text||seen.has(text))return true;
    seen.add(text);causes.push(text);
    return causes.length<3;
  };
  const lines=text.split(/\r?\n/u);
  // Node emits TAP diagnostics in an order that varies between versions:
  // 22.19 writes `error: |-` before `name: 'AssertionError'`. Parse whole
  // diagnostic blocks so field order cannot hide the cause.
  const blocks=[];
  let block=null;
  for(const line of lines){
    const trimmed=line.trim();
    if(trimmed==='---'){block=[];continue;}
    if(trimmed==='...'){if(block)blocks.push(block);block=null;continue;}
    if(block)block.push(line);
  }
  const indentOf=line=>line.length-line.trimStart().length;
  for(const entries of blocks){
    let name='',message='';
    for(let index=0;index<entries.length;index++){
      const trimmed=entries[index].trim();
      const named=/^name:\s*'([^']*(?:Error|Exception)[^']*)'\s*$/u.exec(trimmed);
      if(named){name=named[1];continue;}
      if(/^error:\s*(?:\||\|-)\s*$/u.test(trimmed)){
        const base=indentOf(entries[index]);
        for(let next=index+1;next<entries.length;next++){
          const candidate=entries[next];
          if(!candidate.trim())continue;
          if(indentOf(candidate)<=base&&/^[A-Za-z_][\w-]*:/u.test(candidate.trim()))break;
          message=candidate.trim();break;
        }
        continue;
      }
      const inline=/^error:\s*(?![|])(.+)$/u.exec(trimmed);
      if(inline)message=inline[1].replace(/^['"]|['"]$/gu,'');
    }
    if((name||message)&&!addCause(name||'TAP failure',message))break;
  }
  if(causes.length<3){
    for(const line of lines){
      const direct=/^(?:#\s*)?((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Error|Exception)):\s*(.{1,160})$/u.exec(line.trim());
      if(direct&&!addCause(direct[1],direct[2]))break;
    }
  }
  return {signature:entries[0]??`${failed} failed, ${passed} passed of ${total}`,
    summary:{passed,failed,total,source:'reported-tap',text:`# tests ${total}\n# pass ${passed}\n# fail ${failed}`},failureEntries:entries,causes};
}
function extractedCauses(text){
  const out=[];
  for(const line of text.split(/\r?\n/u)){
    if(!/(?:ERROR|FAILED|AssertionError|Exception|Caused by|What went wrong|\[ERROR\])/iu.test(line))continue;
    const value=line.replace(/^\s*(?:\[ERROR\]|ERROR|FAILED)\s*/iu,'').replace(/^[-: ]+/u,'').trim();
    if(!value||value.length<4)continue;
    const key=value.slice(0,200);
    if(!out.includes(key))out.push(key);
    if(out.length>=3)break;
  }
  return out;
}
const TEST_COMMAND=/^(?:python(?:\.exe)?\s+-m\s+(?:pytest|compileall)|node\s+--test|ruff\s+check|(?:.\\|.\/)?mvnw(?:\.cmd)?|(?:\.\\|\.\/)?gradlew(?:\.bat)?|gradle(?:\.bat)?|mvn(?:\.cmd)?)\b/iu;
export function toolOutputDigest(name,text,{seq=null,command=null,truncated=false}={}){
  if(typeof name!=='string'||!['pwsh','bash','ops_bash','work_exec','grep','glob'].includes(name))return null;
  if(typeof text!=='string'||text.length<TOOL_MIN_CHARS||!Number.isSafeInteger(seq)||truncated)return null;
  // Check commands are owned by testOutputDigest: a rejected (failing/truncated)
  // check must keep its canonical body instead of being replaced by this generic receipt.
  if(TEST_COMMAND.test(String(command??'').trim()))return null;
  if(/\[output truncated; full output:|\[truncated\]/iu.test(text))return null;
  const failureLines=text.split(/\r?\n/u).filter(line=>/ERROR|FAILED|Exception|not ok|Traceback|What went wrong/iu.test(line)).slice(0,8).map(line=>line.slice(0,300));
  const head=text.slice(0,2000),tail=text.slice(-2500);
  const header='[work-evidence output receipt] tool='+name+(command?' command='+String(command).trim().slice(0,180):'');
  const locator='The canonical output is unchanged and recoverable with work_recall kind=output seq='+seq+'.';
  const prefix=header+'\nhead:\n'+head+'\n',suffix='tail:\n'+tail+'\n'+locator;
  const errorBudget=Math.max(0,TOOL_DIGEST_MAX-prefix.length-suffix.length-'errors:\n\n'.length);
  const errors=failureLines.join('\n').slice(0,errorBudget);
  const digest=prefix+(errors?'errors:\n'+errors+'\n':'')+suffix;
  return {text:digest,originalChars:text.length,signature:null};
}
const messageOf=event=>event.data?.message??(event.data?.role?event.data:null);
/** Only a genuine user request may suspend request-view receipts. Plugin-injected
 *  guidance can mention "原始输出" while describing a failure; treating that as a
 *  user request silently restores every canonical test output into the next request. */
export function fullOutputRequest(event){
  if(!event||event.type!=='user/message')return {applies:false,requested:false};
  const message=messageOf(event);
  if(!message)return {applies:false,requested:false};
  const kind=message.source?.kind;
  if(kind!==undefined&&kind!=='user'&&!(kind==='user-question-reply'&&message.source.outcome==='answered'))
    return {applies:false,requested:false};
  return {applies:true,requested:FULL_OUTPUT_REQUEST.test(resultText(message.content))};
}
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
export function testOutputDigest(command,text,{seq=null,truncated=false,focus=[],filterEnvironment=true}={}){
  if(typeof command!=='string'||!TEST_COMMAND.test(command.trim()))return null;
  const isNodeTest=/node\s+--test/iu.test(command);
  if(typeof text!=='string'||text.length<TEST_MIN_CHARS||truncated||!Number.isSafeInteger(seq))return null;
  // A spill marker means this request view never held the complete output;
  // work_recall cannot recover a host-spilled body, so it must not be hidden.
  if(/\[output truncated; full output:|\[truncated\]/iu.test(text))return null;
  const failure=isNodeTest?tapCheckFailure(text):reportedCheckFailure(text),summary=failure?.summary??null,entries=failure?.failureEntries??[];
  const failedLines=text.split(/\r?\n/u).filter(line=>/^\s*(?:FAILED|ERROR|not ok|[1-9]\d*\s+(?:failed|failures))\b/iu.test(line));
  // Non-TAP check outputs do not carry structured failure causes. Projecting a passing run is safe;
  // projecting a failing run hides the diagnostic detail the model needs and triggers reruns.
  const isMavenGradle=/^(?:.\\|.\/)?(?:mvnw(?:\.cmd)?|mvn(?:\.cmd)?|gradlew(?:\.bat)?|gradle(?:\.bat)?)\b/iu.test(command.trim());
  if(!isNodeTest&&!isMavenGradle&&(failedLines.length>0||(summary&&Number.isInteger(summary.failed)&&summary.failed>0)))return null;
  if(isNodeTest&&!failure)return null;
  if(!failure&&!/(?:^|\n)\s*(?:\[INFO\]\s*)?(?:\d+\s+(?:passed|failed|skipped|errors?|tests?|checks?)\b|(?:Tests run|tests|checks)\s*:\s*\d+\b)/iu.test(text))return null;
  const environmentFailure=/FileNotFoundError|WinError|PermissionError|\[Errno \d+\]|No such file or directory|Access is denied|Cannot find path|ModuleNotFoundError/iu;
  const focusPaths=Array.isArray(focus)?focus.filter(item=>typeof item==='string'&&item):[];
  const actionableEntries=filterEnvironment?entries.filter(entry=>!environmentFailure.test(entry)):entries;
  const failureLinesOnly=failedLines.filter(line=>/^\s*(?:FAILED|ERROR|not ok)\b/iu.test(line));
  if(filterEnvironment&&(entries.length||failureLinesOnly.length)&&!actionableEntries.length&&!failureLinesOnly.some(line=>!environmentFailure.test(line)))return null;
  const focusEntries=focusPaths.length?actionableEntries.filter(entry=>focusPaths.some(item=>entry.includes(item))):[];
  const shownEntries=focusEntries.length?focusEntries:actionableEntries.length?actionableEntries:entries;
  const actionableFailed=filterEnvironment?failedLines.filter(line=>!environmentFailure.test(line)):failedLines;
  const focusFailed=focusPaths.length?actionableFailed.filter(line=>focusPaths.some(item=>line.includes(item))):[];
  const shownFailed=focusFailed.length?focusFailed:actionableFailed.length?actionableFailed:failedLines;
  const detailLines=failure?[]:text.split(/\r?\n/u).filter(line=>/(?:Error|Exception|assert|AssertionError|File "|line \d+|Traceback)/iu.test(line)).slice(-10);
  const tail=text.slice(-TEST_TAIL_CHARS).split(/\r?\n/u).filter(line=>line.trim()).slice(-18).join('\n');
  const lines=['[work-evidence test receipt] command='+command.trim().slice(0,180)];
  if(summary&&Number.isInteger(summary.failed))lines.push('result: '+(summary.passed??'?')+' passed, '+summary.failed+' failed'+(summary.total?(' of '+summary.total):''));
  else if(entries.length)lines.push('result: '+entries.length+' named failures');
  if(shownEntries.length)lines.push('failing: '+shownEntries.slice(0,8).join(' | '));
  else if(shownFailed.length)lines.push('failing: '+shownFailed.slice(0,8).join(' | '));
  const environmentCount=filterEnvironment?(entries.filter(entry=>environmentFailure.test(entry)).length+(entries.length?0:failedLines.filter(line=>environmentFailure.test(line)).length)):0;
  if(environmentCount>0)lines.push('environment-like failures omitted: '+environmentCount+' (canonical output retains them).');
  if(detailLines.length)lines.push('details: '+detailLines.join(' | '));
  const causes=failure?.causes?.length?failure.causes:extractedCauses(text);
  if(causes.length)lines.push('causes: '+causes.join(' | '));
  if(tail)lines.push('tail:\n'+tail);
  const locator='The canonical output is unchanged and recoverable with work_recall kind=output'+(seq!==null?(' seq='+seq):'')+'.';
  const body=lines.join('\n');
  const digest=body.length+locator.length+1<=TEST_DIGEST_MAX?body+'\n'+locator:body.slice(0,Math.max(0,TEST_DIGEST_MAX-locator.length-2))+'\n'+locator;
  return {text:digest,
    signature:failure?.signature??null,summary,originalChars:text.length};
}

/** A request view only; canonical events and reasoning remain complete. */
export function createHistoryHygiene(runtime,taskFlow,{isProtected=()=>false,retainedSource=()=>false,canRecall=()=>false,referenceContext=null}={}){
  const states=new Map();
  function get(agent){
    let state=states.get(agent.session.id);
    if(!state){state={cursor:0,step:0,results:new Map(),failures:new Set(),pinnedCalls:new Set(),pinnedResults:new Set(),retainedSources:new Set(),
      outputPlans:new Map(),hiddenResults:new Set(),omittedSources:new Set(),liveReads:new Map(),observedPaths:new Map(),commands:new Map(),toolCalls:new Map(),fullOutputRequested:false,requests:0,outputs:0,chars:0,testOutputViews:0,testOutputChars:0,restores:0,rereadPromotions:0};states.set(agent.session.id,state);}
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
      const fullOutput=fullOutputRequest(event);
      if(fullOutput.applies)state.fullOutputRequested=fullOutput.requested;
      if(event.type==='step/start')state.step++;
      if(['tool/call','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)){
        const args=argsOf(data.arguments);
        if(data.callId)state.toolCalls.set(data.callId,{name:data.name,arguments:data.arguments});
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
        const id=callIdOf(message),text=resultText(message.content),command=state.commands.get(id)?.command??null,call=state.toolCalls.get(id);
        if(id)state.toolCalls.delete(id);
        const baseFocus=(()=>{try{return taskFlow.phase(agent)?.focus??[]}catch{return []}})();
        const isPytest=/^python(?:\.exe)?\s+-m\s+pytest/iu.test(command??'');
        const testFocus=isPytest?['tests/']:[];
        const digest=command?testOutputDigest(command,text,{seq:event.seq,truncated:event.data?.meta?.truncated===true,focus:[...baseFocus,...testFocus],filterEnvironment:isPytest}):null;
        const failed=!!message.isError||hasPruneProblem(message.content??[])||state.failures.has(id)||isProtected(agent,id);
        const toolDigest=!digest&&!failed&&call?toolOutputDigest(call.name,text,{seq:event.seq,command,truncated:event.data?.meta?.truncated===true}):null;
        state.commands.delete(id);
        const record={seq:event.seq,step:state.step,callId:id,failed,reads:[...(state.liveReads.get(id)?.values()??[])],
          paths:[...(state.observedPaths.get(id)??[])],testDigest:digest?.text??null,testSignature:digest?.signature??null,testOriginalChars:digest?.originalChars??0,toolDigest:toolDigest?.text??null,toolOriginalChars:toolDigest?.originalChars??0};
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
      if(entry?.testDigest&&!isProtected(agent,entry.callId)&&state.step-entry.step>=1&&!state.fullOutputRequested&&!state.pinnedResults.has(entry.seq)&&!pins.opaque&&!pins.targets.has(entry.seq)){
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
      if(entry?.toolDigest&&!isProtected(agent,entry.callId)&&runtime.get(agent).config?.swLedger!==true&&state.step-entry.step>=1&&!state.fullOutputRequested&&!state.pinnedResults.has(entry.seq)&&!pins.opaque&&!pins.targets.has(entry.seq)){
        const reduction=resultText(message.content).length-entry.toolDigest.length;
        if(reduction>=MIN_SAVING){
          const after={...message,content:[{type:'text',text:entry.toolDigest}]};
          outputs++;saved+=reduction;hidden.add(entry.seq);
          if(record){
            state.outputPlans.set(entry.seq,{test:false,tool:true,content:after.content});
            runtime.effects?.rewrite(agent,{feature:'historyOutput',afterMessage:after,beforeMessages:[message],sourceSeqs:[entry.seq]});
            runtime.effects?.decide(agent,'historyOutput','applied','oversized-tool-output-receipt',{seq:entry.seq,saved});
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
      if(existing?.test||existing?.tool)return message;
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
    fullOutputRequested(agent){sync(agent);return get(agent).fullOutputRequested;},
    needsRecall(agent){
      if(!runtime.isEnabled(agent)||!runtime.get(agent).config.historyHygiene)return false;
      const s=sync(agent);if(s.suspended)return false;
      return [...s.results.values()].some(entry=>!entry.failed&&!entry.reads.length&&s.step-entry.step>=1&&
        resultText(agent.session.eventAt(entry.seq)?.data?.message?.content).length>=runtime.get(agent).config.contextPruneMinChars);
    },
    bodyVisible(agent,seq){
      if(!runtime.isEnabled(agent)||!runtime.get(agent).config.historyHygiene)return true;
      const s=sync(agent);return s.suspended||s.fullOutputRequested||!s.hiddenResults.has(seq)&&referenceContext?.bodyVisible(agent,seq)!==false;
    },
    manages(agent,seq){return runtime.isEnabled(agent)&&runtime.get(agent).config.historyHygiene&&!get(agent).suspended&&(get(agent).hiddenResults.has(seq)||referenceContext?.manages(agent,seq)===true);},
    retainsSource(agent,file){return get(agent).retainedSources.has(fileKey(runtime.get(agent).root,file));},
    summary(agent){const s=sync(agent),references=referenceContext?.summary(agent)??null;return {enabled:runtime.isEnabled(agent)&&runtime.get(agent).config.historyHygiene,requestViews:s.requests,outputViews:s.outputs,testOutputViews:s.testOutputViews,
      charsRemovedAcrossViews:s.chars+(references?.charsRemovedAcrossViews??0),toolOutputCharsRemovedAcrossViews:s.chars-s.testOutputChars,testOutputCharsRemoved:s.testOutputChars,
      explicitRecoveries:s.restores,rereadPromotions:s.rereadPromotions,retainedCalls:s.pinnedCalls.size,retainedResults:s.pinnedResults.size,suspended:!!s.suspended,
      referenceContext:references,reasoning:'unchanged',canonicalHistory:'unchanged'};},
    disposeAgent(agent){referenceContext?.disposeAgent(agent);states.delete(agent.session.id);},dispose(){referenceContext?.dispose();states.clear();}};
}
