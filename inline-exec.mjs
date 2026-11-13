import {argsOf,eventLog,isUserRequestMessage,textOf} from './runtime.mjs';
import {Script} from 'node:vm';
import path from 'node:path';
import {nativeShellScript} from './native-shell-script.mjs';
import {stat} from 'node:fs/promises';

const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const bashQuote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const INPUT_KEYS=new Set(['runtime','language','code','scriptRef','edits','executable','interpreter','format','cwd','workdir','timeoutMs','mode','sources']);
const CALL_EVENT_TYPES=new Set(['tool/call','tool/ptc-dispatch-start','tool/ptc-dispatch','tool/code-dispatch-start','tool/code-dispatch']);
const RESULT_EVENT_TYPES=new Set(['tool/result','tool/ptc-dispatch','tool/code-dispatch']);
const validExecutable=value=>typeof value==='string'&&value.trim()&&value.length<=4096&&!/[\0\r\n]/u.test(value);
export function sameInlineExecutable(left,right){
  if(typeof left!=='string'||typeof right!=='string')return false;
  const normalize=value=>process.platform==='win32'?path.win32.normalize(value).toLowerCase():path.posix.normalize(value);
  return normalize(left)===normalize(right);
}
/** User authorization must name the actual file, including on case-sensitive Windows directories. */
export async function sameDeclaredInlineExecutable(left,right){
  if(typeof left!=='string'||typeof right!=='string'||!path.isAbsolute(left)||!path.isAbsolute(right))return false;
  try{
    const [first,second]=await Promise.all([stat(left,{bigint:true}),stat(right,{bigint:true})]);
    return first.isFile()&&second.isFile()&&first.ino!==0n&&first.dev!==0n&&second.dev!==0n&&first.ino===second.ino&&first.dev===second.dev;
  }catch{return false;}
}
function normalizeInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('work_exec arguments must be an object');
  for(const key of Object.keys(input))if(!INPUT_KEYS.has(key))throw new Error('Unknown work_exec argument: '+key);
  const {language,interpreter,cwd,workdir,mode,sources,...normalized}=input;
  if(mode!==undefined&&mode!=='once')throw new Error('scriptRef requires a fresh-process work_exec call');
  for(const [key,value]of [['runtime',language],['executable',interpreter]])if(value!==undefined){
    if(normalized[key]!==undefined&&normalized[key]!==value)throw new Error('Conflicting work_exec '+key+' alias');
    normalized[key]=value;
  }
  for(const directory of [cwd,workdir])if(directory!==undefined&&!['.','./','.\\'].includes(directory))throw new Error('work_exec runs in the current project; cwd/workdir may only be .');
  if(normalized.timeoutMs!==undefined&&(!Number.isInteger(normalized.timeoutMs)||normalized.timeoutMs<1||normalized.timeoutMs>600000))
    throw new Error('work_exec timeoutMs must be an integer from 1 to 600000');
  return normalized;
}
function eventCallId(type,data){
  if(type==='tool/result')return data.message?.source?.callId??data.message?.toolCallId??data.callId;
  return data.subCallId??data.callId;
}
function metadataOf(content){
  if(typeof content==='string'){
    try{return JSON.parse(content);}catch{return null;}
  }
  const blocks=Array.isArray(content)?content:content&&typeof content==='object'?[content]:[];
  const text=blocks.filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n');
  if(!text)return null;
  try{return JSON.parse(text);}catch{return null;}
}
function scriptExecutableOf(event){
  const data=event.data??{};
  const metadata=event.type==='tool/result'?metadataOf(data.message?.content):metadataOf(data.content);
  const declared=[metadata?.scriptRef,metadata?.scriptRuntime,metadata?.scriptChars].some(value=>value!==undefined);
  return declared&&validExecutable(metadata?.scriptExecutable)?metadata.scriptExecutable:null;
}
function scriptHostRuntimeOf(event){
  const data=event.data??{};
  const metadata=event.type==='tool/result'?metadataOf(data.message?.content):metadataOf(data.content);
  const selection=metadata?.hostRuntimeSelection;
  return metadata?.scriptExecutableSource==='host-node-runtime'&&selection?.source==='host-node-runtime'&&
    validExecutable(selection.executable)&&sameInlineExecutable(selection.executable,metadata.scriptExecutable)?
    {...selection}:null;
}
const messageOf=event=>event.data?.message??event.data??{};
export function inlineScriptEventRef(session,callId){
  if(typeof callId!=='string')return null;
  const event=eventLog(session).find(event=>CALL_EVENT_TYPES.has(event.type)&&event.data?.name==='work_exec'&&eventCallId(event.type,event.data)===callId&&Number.isSafeInteger(event.seq)&&event.seq>=0);
  return event?'event:'+event.seq:null;
}
const DECLARED_EXECUTABLE=/\b(?:existing|installed|available)\b|(?:已有|现有|已经安装|已安装|可用)/iu;
const PATH_PERMISSION=/(?:改用|切换到|回退到|使用|采用|用)\s*PATH\b|(?:use|fall\s*back\s+to|switch\s+to)\s+(?:the\s+)?PATH\b|\bor\s+(?:the\s+)?PATH\b/giu;
const PATH_PROHIBITION=/(?:不要|请勿|禁止|do not|don't|must not|never)[^。；;\n]{0,24}$/iu;
const PATH_CONTRAST=/(?:\bbut\b|\binstead\b|\brather\b|而是|但是|不过|却|转而)/iu;
function pathFallbackAllowedIn(clause){
  for(const match of clause.matchAll(PATH_PERMISSION)){
    if(!match[0].endsWith('PATH'))continue;
    const segment=clause.slice(0,match.index).split(PATH_CONTRAST).at(-1);
    if(!PATH_PROHIBITION.test(segment))return true;
  }
  return false;
}
const NEGATED_EXECUTABLE=/\b(?:not|never)\s+(?:existing|installed|available)\b|\bno\s+(?:existing|installed|available)\b|\bunavailable\b|\b(?:do not|don't|must not|should not|never)\s+(?:use|invoke|run|execute)\b|\bdoes\s+not\s+exist\b|(?:不要|请勿|禁止)(?:使用|调用|执行)|(?:不可用|无法使用|不能使用|未安装|不存在|未提供)|(?:未|没有|并非|不是)[^。；;\n]{0,80}(?:解释器|路径|可用|安装|存在|使用|调用)/iu;
const pythonExecutable=/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/iu,nodeExecutable=/^node(?:\.exe)?$/iu;
function executablePath(value,runtime){
  if(typeof value!=='string')return null;
  const path=value.trim();
  if(!path||path.length>4096||/[\0\r\n"'`<>|?*]/u.test(path))return null;
  const absolute=/^[A-Za-z]:[\\/][^\\/]/u.test(path)||/^\/[^/]/u.test(path);
  if(!absolute)return null;
  const basename=path.split(/[\\/]/u).at(-1);
  return (runtime==='python'?pythonExecutable:nodeExecutable).test(basename)?path:null;
}
function declaredPathFacts(text,runtime){
  const all=new Map(),declared=new Map(),positive=new Map();let negated=false,pathFallbackAllowed=false;
  const windows=/[A-Za-z]:[\\/](?:[^\r\n"'`<>|?*:\\/]+[\\/])*(?:python(?:3(?:\.\d+)?)?(?:\.exe)?|node(?:\.exe)?)(?![A-Za-z0-9_\\/-]|\.[A-Za-z0-9_-])/giu;
  const posix=/(?<![\w.:\\/])\/(?:[^\r\n"'`<>|?*\\/\s]+[\\/])*(?:python(?:3(?:\.\d+)?)?(?:\.exe)?|node(?:\.exe)?)(?![A-Za-z0-9_\\/-]|\.[A-Za-z0-9_-])/giu;
  const quoted=/(["'`])([^\r\n]*?)\1/gu;
  for(const clause of String(text??'').split(/\r?\n|(?<=[!?;。！？；，,])|(?<=\.)(?=\s)/u)){
    const quotedPaths=[...clause.matchAll(quoted)].map(match=>executablePath(match[2],runtime)).filter(Boolean);
    const views=quotedPaths.length?[]:[windows,posix];
    const paths=quotedPaths.concat(views.flatMap(view=>[...clause.matchAll(view)].map(match=>executablePath(match[0],runtime))).filter(Boolean));
    const denied=NEGATED_EXECUTABLE.test(clause);
    if(pathFallbackAllowedIn(clause))pathFallbackAllowed=true;
    if(!paths.length)continue;
    for(const candidate of paths){
      const key=/^[A-Za-z]:/u.test(candidate)?candidate.replaceAll('/','\\').toLowerCase():candidate;
      if(!all.has(key))all.set(key,candidate);
      if(denied){negated=true;continue;}
      if(!positive.has(key))positive.set(key,candidate);
      if(DECLARED_EXECUTABLE.test(clause)&&!declared.has(key))declared.set(key,candidate);
    }
  }
  return {all:[...all.values()],declared:[...declared.values()],positive:[...positive.values()],negated,pathFallbackAllowed};
}
function pathFactsFrom(event,runtime){
  return event?declaredPathFacts(textOf(messageOf(event)),runtime):{all:[],declared:[],positive:[],negated:false,pathFallbackAllowed:false};
}

const SOURCE_LINE_CHARS=500,EXCEPTION_LINE_CHARS=600;
const PENDING_NATIVE_STATES=new Set(['background','promoted','running','pending','queued','stopping','partial']);
function completedNativeValue(value){
  if(!value||typeof value!=='object')return false;
  const status=value.status??value.state??value.job?.status,kind=value.kind??value.job?.kind;
  if(PENDING_NATIVE_STATES.has(String(status??'').toLowerCase())||PENDING_NATIVE_STATES.has(String(kind??'').toLowerCase()))return false;
  if(value.timedOut===true||value.aborted===true||value.complete===false||value.completed===false||value.outputPartial===true||value.lossy===true||value.truncated===true||
    value.stdout?.truncated===true||value.stderr?.truncated===true||value.stderr?.complete===false)return false;
  return Number.isInteger(value.exitCode??value.exit_code)&&(value.exitCode??value.exit_code)!==0;
}
function nativeStream(value,name){
  const stream=value?.[name];
  if(typeof stream==='string')return stream;
  if(stream&&typeof stream==='object'&&typeof stream.text==='string')return stream.text;
  const text=value?.[name+'Text'];
  return typeof text==='string'?text:null;
}
function boundedText(text,maximum){
  const points=Array.from(String(text??''));return {text:points.slice(0,maximum).join(''),truncated:points.length>maximum};
}
function exceptionLineOf(lines,runtime){
  if(runtime==='python'){
    for(let index=lines.length-1;index>=0;index--){
      const line=lines[index].trim();
      if(/^[A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit|Warning|Iteration)(?::|$)/u.test(line))return line;
    }
    return null;
  }
  for(const source of lines){
    const line=source.trim();
    if(/^(?:(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)?(?:Error|Exception)(?:\s*\[[^\]]+\])?(?::|$)|Uncaught(?::|\s).*)/u.test(line))return line;
  }
  return null;
}

/** Locate a completed runtime failure frame that explicitly names the current stdin script. */
export function inlineFailureLocation(script,nativeValue){
  if(!script||typeof script.code!=='string'||!['python','node'].includes(script.runtime)||!completedNativeValue(nativeValue))return null;
  const stderr=nativeStream(nativeValue,'stderr');
  if(!stderr)return null;
  const lines=stderr.split(/\r\n|\n|\r/u),exceptionLine=exceptionLineOf(lines,script.runtime);
  if(!exceptionLine)return null;
  let line=null,column=null,externalFrame=false;
  if(script.runtime==='python'){
    const frames=[...stderr.matchAll(/^\s*File\s+"<stdin>",\s*line\s+(\d+)(?:,\s*in\s+[^\r\n]+)?\s*$/gmu)];
    const frame=frames.at(-1);
    if(!frame)return null;
    line=Number(frame[1]);
    externalFrame=/^\s*File\s+"(?!<stdin>")[^"\r\n]+",\s*line\s+\d+/mu.test(stderr.slice(frame.index+frame[0].length));
  }else{
    const frames=[...stderr.matchAll(/(?:file:\/\/\/[^\s]*\/)?\[(?:stdin|eval1)\]:(\d+)(?::(\d+))?/gu)]
      .map(frame=>({line:Number(frame[1]),column:frame[2]===undefined?null:Number(frame[2])}));
    const frame=frames.find(item=>item.column!==null)??frames[0];
    if(!frame)return null;
    line=frame.line;column=frame.column;
    const firstDiagnostic=lines.find(item=>item.trim())?.trim();
    externalFrame=!!firstDiagnostic&&/^file:\/\//u.test(firstDiagnostic)&&!/\[(?:stdin|eval1)\]:\d+/u.test(firstDiagnostic);
  }
  const sourceLines=script.code.split(/\r\n|\n|\r/u);
  if(!Number.isInteger(line)||line<1||line>sourceLines.length)return null;
  const exception=boundedText(exceptionLine,EXCEPTION_LINE_CHARS),source=[];
  for(let current=Math.max(1,line-1);current<=Math.min(sourceLines.length,line+1);current++){
    const text=boundedText(sourceLines[current-1],SOURCE_LINE_CHARS);
    source.push({line:current,text:text.text,textTruncated:text.truncated});
  }
  return {runtime:script.runtime,line,column,frame:'stdin',exceptionInScript:!externalFrame,sourceLines:source,exceptionLine:exception.text,exceptionLineTruncated:exception.truncated,
    note:externalFrame?'frame is the current stdin script; the final exception frame is outside this script and is not treated as this source line.':
      'frame is the current stdin script; the location does not by itself prove the root cause.'};
}

export function inlineFormatRecovery(script,nativeValue,scriptRef,location=inlineFailureLocation(script,nativeValue)){
  if(script?.runtime!=='node'||script.format!==undefined||typeof scriptRef!=='string'||!scriptRef||
    !location||location.frame!=='stdin'||location.exceptionInScript!==true||!Number.isInteger(location.column)||
    !/^require\s*\(/u.test(script.code.split(/\r\n|\n|\r/u)[location.line-1]?.slice(location.column-1)??'')||
    !/^ReferenceError: require is not defined in ES module scope\b/u.test(location.exceptionLine))return null;
  // Recommend an explicit retry only if the unchanged program parses as CommonJS.
  // ESM imports and top-level await must keep their original execution semantics.
  try{new Script(script.code);}catch{return null;}
  return {reason:'commonjs-program-with-default-esm',tool:'work_exec',arguments:{scriptRef,format:'commonjs'},
    note:'The default ESM run failed. The unchanged script parses as CommonJS. This explicit retry uses the recorded version; no retry was executed.'};
}

/** Whether the current human request names an interpreter path it does not reject. */
export function namedInlineExecutable(session,runtime){
  if(!['python','node'].includes(runtime))return false;
  const events=eventLog(session);
  const user=events.findLast(event=>event.type==='user/message'&&isUserRequestMessage(messageOf(event)));
  const facts=pathFactsFrom(user,runtime);
  return !facts.pathFallbackAllowed&&facts.positive.length>0;
}

export function declaredInlineExecutable(session,runtime){
  if(!['python','node'].includes(runtime))return null;
  const events=eventLog(session);
  const user=events.findLast(event=>event.type==='user/message'&&isUserRequestMessage(messageOf(event)));
  const userFacts=pathFactsFrom(user,runtime);
  if(userFacts.negated||userFacts.all.length>1)return null;
  if(userFacts.declared.length===1)return {executable:userFacts.declared[0],source:{kind:'user',seq:user.seq??null}};
  const system=events.findLast(event=>event.type==='system/message');
  const systemFacts=pathFactsFrom(system,runtime);
  if(systemFacts.negated||systemFacts.all.length!==1||systemFacts.declared.length!==1)return null;
  return {executable:systemFacts.declared[0],source:{kind:'system',seq:system.seq??null}};
}

/** Reconstruct explicitly referenced scripts from this session's original calls. */
export function resolveInlineScript(input,session,signal,{nativeShellScriptReuse=false}={}){
  const events=typeof input?.scriptRef==='string'?eventLog(session):[],calls=new Map(),resultExecutables=new Map(),resultHostRuntimes=new Map();
  for(const event of events){
    const data=event.data??{};
    if(!CALL_EVENT_TYPES.has(event.type))continue;
    const id=eventCallId(event.type,data);
    if(typeof id==='string'){
      const prior=calls.get(id);
      const name=data.name??prior?.name;
      const args=data.arguments===undefined?prior?.args:argsOf(data.arguments);
      if(name||args!==undefined)calls.set(id,{name,args,seq:prior?.seq??event.seq});
    }
  }
  for(const event of events){
    if(!RESULT_EVENT_TYPES.has(event.type))continue;
    const data=event.data??{},id=eventCallId(event.type,data),call=calls.get(id);
    if(call?.name!=='work_exec')continue;
    const executable=scriptExecutableOf(event);
    if(executable)resultExecutables.set(id,executable);
    const hostRuntime=scriptHostRuntimeOf(event);
    if(hostRuntime)resultHostRuntimes.set(id,hostRuntime);
  }
  const eventRefs=new Map(events.filter(event=>CALL_EVENT_TYPES.has(event.type)&&
    (event.data?.name==='work_exec'||nativeShellScriptReuse&&event.data?.name==='bash')&&Number.isSafeInteger(event.seq)&&event.seq>=0)
    .map(event=>['event:'+event.seq,eventCallId(event.type,event.data)]).filter(([,id])=>typeof id==='string'&&calls.has(id)));
  try{return resolveIndexedScript(input,calls,resultExecutables,resultHostRuntimes,eventRefs,signal,nativeShellScriptReuse);}catch(error){
    if(error.code!=='WORK_EXEC_SCRIPT_REF_NOT_FOUND')throw error;
    const request=events.findLast(event=>event.type==='user/message'&&isUserRequestMessage(messageOf(event)));
    const requestedRuntime=input.runtime??input.language,available=[];
    if(Number.isSafeInteger(request?.seq))for(const [scriptRef,call]of [...calls].reverse().filter(([,call])=>call.name==='work_exec'&&call.seq>request.seq).slice(0,16)){
      signal?.throwIfAborted();
      if(scriptRef.length>256)continue;
      try{
        const script=resolveIndexedScript({scriptRef,...(requestedRuntime===undefined?{}:{runtime:requestedRuntime})},calls,resultExecutables,resultHostRuntimes,eventRefs,signal);
        if(typeof script.code!=='string'||!script.code.trim()||script.code.length>64000)continue;
        if(input.edits!==undefined)resolveIndexedScript({...input,scriptRef},calls,resultExecutables,resultHostRuntimes,eventRefs,signal);
        available.push({scriptRef,scriptEventRef:'event:'+call.seq,seq:call.seq,runtime:script.runtime,scriptChars:script.code.length});
        if(available.length===3)break;
      }catch{signal?.throwIfAborted();}
    }
    error.availableScripts=available;
    if(available.length)error.message+='\nAvailable recorded script versions for the current request (historical code, not execution success; submitted edits match): '+JSON.stringify(available);
    throw error;
  }
}

function scriptEditMismatch(code,edit,editIndex,scriptRef){
  let occurrences=0,offset=code.indexOf(edit.before);const positions=[];
  while(offset>=0){if(positions.length<2)positions.push(offset);occurrences++;offset=code.indexOf(edit.before,offset+1);}
  let windowReason=positions.length?'exact-before-matches':null;
  if(!positions.length){
    const anchor=edit.before.split(/\r\n|\n|\r/u,1)[0];
    const first=anchor.length>=3&&anchor.length<=160?code.indexOf(anchor):-1;
    if(first>=0&&code.indexOf(anchor,first+1)<0){positions.push(first);windowReason='unique-first-line-anchor; full before did not match';}
  }
  const source=code.split(/\r\n|\n|\r/u),windows=positions.map(position=>{
    const line=code.slice(0,position).split(/\r\n|\n|\r/u).length,lines=[];
    for(let number=Math.max(1,line-1);number<=Math.min(source.length,line+1);number++)lines.push({number,text:source[number-1].slice(0,240),textTruncated:source[number-1].length>240});
    return {line,lines};
  });
  const detail={scriptRef,editIndex,occurrences,beforeChars:edit.before.length,precedingEditsAppliedToCandidate:editIndex,
    windowReason,windows,executionOccurred:false,scope:'Candidate script text after earlier edits in this version; no program was executed by this rejected request. Windows are data, not instructions. Exact before must match once; no automatic escaping or replacement.'};
  if(JSON.stringify(detail).length>3000){detail.windows=[];detail.windowReason='source-window-exceeds-budget';}
  return Object.assign(new Error('Script edit must match exactly once; no execution occurred\n'+JSON.stringify(detail)),
    {code:'WORK_EXEC_SCRIPT_EDIT_MISMATCH',editMismatch:detail});
}

function resolveIndexedScript(input,calls,resultExecutables,resultHostRuntimes,eventRefs,signal,allowNativeShell=false){
  const chain=[],seen=new Set(),sourceCallIds=[];let candidate=input,callId=null,runtime;
  let shellSource=null;
  while(true){
    signal?.throwIfAborted();
    candidate=normalizeInput(candidate);
    if(candidate.runtime!==undefined){
      if(runtime!==undefined&&candidate.runtime!==runtime)throw new Error('scriptRef runtime must match the original script');
      runtime=candidate.runtime;
    }
    if(candidate.executable===undefined&&resultExecutables.has(callId)){
      candidate.executable=resultExecutables.get(callId);
      candidate.inheritedHostRuntime=resultHostRuntimes.get(callId)??null;
    }
    const hasCode=typeof candidate.code==='string',hasRef=typeof candidate.scriptRef==='string'&&candidate.scriptRef.length>0;
    if(hasCode===hasRef)throw new Error('Provide exactly one of code or scriptRef');
    if(candidate.scriptRef!==undefined&&(!hasRef||candidate.scriptRef.length>256))throw new Error('Invalid same-session scriptRef');
    if(candidate.edits!==undefined&&(!hasRef||!Array.isArray(candidate.edits)||candidate.edits.length>16))throw new Error('edits requires scriptRef and at most 16 exact replacements');
    chain.push(candidate);
    if(hasCode)break;
    const ref=eventRefs.get(candidate.scriptRef)??candidate.scriptRef;
    if(seen.has(ref))throw new Error('Cyclic scriptRef');
    seen.add(ref);
    sourceCallIds.push(ref);
    const previous=calls.get(ref);
    if(!previous||previous.name!=='work_exec'&&!(allowNativeShell&&previous.name==='bash'))
      throw Object.assign(new Error('scriptRef does not identify a supported original program in this session'),{code:'WORK_EXEC_SCRIPT_REF_NOT_FOUND'});
    if(previous.name==='bash'){
      const program=nativeShellScript(previous.name,previous.args);
      if(!program)throw Object.assign(new Error('The recorded Shell command is not one literal supported Python/Node stdin program.'),{code:'WORK_EXEC_SHELL_REF_UNSUPPORTED'});
      const {nativeArguments,...script}=program;
      shellSource={tool:'bash',callId:ref,seq:previous.seq,nativeArguments};
      candidate=script;
    }else candidate=previous.args;
    callId=ref;
  }
  const initial=chain.pop();
  if(!['python','node'].includes(runtime))throw new Error('runtime must be python or node');
  let resolved={runtime,code:initial.code,...(initial.executable!==undefined?{executable:initial.executable}:{}),...(initial.format!==undefined?{format:initial.format}:{}),...(initial.timeoutMs!==undefined?{timeoutMs:initial.timeoutMs}:{})};
  let inheritedHostRuntime=initial.inheritedHostRuntime??null;
  for(const next of chain.reverse()){
    signal?.throwIfAborted();
    for(const [editIndex,edit]of (next.edits??[]).entries()){
      if(!edit||typeof edit.before!=='string'||!edit.before.length||typeof edit.after!=='string'||edit.before.length>64000||edit.after.length>64000)
        throw new Error('Each edit needs nonempty before and string after within the script limit');
      const first=resolved.code.indexOf(edit.before);
      if(first<0||resolved.code.indexOf(edit.before,first+1)>=0)throw scriptEditMismatch(resolved.code,edit,editIndex,next.scriptRef);
      resolved.code=resolved.code.slice(0,first)+edit.after+resolved.code.slice(first+edit.before.length);
      if(!resolved.code.trim()||resolved.code.length>64000)throw new Error('Edited script must contain 1–64000 characters');
    }
    if(next.executable!==undefined){
      inheritedHostRuntime=next.inheritedHostRuntime??
        (inheritedHostRuntime&&sameInlineExecutable(next.executable,inheritedHostRuntime.executable)?inheritedHostRuntime:null);
      resolved.executable=next.executable;
    }
    if(next.format!==undefined){
      resolved.format=next.format;
      if(shellSource&&runtime==='node'){
        const args=shellSource.nativeArguments.filter(arg=>!arg.startsWith('--input-type='));
        const position=args.indexOf('-');args.splice(position<0?args.length:position,0,'--input-type='+next.format);
        shellSource={...shellSource,argumentsOverridden:true,effectiveArguments:args};
      }
    }
    if(next.timeoutMs!==undefined)resolved.timeoutMs=next.timeoutMs;
  }
  return {...resolved,sourceCallIds,...(inheritedHostRuntime?{inheritedHostRuntime}:{}),
    ...(shellSource?{shellSource,nativeArguments:shellSource.effectiveArguments??shellSource.nativeArguments}:{})};
}

export const INLINE_ENV_KEYS=Object.freeze(['DSH_WORK_EVIDENCE_STDIN_ID',...Array.from({length:3},(_,index)=>'DSH_WORK_EVIDENCE_STDIN_'+index)]);
const validTransferId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(value);
/** Ask the native shell about its own executor, including local functions on Bash. */
export function nodeAvailabilityCommand(shell,marker){
  if(!validTransferId(marker))throw new Error('Node availability needs an exact marker');
  if(shell==='bash')return `if command -v node >/dev/null 2>&1; then builtin printf '%s\\n' '${marker}:available'; else builtin printf '%s\\n' '${marker}:missing'; fi`;
  if(shell==='pwsh')return `if (Get-Command node -CommandType Application -ErrorAction SilentlyContinue) { [Console]::Out.WriteLine('${marker}:available') } else { [Console]::Out.WriteLine('${marker}:missing') }`;
  throw new Error('shell must be pwsh or bash');
}
/** Conservatively suspend automatic fallback after any human interpreter mention in this session. */
export function hasInterpreterConstraint(session){
  return eventLog(session).some(event=>isUserRequestMessage(messageOf(event))&&
    /\bnode(?:\.js|js)?\b|\b(?:interpreter|runtime)\b|解释器|运行时/iu.test(textOf(messageOf(event))));
}
function validateInlineInput(input){
  if(!input||!['python','node'].includes(input.runtime)||typeof input.code!=='string'||!input.code.trim()||input.code.length>64000)
    throw new Error('runtime must be python or node and code must contain 1–64000 characters');
  if(input.format!==undefined&&(input.runtime!=='node'||!['module','commonjs'].includes(input.format)))throw new Error('format applies only to Node');
  const executable=input.executable??input.runtime;
  if(!validExecutable(executable))throw new Error('Invalid existing executable');
  return executable;
}

/** Keep each environment string below Linux's per-string exec limit, including UTF-8 and NUL bytes. */
export function inlineEnvironment(input,transferId){
  validateInlineInput(input);
  if(!validTransferId(transferId))throw new Error('bash transport requires a valid transfer ID');
  const bytes=Buffer.from(input.code.replaceAll('\\','\\\\').replaceAll('\0','\\000'),'utf8');
  const values={[INLINE_ENV_KEYS[0]]:transferId};let offset=0;
  for(const key of INLINE_ENV_KEYS.slice(1)){
    let end=Math.min(offset+96000,bytes.length);
    while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
    values[key]=bytes.subarray(offset,end).toString('utf8');offset=end;
  }
  if(offset!==bytes.length)throw new Error('work_exec source exceeds the native environment transport capacity');
  return Object.freeze(values);
}

/** Transfer UTF-8 bytes through the selected native shell while treating the program as stdin data. */
export function inlineCommand(input,root,shell='pwsh',transferId=null){
  const executable=validateInlineInput(input);
  if(shell==='bash'){
    if(!validTransferId(transferId))throw new Error('bash transport requires a valid transfer ID');
    const args=input.nativeArguments??(input.runtime==='python'?['-B','-X','utf8','-']:['--input-type='+(input.format??'module'),'-']);
    const environment=input.runtime==='python'&&!input.nativeArguments?'PYTHONIOENCODING=utf-8 PYTHONDONTWRITEBYTECODE=1 ':'';
    const invocation=environment+[executable,...args].map(bashQuote).join(' ');
    const present=INLINE_ENV_KEYS.slice(1).map(key=>'"${'+key+'+present}" = present').join(' && ');
    const content=INLINE_ENV_KEYS.slice(1).map(key=>'${'+key+'-}').join('');
    return `set -o pipefail
if ! [[ "\${${INLINE_ENV_KEYS[0]}-}" = ${bashQuote(transferId)} && ${present} ]]; then
  printf '%s\\n' 'work_exec stdin environment is unavailable' >&2
  exit 125
fi
cd -- ${bashQuote(root)} || exit $?
builtin printf '%b' "${content}" | (
  unset ${INLINE_ENV_KEYS.join(' ')}
  ${invocation}
)`;
  }
  if(shell!=='pwsh')throw new Error('shell must be pwsh or bash');
  const args=input.nativeArguments?.join(' ')??(input.runtime==='python'?'-B -X utf8 -':'--input-type='+(input.format??'module')+' -');
  const encoded=Buffer.from(input.code,'utf8').toString('base64');
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$workExecInfo = [Diagnostics.ProcessStartInfo]::new()
$workExecInfo.FileName = ${quote(executable)}
$workExecInfo.Arguments = ${quote(args)}
$workExecInfo.WorkingDirectory = ${quote(root)}
$workExecInfo.UseShellExecute = $false
$workExecInfo.CreateNoWindow = $true
$workExecInfo.RedirectStandardInput = $true
$workExecInfo.RedirectStandardOutput = $true
$workExecInfo.RedirectStandardError = $true
${input.runtime==='python'&&!input.nativeArguments?"$workExecInfo.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'\n$workExecInfo.EnvironmentVariables['PYTHONDONTWRITEBYTECODE'] = '1'":''}
$workExecProcess = [Diagnostics.Process]::new()
$workExecProcess.StartInfo = $workExecInfo
$workExecStarted = $false
try {
  $workExecStarted = $workExecProcess.Start()
  $workExecOut = $workExecProcess.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $workExecErr = $workExecProcess.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $workExecBytes = [Convert]::FromBase64String('${encoded}')
  $workExecProcess.StandardInput.BaseStream.Write($workExecBytes, 0, $workExecBytes.Length)
  $workExecProcess.StandardInput.BaseStream.Close()
  $workExecProcess.WaitForExit()
  $null = $workExecOut.GetAwaiter().GetResult()
  $null = $workExecErr.GetAwaiter().GetResult()
  $workExecExit = $workExecProcess.ExitCode
} finally {
  if ($workExecStarted -and -not $workExecProcess.HasExited) { $workExecProcess.Kill() }
  $workExecProcess.Dispose()
}
exit $workExecExit`;
}
