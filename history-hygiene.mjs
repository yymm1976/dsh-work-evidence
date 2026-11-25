import path from 'node:path';
import {argsOf,eventLog} from './runtime.mjs';
import {isSourceBodyPath,isSourceBody,planContextPrune,readDispatch,hasPruneProblem,sourceBodyPaths} from './context-pruning.mjs';
import {resultText,surfaceReferences} from './visible-results.mjs';
import {renderedReads} from './observation-ledger.mjs';
import {messageTokens,textTokens} from './context-economics.mjs';
import {reportedCheckFailure} from './recovery.mjs';
import {physicalPathKey} from './evidence.mjs';

const AGE=2,MIN_SAVING=512,MAX_CANDIDATE_PLANS=32;
const TEST_MIN_CHARS=4000,TEST_TAIL_CHARS=1800,TEST_DIGEST_MAX=4000,TOOL_MIN_CHARS=12000,TOOL_DIGEST_MAX=5000;
const FULL_OUTPUT_REQUEST=/(?:完整|全部|原始)(?:的)?(?:工具|命令)?输出|\b(?:full|raw)(?:\s+(?:canonical|tool|command))?\s+output\b/iu;
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
  if(typeof name!=='string'||!['pwsh','bash','work_exec','grep','glob'].includes(name))return null;
  if(typeof text!=='string'||text.length<TOOL_MIN_CHARS||!Number.isSafeInteger(seq)||truncated)return null;
  // Check commands are owned by testOutputDigest: a rejected (failing/truncated)
  // check must keep its canonical body instead of being replaced by this generic receipt.
  if(TEST_COMMAND.test(String(command??'').trim()))return null;
  if(/\[output truncated; full output:|\[truncated\]/iu.test(text))return null;
  // A source body is never replaced by a head/tail receipt, whatever produced it: a shell
  // `cat` returns the whole file with no native read dispatch and no markup, and hiding its
  // middle makes the task re-read exactly the part that was hidden.
  if(isSourceBody(text,{transport:['pwsh','bash','work_exec','run_code'].includes(name)}))return null;
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
  return physicalPathKey(root,file);
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
  // A check command can print a source body next to passing totals. This function is the
  // innermost producer of a receipt, so the retention rule has to hold here too: every
  // caller that forgot to ask would otherwise reduce the body to a summary of its own tail.
  if(isSourceBody(text))return null;
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

/** Render the native MatchInfo line format with one common path prefix. */
export function compactPowerShellMatchPaths(text,root,command){
  if(typeof command!=='string'||!/^\s*Select-String\s/iu.test(command)||
    typeof text!=='string'||text.length<2*MIN_SAVING||typeof root!=='string'||!path.isAbsolute(root)||
    /\[(?:output truncated|truncated|stderr|exit code:|timed out|still running)/iu.test(text))return text;
  const prefix=path.normalize(root).replace(/[\\/]+$/u,'')+path.sep;
  // Without context markers, require a complete block of absolute MatchInfo rows.
  const unprefixed=text.trimStart().startsWith(prefix)&&text.split(/\r?\n/u).every(row=>
    !row.trim()||row.startsWith(prefix)&&/^[^:]+:[1-9]\d*:/u.test(row.slice(prefix.length)));
  let matches=0;
  const relative=text.replace(/^(> | {2})?([^\r\n]+?):([1-9]\d*):/gmu,(line,lead,file,number)=>{
    if((!lead&&!unprefixed)||!file.startsWith(prefix)||file.length===prefix.length)return line;
    matches++;
    return (lead??'')+file.slice(prefix.length)+':'+number+':';
  });
  const shortened='[Select-String path prefix: '+prefix+']\n'+relative;
  return matches>=2&&text.length-shortened.length>=MIN_SAVING?shortened:text;
}

/** Share the workspace prefix of a single-column FullName table without changing any displayed rows. */
export function compactPowerShellInventoryPaths(text,root,command){
  if(typeof command!=='string'||!/^\s*Get-ChildItem\s/iu.test(command)||
    typeof text!=='string'||text.length<2*MIN_SAVING||typeof root!=='string'||!path.isAbsolute(root)||
    /\[(?:output truncated|truncated|stderr|exit code:|timed out|still running)/iu.test(text))return text;
  const header=/^(?:\r?\n)*FullName[ \t]*\r?\n-{8}[ \t]*\r?\n/u.exec(text)?.[0];
  if(!header)return text;
  const prefix=path.normalize(root).replace(/[\\/]+$/u,'')+path.sep;
  const rows=text.slice(header.length).split('\n');
  if(rows.some(row=>row.trim()&&(!row.startsWith(prefix)||!row.slice(prefix.length).trim())))return text;
  const relative=rows.map(row=>row.startsWith(prefix)?row.slice(prefix.length):row).join('\n');
  const shortened='[FullName path prefix: '+prefix+']\n'+header+relative;
  return text.length-shortened.length>=MIN_SAVING?shortened:text;
}

/** Use a proven matched excerpt when the native head preview hides every literal alternative. */
export function compactNativeGrepPreviews(text,matches,pattern){
  if(typeof text!=='string'||!text.includes(' (line truncated)')||!/^Found \d+ (?:match|matches)\n\n/u.test(text)||
    !Array.isArray(matches)||typeof pattern!=='string'||pattern.length>512||
    !/^[\p{L}\p{N}_ -]+(?:\|[\p{L}\p{N}_ -]+)*$/u.test(pattern))return text;
  const terms=pattern.split('|'),sections=text.split('\n\n');
  if(terms.length>32||terms.some(term=>!term.trim()))return text;
  const linesByPath=new Map();
  for(const match of matches){
    if(typeof match?.path!=='string'||!Number.isSafeInteger(match.lineNumber)||typeof match.line!=='string')continue;
    let lines=linesByPath.get(match.path);
    if(!lines){lines=new Map();linesByPath.set(match.path,lines);}
    if(lines.has(match.lineNumber))lines.set(match.lineNumber,null);
    else lines.set(match.lineNumber,match.line);
  }
  for(let index=1;index<sections.length;index++){
    const [file,...rows]=sections[index].split('\n'),lines=linesByPath.get(file);
    if(!lines)continue;
    const rendered=rows.map(row=>{
      const match=/^Line ([1-9]\d*): (.*) \(line truncated\)$/u.exec(row);
      if(!match)return row;
      const [,number,preview]=match,source=lines.get(Number(number));
      if(typeof source!=='string'||source.length<=preview.length||!source.startsWith(preview))return row;
      let position=Infinity,length=0;
      for(const term of terms){
        const start=source.indexOf(term);
        if(start<0)continue;
        if(start+term.length<=preview.length)return row;
        if(start<position){position=start;length=term.length;}
      }
      if(position===Infinity)return row;
      let start=Math.max(0,position-64),end=Math.min(source.length,position+length+96);
      if(start>0&&/[\uDC00-\uDFFF]/u.test(source[start]))start--;
      if(end<source.length&&/[\uDC00-\uDFFF]/u.test(source[end]))end++;
      const excerpt=(start>0?'…':'')+source.slice(start,end)+(end<source.length?'…':'');
      const replacement=`Line ${number}: ${excerpt} (matched excerpt; line truncated)`;
      return row.length-replacement.length>=MIN_SAVING?replacement:row;
    });
    sections[index]=[file,...rendered].join('\n');
  }
  return sections.join('\n\n');
}

/** Summarize definition lines already present in a native grep result. */
export function grepDefinitionSummary(text){
  if(typeof text!=='string'||!text.startsWith('Found ')||text.includes('\nDefinition hits ('))return text;
  const definitions=[];
  let file=null;
  for(const row of text.split(/\r?\n/u)){
    if(!row.trim())continue;
    if(!/^Line [1-9]\d*: /u.test(row)){
      if(!/^Found \d+ /u.test(row))file=row;
      continue;
    }
    if(!file)continue;
    const match=/^Line ([1-9]\d*): (.*)$/u.exec(row);
    if(!match)continue;
    const declaration=/^\s*(?:async\s+)?(?:def|class|function)\s+([A-Za-z_$][\w$]*)/u.exec(match[2]);
    if(!declaration)continue;
    definitions.push({file,line:Number(match[1]),name:declaration[1]});
  }
  if(definitions.length<2)return text;
  const shown=definitions.slice(0,8).map(item=>item.file+':'+item.line+' '+item.name);
  const extra=definitions.length-shown.length;
  return 'Definition hits ('+definitions.length+'): '+shown.join('; ')+(extra?' ; +'+extra+' more':'')+'\n\n'+text;
}

/** A request view only; canonical events and reasoning remain complete. */
export function createHistoryHygiene(runtime,taskFlow,{isProtected=()=>false,retainedSource=()=>false,canRecall=()=>false,referenceContext=null}={}){
  const states=new Map();
  function get(agent){
    let state=states.get(agent.session.id);
    if(!state){state={cursor:0,step:0,results:new Map(),failures:new Set(),pinnedCalls:new Set(),pinnedResults:new Set(),retainedSources:new Set(),
      outputPlans:new Map(),candidatePlans:new Map(),hiddenResults:new Set(),omittedSources:new Set(),liveReads:new Map(),liveGrepViews:new Map(),observedPaths:new Map(),commands:new Map(),toolCalls:new Map(),fullOutputRequested:false,requests:0,outputs:0,chars:0,testOutputViews:0,testOutputChars:0,restores:0,rereadPromotions:0,definitionSummaryCalls:0,definitionSummaryCandidateCalls:0,definitionSummarySentCalls:0,definitionSummaryCompactedChars:0,definitionSummaryCandidateInjectedChars:0,definitionSummaryInjectedChars:0,definitionSummaryObservedInjectedChars:0,definitionSummaryProjectedInjectedChars:0,definitionSummaryProjectionCalls:0};states.set(agent.session.id,state);}
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
    else if(exec.name==='grep'&&!exec.parent&&result.content?.length===1&&result.content[0].type==='text'){
      const before=result.content[0].text;
      const compacted=compactNativeGrepPreviews(before,result.value?.matches,argsOf(exec.arguments).pattern);
      const summary=grepDefinitionSummary(compacted),candidate=summary!==compacted;
      const after=runtime.get(exec.agent).config.definitionSummary==='on'&&candidate?summary:compacted;
      if(compacted!==before)state.definitionSummaryCompactedChars+=Math.max(0,before.length-compacted.length);
      if(candidate){
        const injected=Math.max(0,summary.length-compacted.length);
        state.definitionSummaryCandidateCalls=(state.definitionSummaryCandidateCalls??0)+1;
        state.definitionSummaryCandidateInjectedChars=(state.definitionSummaryCandidateInjectedChars??0)+injected;
      }
      if(after!==compacted){
        state.definitionSummaryCalls++;
        state.definitionSummarySentCalls=(state.definitionSummarySentCalls??0)+1;
        const injected=Math.max(0,after.length-compacted.length);
        state.definitionSummaryInjectedChars+=injected;
        state.definitionSummaryObservedInjectedChars+=injected;
      }
      if(after!==before){
        if(state.liveGrepViews.size>=64)state.liveGrepViews.delete(state.liveGrepViews.keys().next().value);
        state.liveGrepViews.set(exec.callId,{before,after,definitionSummaryInjectedChars:Math.max(0,after.length-compacted.length)});
      }
    }
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
        if(['pwsh','bash'].includes(data.name)&&typeof args?.command==='string'){
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
        const grepView=state.liveGrepViews.get(id);
        state.liveGrepViews.delete(id);
        if(id)state.toolCalls.delete(id);
        const textOnly=Array.isArray(message.content)&&message.content.every(block=>block?.type==='text');
        let digest=null;
        if(command&&textOnly&&text.length>=TEST_MIN_CHARS&&TEST_COMMAND.test(command.trim())){
          const isPytest=/^python(?:\.exe)?\s+-m\s+pytest/iu.test(command);
          let focus=[];
          try{focus=taskFlow.phase(agent)?.focus??[];}catch{}
          digest=testOutputDigest(command,text,{seq:event.seq,truncated:event.data?.meta?.truncated===true,
            focus:isPytest?[...focus,'tests/']:focus,filterEnvironment:isPytest});
        }
        const failed=!!message.isError||hasPruneProblem(message.content??[])||state.failures.has(id)||isProtected(agent,id);
        const toolDigest=textOnly&&!digest&&!failed&&call?toolOutputDigest(call.name,text,{seq:event.seq,command,truncated:event.data?.meta?.truncated===true}):null;
        state.commands.delete(id);
        let initialOutputView=textOnly&&!failed&&grepView?.before===text?
          {text:grepView.after,reason:'native-grep-match-excerpt',definitionSummaryInjectedChars:grepView.definitionSummaryInjectedChars??0}:null;
        if(textOnly&&!failed&&call?.name==='pwsh'&&event.data?.meta?.truncated!==true){
          const root=runtime.get(agent).root;
          const matches=compactPowerShellMatchPaths(text,root,command);
          if(matches!==text)initialOutputView={text:matches,reason:'powershell-match-path-prefix'};
          else if(message.content.length===1){
            const inventory=compactPowerShellInventoryPaths(text,root,command);
            if(inventory!==text)initialOutputView={text:inventory,reason:'powershell-inventory-path-prefix'};
          }
        }
        const transport=!!call&&['pwsh','bash','work_exec','run_code'].includes(call.name);
        const record={seq:event.seq,step:state.step,callId:id,failed,textOnly,textLength:text.length,transport,
          initialOutputView,reads:[...(state.liveReads.get(id)?.values()??[])],
          paths:[...(state.observedPaths.get(id)??[])],testDigest:digest?.text??null,toolDigest:toolDigest?.text??null};
        state.results.set(message.id,record);
        if(!failed&&record.reads.length){
          const printed=renderedReads(record.reads,text);
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
    const config=runtime.get(agent).config;
    let pricingSettings;
    const allowed=(feature,before,after,seq,entry=null,savedTokensEstimate=Math.max(0,messageTokens(before)-messageTokens(after)))=>{
      const economics=runtime.contextControl?.assess(agent,{messages:[before],changedSeq:seq,changedMessageId:before.id,savedTokensEstimate,
        ...(feature==='referenceContext'?{route:runtime.currentSelection?.(agent)??null}:{})});
      if(record&&economics){
        runtime.contextControl.remember(agent,economics,feature);
        let details={sourceSeq:seq,economics};
        if(entry){
          pricingSettings??=JSON.stringify([config.projectionPricing,config.projectionHorizonSteps]);
          const signature=JSON.stringify([economics.reason,economics.route,economics.pricingSource,economics.currency]);
          const prior=entry.deferredEconomics;
          if(economics.allowed)entry.deferredEconomics=null;
          else if(prior?.signature===signature&&prior.pricingSettings===pricingSettings){
            prior.count++;
            // Snapshot the trend sparsely, while preserving every outcome and the latest live estimate.
            if(!Number.isInteger(Math.log2(prior.count)))details={sourceSeq:seq};
          }else entry.deferredEconomics={signature,pricingSettings,count:1};
        }
        runtime.effects?.decide(agent,feature,economics.allowed?'approved':'deferred',economics.reason,details);
      }
      return economics?.allowed===true;
    };
    const pruneSettings={thresholdChars:config.contextPruneMinChars,headChars:config.contextPruneHeadChars,tailChars:config.contextPruneTailChars};
    const settingsKey=JSON.stringify(pruneSettings),state=sync(agent),pins=surfaceReferences(agent.session),root=runtime.get(agent).root,flow=taskFlow.phase(agent),focus=new Set((flow.focus??[]).map(file=>fileKey(root,file)));
    if(state.settingsKey!==settingsKey){
      state.outputPlans.clear();
      state.candidatePlans.clear();
      for(const entry of state.results.values())entry.deferredEconomics=null;
      state.settingsKey=settingsKey;
    }
    let outputs=0,saved=0,testViews=0,testSaved=0;const hidden=new Set();
    const result=messages.map(message=>{
      if(message.role!=='tool'||state.fullOutputRequested||pins.opaque)return message;
      const entry=state.results.get(message.id);
      if(!entry?.textOnly||state.step-entry.step<1||state.pinnedResults.has(entry.seq)||pins.targets.has(entry.seq)||isProtected(agent,entry.callId))return message;
      const original=agent.session.eventAt(entry.seq)?.data?.message;
      // A surface replacement may retain the message id while changing the body.
      // Receipts and prune plans describe only the captured canonical result.
      if(!original||message.isError!==original.isError||message.content!==original.content&&JSON.stringify(message.content)!==JSON.stringify(original.content))return message;
      if(entry.initialOutputView){
        const {text,reason,definitionSummaryInjectedChars=0}=entry.initialOutputView;
        const planned=state.outputPlans.get(entry.seq);
        const content=planned?.initial?planned.content:[{type:'text',text}];
        const after={...message,content};
        const reduction=entry.textLength-text.length;
        const firstSend=!entry.initialOutputProjected&&state.step-entry.step<=1;
        const optedInSummary=config.definitionSummary==='on'&&reason==='native-grep-match-excerpt'&&
          definitionSummaryInjectedChars>0;
        if(reduction<=0&&!optedInSummary)return message;
        if(!planned?.initial&&!firstSend){
          const approved=allowed('historyOutput',message,after,entry.seq,entry,Math.max(0,textTokens(message)-textTokens(after)));
          if(!approved)return message;
        }
        outputs++;saved+=reduction;hidden.add(entry.seq);
        if(record&&!planned?.initial&&!entry.initialOutputProjected){
          entry.initialOutputProjected=true;
          state.outputPlans.set(entry.seq,{initial:true,content});
          runtime.effects?.rewrite(agent,{feature:'historyOutput',afterMessage:after,beforeMessages:[message],sourceSeqs:[entry.seq]});
          runtime.effects?.decide(agent,'historyOutput','applied',
            firstSend?(optedInSummary?'initial-opted-in-definition-summary':'initial-unsent-output-view'):reason,
            {seq:entry.seq,savedChars:reduction,
              economics:firstSend?{allowed:true,reason:optedInSummary?'initial-opted-in-definition-summary':'initial-unsent-output-view',refillCostEstimate:0}:undefined});
        }
        if(definitionSummaryInjectedChars>0){
          state.definitionSummaryProjectionCalls++;
          state.definitionSummaryProjectedInjectedChars+=definitionSummaryInjectedChars;
        }
        return after;
      }
      if(entry.testDigest){
        const reduction=entry.textLength-entry.testDigest.length;
        if(reduction>=MIN_SAVING){
          const planned=state.outputPlans.get(entry.seq);
          const content=planned?.test?planned.content:[{type:'text',text:entry.testDigest}];
          const after={...message,content};
          if(!planned?.test&&!allowed('historyTestOutput',message,after,entry.seq,entry,Math.max(0,messageTokens(message)-messageTokens(after))))return message;
          outputs++;saved+=reduction;testViews++;testSaved+=reduction;hidden.add(entry.seq);
          if(record&&!planned?.test){
            state.outputPlans.set(entry.seq,{test:true,content});
            runtime.effects?.rewrite(agent,{feature:'historyTestOutput',afterMessage:after,beforeMessages:[message],sourceSeqs:[entry.seq]});
            runtime.effects?.decide(agent,'historyTestOutput','applied','test-output-receipt',{seq:entry.seq,saved});
          }
          return after;
        }
      }
      // The digest builder excludes source bodies, and this view still holds the exact captured content.
      if(entry.toolDigest&&config.swLedger!==true){
        const reduction=entry.textLength-entry.toolDigest.length;
        if(reduction>=MIN_SAVING){
          const after={...message,content:[{type:'text',text:entry.toolDigest}]};
          if(!state.outputPlans.get(entry.seq)?.tool){
            entry.toolSavings??=Math.max(0,messageTokens(original)-messageTokens(after));
            if(!allowed('historyOutput',message,after,entry.seq,entry,entry.toolSavings))return message;
          }
          outputs++;saved+=reduction;hidden.add(entry.seq);
          if(record){
            state.outputPlans.set(entry.seq,{test:false,tool:true,content:after.content});
            runtime.effects?.rewrite(agent,{feature:'historyOutput',afterMessage:after,beforeMessages:[message],sourceSeqs:[entry.seq]});
            runtime.effects?.decide(agent,'historyOutput','applied','oversized-tool-output-receipt',{seq:entry.seq,saved});
          }
          return after;
        }
      }
      if(entry.failed||state.step-entry.step<AGE||entry.textLength<=pruneSettings.thresholdChars)return message;
      // Reading is not evidence that the middle of a source is disposable.
      // Leave source windows to the existing larger, recoverable protocol.
      if(entry.reads.length)return message;
      // A result that names source code is the object of the repair, not a log: keep it
      // whole here too. Every prune entry point must give the same answer for the same
      // body, or one path silently undoes the retention the others enforce.
      const protect=file=>isSourceBodyPath(file)||retainedSource(agent,file)||state.retainedSources.has(fileKey(root,file))||focus.has(fileKey(root,file));
      const existing=state.outputPlans.get(entry.seq);
      if(existing?.test||existing?.tool)return message;
      entry.namedPaths??=sourceBodyPaths(resultText(original.content));
      if(entry.namedPaths.some(protect))return message;
      let planned=existing;
      if(!planned){
        planned=state.candidatePlans.get(entry.seq);
        if(planned===undefined){
          const draft=planContextPrune(original,entry.reads,{seq:entry.seq,...pruneSettings,retainSource:isSourceBodyPath,
            transport:entry.transport===true});
          planned=draft&&{...draft,reduction:entry.textLength-resultText(draft.content).length,
            savedTokensEstimate:Math.max(0,messageTokens(original)-messageTokens({...original,content:draft.content}))};
          if(state.candidatePlans.size>=MAX_CANDIDATE_PLANS)state.candidatePlans.delete(state.candidatePlans.keys().next().value);
          state.candidatePlans.set(entry.seq,planned);
        }
      }
      if(!planned)return message;
      const {reduction}=planned;
      if(reduction<MIN_SAVING)return message;
      const after={...message,content:planned.content};
      if(!existing&&!allowed('historyOutput',message,after,entry.seq,entry,planned.savedTokensEstimate))return message;
      outputs++;saved+=reduction;
      hidden.add(entry.seq);
      if(record){
        state.outputPlans.set(entry.seq,planned);
        state.candidatePlans.delete(entry.seq);
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
        entry.textLength>=runtime.get(agent).config.contextPruneMinChars);
    },
    bodyVisible(agent,seq){
      if(!runtime.isEnabled(agent)||!runtime.get(agent).config.historyHygiene)return true;
      const s=sync(agent);return s.suspended||s.fullOutputRequested||!s.hiddenResults.has(seq)&&referenceContext?.bodyVisible(agent,seq)!==false;
    },
    manages(agent,seq){return runtime.isEnabled(agent)&&runtime.get(agent).config.historyHygiene&&!get(agent).suspended&&(get(agent).hiddenResults.has(seq)||referenceContext?.manages(agent,seq)===true);},
    retainsSource(agent,file){return get(agent).retainedSources.has(fileKey(runtime.get(agent).root,file));},
    summary(agent){const s=sync(agent),references=referenceContext?.summary(agent)??null;return {enabled:runtime.isEnabled(agent)&&runtime.get(agent).config.historyHygiene,requestViews:s.requests,outputViews:s.outputs,testOutputViews:s.testOutputViews,
      charsRemovedAcrossViews:s.chars+(references?.charsRemovedAcrossViews??0),toolOutputCharsRemovedAcrossViews:s.chars-s.testOutputChars,testOutputCharsRemoved:s.testOutputChars,
      definitionSummary:{enabled:runtime.get(agent).config.definitionSummary==='on',calls:s.definitionSummaryCalls,candidateCalls:s.definitionSummaryCandidateCalls,sentCalls:s.definitionSummarySentCalls,
        compactedChars:s.definitionSummaryCompactedChars,candidateInjectedChars:s.definitionSummaryCandidateInjectedChars,injectedChars:s.definitionSummaryInjectedChars,
        observedInjectedChars:s.definitionSummaryObservedInjectedChars,projectedInjectedChars:s.definitionSummaryProjectedInjectedChars,
        projectionCalls:s.definitionSummaryProjectionCalls,
        cumulativeInjectedChars:s.definitionSummaryProjectedInjectedChars,
        netChars:s.definitionSummaryCompactedChars-s.definitionSummaryProjectedInjectedChars,
        observedNetChars:s.definitionSummaryCompactedChars-s.definitionSummaryInjectedChars,
        note:'observedInjectedChars is measured when the tool result is observed; projectedInjectedChars counts the summary in actual request views. Neither proves provider token use or savings.'},
      explicitRecoveries:s.restores,rereadPromotions:s.rereadPromotions,retainedCalls:s.pinnedCalls.size,retainedResults:s.pinnedResults.size,suspended:!!s.suspended,
      referenceContext:references,reasoning:'unchanged',canonicalHistory:'unchanged'};},
    disposeAgent(agent){referenceContext?.disposeAgent(agent);states.delete(agent.session.id);},dispose(){referenceContext?.dispose();states.clear();}};
}
