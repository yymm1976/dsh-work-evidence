import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {Script} from 'node:vm';
const NATIVE_TEMPLATE_FRAME=/^    at eval \(eval at runProgram \(file:\/\/\/[^\r\n]*\/@deepseek-ai\/dsh-ptc-runtime-node\/lib\/process\.js:\d+:\d+\), <anonymous>:(\d+):(\d+)\)/mu;

export function nativePwshInvocationDiagnostic(argumentsValue,result){
  const command=argumentsValue?.command;
  if(typeof command!=='string'||command.length>4096||/[\r\n]/u.test(command))return null;
  const executable=/^[ \t]*([A-Za-z]:[\\/][^"'`$\r\n;&|<>]*?\.exe)(?=[ \t]|$)/iu.exec(command)?.[1];
  if(!executable||executable.length>1024||!/[ \t]/u.test(executable))return null;
  const raw=result?.value??result,value=raw?.data??raw,exitCode=value?.exitCode??value?.exit_code;
  if(!Number.isInteger(exitCode)||exitCode===0||['background','promoted'].includes(value.kind)||
    ['running','pending','queued','stopping','cancelled','killed'].includes(value.status??value.job?.status)||
    value.timedOut||value.aborted||value.cancelled||value.signal!=null||value.stopped!==undefined||value.partial||value.outputPartial||
    value.lossy||value.complete===false||value.truncated||value.stdout?.truncated||value.stderr?.truncated||
    value.stdout?.complete===false||value.stderr?.complete===false)return null;
  const stream=item=>typeof item==='string'?item:typeof item?.text==='string'?item.text:'';
  const output=stream(value.stderr??value.stderrText)+'\n'+stream(value.stdout??value.stdoutText);
  const reportedCommand=command.trimStart().split(/[ \t]/u,1)[0];
  const quoted=new RegExp('["\'“”‘’]'+reportedCommand.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')+'["\'“”‘’]','u');
  const english=output.includes("The term '"+reportedCommand+"' is not recognized as a name of a cmdlet, function, script file, or executable program.");
  const structured=[stream(value.stderr??value.stderrText),stream(value.stdout??value.stdoutText)].some(stream=>
    stream.split(/\r?\n\r?\n/u).some(record=>/FullyQualifiedErrorId\s*:\s*CommandNotFoundException\b/iu.test(record)&&quoted.test(record)));
  if(!english&&!structured)return null;
  return {kind:'unquoted-executable-path',executable,reportedCommand,processExitCode:exitCode,
    suggestedPrefix:"& '"+executable+"'",scope:'Invocation syntax only; original arguments and effects remain. No command was changed or retried.'};
}

export function nativeProgramParseLocation(code,result){
  if(!result?.isError||typeof code!=='string'||code.length<1000||code.length>64000)return null;
  const output=(result.content??[]).filter(block=>block.type==='text').map(block=>block.text??'').join('\n');
  const reported=/^Error: code run failed \(exception\): ([^\r\n]+)/mu.exec(output)?.[1];
  if(!reported)return null;
  try{stripTypeScriptTypes('async function __dsh_program__() {\n'+code+'\n}');}
  catch(error){
    if(error.code!=='ERR_INVALID_TYPESCRIPT_SYNTAX'||error.message!==reported)return null;
    const stack=String(error.stack??''),match=/^:(\d+)(?::\d+)?\r?\n/u.exec(stack);
    const line=Number(match?.[1])-1,source=code.split(/\r\n|\n|\r/u);
    if(!Number.isSafeInteger(line)||line<1||line>source.length)return null;
    const lines=[];
    for(let number=Math.max(1,line-3);number<=Math.min(source.length,line+2);number++)lines.push({number,text:source[number-1].slice(0,400),textTruncated:source[number-1].length>400});
    const location={runtime:'native-typescript-function-body',code:error.code,message:error.message,line,lines,
      parserOnly:true,executionOccurred:false,scope:'original program text; parser points to the failure location, not a proven root cause'};
    return JSON.stringify(location).length<=3500?location:null;
  }
  return null;
}

export function nativeTemplateCallLocation(code,result){
  if(!result?.isError||typeof code!=='string'||code.length<1000||code.length>64000)return null;
  const output=(result.content??[]).filter(block=>block.type==='text').map(block=>block.text??'').join('\n');
  if(/^Error: code run failed \(exception\): TypeError: String\.raw\(\.\.\.\) is not a function\r?\n/u.test(output)){
    const frame=NATIVE_TEMPLATE_FRAME.exec(output);
    if(!frame)return null;
    // This native runtime adds one strict-mode line to AsyncFunction's two generated lines.
    // Require the original raw-template boundary at that exact position; other wrappers stay unknown.
    const line=Number(frame[1])-3,column=Number(frame[2]),source=code.split(/\r\n|\n|\r/u);
    if(!Number.isSafeInteger(line)||line<1||line>source.length||!Number.isSafeInteger(column)||column<2||column>source[line-1].length)return null;
    if(source[line-1].slice(column-2,column)!=='``')return null;
    const lineStarts=[0];for(const separator of code.matchAll(/\r\n|\n|\r/gu))lineStarts.push(separator.index+separator[0].length);
    const offset=lineStarts[line-1]+column-1,boundaries=code.matchAll(/\bString\.raw`(?:\\[\s\S]|[^`\\$]|\$(?!\{))*`(?=`)/gu);
    if(![...boundaries].some(match=>match.index+match[0].length===offset))return null;
    const lines=[];
    for(let number=Math.max(1,line-2);number<=Math.min(source.length,line+2);number++)lines.push({number,text:source[number-1].slice(0,400),textTruncated:source[number-1].length>400});
    const location={runtime:'native-typescript-function-body',kind:'string-raw-template-call',line,column,lines,
      parserOnly:false,executionOccurred:true,scope:'The native Node frame maps to this original String.raw template boundary; other runtime wrappers and interpolated template prefixes are not inferred.'};
    return JSON.stringify(location).length<=3000?location:null;
  }
  const match=/^Error: code run failed \(exception\): TypeError: "([\s\S]{1,64000}?)" is not a function\r?\n[ \t]+at /mu.exec(output);
  if(!match)return null;
  const literal=match[1];let start=code.indexOf(literal),end=start+literal.length,decoded=false;
  if(start>=0&&code.indexOf(literal,start+1)>=0)return null;
  if(start<1||code.indexOf(literal,start+1)>=0||code[start-1]!=='`'||code[end]!=='`'||code[end+1]!=='`'){
    const candidates=[];let inspected=0;
    // Only isolated, non-interpolated literals after '=' are decoded. No source
    // program, expression, tag function or ${...} interpolation is evaluated.
    for(const template of code.matchAll(/`(?:\\[\s\S]|[^`\\$]|\$(?!\{))*`(?=`)/gu)){
      if(!/=\s*$/u.test(code.slice(0,template.index)))continue;
      if(++inspected>16)return null;
      let value;try{value=new Script('('+template[0]+')').runInNewContext(Object.create(null),{timeout:20});}catch{continue;}
      if(value===literal)candidates.push({start:template.index+1,end:template.index+template[0].length-1});
      if(candidates.length>1)return null;
    }
    if(candidates.length!==1)return null;
    ({start,end}=candidates[0]);decoded=true;
  }
  const line=code.slice(0,end).split(/\r\n|\n|\r/u).length,source=code.split(/\r\n|\n|\r/u),lines=[];
  if(decoded){
    const frame=NATIVE_TEMPLATE_FRAME.exec(output),column=Number(frame?.[2]);
    const beforeBoundary=code.slice(0,end).split(/\r\n|\n|\r/u).at(-1).length;
    if(Number(frame?.[1])-3!==line||column!==beforeBoundary+2||source[line-1].slice(column-2,column)!=='``')return null;
  }
  for(let number=Math.max(1,line-2);number<=Math.min(source.length,line+2);number++)lines.push({number,text:source[number-1].slice(0,400),textTruncated:source[number-1].length>400});
  const location={runtime:'native-typescript-function-body',kind:'quoted-string-template-call',line,lines,
    parserOnly:false,executionOccurred:true,...(decoded?{literalEscapesDecoded:true}:{}),
    scope:'The error string uniquely matches this recorded template prefix; source line numbers are independent of the generated runtime stack.'};
  return JSON.stringify(location).length<=3000?location:null;
}

const forms={
  read:'{file_path:"file",offset:1,limit:80} -> {path,offset,lines:[{number,text}],totalLines}; use result.lines, not result.content or result.text',
  ops_read_files:'{files:[{path:"file",offset:1,limit:80}]} -> items[].items[] has line/text; some hosts wrap the native value in data',
  ops_glob:'{path:"src",pattern:["**/*.java"]} -> items[] contains paths; some hosts wrap the native value in data',
  ops_grep:'{path:"src",pattern:"symbol",outputMode:"content",limit:40} -> items[] has path/line/text; some hosts wrap the native value in data',
  ops_stat:'{path:"file"} -> path/exists/revision, possibly inside data. One path per call; use separate native calls for several paths, without inventing data.items',
  project_evidence:'source: {mode:"source",query:"ClassName",members:["method"]} or batch queries:[{query,members},...]; archive: {mode:"archive",archive:"lib.jar",entry:"pkg/Class.java",members:["method"]}; read: {mode:"read",files:[{path:"file",offset:1,limit:80}]}'
};
const readTools=new Set(['read','ops_read_files','ops_glob','ops_grep','ops_stat','project_evidence']);
export function nativeReadOutputSymptom(source,output,{nonemptyRead=false,lineTextTruncated=false,isError=false}={}){
  if(isError&&lineTextTruncated&&/\.lines\b/u.test(source)&&/\bJSON\s*\.\s*parse\s*\(/u.test(source)&&
    /^Error: code run failed \(exception\): SyntaxError:/mu.test(output)&&/^\s+at JSON\.parse \(<anonymous>\)/mu.test(output))return 'line-text-truncated-json';
  if(!/\.(?:content|text)\b/u.test(source))return null;
  const emptyFieldFallback=nonemptyRead&&/(?:\?\.|\.)(?:content|text)\b\s*(?:\?\?|\|\|)\s*(?:""|'')/u.test(source)&&
    output.split(/\r?\n/u).every(line=>!line.trim()||/^\s*(?:={2,}[^\r\n]*={2,}|#{1,6} [^\r\n]*|---[^\r\n]*---)\s*$/u.test(line));
  return !isError&&(emptyFieldFallback||/(?:^|\n)\s*undefined\s*(?:\r?\n|$)/u.test(output))||isError&&
    /\.(?:slice|map|split|join) is not a function|Cannot read properties of undefined/u.test(output)?
    emptyFieldFallback?'empty-field-fallback':'field-access':null;
}
export function nativeReadRecoveryEntries(agent,seqs){
  const entries=[];let total=0;
  for(const seq of seqs){
    let event;try{event=agent.session.eventAt?.(seq);}catch{}
    if(!['tool/ptc-dispatch','tool/code-dispatch'].includes(event?.type)||event.data.name!=='read'||event.data.isError||
      !Array.isArray(event.data.content)||event.data.content.some(block=>block.type!=='text'))continue;
    const text=event.data.content.map(block=>block.text??'').join('\n'),entry={seq,type:event.type,historical:true,text};
    const chars=JSON.stringify(entry).length;
    if(!text||chars>3000||total+chars>4000)continue;
    entries.push(entry);total+=chars;
  }
  return entries;
}

/** Actual failed process frames, restricted to the current project. */
export function executionFailureFrames(result,root){
  if(typeof root!=='string'||!root)return [];
  const raw=result?.value??result,value=raw?.data??raw;
  if(!value||['background','promoted'].includes(value.kind)||['running','pending','queued','stopping','cancelled','killed'].includes(value.status??value.job?.status)||
    value.timedOut||value.aborted||value.cancelled||value.signal!=null||value.stopped!==undefined||value.partial||value.outputPartial||value.lossy||value.complete===false||
    value.truncated||value.stdout?.truncated||value.stderr?.truncated||value.stdout?.complete===false||value.stderr?.complete===false)return [];
  if(!(Number.isInteger(value.exitCode)&&value.exitCode!==0)&&!(Number.isInteger(value.exit_code)&&value.exit_code!==0))return [];
  const stream=item=>typeof item==='string'?item:typeof item?.text==='string'?item.text:'';
  const text=stream(value.stderr??value.stderrText)||stream(value.stdout??value.stdoutText)||result.content?.filter(block=>block.type==='text').map(block=>block.text??'').join('\n')||'';
  const frames=[],seen=new Set();
  const add=(file,line,column,printedLine)=>{
    try{if(file.startsWith('file:///'))file=fileURLToPath(file);}catch{return;}
    if(!path.isAbsolute(file)||!Number.isSafeInteger(line)||line<1)return;
    const relative=path.relative(root,file);
    if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return;
    const key=JSON.stringify([file,line,column]);if(seen.has(key))return;seen.add(key);
    frames.push({path:path.resolve(file),line,column,printedLine:printedLine?.trim()||null});
  };
  for(const match of text.matchAll(/(file:\/\/\/[^\r\n]*?\.(?:[cm]?js|py)|(?:[A-Za-z]:[\\/]|\/)[^:\r\n]*?\.(?:[cm]?js|py)):(\d+)(?::(\d+))?/gu)){
    const start=text.lastIndexOf('\n',match.index)+1,end=text.indexOf('\n',match.index+match[0].length);
    const header=!text.slice(start,match.index).trim()&&!text.slice(match.index+match[0].length,end<0?text.length:end).trim();
    const printedLine=header&&end>=0?text.slice(end+1).split(/\r?\n/u,1)[0]:null;
    add(match[1],Number(match[2]),match[3]?Number(match[3]):null,printedLine);
  }
  for(const match of text.matchAll(/^\s*File "([^"\r\n]+\.py)", line (\d+)[^\r\n]*\r?\n([^\r\n]*)/gmu))
    add(match[1],Number(match[2]),null,match[3]);
  return frames;
}

/** A bounded excerpt of the recorded write, never a current file observation. */
export function recordedSourceExcerpt(event,frame){
  let args=event?.data?.arguments;
  if(typeof args==='string')try{args=JSON.parse(args);}catch{return null;}
  const tool=event?.data?.name,full=['write','ops_write_file'].includes(tool),edited=['edit','ops_edit_file'].includes(tool);
  const source=full?args?.content:edited?args?.new_string:undefined;
  if(typeof source!=='string'||!source)return null;
  const lines=source.split(/\r\n|\n|\r/u);let index=full?frame.line-1:-1;
  if(!full&&frame.printedLine){
    const matches=lines.flatMap((line,index)=>line.trim()===frame.printedLine?[index]:[]);
    if(matches.length===1)index=matches[0];
  }
  if(index<0||index>=lines.length)return null;
  const window=lines.slice(Math.max(0,index-2),index+3).map((text,offset)=>({recordLine:Math.max(0,index-2)+offset+1,
    text:text.slice(0,400),textTruncated:text.length>400}));
  const excerpt={scope:full?'recorded-file-window':'recorded-replacement-window',historical:true,currentFileState:'not-observed',
    frame:{path:frame.path,line:frame.line,column:frame.column},source:{seq:event.seq,kind:'call',tool},lines:window};
  return JSON.stringify(excerpt).length<=3000?excerpt:null;
}

function unittestCheckFailure(text){
  const lines=String(text??'').slice(-12000).split(/\r?\n/u);
  const ranIndex=lines.findLastIndex(line=>/^Ran \d+ tests? in \d+(?:\.\d+)?s\s*$/u.test(line));
  if(ranIndex<0)return null;
  const verdict=lines.slice(ranIndex+1).find(line=>/^FAILED \([^\r\n]+\)\s*$/u.test(line));
  if(!verdict)return null;
  const fields={failures:0,errors:0,skipped:0,'expected failures':0,'unexpected successes':0},seen=new Set();
  for(const item of verdict.trim().slice(8,-1).split(/,\s*/u)){
    const match=/^(failures|errors|skipped|expected failures|unexpected successes)=(\d+)$/u.exec(item);
    if(!match||seen.has(match[1])||!Number.isSafeInteger(Number(match[2])))return null;
    seen.add(match[1]);fields[match[1]]=Number(match[2]);
  }
  const total=Number(/^Ran (\d+)/u.exec(lines[ranIndex])[1]),accounted=Object.values(fields).reduce((sum,value)=>sum+value,0);
  const failed=fields.failures+fields.errors+fields['unexpected successes'];
  if(!Number.isSafeInteger(total)||!Number.isSafeInteger(accounted)||accounted>total||failed===0)return null;
  const failureEntries=lines.slice(0,ranIndex).filter(line=>/^(?:FAIL|ERROR|UNEXPECTED SUCCESS): \S/u.test(line)).slice(0,4).map(line=>line.slice(0,180));
  return {signature:failureEntries[0]??verdict.trim(),summary:{passed:total-accounted,failed,total,failures:fields.failures,errors:fields.errors,
    skipped:fields.skipped,expectedFailures:fields['expected failures'],unexpectedSuccesses:fields['unexpected successes'],source:'reported-unittest',
    text:lines[ranIndex].trim()+'\n'+verdict.trim()},failureEntries};
}

function namedRatioFailure(text){
  const lines=String(text??'').slice(-12000).split(/\r?\n/u);
  const index=lines.findLastIndex(line=>/^TOTAL[ \t]+\d+[ \t]*\/[ \t]*\d+[ \t]*$/u.test(line));
  if(index<0||lines.slice(index+1).some(line=>line.trim()))return null;
  const [,passedText,totalText]=/^TOTAL[ \t]+(\d+)[ \t]*\/[ \t]*(\d+)/u.exec(lines[index]);
  const passed=Number(passedText),total=Number(totalText);
  if(!Number.isSafeInteger(passed)||!Number.isSafeInteger(total)||passed<0||total<=passed)return null;
  const verdicts=lines.slice(0,index).map(line=>/^(PASS|FAIL)[ \t]+\S[^\r\n]*$/u.exec(line)).filter(Boolean);
  if(verdicts.length!==total||verdicts.filter(match=>match[1]==='PASS').length!==passed)return null;
  const failed=verdicts.filter(match=>match[1]==='FAIL');
  const failureEntries=failed.slice(0,4).map(match=>match[0].slice(0,180));
  return {signature:failureEntries[0],summary:{passed,failed:total-passed,total,source:'reported-named-ratio',text:lines[index].trim()},failureEntries};
}

export function reportedCheckFailure(text){
  if(typeof text==='string'&&text.length<=64000){
    let value;try{value=JSON.parse(text);}catch{}
    const failures=value?.failures;
    if(Number.isSafeInteger(value?.passed)&&Number.isSafeInteger(value?.total)&&value.passed>=0&&value.total>value.passed&&
      Array.isArray(failures)&&failures.length===value.total-value.passed&&failures.every(item=>item&&typeof item==='object'&&
        (item.pass===false||item.passed===false)&&typeof item.name==='string'&&item.name.trim()))
      return {signature:'Reported comparisons: '+failures.length+'/'+value.total+' failed; '+failures[0].name.trim().slice(0,140),
        summary:{passed:value.passed,failed:failures.length,total:value.total,source:'reported-json'},failureEntries:failures.slice(0,4).map(item=>item.name.slice(0,180))};
  }
  const unittest=unittestCheckFailure(text);if(unittest)return unittest;
  const namedRatio=namedRatioFailure(text);if(namedRatio)return namedRatio;
  const lines=String(text??'').slice(-12000).split(/\r?\n/u),numericMarkers=new Set();let positive=null,summary=null;
  for(const line of lines){
    const listed=/^\s*FAILURES\s*:\s*\[\s*((?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")(?:\s*,\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"))*\s*,?)\s*\]\s*$/iu.exec(line);
    if(listed){
      positive=line.trim().slice(0,180);
      summary={failed:[...listed[1].matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/gu)].length,
        source:'reported-list',text:line.trim().slice(0,240)};
    }
    const pair=/^\s*(?:[A-Za-z][\w.-]*[ \t]+){0,2}(?:checks?|tests?|suites?|assertions?|comparisons?)\s*:\s*(\d+)\s+(?:passed|ok)\s*[,;]\s*(\d+)\s+(?:failed|failures)\b/iu.exec(line)??
      /^\s*PASS(?:ED)?[ \t]*[:=]?[ \t]+(\d+)[ \t,;]+FAIL(?:ED|URES?)?[ \t]*[:=]?[ \t]+(\d+)[ \t]*$/iu.exec(line);
    const total=/^\s*(?:checks?|tests?|suites?|assertions?|comparisons?|total)\s*:\s*(\d+)\s*[,;]\s*(?:failed|failures)\s*:\s*(\d+)\s*$/iu.exec(line);
    const match=/^\s*(?:FAIL(?:ED|URES?|_TOTAL|_COUNT)?)(?:\s*[:=(]\s*|\s+)(\d+)\b/iu.exec(line)??
      /^\s*(?:\d+\s+)?(?:checks?|tests?|total)\b[^\r\n]{0,160}?\b(?:failed|failures)\s*[:=]?\s*(\d+)\b/iu.exec(line)??
      /^\s*(?:\d+\s+)?(?:checks?|tests?|total)\b[^\r\n]{0,160}?\b(\d+)\s+(?:failed|failures)\b/iu.exec(line)??
      (pair?[pair[0],pair[2]]:null)??/^\s*(\d+)\s+(?:failed|failures)\b/iu.exec(line);
    if(match){
      numericMarkers.add(line);
      if(Number(match[1])>0)positive=line.trim().slice(0,180);
      if(pair&&Number.isSafeInteger(Number(pair[1]))&&Number.isSafeInteger(Number(pair[2])))
        summary={passed:Number(pair[1]),failed:Number(pair[2]),source:'reported-text',text:line.trim().slice(0,240)};
      if(total&&Number.isSafeInteger(Number(total[1]))&&Number.isSafeInteger(Number(total[2]))&&Number(total[2])<=Number(total[1]))
        summary={passed:Number(total[1])-Number(total[2]),failed:Number(total[2]),total:Number(total[1]),source:'reported-text',text:line.trim().slice(0,240)};
    }
  }
  const failureEntries=lines.filter(line=>!numericMarkers.has(line)&&(/^\s*(?:FAIL(?:ED)?\s*:\s*\S|LOAD-FAIL[ \t]+\S)/iu.test(line)||
    positive&&/^\s*FAIL[ \t]+\S/iu.test(line))).slice(0,4).map(line=>line.trim().slice(0,180));
  return positive||failureEntries.length?{signature:failureEntries[0]??positive,summary,failureEntries}:null;
}

/** Process exit and the program's own report are independent observations. */
export function reportedExecutionChecks(result){
  const raw=result?.value??result,value=raw?.data??raw;
  if(!value||['background','promoted'].includes(value.kind)||['running','pending','queued','stopping'].includes(value.status??value.job?.status)||
    value.timedOut||value.aborted||value.cancelled||value.signal!=null||value.stopped!==undefined||value.partial||value.outputPartial||value.lossy||value.complete===false||
    value.truncated||value.stdout?.truncated||value.stderr?.truncated||value.stdout?.complete===false||value.stderr?.complete===false)return null;
  const exitCode=Number.isInteger(value.exitCode)?value.exitCode:Number.isInteger(value.exit_code)?value.exit_code:null;
  if(exitCode===null)return null;
  const stdout=typeof value.stdout==='string'?value.stdout:typeof value.stdout?.text==='string'?value.stdout.text:value.stdoutText;
  const stderr=typeof value.stderr==='string'?value.stderr:typeof value.stderr?.text==='string'?value.stderr.text:value.stderrText;
  const outputFailure=reportedCheckFailure(stdout??''),failure=outputFailure??unittestCheckFailure(stderr);
  return failure?{status:'reported-failed',processExitCode:exitCode,...failure,sourceStream:outputFailure?'stdout':'stderr',countsScope:'exact-program-report; not inferred assertion counts'}:null;
}
// The desktop compatibility handlers derive missing UI descriptions by mutating
// parsed arguments, which the tool service freezes. Add the same display value
// before validation; keep the original argument object and host execution path.
export function installExecutionDescriptionCompatibility(ctx,runtime){
  ctx.on('tools/pre-execute',(exec,next)=>{
    const args=exec.arguments,field=exec.name==='run_code'?'code':['pwsh','bash'].includes(exec.name)?'command':null;
    if(field&&exec.agent&&runtime.isEnabled(exec.agent)&&args&&typeof args==='object'&&!Array.isArray(args)&&
      typeof args[field]==='string'&&(args.description===undefined||typeof args.description==='string'&&!args.description.trim())){
      const description=args[field].trim().split(/\r?\n/)[0].slice(0,80)||(field==='code'?'Run program':'Run shell command');
      exec.arguments=Object.freeze({...args,description});
    }
    return next();
  },{prepend:true});
}
export function installNativeReadArgumentRecovery(ctx,runtime){
  ctx.on('tools/pre-execute',async(exec,next)=>{
    if(exec.name!=='read'||!exec.agent)return next();
    await runtime.init(exec.agent,exec.signal);
    const state=runtime.get(exec.agent);
    if(runtime.isEnabled(exec.agent)&&state.config.readArgumentRecovery){
      const args=exec.arguments;
      if(args&&typeof args==='object'&&Object.hasOwn(args,'path')&&Object.hasOwn(args,'file_path')&&args.path!==args.file_path)
        return {kind:'deny',reason:'Conflicting read path and file_path; provide one file_path.',info:{code:'INVALID_ARGS'}};
      const corrected=correctedReadArguments('read',exec.arguments);
      if(corrected){
        // Native read rejects missing file_path before tools/execute. Normalize
        // before the host's final guards so they inspect the actual target.
        exec.arguments=Object.freeze(corrected);
        state.metrics.readArgumentNormalizations++;state.dirty=true;
        runtime.effects?.decide(exec.agent,'argumentRecovery','applied','before-validation-normalization',{tool:'read',execution:'not-inferred'});
      }
    }
    return next();
  },{prepend:true});
}
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
export function correctedReadArguments(name,args){
  if(!readTools.has(name)||!object(args))return null;
  const next={...args};let changed=false;
  if(name==='read'&&Object.hasOwn(next,'path')){
    if(!text(next.path)||Object.hasOwn(next,'file_path')&&next.file_path!==next.path)return null;
    next.file_path=next.path;delete next.path;changed=true;
  }
  if(name==='ops_stat'&&!Object.hasOwn(next,'path')&&Array.isArray(next.paths)&&next.paths.length===1&&text(next.paths[0])){
    next.path=next.paths[0];delete next.paths;changed=true;
  }
  if(name==='ops_glob'&&text(next.pattern)){next.pattern=[next.pattern];changed=true;}
  // An identical redundant alias carries no additional query intent. Conflicts stay errors.
  if(name==='ops_glob'&&Object.hasOwn(next,'glob')){
    const alias=text(next.glob)?[next.glob]:next.glob;
    if(!Array.isArray(alias)||!alias.length||alias.some(value=>!text(value)))return null;
    if(Object.hasOwn(next,'pattern')&&JSON.stringify(next.pattern)!==JSON.stringify(alias))return null;
    next.pattern=alias;delete next.glob;changed=true;
  }
  if(name==='ops_grep'){
    if(next.outputMode==='files'){next.outputMode='files_with_matches';changed=true;}
    const modes=['files_with_matches','content','count','summary'];
    if(Object.hasOwn(next,'outputMode')&&!modes.includes(next.outputMode))return null;
    for(const alias of ['mode','output_mode']){
      if(!Object.hasOwn(next,alias))continue;
      const value=next[alias]==='files'?'files_with_matches':next[alias];
      if(!modes.includes(value))return null;
      if(Object.hasOwn(next,'outputMode')&&next.outputMode!==value)return null;
      next.outputMode=value;delete next[alias];changed=true;
    }
    if(Object.hasOwn(next,'caseInsensitive')&&typeof next.caseInsensitive!=='boolean')return null;
    if(Object.hasOwn(next,'case_insensitive')){
      if(typeof next.case_insensitive!=='boolean')return null;
      if(Object.hasOwn(next,'caseInsensitive')&&next.caseInsensitive!==next.case_insensitive)return null;
      next.caseInsensitive=next.case_insensitive;delete next.case_insensitive;changed=true;
    }
    // Keep meaningful whitespace and bound inline regex flags to each alternative.
    if(Array.isArray(next.pattern)&&next.pattern.length>=1&&next.pattern.every(value=>typeof value==='string'&&value.length>0)){
      next.pattern=next.pattern.length===1?next.pattern[0]:next.pattern.map(value=>'(?:'+value+')').join('|');changed=true;
    }
    if(Object.hasOwn(next,'files_only')){
      if(next.files_only!==true)return null;
      if(Object.hasOwn(next,'outputMode')&&next.outputMode!=='files_with_matches')return null;
      next.outputMode='files_with_matches';delete next.files_only;changed=true;
    }
    // maxMatches is the common ripgrep-style synonym for grep's limit; seen in edit-019.
    if(Object.hasOwn(next,'maxMatches')){
      if(!Number.isInteger(next.maxMatches)||next.maxMatches<1||Object.hasOwn(next,'limit'))return null;
      next.limit=next.maxMatches;delete next.maxMatches;changed=true;
    }
  }
  if(name==='ops_read_files'&&!Object.hasOwn(next,'files')&&text(next.path)&&Object.keys(next).every(key=>['path','offset','limit'].includes(key))){
    return {files:[next]};
  }
  if(name==='project_evidence'){
    if(next.mode!=='read'&&Array.isArray(next.files)&&next.files.length>=1&&!text(next.archive)&&!text(next.entry)&&!text(next.query)&&!Array.isArray(next.queries)){
      next.mode='read';changed=true;
    }
    if(next.mode==='source'&&text(next.archive)&&text(next.entry)&&!text(next.query)&&!Array.isArray(next.queries)){
      next.mode='archive';changed=true;
    }
  }
  return changed?next:null;
}
export function recoveryFor(name,args,result){
  const value=result?.value;
  const error=value?.error||result?.error;
  const code=String(error?.info?.code||error?.code||value?.code||'');
  const message=String(error?.message||value?.nextFactNeeded||'');
  if(!error&&!['unavailable','unknown'].includes(value?.state))return null;
  const prohibited=/DENIED|APPROVAL|SANDBOX|ABORT|CANCEL|CONFLICT|UNKNOWN|PARTIAL|OUTPUT_LIMIT|EXECUTOR_UNAVAILABLE/i.test(code);
  const invalid=!prohibited&&(/ARGUMENT|ARGS|SCHEMA|MODE_FIELDS|LOCATOR_REQUIRED/i.test(code)||/invalid arguments|missing required property|unknown (?:field|property)|must match exactly one oneOf branch|returned invalid output/i.test(message));
  const correctedArguments=invalid?correctedReadArguments(name,args):null;
  return {shape:forms[name]||'Use this tool\'s current parameter declaration.',
    correctedCall:correctedArguments?{tool:name,arguments:correctedArguments}:null,
    retry:correctedArguments?'one-read-only-correction':prohibited?'do-not-repeat-unchanged':'after-input-change',
    automaticAllowed:!!correctedArguments,
    note:correctedArguments?'Only an unambiguous read-only parameter alias is changed; all other input is retained.':'Missing facts, mode choices, permission failures and write effects are never guessed.'};
}
export function evidenceArgumentError(args,message,code='EVIDENCE_INVALID_ARGUMENT'){
  const result={state:'unavailable',mode:typeof args?.mode==='string'?args.mode:'unknown',code,sources:[],nextFactNeeded:message,
    error:{code,message,effectState:'none',retry:'after-input-change'}};
  result.recovery=recoveryFor('project_evidence',args,{value:result});return result;
}
export function recoveryOf(result){
  const value=result?.value;
  const recovery=value?.data?.workEvidenceRecovery??value?.recovery??result?.error?.recovery??result?.meta?.workEvidenceReadRecovery;
  return object(recovery)?recovery:null;
}
export function withRecovery(result,recovery){
  if(!recovery)return result;
  if(object(result.value)){
    const original=result.value;
    // OPS PTC envelopes forbid new top-level fields. Their data object permits
    // extension; preserve status, error, coverage and the existing data fields.
    const envelope=['completed','partial','rejected','conflict','error','unknown'].includes(original.status)
      &&(object(original.data)||object(original.error));
    const value=envelope
      ?{...original,data:{...original.data,workEvidenceRecovery:recovery}}
      :{...original,recovery};
    return {...result,value,content:[{type:'text',text:JSON.stringify(value)}]};
  }
  return {...result,error:{...result.error,recovery},content:[...(result.content||[]),{type:'text',text:'Recovery: '+JSON.stringify(recovery)}]};
}
export function recoveredResult(result,{tool,originalArguments,correctedArguments,originalError}){
  const followup=recoveryFor(tool,correctedArguments,result);
  const recovery={applied:true,tool,originalArguments,correctedArguments,originalError,
    stage:'after-error',attempts:2,followup:followup?{...followup,automaticAllowed:false}:null,
    note:'One deterministic read-only argument correction; this does not assert complete coverage.'};
  return withRecovery(result,recovery);
}

export function normalizedReadResult(result,{tool,originalArguments,correctedArguments}){
  const followup=recoveryFor(tool,correctedArguments,result);
  const recovery={applied:true,stage:'before-dispatch',tool,originalArguments,correctedArguments,
    attempts:1,followup:followup?{...followup,automaticAllowed:false}:null,
    note:'One read-only call with normalized arguments through the native tool entry. The original arguments were not executed; no prior failure is claimed.'};
  // Native read has a closed output schema and host presentation metadata.
  // Keep its value and rendered content unchanged; the receipt belongs to metadata.
  return tool==='read'?{...result,meta:{...result.meta,workEvidenceReadRecovery:recovery}}:withRecovery(result,recovery);
}
