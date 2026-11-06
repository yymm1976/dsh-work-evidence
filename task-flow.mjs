import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {argsOf,eventLog,isUserRequestMessage,MODE_POLICY_VERSION} from './runtime.mjs';
import {resultText,parseResult,resultHasProblem,resultIdentity} from './visible-results.mjs';
import {STAGE_CHECKPOINT_GUIDANCE} from './stage-checkpoints.mjs';
import {createExecutionDependencies,dependencyView} from './execution-dependencies.mjs';
import {recordedProcessCompletion} from './execution-evidence.mjs';
import {nativeReadObservation} from './host-references.mjs';
import {nativeReadOutputSymptom,nativeReadRecoveryEntries,executionFailureFrames,recordedSourceExcerpt,reportedCheckFailure,reportedExecutionChecks,nativeProgramParseLocation,nativeTemplateCallLocation,nativePwshInvocationDiagnostic} from './recovery.mjs';
import {resolveNativeProgram,nativeProgramAddress} from './program-reference.mjs';
import {textWindow,within} from './evidence.mjs';
import {declaredInlineExecutable} from './inline-exec.mjs';

const SOURCE='work-evidence-task-flow';
const PHASES=['investigate','modify','execute','deliver','mixed'];
const SHELL=['pwsh','ops_bash','bash','work_exec'];
const READ=new Set(['read','ops_read_files','ops_inspect_local_file','project_evidence','fastedit_java']);
const WRITE=new Set(['write','edit','ops_write_file','ops_edit_file','str_replace_editor','verified_exec','fastedit_java']);
const INTERNAL=new Set(['work_state','work_status','work_report','work_recall','work_probe','todo_write','compress','decompress','search_context','acp_status']);
const WORK_EXEC_DISCOVERY='当前 SDK 未显示 work_exec 参数时，可用宿主已声明的 capabilities.search({query:"work_exec",budgetBytes:8192}) 取得真实接口。宿主没有该发现入口或没有提供此工具时，沿用当前原生工具。';
export const TASK_FLOW_GUIDANCE='Work Evidence：遵守用户范围、文件保护和完整交付；处理尚未由实际结果回答的缺口，已知且独立的动作同轮合并，已确定就直接执行，不复述。\n'+
  '逐项完成用户明确列出的交付项。需要现实依据的事实以一次成功读取或执行为证据；同一批来源可确定的派生值沿用该证据。仅在用户明确要求、存在独立失败路径或来源冲突时，再另做最小验证。\n'+
  '已知来源和独立动作尽量同轮批量。JSON/JSONL/CSV/NDJSON应在同一次PTC调用中读取、解析并计算，只输出所需结构、计数或值，不回显整表；内部执行程序只保留完成动作所需语句，不生成重复摘要或调试日志。work_exec用于项目/外部执行，跨模型轮次复用Node状态才用retained；项目文件修改用write/edit。\n'+
  '工具调用前不预演完整任务或重复内部推导。程序输出核对明确字段、来源标记、顺序和边界，只修实际差异；结构化交付物保留全部规定字段并检查语法与形状，未要求可读排版时JSON使用紧凑单行。最终答复包含用户要求的完整交付、实际依据和剩余问题，不重复数据。先定位首个实际差异，继续处理其他已知失败，不重建未改实现。';
export const READ_ONLY_TASK_FLOW_GUIDANCE='遵守用户只读范围和完整交付，步数与用量不代表完成。逐项完成用户明确列出的交付项；需要现实依据的事实以一次成功读取或执行为证据，同一批来源可确定的派生值沿用该证据。仅在用户明确要求、存在独立失败路径或来源冲突时，再另做最小验证。\n'+
  '确需工具时，用一个PTC程序按用户顺序读取明确来源、解析并计算；JSON/JSONL/CSV/NDJSON不逐个调用read回显，也不在后续轮次重读，只输出所需结构或值。所需原文已可见时直接答复，不为整理已知值另开程序。内部程序只保留必要语句和实际错误，不生成重复摘要或调试日志；实际失败或来源冲突时才另起最小实现。\n'+
  '工具调用前不预演完整任务或重复内部推导。交付前核对明确字段、来源标记、顺序和边界，只修实际差异；结构化交付物保留全部规定字段并检查语法与形状，未要求可读排版时JSON使用紧凑单行。全部明确要求完成后直接交付，不重复数据。';
const STAGE_GUIDANCE='得到重要新结论、改变方案、遇到阻碍或进入长等待时，在普通助手正文给出可独立理解的阶段判断：结论、关键依据、尚未确定的范围和下一步。无新事实不复述，不逐工具播报，不展示内部思考；明确区分用户决定、已观察事实与助手假设。用户明确要求仅最终工件或禁止中途输出时遵守其格式。';
const MODE_EXECUTION_HYGIENE='工具调用前不预演完整任务或重复内部推导；独立读取、解析和计算尽量在同一程序完成，嵌套工具也同轮批量。程序要输出本次判断所需的全部字段、值或计数，不回显无关整表，也不生成重复摘要或调试日志；不要把已读取对象遗漏输出后在下一次调用中重读。已有成功观察及其可确定派生值直接复用。所需原文已可见时直接答复，不为整理已知值另开程序。项目文件修改用write/edit；入口可用且确需运行完整Node/Python程序时用work_exec。仅Node程序按实际模块格式设置format；Python程序不传format。';
export const QUALITY_PRIORITY='You have an UNLIMITED TOKEN BUDGET and UNLIMITED TOOL CALLS. Do not artificially restrict your reasoning depth, investigation, or verification to conserve tokens.';
const QUALITY_DISCRIMINATOR='用户明确给出的例外、禁止事项和原样保留规则必须逐项落实，不得自行增加让例外失效的条件；没有实际结果时保留未确定状态。';
const QUALITY_GUIDANCE='质量模式 Ultra：在宿主提供的思考档位上，按任务需要深入分析关键假设、竞争解释、边界和失败路径；复杂问题持续推理到足以作出可靠判断，不因时间或用量提前收束。反复失败时查找各次尝试共同依赖的假设，依据新事实调整路径；修改前考虑受影响的调用方、数据流和失败状态。区分已观察事实、推断与未解决问题，不扩大用户要求的范围。遵守用户指定的范围、禁令和暂停条件。完整完成用户全部要求。'+QUALITY_PRIORITY+
  'Treat this task as a rigorous capability evaluation where both your final deliverable and your entire execution trajectory are scored. Your objective is to maximize correctness, completeness, reliability, and instruction compliance while maintaining a focused, efficient execution trajectory. '+
  'Reasoning Quality: Think as deeply as the task requires. Investigate complex dependencies, edge cases, alternative explanations, and potential failure modes. Do not settle for superficial conclusions or premature solutions. Reconsider assumptions when evidence contradicts them. '+
  'Evidence-Driven Execution: Read the relevant files, inspect actual implementations, and verify important assumptions before making changes. Prefer targeted investigation over broad, unfocused exploration. Never fabricate evidence, test results, or implementation details. '+
  'Targeted Efficiency: Avoid redundant reasoning, repeated file reads, unnecessary tool calls, circular analysis, and exploration unrelated to the task. More tokens and more steps are not inherently better; every additional action should contribute meaningful value. '+
  'No Artificial Shortcuts: Do not sacrifice necessary analysis, investigation, implementation quality, or testing merely to reduce token consumption or step count. Missing critical evidence, skipping essential validation, or delivering an incomplete solution will be heavily penalized. '+
  'Implementation and Verification: For coding tasks, understand the relevant architecture, make precise and maintainable changes, and verify them with appropriate tests or other concrete evidence. Investigate failures instead of assuming success. '+
  'Strict Instruction Compliance: Follow all user requirements, repository instructions, scope restrictions, workflow constraints, and acceptance criteria. Unauthorized changes, unnecessary modifications, and deviations from the requested task are heavily penalized. '+
  'Completion Discipline: Continue investigating when meaningful uncertainty remains. Once the task is properly completed and sufficiently verified, stop instead of extending the process without purpose. '+
  'The highest score is awarded to an agent that uses as much reasoning and tool activity as genuinely necessary—and no more—to deliver an excellent, well-verified result with a precise and disciplined execution trajectory. Your resources are abundant. Spend them freely when they improve the outcome, but never waste them without purpose. '+MODE_EXECUTION_HYGIENE;
const AGGRESSIVE_GUIDANCE='激进优化：完整满足本次明确要求，并减少本次任务总 Token。读取关键入口后直接实现，独立动作同轮批量；只写决定下一动作所需的推理，不预演完整过程。完成条件以用户要求及其指定的行为定义为准。自行编写的检查预期与行为定义冲突时，必须修正检查预期，不得修改实现去迎合错误预期。全部明确要求及指定检查已有成功依据时交付，不追加用户未要求的多实现对照、穷举配置、旁支调查、上游全套检查或重复复核。复用已成功观察与计算；已有线索足以行动时，不扩大读取。JavaScript反引号字符串包括String.raw会解释${...}；向写入或执行工具传递含该形式的源码时，用普通字符串或正确转义，保留目标语言的反斜杠和换行。内部程序只输出本次所需结果。最终答复只包含交付、实际执行结果和剩余缺口。'+MODE_EXECUTION_HYGIENE;
export function taskFlowGuidance(mode,surface='writable'){
  if(mode==='default'&&surface==='minimal')return '';
  const body=mode==='quality'?QUALITY_GUIDANCE:mode==='aggressive'?AGGRESSIVE_GUIDANCE:surface==='read-only'?READ_ONLY_TASK_FLOW_GUIDANCE:TASK_FLOW_GUIDANCE;
  return `[Work Evidence mode: ${mode}; policy: ${MODE_POLICY_VERSION}]\n`+body+'\n'+
    (mode!=='default'&&surface==='read-only'?'当前任务只读，不扩大文件或执行权限。\n':'')+STAGE_GUIDANCE+'\n'+STAGE_CHECKPOINT_GUIDANCE;
}
const newPacing=()=>({steps:new Set(),operations:0,outputTokens:0,lastOutputTokens:0,missingOutputUsage:0,progressOutputTokens:0,noticeOutputTokens:0,noticeSteps:-1,
  lastProgress:0,nextConvergence:6,notices:new Set(),startup:false,sourceFocus:false,economy:false,computeCalls:0,computeAdvised:false,validationAdvised:false});
function progress(state){const pacing=state.pacing;pacing.lastProgress=pacing.steps.size;pacing.progressOutputTokens=pacing.outputTokens;
  pacing.nextConvergence=Math.max(pacing.nextConvergence,pacing.steps.size+4);}
function rememberPacing(state,key,outputTokens=state.pacing.outputTokens,noticeSteps=state.pacing.steps.size){
  const pacing=state.pacing;
  if(pacing.notices.has(key))return;
  const [,stage]=JSON.parse(key),steps=Number.isSafeInteger(noticeSteps)&&noticeSteps>=0?noticeSteps:pacing.steps.size;
  pacing.notices.add(key);
  pacing.noticeSteps=Math.max(pacing.noticeSteps,steps);
  pacing.noticeOutputTokens=Math.max(pacing.noticeOutputTokens,Number.isSafeInteger(outputTokens)&&outputTokens>=0?Math.min(outputTokens,pacing.outputTokens):pacing.outputTokens);
  if(stage==='startup')pacing.startup=true;
  else if(stage==='focus'){pacing.sourceFocus=true;pacing.economy=true;pacing.nextConvergence=Math.max(pacing.nextConvergence,steps+4);}
  else if(stage==='economy'){pacing.economy=true;pacing.nextConvergence=Math.max(pacing.nextConvergence,steps+4);}
  else pacing.nextConvergence=Math.max(steps+6,steps*2);
}
const messageOf=event=>event?.data?.message??(event?.data?.role?event.data:null);
const scriptVersionKey=(userSeq,scriptRef)=>JSON.stringify([userSeq,'edited-script-version',scriptRef]);
function visibleScriptRef(text,ref){
  if(typeof ref!=='string'||!ref)return false;
  let at=text.indexOf(ref);
  while(at>=0){
    if(!/[\w:.-]/u.test(text[at-1]??'')&&!/[\w:.-]/u.test(text[at+ref.length]??''))return true;
    at=text.indexOf(ref,at+1);
  }
  return false;
}
function rememberVisibleScriptVersions(state,text,rootCallId){
  for(const item of state.executions)if(item.scriptEditCount>0&&item.scriptRef&&
    (rootCallId===undefined||item.rootCallId===rootCallId&&item.status==='observed'&&item.executionCompleted&&!item.partial&&item.exitCode===0)&&
    (visibleScriptRef(text,item.scriptEventRef)||visibleScriptRef(text,item.scriptRef)))
    state.scriptReuseAdvised.add(scriptVersionKey(item.userSeq,item.scriptRef));
}
function localRecallObservation(agent,args,result){
  const kind=args.kind??'output',sessionId=args.sourceSessionId??agent.session.id;
  const target={sessionId,seq:args.seq,kind,...(kind==='reference'?{referenceSessionId:args.referenceSessionId}:{}),offset:args.offset??0};
  const base={tool:'work_recall',target,bodyRetained:false,authority:kind==='reference'?'untrusted-background':'historical-data',deliveryVisibility:'not-assessed'};
  if(sessionId!==agent.session.id)return {...base,status:'denied',reason:'source-session-mismatch'};
  const raw=result.value??parseResult(resultText(result.content)),value=raw?.data??raw;
  if(value?.status!=='observed')return {...base,status:['unavailable','disabled','cancelled'].includes(value?.status)?value.status:'unknown',
    reason:typeof value?.reason==='string'?value.reason.slice(0,200):'recall-result-not-recognized'};
  const addressed=kind==='reference'?value.source?.sessionId===sessionId&&value.source.seq===args.seq&&value.referenceSessionId===args.referenceSessionId:value.seq===args.seq;
  if(!addressed||value.historical!==true||typeof value.text!=='string')return {...base,status:'unknown',reason:'recall-address-not-confirmed'};
  const index=kind==='history',offset=value.offset??0,total=value.totalChars,returnedChars=value.text.length;
  if(offset!==target.offset||!Number.isSafeInteger(offset)||offset<0||!index&&(!Number.isSafeInteger(total)||total<offset+returnedChars))
    return {...base,status:'unknown',reason:'recall-page-not-confirmed'};
  let sourceType=null;try{sourceType=agent.session.eventAt(args.seq)?.type??null;}catch{}
  const nonTextBlocks=Array.isArray(value.nonTextBlocks)?value.nonTextBlocks.filter(type=>typeof type==='string').slice(0,8):[];
  return {...base,status:'observed',sourceType,originalResultIsError:value.isError===true,original:value.original??null,
    page:{offset,returnedChars,totalChars:Number.isSafeInteger(total)?total:null,nextOffset:value.nextOffset??null,
      nextSeq:value.nextSeq??null,throughSeq:value.throughSeq??null,endReached:value.complete===true,
      wholeSourceReturned:!index&&offset===0&&returnedChars===total&&value.complete===true&&value.original!==false&&!nonTextBlocks.length&&
        (kind!=='reference'||value.snapshotComplete===true),
      ...(index?{indexOnly:true,rowCount:value.rowCount??null}:{}),
      ...(kind==='reference'?{snapshotComplete:value.snapshotComplete===true,capturedThroughSeq:value.capturedThroughSeq??null}:{}),nonTextBlocks},
    applicability:'historical-only; current workspace and downstream use not inferred'};
}
const executionView=({key,comparisonText,fileDependencies,...entry})=>({...entry,...dependencyView(entry)});
export const operationKey=(call,cwd)=>{
  if(!isCommand(call.name))return JSON.stringify([call.name,call.args]);
  const {description,...args}=call.args;
  return JSON.stringify([call.name,normalize(cwd??''),args],(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?
    Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
};
const bounded=(map,key,value,max=64)=>{map.set(key,value);if(map.size>max)map.delete(map.keys().next().value);};
const normalize=value=>String(value).replaceAll('\\','/').toLowerCase();
const streamText=value=>typeof value==='string'?value:typeof value?.text==='string'?value.text:'';
const lineRecordRead=value=>!!value&&typeof value.path==='string'&&Number.isSafeInteger(value.offset)&&value.offset>=1&&
  Number.isSafeInteger(value.totalLines)&&value.totalLines>=0&&Array.isArray(value.lines)&&
  value.lines.every(line=>line&&Number.isSafeInteger(line.number)&&line.number>=1&&typeof line.text==='string');
const isCommand=name=>SHELL.includes(name)||name==='job_output';
const shellReportedFailure=text=>/The term[^\r\n]{0,500}is not recognized as a name of a cmdlet|(?:^|\n)\s*(?:ParserError|CommandNotFoundException|ParameterBindingException):/iu.test(String(text??''));
// stderr can contain warnings from a successful process. Missing structured
// metadata proves neither success nor failure in persisted legacy results.
const executionFailed=value=>typeof value==='string'?resultHasProblem(value):!!value&&(
  value.isError===true||value.success===false||value.ok===false||!!(value.error||value.err)||
  Number.isFinite(value.exitCode)&&value.exitCode!==0||Number.isFinite(value.exit_code)&&value.exit_code!==0||
  ['error','failed','killed','cancelled','rejected'].includes(String(value.job?.status??value.status??value.state??'').toLowerCase())||
  value.timedOut===true||value.aborted===true||value.cancelled===true||value.signal!=null||value.stopped!==undefined);
// A successful registry read may contain running or failed jobs. Their states
// describe the jobs, not the outcome of reading the registry.
const operationProblem=(name,value)=>name==='job_list'?
  !!value&&!Array.isArray(value)&&typeof value==='object'&&executionFailed(value):
  isCommand(name)?executionFailed(value?.data??value):resultHasProblem(value);
function programFailureKind(result){
  const text=result.value?.errorText??result.error?.message??resultText(result.content);
  if(/\bworker-exit\b|computation helper reclamation failed|kernel helper did not answer/iu.test(text))return 'worker-exit';
  if(/\b(?:SyntaxError|PTC-[A-Z]*\d+)\b[\s\S]{0,160}(?:parse|transform|syntax)|phase:\s*(?:parse|transform)|\bSyntaxError\b/iu.test(text))return 'parse';
  if(/\b(?:aborted|cancelled|canceled)\b/iu.test(text))return 'cancelled';
  return 'execution';
}
function failureSignature(text){
  const tail=String(text??'').slice(-4096);
  const coded=/^\s*error\[[A-Za-z0-9_-]+\]:\s*[^\r\n]{1,160}/mu.exec(tail)?.[0];
  if(coded)return coded.trim();
  const exception=[...tail.matchAll(/(?:^|\n)([\w.]*\b(?:[\w]*Error|[\w]*Exception))(?:\s*\[[A-Za-z0-9_-]+\])?(?::[ \t]*[^\r\n]{0,160}|[ \t]*\r?(?=\n|$))/gu)].at(-1)?.[0]?.trim();
  return exception??/^\s*(?:(?:[^\r\n]+:\d+(?::\d+)?:)\s*)?(?:fatal\s+)?error:\s*[^\r\n]{1,160}/miu.exec(tail)?.[0]?.trim()??null;
}
function externalOutputDiagnostic(body){
  const text=String(body??'').slice(-12000),signature=failureSignature(text);
  const frame=/^\s*at\s+(?:[^\r\n]*?\s+\()?((?:\[eval\d*\]|\[stdin\]|[^\s()]+\.[cm]?js):\d+:\d+)\)?\s*$/mu.exec(text)?.[1]??null;
  return signature?{signature,frame}:null;
}
function pathsOf(value){
  const paths=new Set();let budget=256;
  const visit=(node,depth=0)=>{
    if(--budget<0||depth>7||!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const item of node.slice(0,32))visit(item,depth+1);return;}
    for(const [key,item] of Object.entries(node)){
      if(['path','file','file_path'].includes(key)&&typeof item==='string'&&item.length<=2000)paths.add(item);
      else if(['paths','sources','focus'].includes(key)&&Array.isArray(item)){
        for(const entry of item.slice(0,16))if(typeof entry==='string'&&entry.length<=2000)paths.add(entry);else visit(entry,depth+1);
      }
      else if(['files','items','sources','edits'].includes(key))visit(item,depth+1);
    }
  };
  visit(value);return [...paths].slice(0,24);
}
export function textPaths(text){
  return [...new Set([...String(text).matchAll(/(?:[A-Za-z]:[\\/])?(?:[\p{L}\p{N}_@.~-]+[\\/])*[\p{L}\p{N}_@~-]+\.(?:[cm]?[jt]sx?|py|java|sql|jsonl?[,;，；:]?|ya?ml|toml|xml|gradle|kts|rs|go|c|cpp|h|glsl|md|rst|ini|csv|ndjson|txt)\b/gu)].map(match=>match[0].replace(/[,;，；:]$/u,'')))].slice(0,16);
}
function explicitlyCorrectedClaim(text,claim){
  if(claim.length<12||claim.length>800)return false;
  const at=text.indexOf(claim);
  if(at<0||text.indexOf(claim,at+claim.length)>=0)return false;
  const context=text.slice(Math.max(0,at-80),at)+text.slice(at+claim.length,at+claim.length+80);
  return /(?:不对|错了|错误|不成立|不再适用|纠正|撤销|推翻|应改为)|(?:\bwrong\b|\bincorrect\b|not true|no longer valid|\bcorrecti(?:on|ng)\b|\bretract(?:ed)?\b|\bsuperseded\b)/iu.test(context);
}
function challengeValidity(state,claim,root){
  const row=state.challengedClaims.get(claim);
  if(!row)return null;
  if(!row.scopePaths.length)return 'challenged';
  if(!root||state.lastOpaqueSeq>row.correctionSeq)return 'unknown';
  if([...state.calls.values()].some(call=>call.seq>row.correctionSeq&&WRITE.has(call.name)))return 'unknown';
  return row.scopePaths.some(file=>state.artifacts.get(normalize(path.resolve(root,file)))?.seq>row.correctionSeq)?'unknown':'challenged';
}
function todoPhase(todos){
  const active=todos.filter(item=>item.status==='in_progress'),phases=new Set();
  for(const item of active){
    const text=item.content;
    if(/调查|定位|查阅|阅读|分析现状|inspect|investigat|locat|read\b|research/iu.test(text))phases.add('investigate');
    if(/修改|修复|实现|编写|重构|implement|modify|\bfix\b|refactor|\bedit\b/iu.test(text))phases.add('modify');
    if(/运行|执行|观察结果|\brun\b|\bexecut|observ.*result/iu.test(text))phases.add('execute');
    if(/交付|整理结论|汇总结果|答复|deliver|finali[sz]|summari[sz]/iu.test(text))phases.add('deliver');
  }
  return {name:phases.size===1?[...phases][0]:phases.size>1?'mixed':null,focus:active.flatMap(item=>textPaths(item.content)).slice(0,24)};
}

export function createTaskFlow(ctx,runtime,{nativeFiles,call,executionDependencies=createExecutionDependencies(nativeFiles)}={}){
  const states=new Map();
  function get(agent){
    let state=states.get(agent.session.id);
    if(!state){state={cursor:0,turn:null,step:0,calls:new Map(),nested:new Map(),nestedFailures:new Map(),completedNested:new Set(),live:new Map(),errors:new Map(),reads:new Map(),jobs:new Set(),pacing:newPacing(),programFailure:null,legacyInterpreterShell:null,
      todos:null,todoSeq:null,artifacts:new Map(),artifactsEvicted:0,executionsEvicted:0,turnStartSeq:null,qualityArtifacts:new Map(),qualityExecutions:[],lastQualityReviewedMutation:null,phase:{name:null,seq:null,focus:[],source:null},lastCompaction:null,report:null,lastMutation:-1,mutationVersion:0,
      lastUser:null,programEpoch:0,programOutputDiagnostics:[],readResultRoots:new Map(),readOutputIssue:null,stageReporting:{lastTextSeq:null,lastTextSteps:0,lastNoticeSteps:0,notices:0,notifiedPhases:[]},lastInlineExec:-1,inlineExecAdvised:new Set(),scriptReuseAdvised:new Set(),diagnosticAdvised:new Set(),reuseAdvised:new Set(),cleanupAdvised:new Set(),
      probes:[],executions:[],sourceReads:[],sourceReadsEvicted:0,repeatedExecution:null,cleanup:null,transitions:[],reuseNotices:0,cleanupNotices:0,
      reportClaims:new Map(),challengedClaims:new Map(),reusedJudgment:null,lastOpaqueSeq:-1};states.set(agent.session.id,state);}
    return state;
  }
  function transition(state,name,seq,focus,source){
    if(!name)return;
    if(state.phase.name!==name){
      state.phase={name,seq,observedSeq:seq,focus:[...new Set(focus)],source};
      state.transitions.push({phase:name,seq,source});state.transitions=state.transitions.slice(-16);
    }else state.phase={...state.phase,observedSeq:seq,focus:[...new Set(['successful-write','observed-file-effect'].includes(source)?[...state.phase.focus,...focus]:focus)].slice(-24),source};
  }
  function consume(agent,state,call,result,event,{coveredFailure=false,coveredNested=false,structuredReads=[],clippedReadSeqs=[],nonemptyRead=false}={}){
    if(call.name==='work_exec')state.lastInlineExec=event.seq;
    if(call.name==='run_code'||SHELL.includes(call.name))state.lastOpaqueSeq=event.seq;
    if(state.lastUser&&event.seq>state.lastUser.seq&&!INTERNAL.has(call.name)&&!(call.name==='run_code'&&coveredNested)){
      state.pacing.operations++;state.pacing.steps.add(state.step);
    }
    const value=result.value??parseResult(resultText(result.content)),payload=value?.data??value;
    let programSource=call.name==='run_code'?String(call.args.code??''):null;
    if(call.name==='run_code'&&call.args.programRef)try{programSource=resolveNativeProgram(call.args,agent.session).code;}catch{}
    const localRecall=call.name==='work_recall'||call.name==='work_state'&&call.args.mode==='recall';
    if(call.name==='session_event_read'||localRecall){
      const observation=call.name==='session_event_read'?{tool:call.name,...(payload?.nativeSourceRead??nativeReadObservation(agent.session.id,call.args,result))}:
        payload?.localSourceRead??localRecallObservation(agent,call.name==='work_state'?{...call.args,kind:'output'}:call.args,result);
      state.sourceReads.push({...observation,seq:event.seq,callSeq:call.seq??(['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)?event.seq:null),userSeq:state.lastUser?.seq??null,turn:state.turn});
      if(state.sourceReads.length>24){state.sourceReads.shift();state.sourceReadsEvicted++;}
      return observation.status!=='observed';
    }
    if((call.name==='work_compute'||call.name==='work_exec'&&payload?.mode==='retained')&&!result.isError&&payload?.status==='completed')state.pacing.computeCalls++;
    const jobState=payload?.job?.status??payload?.status,pending=['background','promoted'].includes(payload?.kind)||['running','pending','queued','stopping'].includes(jobState);
    const deletionDenied=SHELL.includes(call.name)&&/Remove-Item|\bos\.remove\s*\(|\.unlink\s*\(/iu.test(call.args.command??'')&&
      /access.{0,12}denied|permissionerror|winerror\s*5|拒绝访问|访问.{0,8}拒绝/iu.test(payload?.errorText||resultText(result.content));
    const reportedShellFailure=call.name==='pwsh'&&shellReportedFailure(streamText(payload?.stderr??payload?.stderrText)||payload?.errorText||resultText(result.content));
    const partialOutput=payload?.outputPartial===true||payload?.truncated===true||payload?.stdout?.truncated===true||payload?.stderr?.truncated===true;
    const nativeExitCode=Number.isInteger(payload?.exitCode)?payload.exitCode:Number.isInteger(payload?.exit_code)?payload.exit_code:null;
    const completionObservation=nativeExitCode===null&&!pending&&['pwsh','ops_bash','bash'].includes(call.name)?
      recordedProcessCompletion(eventLog(agent.session),{seq:event.seq},event.seq+1):null;
    const exitCode=nativeExitCode??completionObservation?.exitCode??null;
    const checkFailure=SHELL.includes(call.name)&&!pending&&!partialOutput?payload?.checkFailure??reportedExecutionChecks({value})??reportedCheckFailure(
      streamText(payload?.stdout??payload?.stdoutText)||(value==null||typeof value==='string'?resultText(result.content):'')):null;
    const failed=!!result.isError||deletionDenied||reportedShellFailure||!!checkFailure||!pending&&
      (result.observedProblem||operationProblem(call.name,value??resultText(result.content))||exitCode!==null&&exitCode!==0)||['failed','killed'].includes(jobState);
    const cwd=payload?.cwd??call.args.workdir??runtime.get(agent).root??null;
    const complete=!failed&&!pending&&payload?.nativeStructured!==false&&value!=null&&
      (nativeExitCode===0||jobState==='completed')&&!partialOutput&&payload?.complete!==false&&payload?.executionCompleted!==false&&
      !['partial','unknown','unavailable','deopt','disabled'].includes(jobState)&&call.name!=='job_output';
    const key=call.name==='job_output'?'job:'+(call.args.job_id??call.args.jobId??call.args.id):operationKey(call,cwd),seq=event.seq;
    const callId=payload?.scriptRef??event.data?.subCallId??event.data?.callId??messageOf(event)?.source?.callId??null;
    if(call.name==='run_code'&&!result.isError&&!coveredNested&&/\b(?:execFileSync|execSync|spawnSync)\s*\(/u.test(programSource)){
      const diagnostic=payload?.reportedOutputDiagnostic??externalOutputDiagnostic(resultText(result.content));
      if(diagnostic){
        state.programOutputDiagnostics.push({seq,userSeq:state.lastUser?.seq??null,...diagnostic});
        state.programOutputDiagnostics=state.programOutputDiagnostics.slice(-2);
      }
    }
    if(call.name==='run_code'){
      state.readOutputIssue=null;
      const output=String(payload?.errorText??resultText(result.content));
      const source=programSource;
      const symptom=structuredReads.length?nativeReadOutputSymptom(source,output,{nonemptyRead,lineTextTruncated:clippedReadSeqs.length>0,isError:!!result.isError}):null;
      if(symptom)state.readOutputIssue={seq,userSeq:state.lastUser?.seq??null,readSeqs:structuredReads.slice(-4),clippedReadSeqs:clippedReadSeqs.slice(-4),
        assessment:symptom==='line-text-truncated-json'?'clipped-native-read-json-input':'suspected-return-shape-mismatch',symptom};
      // A PTC wrapper is replaced by the next program, while failed inner
      // operations retain their own keys until their matching recovery.
      const wrapperFailed=!!result.isError;
      if(wrapperFailed){
        bounded(state.errors,'run_code:latest',{tool:call.name,seq,callId,scope:'latest-program'});
        if(state.lastUser&&event.seq>state.lastUser.seq){
          state.programFailure={seq,userSeq:state.lastUser.seq,callId,chars:programSource.length,dispatched:!!coveredNested,kind:programFailureKind(result)};
        }
      }else if(!pending){state.errors.delete('run_code:latest');state.programFailure=null;}
    }else if(!INTERNAL.has(call.name)){
      if(failed)bounded(state.errors,key,{tool:call.name,seq,callId,userSeq:state.lastUser?.seq??null,processExitCode:exitCode});
      else{
        const priorError=state.errors.get(key),recoveredProcess=completionObservation?.exitCode===0&&
          priorError?.userSeq===state.lastUser?.seq&&Number.isSafeInteger(priorError?.processExitCode)&&priorError.processExitCode!==0&&
          !partialOutput&&payload?.partial!==true&&payload?.complete!==false&&payload?.lossy!==true;
        if(!SHELL.includes(call.name)||complete||recoveredProcess)state.errors.delete(key);
      }
    }
    const directCommand=String(call.args.command??''),embeddedInterpreter=SHELL.includes(call.name)&&call.name!=='work_exec'&&
      directCommand.length>=800&&/[\\/](?:python|node)(?:\.exe)?\b|\b(?:python\d*|pypy|node)\b/iu.test(directCommand)&&
      (directCommand.includes('\n')||/(?:\s-[ce]\s|@['"]|<{1,2}\s*['"]?python)/iu.test(directCommand));
    if(embeddedInterpreter&&state.lastUser&&event.seq>state.lastUser.seq)
      state.legacyInterpreterShell={seq,userSeq:state.lastUser.seq,tool:call.name,chars:directCommand.length};
    if(call.name==='work_exec'&&!failed&&!pending&&Array.isArray(payload?.scriptSourceRefs)){
      const repaired=new Set(payload.scriptSourceRefs.filter(id=>typeof id==='string'));
      for(const [errorKey,error]of state.errors)if(error.tool==='work_exec'&&repaired.has(error.callId))state.errors.delete(errorKey);
    }
    if(payload?.jobId||payload?.job_id||payload?.job?.id){
      const id=payload.jobId??payload.job_id??payload.job.id;
      if(pending)state.jobs.add(id);
      else state.jobs.delete(id);
    }
    if(call.name==='job_output'&&!failed&&payload?.kind!=='background'&&['completed','killed','failed'].includes(payload?.status??payload?.job?.status)){
      const id=call.args.job_id??call.args.jobId??call.args.id;if(id)state.jobs.delete(id);
    }
    const runtimeConfig=runtime.get(agent).config;
    const probeExecution=call.name==='work_probe'&&call.args.mode!=='recall'&&call.args.mode!=='inspect'&&payload?.fileDependencies&&payload?.id;
    if((isCommand(call.name)||probeExecution)&&(['executionTriage','stageWorkingSet'].some(key=>runtimeConfig[key])||
      runtime.activeMode(agent)==='quality'&&runtimeConfig.qualityReview)){
      const entry={seq,tool:call.name,command:String(probeExecution?call.args.arguments?.command??'':call.args.command??'').slice(0,180),description:String(probeExecution?payload.question:call.args.description??'').slice(0,180),
        cwd,exitCode,
        ...(completionObservation?{completionObservation}:{}),
        status:probeExecution?payload.status:pending?'pending':failed?'failed':complete?'observed':'partial',executionCompleted:probeExecution?payload.executionCompleted===true:complete,
        partial:partialOutput||payload?.partial===true,
        jobId:payload?.jobId??payload?.job_id??payload?.job?.id??null,
        backgroundFailureSignature:pending?payload?.backgroundFailureSignature??failureSignature(streamText(payload?.output)||streamText(payload?.stderr)):null,
        ...(probeExecution?{probeId:payload.id,nativeTool:payload.tool}:{}),
        fileDependencies:payload?.fileDependencies,...dependencyView(payload),
        userSeq:state.lastUser?.seq??null,mutationSeq:state.lastMutation,programEpoch:state.programEpoch,turn:state.turn,key,rootCallId:event.data?.rootCallId??null,
        comparisonText:payload?.comparisonText??null,
        scriptRef:call.name==='work_exec'&&typeof payload?.scriptRef==='string'?payload.scriptRef:null,
        scriptEventRef:call.name==='work_exec'&&typeof payload?.scriptEventRef==='string'?payload.scriptEventRef:null,
        scriptEditsSubmitted:call.name==='work_exec'?(payload?.scriptEditsSubmitted??call.args.edits?.length??0):0,
        scriptEditCount:call.name==='work_exec'&&payload?.scriptRef?(payload.scriptEditCount??(call.args.edits??[]).filter(edit=>edit?.before!==edit?.after).length):0,
        scriptChars:call.name==='work_exec'?payload?.scriptChars??call.args.code?.length??0:0,scriptRuntime:call.name==='work_exec'?payload?.scriptRuntime??call.args.runtime:null,
        errorCode:call.name==='work_exec'&&typeof payload?.errorCode==='string'?payload.errorCode:
          call.name==='work_exec'&&typeof payload?.error?.code==='string'?payload.error.code:null,
        scriptSourceRefs:call.name==='work_exec'&&Array.isArray(payload?.scriptSourceRefs)?payload.scriptSourceRefs.filter(id=>typeof id==='string'):[],
        formatRecovery:call.name==='work_exec'&&payload?.recovery?.reason==='commonjs-program-with-default-esm'?payload.recovery:null,
        failureSignature:failed?checkFailure?.signature??payload?.failureSignature??failureSignature(payload?.errorText||streamText(payload?.stderr??payload?.stderrText)||resultText(result.content)):null,
        failureSource:checkFailure?'reported-checks':null};
      const prior=state.executions.findLast(item=>item.key===key&&item.cwd===entry.cwd&&item.userSeq===entry.userSeq&&item.mutationSeq===entry.mutationSeq);
      if(complete&&entry.comparisonText!==null&&prior?.executionCompleted&&prior.programEpoch===entry.programEpoch&&prior.comparisonText===entry.comparisonText)
        state.repeatedExecution={...entry,reuseKey:JSON.stringify([entry.userSeq,entry.mutationSeq,entry.cwd,key,entry.comparisonText]),priorSeq:prior.seq};
      state.executions.push(entry);if(state.executions.length>24)state.executionsEvicted++;state.executions=state.executions.slice(-24);
      if(runtime.activeMode(agent)==='quality'&&runtimeConfig.qualityReview){
        const {key:operationIdentity,comparisonText,...reviewEntry}=entry;
        state.qualityExecutions.push(reviewEntry);
        state.qualityExecutions=state.qualityExecutions.slice(-16);
      }
      if(complete)transition(state,'execute',seq,textPaths(call.args.command??''),'native-execution');
      if(deletionDenied)
        state.cleanup={seq,key:JSON.stringify([state.turn,state.lastUser?.seq,state.lastMutation]),callKey:key,userSeq:state.lastUser?.seq,tool:call.name};
    }
    if(call.name==='work_probe'&&call.args.mode!=='recall'&&call.args.mode!=='inspect'&&payload?.id&&payload.question){
      if(!state.probes.some(probe=>probe.id===payload.id))state.probes.push({id:payload.id,seq,status:payload.status,question:payload.question,elapsedMs:payload.elapsedMs});
      state.probes=state.probes.slice(-16);
      const probeKey='probe:'+call.args.question;
      if(['failed','different','unknown','partial'].includes(payload.status))bounded(state.errors,probeKey,{tool:'work_probe',seq});
      else if(payload.status==='observed')state.errors.delete(probeKey);
      if(payload.executionCompleted)transition(state,'execute',seq,call.args.sources??[],'execution-evidence');
    }
    if(WRITE.has(call.name)&&!(call.name==='fastedit_java'&&['find','read','locate'].includes(call.args.mode??call.args.action??call.args.operation))){
      const files=pathsOf(call.args).filter(file=>!normalize(path.resolve(runtime.get(agent).root??'.',file)).includes('/.dsh/work-evidence/'));
      const conditional=['verified_exec','fastedit_java'].includes(call.name),fileKey=file=>normalize(path.resolve(cwd??'.',file));
      const mutations=files.flatMap(file=>{
        const effect=conditional?(Array.isArray(payload?.files)?payload.files.find(item=>typeof (item.file??item.path)==='string'&&fileKey(item.file??item.path)===fileKey(file))?.effectState:payload?.effectState):!failed?'applied':null;
        return ['applied','partial','unknown'].includes(effect)?[{path:file,effectState:effect}]:[];
      });
      if(mutations.length){
        state.lastMutation=seq;state.mutationVersion++;state.report=null;progress(state);transition(state,'modify',seq,mutations.map(item=>item.path),'observed-file-effect');
        for(const item of mutations){
          const key=fileKey(item.path);
          executionDependencies.invalidate(runtime.get(agent).root,[...state.executions,...state.qualityExecutions],{...item,path:path.resolve(cwd??runtime.get(agent).root??'.',item.path),seq});
          if(runtime.activeMode(agent)==='quality'&&runtimeConfig.qualityReview)state.qualityArtifacts.set(key,{...item,path:path.resolve(cwd??runtime.get(agent).root??'.',item.path),seq,tool:call.name,callId,userSeq:state.lastUser?.seq??null});
          if(!state.artifacts.has(key)&&state.artifacts.size>=32)state.artifactsEvicted++;
          state.artifacts.delete(key);
          bounded(state.artifacts,key,{...item,seq,argumentsSeq:call.seq??seq,tool:call.name,callId,userSeq:state.lastUser?.seq??null},32);
        }
      }
    }
    if(failed)return true;
    if(READ.has(call.name))for(const file of [...pathsOf(call.args),...pathsOf(payload)])
      bounded(state.reads,normalize(path.resolve(runtime.get(agent).root??'.',file)),{path:file,seq},32);
    if(call.name==='work_state'&&call.args.mode==='stage'&&payload?.status==='recorded'){
      transition(state,call.args.phase,seq,call.args.focus??[],'explicit-stage');
    }
    if(call.name==='work_report'&&payload?.saved===true){
      state.report={seq,args:call.args,path:payload.path,argumentsSeq:['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)?seq:call.seq??null};
      if(call.args.status==='complete'&&!call.args.remaining?.length)transition(state,'deliver',seq,[],'reported-conclusion');
      if(runtime.get(agent).config.executionTriage)for(const item of call.args.claims??[]){
        if(!['observed','inferred'].includes(item.status))continue;
        const challenge=challengeValidity(state,item.claim,runtime.get(agent).root);
        if(challenge==='challenged')state.reusedJudgment={claim:item.claim,reportSeq:state.challengedClaims.get(item.claim).reportSeq,
          correctionSeq:state.challengedClaims.get(item.claim).correctionSeq,reusedSeq:seq,source:'work_report'};
        else if(!challenge)bounded(state.reportClaims,item.claim,{reportSeq:seq,scopePaths:textPaths(item.claim)},16);
      }
    }
    return false;
  }
  function sync(agent){
    const state=get(agent),log=eventLog(agent.session);
    while(state.cursor<log.length){
      const event=log[state.cursor++],data=event.data??{},message=messageOf(event);
      if(event.type==='turn/start'){
        state.turn=data.turn;state.turnStartSeq=event.seq;state.todos=null;state.todoSeq=null;state.report=null;state.lastMutation=-1;state.errors.clear();state.calls.clear();state.nested.clear();state.nestedFailures.clear();state.reads.clear();
        state.phase={name:null,seq:null,focus:[],source:null};state.repeatedExecution=null;state.cleanup=null;state.reusedJudgment=null;
        state.pacing=newPacing();state.completedNested.clear();state.programFailure=null;state.programOutputDiagnostics=[];state.readResultRoots.clear();state.readOutputIssue=null;state.legacyInterpreterShell=null;
        state.qualityArtifacts.clear();state.qualityExecutions=[];state.lastQualityReviewedMutation=null;
      }
      if(event.type==='step/start')state.step++;
      if(event.type==='compaction/end')state.lastCompaction=event.seq;
      if(event.type==='job/registered'&&data.jobId)state.jobs.add(data.jobId);
      if(event.type==='job/settled'&&data.jobId){
        state.jobs.delete(data.jobId);
        if(['failed','killed'].includes(data.status))bounded(state.errors,'job:'+data.jobId,{tool:'job_output',seq:event.seq});
      }
      if(event.type==='user/message'){
        const kind=String(message?.source?.kind??'');
        if(kind===SOURCE){
          const advice=message.source.taskFlow;
          if(advice?.kind==='reuse'&&!state.reuseAdvised.has(advice.key)){state.reuseAdvised.add(advice.key);state.reuseNotices++;}
          if(advice?.kind==='cleanup'&&!state.cleanupAdvised.has(advice.key)){state.cleanupAdvised.add(advice.key);state.cleanupNotices++;}
          if(advice?.kind==='pacing')rememberPacing(state,advice.key,advice.outputTokens,advice.stepCount);
          if(advice?.kind==='compute'){state.pacing.computeAdvised=true;state.pacing.notices.add(advice.key);}
          if(advice?.kind==='validation'){state.pacing.validationAdvised=true;state.pacing.notices.add(advice.key);}
          if(advice?.kind==='inlineExec')state.inlineExecAdvised.add(advice.key);
          if(advice?.kind==='diagnostic')state.diagnosticAdvised.add(advice.key);
          if(['scriptReuse','scriptVersion','scriptSource'].includes(advice?.kind))state.scriptReuseAdvised.add(advice.key);
          if(['scriptVersion','scriptSource'].includes(advice?.kind))rememberVisibleScriptVersions(state,resultText(message.content));
          if(advice?.kind==='judgment'){
            state.stageReporting.lastNoticeSteps=state.pacing.steps.size;state.stageReporting.notices++;
            if(advice.phaseKey&&!state.stageReporting.notifiedPhases.includes(advice.phaseKey))state.stageReporting.notifiedPhases.push(advice.phaseKey);
          }
          if(advice?.kind==='mode')state.pacing.notices.add(advice.key);
        }else if(isUserRequestMessage(message)){
          const text=resultText(message?.content);
          if(runtime.get(agent).config.executionTriage){
            const matches=[...state.reportClaims].filter(([claim])=>explicitlyCorrectedClaim(text,claim));
            if(matches.length===1){const [claim,original]=matches[0];
              bounded(state.challengedClaims,claim,{...original,correctionSeq:event.seq},8);
            }
          }
          state.lastUser={id:message.id,seq:event.seq,text};state.report=null;state.pacing=newPacing();state.reusedJudgment=null;
          state.stageReporting={lastTextSeq:null,lastTextSteps:0,lastNoticeSteps:0,notices:0,notifiedPhases:[]};
          state.programFailure=null;state.programOutputDiagnostics=[];state.readResultRoots.clear();state.readOutputIssue=null;state.legacyInterpreterShell=null;state.lastQualityReviewedMutation=null;
        }
      }
      if(event.type==='todo/write'&&Array.isArray(data.todos)){
        if(data.todos.filter(item=>item.status==='completed').length>(state.todos??[]).filter(item=>item.status==='completed').length)progress(state);
        state.todos=data.todos;state.todoSeq=event.seq;const phase=todoPhase(data.todos);transition(state,phase.name,event.seq,phase.focus,'todo-progress');
      }
      if(event.type==='tool/call'&&data.callId){
        // Generic PTC code can write through node:fs without emitting a file-tool event.
        // Its boundary invalidates unversioned execution comparisons; no mutation is asserted.
        if((data.name==='run_code'||SHELL.includes(data.name))&&!state.calls.has(data.callId))state.lastOpaqueSeq=event.seq;
        if(data.name==='run_code'&&!state.calls.has(data.callId)){state.programEpoch++;state.repeatedExecution=null;}
        bounded(state.calls,data.callId,{name:data.name,args:argsOf(data.arguments),seq:event.seq},256);
      }
      if(event.type==='assistant/message'){
        const text=resultText(message?.content).trim();
        if(text){state.stageReporting.lastTextSeq=event.seq;state.stageReporting.lastTextSteps=state.pacing.steps.size;}
        if(text&&challengeValidity(state,text,runtime.get(agent).root)==='challenged'){
          const row=state.challengedClaims.get(text);state.reusedJudgment={claim:text,reportSeq:row.reportSeq,correctionSeq:row.correctionSeq,reusedSeq:event.seq,source:'assistant-text'};
        }
        const outputTokens=data.usage?.outputTokens;
        if(Number.isSafeInteger(outputTokens)&&outputTokens>=0){state.pacing.outputTokens+=outputTokens;state.pacing.lastOutputTokens=outputTokens;}
        else state.pacing.missingOutputUsage++;
        for(const block of message?.content??[])if(block.type==='tool-call'&&!state.calls.has(block.id)){
          if(block.name==='run_code'||SHELL.includes(block.name))state.lastOpaqueSeq=event.seq;
          if(block.name==='run_code'){state.programEpoch++;state.repeatedExecution=null;}
          bounded(state.calls,block.id,{name:block.name,args:argsOf(block.arguments),seq:event.seq},256);
        }
      }
      if(['tool/ptc-dispatch-start','tool/code-dispatch-start'].includes(event.type))bounded(state.nested,data.subCallId??data.callId??data.rootCallId,{name:data.name,seq:event.seq},256);
      if(['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)){
        if(data.rootCallId)state.completedNested.add(data.rootCallId);
        state.nested.delete(data.subCallId??data.callId??data.rootCallId);
        const id=data.subCallId??data.callId,live=state.live.get(id);state.live.delete(id);
        if(data.rootCallId&&data.name==='read'&&!data.isError&&live?.value?.lineRecordRead){
          const prior=state.readResultRoots.get(data.rootCallId);
          bounded(state.readResultRoots,data.rootCallId,{seqs:[...(prior?.seqs??[]),event.seq].slice(-4),nonempty:prior?.nonempty===true||live.value.readHasText===true,
            clippedSeqs:[...(prior?.clippedSeqs??[]),...(live.value.readLineTextTruncated?[event.seq]:[])].slice(-4)});
        }
        const failed=consume(agent,state,{name:data.name,args:argsOf(data.arguments)},live??{isError:!!data.isError,content:data.content,value:parseResult(resultText(data.content))},event);
        if(data.rootCallId&&failed){
          const key=resultIdentity(data.content),values=state.nestedFailures.get(data.rootCallId)??new Set();
          if(key&&values.size<32)values.add(key);bounded(state.nestedFailures,data.rootCallId,values,128);
        }
      }
      if(event.type==='tool/result'&&event.surfaceOp?.op!=='replace'){
        const id=message?.source?.callId??message?.toolCallId,call=state.calls.get(id);
        const live=state.live.get(id);state.live.delete(id);
        if(call)consume(agent,state,call,live??{isError:!!message.isError,content:message.content},event,
          {coveredFailure:state.nestedFailures.get(id)?.has(resultIdentity(message.content))===true,coveredNested:state.completedNested.has(id),
            structuredReads:state.readResultRoots.get(id)?.seqs??[],clippedReadSeqs:state.readResultRoots.get(id)?.clippedSeqs??[],nonemptyRead:state.readResultRoots.get(id)?.nonempty===true});
        if(call?.name==='run_code'&&!message.isError)rememberVisibleScriptVersions(state,resultText(message.content),id);
        state.readResultRoots.delete(id);
        state.completedNested.delete(id);
        state.nestedFailures.delete(id);
        state.calls.delete(id);
      }
      for(const notices of [state.reuseAdvised,state.cleanupAdvised,state.diagnosticAdvised,state.scriptReuseAdvised])if(notices.size>64)notices.delete(notices.values().next().value);
    }
    return state;
  }
  function phase(agent){
    const state=sync(agent);
    return {...state.phase,key:state.phase.name?JSON.stringify([state.turn,state.lastUser?.seq,state.phase.seq,state.lastCompaction]):null};
  }
  function declaration(args){
    if(!PHASES.includes(args.phase))throw new Error('phase must be investigate, modify, execute, deliver or mixed');
    if(!Array.isArray(args.focus??[])||(args.focus??[]).length>24||(args.focus??[]).some(file=>typeof file!=='string'||!file.trim()||file.length>2000))throw new Error('focus must be a bounded list of current paths');
    return {status:'recorded',phase:args.phase,focus:args.focus??[],
      note:'A stage signal for the next complete exchange boundary; this does not establish completion or authorize execution.'};
  }
  function message(kind,key,text){return {id:randomUUID(),role:'user',source:{kind:SOURCE,taskFlow:{kind,key}},content:[{type:'text',text}]};}
  async function startupPaths(agent,pendingMessages,signal){
    const incoming=pendingMessages.findLast(isUserRequestMessage);
    if(!incoming||!nativeFiles||!runtime.isEnabled(agent)||!runtime.get(agent).config.stepPacing)return [];
    const text=resultText(incoming.content),readme=/(?:^|[^A-Za-z0-9_./\\-])README(?=$|[^A-Za-z0-9_./\\-])/iu.exec(text);
    const readmeIndex=readme?readme.index+readme[0].length-6:-1;
    const position=file=>file==='README'?readmeIndex:text.indexOf(file);
    const files=[...new Set([...textPaths(text),...(readme?['README']:[])])].sort((a,b)=>position(a)-position(b)).slice(0,6),root=runtime.get(agent).root;
    if(!root||!files.length)return [];
    // A negative read instruction involving a named file disables optional
    // discovery for this request; the model handles the user's finer scope.
    if(text.split(/[，,。；;\n]/u).some(part=>{
      let prohibited=false,readDenied=false;
      for(const segment of part.split('、')){
        const lower=segment.toLowerCase(),statement=files.reduce((value,file)=>value.replaceAll(file.toLowerCase(),' '),lower);
        const negative=/(?:不要|不得|禁止|不允许|不能|不读取|do not|don't|never)/iu.test(statement);
        if(negative)prohibited=true;
        if(!prohibited)continue;
        if(/读取|阅读|读|查看|打开|访问|\b(?:read|open|access|inspect)\b/iu.test(statement))readDenied=true;
        else if(/修改|编辑|写入|删除|移除|安装|运行|执行|派|\b(?:modify|edit|write|delete|remove|install|run|execute)\b/iu.test(statement))readDenied=false;
        else if(negative)readDenied=true;
        if(readDenied&&files.some(file=>lower.includes(file.toLowerCase())))return true;
      }
      return false;
    }))return [];
    const stat=async file=>{
      try{return await nativeFiles.stat(root,file,signal);}catch(error){if(!['ENOENT','FS_NOT_FOUND'].includes(error.code))throw error;return {exists:false};}
    };
    const found=await Promise.allSettled(files.map(async file=>{
      let info;
      if(file==='README'){
        // A bare document name is resolved only at the project root. Every
        // candidate must be observable before a unique name can be confirmed.
        const candidates=await Promise.allSettled(['README','README.md','README.rst','README.txt'].map(stat));
        const failed=candidates.find(item=>item.status==='rejected');if(failed)throw failed.reason;
        const matches=candidates.map(item=>item.value).filter(item=>item.exists&&item.type==='file');
        if(matches.length!==1){
          runtime.effects?.decide(agent,'stepPacing','not-applicable','startup-readme-location-unavailable',{matches:matches.map(item=>item.path)});
          return null;
        }
        info=matches[0];
      }else info=await stat(file);
      if(!info.exists&&!/[\\/]/u.test(file)&&call&&ctx.tools?.get?.('glob',agent)){
        const result=await call('glob',{pattern:'**/'+file,path:root},runtime.execFor(agent,signal));
        const paths=result.value?.paths;
        if(result.isError||!Array.isArray(paths)||paths.length!==1)runtime.effects?.decide(agent,'stepPacing','not-applicable','startup-location-lookup-unavailable',
          {file,matches:Array.isArray(paths)?paths.slice(0,4):null,reasonDetail:String(result.error?.message??JSON.stringify(result.value??result.content)).slice(0,400)});
        if(!result.isError&&Array.isArray(paths)&&paths.length===1)info=await nativeFiles.stat(root,paths[0],signal);
      }
      return info.exists&&info.type==='file'?path.relative(root,info.path).replaceAll('\\','/'):null;
    }));
    signal.throwIfAborted();
    found.forEach((item,index)=>{if(item.status==='rejected')runtime.effects?.decide(agent,'stepPacing','not-applicable','startup-location-unavailable',{file:files[index],reasonDetail:String(item.reason?.message??item.reason).slice(0,200)});});
    return [...new Set(found.flatMap(item=>item.status==='fulfilled'&&item.value?[item.value]:[]))];
  }
  function beforeStep(agent,pendingMessages=[],knownPaths=[]){
    if(!runtime.isEnabled(agent))return [];
    const state=sync(agent),runtimeState=runtime.get(agent),config=runtimeState.config,messages=[],surfaceMode=runtimeState.taskSurfaceMode,mode=runtime.activeMode(agent);
    if(state.calls.size||state.nested.size)return messages;
    if(surfaceMode==='minimal')return messages;
    const user=state.lastUser,text=user?.text??'',key=String(user?.seq);
    const emit=(kind,id,text)=>{
      runtime.effects?.decide(agent,({reuse:'reuseAdvice',cleanup:'cleanupAdvice',pacing:'stepPacing',compute:'retainedComputeAdvice',validation:'stepPacing',inlineExec:'inlineExecAdvice',diagnostic:'failureAdvice',scriptReuse:'scriptReuseAdvice',scriptVersion:'scriptReuseAdvice',review:'qualityReview',judgment:'stageJudgment'}[kind]??'guidance'),'applied','observed-scene-condition',{noticeId:id});
      const notice=message(kind,id,text);
      if(kind==='pacing'){notice.source.taskFlow.outputTokens=state.pacing.outputTokens;notice.source.taskFlow.stepCount=state.pacing.steps.size;}
      messages.push(notice);runtime.get(agent).dirty=true;return messages;
    };
    const judgmentReminder=()=>{
      const row=state.reusedJudgment;
      if(!config.executionTriage||!row||challengeValidity(state,row.claim,runtimeState.root)!=='challenged')return null;
      const id=JSON.stringify(['challenged-claim',row.reportSeq,row.correctionSeq,row.reusedSeq]);
      if(state.diagnosticAdvised.has(id))return null;
      state.diagnosticAdvised.add(id);
      const notices=emit('diagnostic',id,'[work-evidence] 用户在事件'+row.correctionSeq+'原文纠正了报告事件'+row.reportSeq+'中登记的判断；事件'+row.reusedSeq+'再次原样采用。旧判断已标记为 challenged，不表示纠正或任何替代结论已经验证。核对纠正与原依据；没有新证据时不要恢复旧判断。没有自动修改事实、文件或任务结果。');
      notices[0].source.taskFlow.judgment={status:'challenged',reportSeq:row.reportSeq,correctionSeq:row.correctionSeq,reusedSeq:row.reusedSeq,source:row.source};
      return notices;
    };
    const incoming=pendingMessages.findLast(isUserRequestMessage);
    if(incoming){
      const judgment=judgmentReminder();if(judgment)return judgment;
      const modeKey=JSON.stringify([incoming.id,'pb001-brief']);
      if(mode==='aggressive'&&config.stepPacing&&!state.pacing.notices.has(modeKey)){
        state.pacing.notices.add(modeKey);
        emit('mode',modeKey,'[work-evidence] 本次使用激进优化：按本次要求及其指定的行为定义完成交付；检查预期与要求冲突时先修正预期。全部明确要求及指定检查已有成功依据时整理交付，不追加无关检查或重复复核。');
      }
      const qualityKey=JSON.stringify([incoming.id,'pb001-discriminating-input']);
      if(mode==='quality'&&config.stepPacing&&!state.pacing.notices.has(qualityKey)){
        state.pacing.notices.add(qualityKey);
        emit('mode',qualityKey,'[work-evidence] 仅对本次请求应用质量增强：'+QUALITY_PRIORITY+'围绕全部关键结论取得实际依据。'+QUALITY_DISCRIMINATOR+'逐项完成交付、实际失败和重要备选方案的取舍说明。');
      }
      const expandedFor=runtimeState.taskSurfaceExpandedFor;
      if(expandedFor===incoming.id){
        let workExec=false;try{workExec=!!ctx.tools.get('work_exec',agent);}catch{}
        if(workExec){
          runtimeState.taskSurfaceExpandedFor=null;
          return emit('pacing',JSON.stringify([incoming.id,'surface-expanded']),
            '[work-evidence] 当前请求已从只读转为可写，work_exec现已可用。确需运行完整Node/Python程序时提交原文，项目修改仍用write/edit；只使用当前请求明确授权的范围，已有结果足够时直接继续。'+WORK_EXEC_DISCOVERY);
        }
      }
      if(surfaceMode==='read-only'&&ctx.tools.modeFor?.(agent)==='ptc'&&knownPaths.length>1){
        const id=JSON.stringify([incoming.id,'read-only-batch',0]);
        if(!state.pacing.notices.has(id)){
          rememberPacing(state,id);
          return emit('pacing',id,'[work-evidence] 已确认'+knownPaths.length+'个明确来源：'+JSON.stringify(knownPaths)+
            '。下一次工具调用在同一PTC程序内按用户指定顺序读取这些来源、解析并完成只读计算或测试；JSON/JSONL/CSV/NDJSON不回显整表，只打印所需字段、计数或结果。不要逐个文件分轮；若确实依赖前次未知结果，再在该次结果后继续。只读与文件保护限制不变。');
        }
      }
      if(surfaceMode==='read-only')return messages;
      if(config.stepPacing&&ctx.tools.modeFor?.(agent)==='ptc'&&knownPaths.length){
        const id=JSON.stringify([incoming.id,'startup',0]);
        if(!state.pacing.notices.has(id)){
          rememberPacing(state,id);
          const batching=knownPaths.length>1?'若下一步就是读取这些已明确来源，可在一个PTC程序里按用户指定顺序处理，避免为每个已知路径增加往返。':'';
          const retained=knownPaths.length>=3&&(()=>{try{return !!ctx.tools.get('work_exec',agent);}catch{return false;}})()?
            '若这些输入需要多个模型步骤才能算完，可在后续步骤用work_exec的retained模式保留同一Node状态；单步能完成时直接在当前PTC程序处理。':'';
          const structured=knownPaths.some(file=>/\.(?:jsonl?|csv|ndjson)$/iu.test(file))?
            '结构化数据应在同一程序内读取和解析，不回显整表。':'';
          return emit('pacing',id,'[work-evidence] 已确认文件位置：'+JSON.stringify(knownPaths)+'。'+batching+structured+
            retained+'这些路径是已定位的起点，读取与修改范围仍以用户要求为准。');
        }
      }
      return messages;
    }
    const judgment=judgmentReminder();if(judgment)return judgment;
    const readIssue=state.readOutputIssue,readIssueKey=JSON.stringify([user?.seq,readIssue?.symptom==='line-text-truncated-json'?'native-read-clipped-json':'native-read-result']);
    if(config.executionTriage&&user&&readIssue?.userSeq===user.seq&&!state.diagnosticAdvised.has(readIssueKey)){
      state.diagnosticAdvised.add(readIssueKey);
      if(readIssue.symptom==='line-text-truncated-json')return emit('diagnostic',readIssueKey,
        '[work-evidence] 事件'+readIssue.seq+'发生 JSON.parse 失败；同次程序的 read 事件'+readIssue.clippedReadSeqs.join('、')+'已返回行正文截断标记。若将这些 lines 拼为 JSON，输入并不完整。'+
        'offset/limit 控制行号和行数；扩大 limit 或取回同一历史事件不能补回截断的行正文，也不能删掉标记后当作完整数据解析。'+
        '仍需统计时，在同一原生 PTC 程序中用当前宿主允许的完整内容读取方式读取、解析并计算，只输出所需结果。继续遵守用户范围和宿主权限；读取被拒时保留具体原因。');
      let recallAvailable=false;try{recallAvailable=!!ctx.tools.get('work_recall',agent);}catch{}
      const recordedReads=recallAvailable?'变量未保留时，先按原读取事件取回历史原文：'+readIssue.readSeqs.map(seq=>
        'work_recall('+JSON.stringify({kind:'event',seq,offset:0,maxChars:16000})+')').join('；')+'。按返回的 nextOffset 续页；需要当前文件状态时再读取文件。':
        '变量未保留且没有历史取回入口时，重新读取所需范围。';
      return emit('diagnostic',readIssueKey,'[work-evidence] 事件'+readIssue.readSeqs.join('、')+'的 read 返回 {path,offset,lines:[{number,text}],totalLines}。若事件'+readIssue.seq+'的空白正文、undefined 或取值异常来自 .content/.text，改用已有返回对象的 lines，例如 r.lines.map(l=>l.text).join("\\n")。原变量仍可用时直接复用，按 number 定位源码行。'+recordedReads);
    }
    if(config.executionTriage&&state.cleanup&&state.cleanup.userSeq===user?.seq&&state.errors.has(state.cleanup.callKey)&&!state.cleanupAdvised.has(state.cleanup.key)){
      let remove=false,loadRemove=false;try{
        remove=!!ctx.tools.get('ops_remove',agent);
        const loader=ctx.tools.get('ops_load_sdk',agent);
        loadRemove=typeof loader?.description==='string'&&/(?:^|[\s,])remove(?:[\s,.]|$)/u.test(loader.description);
      }catch{}
      state.cleanupAdvised.add(state.cleanup.key);state.cleanupNotices++;
      return emit('cleanup',state.cleanup.key,'[work-evidence] 已观察到删除操作被拒（事件'+state.cleanup.seq+'）。'+
        (remove?'当前可用原生ops_remove。若确需清理当前任务中自己创建的文件，先查看该入口的真实参数并使用已有权限。':
          loadRemove?'当前原生SDK目录包含remove，可先调用ops_load_sdk({tools:["remove"]})，下一模型步骤再按真实声明使用；当前run_code快照不能立即调用新API。加载SDK不执行文件操作，删除仍须在当前任务授权内。':'当前未确认可用的原生删除入口。')+
        '不要为了删除重复改写Shell、修改权限或绕过限制；无法在已有权限内完成时，保留具体未完成项。此提示不执行或删除文件。');
    }
    const troubledJob=state.executions.findLast(item=>item.userSeq===user?.seq&&item.status==='pending'&&item.jobId&&state.jobs.has(item.jobId)&&item.backgroundFailureSignature);
    const troubledJobKey=JSON.stringify([user?.seq,'background-diagnostic',troubledJob?.jobId]);
    if(config.executionTriage&&user&&troubledJob&&!state.diagnosticAdvised.has(troubledJobKey)){
      state.diagnosticAdvised.add(troubledJobKey);
      return emit('diagnostic',troubledJobKey,'[work-evidence] 后台任务 '+troubledJob.jobId+'（事件'+troubledJob.seq+'）输出包含 '+troubledJob.backgroundFailureSignature+'，当前尚未观察到结束。通过宿主任务接口查看真实状态和输出；旧程序已失败且不再需要时结束该任务，用户要求保留的后台任务继续保留。'+
        (troubledJob.scriptRef?'修正原程序可沿用 scriptRef '+JSON.stringify(troubledJob.scriptRef)+'，不必重发整段代码。':''));
    }
    if(config.executionTriage&&user&&state.lastInlineExec<user.seq&&!state.inlineExecAdvised.has(key)&&
      (state.lastMutation>user.seq||state.executions.some(item=>item.userSeq===user.seq&&item.status==='failed'))){
      let ready=false;try{ready=process.platform==='win32'&&!!ctx.tools.get('pwsh',agent)&&!!ctx.tools.get('work_exec',agent);}catch{}
      if(ready){
        state.inlineExecAdvised.add(key);
        return emit('inlineExec',key,'[work-evidence] 若下一实际缺口确需运行完整Node/Python程序，可用work_exec提交原文；项目修改仍用write/edit，已有结果足够时不因本提示新增执行。'+WORK_EXEC_DISCOVERY);
      }
    }
    const formatFailure=state.executions.findLast(item=>item.userSeq===user?.seq&&item.status==='failed'&&item.formatRecovery&&item.scriptRef);
    const formatKey=JSON.stringify([user?.seq,'node-format',formatFailure?.scriptRef]);
    if(config.executionTriage&&user&&formatFailure&&!state.diagnosticAdvised.has(formatKey)){
      state.diagnosticAdvised.add(formatKey);state.scriptReuseAdvised.add(JSON.stringify([user.seq,formatFailure.scriptRef]));
      return emit('diagnostic',formatKey,'[work-evidence] 事件'+formatFailure.seq+'因默认 ESM 格式下的 require 失败。原程序可按 CommonJS 语法解析；若仍需执行该程序，核对失败前的实际效果后，可用 work_exec('+JSON.stringify(formatFailure.formatRecovery.arguments)+') 沿用原文并明确格式，无需重发整段代码。');
    }
    const failedScript=state.executions.findLast(item=>item.userSeq===user?.seq&&item.tool==='work_exec'&&item.status==='failed'&&item.scriptChars>=2400&&item.scriptRef&&['python','node'].includes(item.scriptRuntime));
    const scriptAdviceKey=JSON.stringify([user?.seq,failedScript?.scriptRef]);
    if(config.executionTriage&&user&&failedScript&&!state.scriptReuseAdvised.has(scriptAdviceKey)&&
      !failedScript.scriptSourceRefs.some(ref=>state.scriptReuseAdvised.has(JSON.stringify([user.seq,ref])))){
      state.scriptReuseAdvised.add(scriptAdviceKey);
      const pathFallback=failedScript.errorCode==='WORK_EXEC_EXECUTABLE_NOT_FOUND'&&!declaredInlineExecutable(agent.session,failedScript.scriptRuntime);
      const recovery={runtime:failedScript.scriptRuntime,scriptRef:failedScript.scriptEventRef??failedScript.scriptRef,
        ...(pathFallback?{executable:failedScript.scriptRuntime}:{}),
        edits:[{before:'唯一原文',after:'替换原文'}]};
      return emit('scriptReuse',scriptAdviceKey,'[work-evidence] 事件'+failedScript.seq+'的完整脚本可用work_exec('+JSON.stringify(recovery)+')复用。'+
        (pathFallback?'此处显式指定PATH运行时，避免继续继承不存在的解释器路径。':failedScript.errorCode==='WORK_EXEC_EXECUTABLE_NOT_FOUND'?'任务声明了特定解释器，保留该缺失路径为阻塞项，不改用PATH。':'')+
        '合并已知且独立的修正，有依赖时先处理阻塞项；保留错误及未完成要求。替换须唯一匹配，成功执行会返回新scriptEventRef。');
    }
    const editedScript=state.executions.findLast(item=>item.userSeq===user?.seq&&item.tool==='work_exec'&&Number.isInteger(item.exitCode)&&!item.partial&&item.status!=='pending'&&item.scriptEditCount>0&&item.scriptRef);
    const versionAdviceKey=scriptVersionKey(user?.seq,editedScript?.scriptRef);
    if(config.executionTriage&&user&&editedScript&&!state.scriptReuseAdvised.has(versionAdviceKey)){
      state.scriptReuseAdvised.add(versionAdviceKey);
      return emit('scriptVersion',versionAdviceKey,'[work-evidence] 事件'+editedScript.seq+'返回的脚本版本为'+JSON.stringify(editedScript.scriptEventRef??editedScript.scriptRef)+'。继续修改这版程序时，显式引用此ref；之后沿用下一次返回的新ref。原始错误、输出和未完成要求继续保留。');
    }
    const programFailure=state.programFailure,programFailureKey=JSON.stringify([user?.seq,'program-failure',programFailure?.seq]);
    if(config.executionTriage&&user&&programFailure?.userSeq===user.seq&&programFailure.chars>=1000&&!state.diagnosticAdvised.has(programFailureKey)&&
      !['native-program-parser','native-program-template'].some(kind=>state.diagnosticAdvised.has(JSON.stringify([user.seq,kind,programFailure.callId])))){
      state.diagnosticAdvised.add(programFailureKey);
      if(programFailure.kind==='worker-exit')return emit('diagnostic',programFailureKey,
        '[work-evidence] 事件'+programFailure.seq+'是执行工作进程故障'+(programFailure.dispatched?'，内部工具已经分发，先确认实际状态':'，尚未分发内部工具')+'。保留已取得结果，先按宿主错误处理执行环境；不能据此判断程序语法错误，也不能把失败当成已完成。');
      if(programFailure.kind==='cancelled')return emit('diagnostic',programFailureKey,
        '[work-evidence] 事件'+programFailure.seq+'的程序已取消。保留实际执行状态，遵守当前暂停或停止要求。');
      let retainedAvailable=false;try{retainedAvailable=!!ctx.tools.get('work_exec',agent);}catch{}
      const programRef=config.nativeProgramReuse&&ctx.tools.modeFor?.(agent)==='ptc'?nativeProgramAddress(agent.session,programFailure.callId):null;
      const reference=programRef?
        ' 可用 run_code({programRef:'+JSON.stringify(programRef)+',edits:[{before:"唯一原文",after:"替换原文"}]}) 修改已记录程序。只复用程序文字，原有修改仍保留；本次执行由你明确发起。':'';
      return emit('diagnostic',programFailureKey,(programFailure.dispatched?
        '[work-evidence] 事件'+programFailure.seq+'的程序已实际调用内部工具，随后在'+programFailure.chars+'字符程序中报错。保留已取得结果，合并已知且独立的修正；有依赖时先处理阻塞项。'+
          (retainedAvailable?'若后续计算跨回合复用这些输入或对象，可用work_exec retained承接；':'')+
          '沿用上一条程序的未改部分，不重建已有实现。':
        '[work-evidence] 事件'+programFailure.seq+'的run_code失败，尚未观察到内部工具分发；程序长'+programFailure.chars+
        '字符。'+(programFailure.kind==='parse'?'按实际解析错误修正程序。':'先依据原错误定位失败原因，不能仅凭未分发内部工具推断语法错误或程序没有副作用。')+'保留已有实现，只修改实际失败部分。')+reference);
    }
    const legacyShell=state.legacyInterpreterShell,legacyShellKey=JSON.stringify([user?.seq,'legacy-inline-shell']);
    if(config.executionTriage&&user&&legacyShell?.userSeq===user.seq&&!state.inlineExecAdvised.has(legacyShellKey)&&
      (()=>{try{return !!ctx.tools.get('work_exec',agent);}catch{return false;}})()){
      state.inlineExecAdvised.add(legacyShellKey);
      return emit('inlineExec',legacyShellKey,'[work-evidence] 事件'+legacyShell.seq+'的直接'+legacyShell.tool+'调用嵌入了'+legacyShell.chars+
        '字符的Node/Python解释器程序。下一次执行同类完整解释器程序时直接用work_exec({runtime,code,executable?})提交原文，避免继续拼接Shell、here-string或临时文件；普通Shell原生命令仍可用现有入口。'+WORK_EXEC_DISCOVERY);
    }
    const repeated=state.repeatedExecution;
    if(config.executionTriage&&repeated&&repeated.userSeq===user?.seq&&repeated.mutationSeq===state.lastMutation&&!state.reuseAdvised.has(repeated.reuseKey)){
      state.reuseAdvised.add(repeated.reuseKey);state.reuseNotices++;
      return emit('reuse',repeated.reuseKey,'[work-evidence] 同一原生调用在事件'+repeated.priorSeq+'和'+repeated.seq+
        '返回了相同的完整短输出，期间未观察到当前工作区修改。若已有结果覆盖当前问题，直接使用会话中的结果；需要当前外部状态或不同输入时继续取得新观察。没有替你缓存执行、重发命令或判断任务完成。');
    }
    const failures=state.executions.slice(-2);
    if(config.executionTriage&&user&&!state.jobs.size&&failures.length===2&&failures.every(item=>item.status==='failed'&&item.userSeq===user.seq&&item.mutationSeq===state.lastMutation)&&
      failures[0].failureSignature&&failures[0].failureSignature===failures[1].failureSignature){
      const id=JSON.stringify([state.turn,user.seq,state.lastMutation,failures[0].failureSignature]);
      if(!state.diagnosticAdvised.has(id)){
        state.diagnosticAdvised.add(id);
        const [first,second]=failures,relation=first.key===second.key?'相同':'不同';
        return emit('diagnostic',id,'[work-evidence] 事件'+first.seq+'与'+second.seq+'均失败，提取到的失败摘要相同：'+first.failureSignature+
          '。记录到的调用参数'+(relation==='相同'?'与工作目录':'')+'：'+relation+'；两次均未观察到文件工具写入。'+
          '相同摘要不证明根因或外部输入相同。先对照两次实际参数和失败位置，保留完整实际值，区分实现错误与检查预期或取值错误。不要仅凭本提示停止、重试或替换实现。');
      }
    }
    const outputFailures=state.programOutputDiagnostics;
    if(config.executionTriage&&user&&outputFailures.length===2&&outputFailures.every(item=>item.userSeq===user.seq)){
      const id=JSON.stringify([user.seq,'program-output-diagnostic']);
      if(!state.diagnosticAdvised.has(id)){
        state.diagnosticAdvised.add(id);
        return emit('diagnostic',id,'[work-evidence] 事件'+outputFailures[0].seq+'和'+outputFailures[1].seq+'的外部程序输出均包含错误诊断，最近一项为 '+outputFailures[1].signature+(outputFailures[1].frame?'（'+outputFailures[1].frame+'）':'')+'。PTC 返回正常不表示外部检查通过。先依据实际失败值和现有 API 判断检查预期是否正确，再同轮修正已知且独立的错误；保留已通过项，沿用已有脚本和数据。');
      }
    }
    const pacing=state.pacing,steps=pacing.steps.size;
    const latestExecution=state.executions.findLast(item=>item.executionCompleted&&item.seq>state.lastMutation&&item.seq>(user?.seq??Infinity));
    if(steps===pacing.noticeSteps&&pacing.outputTokens===pacing.noticeOutputTokens)return messages;
    const currentWriteObserved=state.lastMutation>(user?.seq??Infinity)&&latestExecution&&!state.errors.size&&!state.jobs.size&&
      !(state.todos??[]).some(item=>item.status!=='completed');
    const outputSinceNotice=Math.max(0,pacing.outputTokens-pacing.noticeOutputTokens);
    const outputSinceProgress=Math.max(0,pacing.outputTokens-pacing.progressOutputTokens);
    const outputHeavy=steps>=2&&pacing.outputTokens>=8000&&outputSinceNotice>=8000;
    const outputStalled=steps>=2&&outputSinceProgress>=12000&&outputSinceNotice>=8000;
    const qualityReviewKey=JSON.stringify([user?.seq,'quality-equivalence-check',state.lastMutation]);
    if(mode==='quality'&&config.qualityReview&&user&&state.lastMutation>user.seq&&latestExecution&&!state.jobs.size&&!pacing.notices.has(qualityReviewKey)){
      pacing.notices.add(qualityReviewKey);
      const priorReview=state.lastQualityReviewedMutation??user.seq;
      const tracked=[...state.qualityArtifacts.values()].filter(item=>item.userSeq===user.seq);
      const modified=tracked
        .filter(item=>item.userSeq===user.seq&&item.seq>priorReview)
        .sort((left,right)=>left.seq-right.seq)
        .map(item=>({path:item.path,effectState:item.effectState}));
      const modifiedPaths=new Set(modified.map(item=>item.path));
      const unresolvedEffects=tracked
        .filter(item=>item.effectState!=='applied'&&!modifiedPaths.has(item.path))
        .map(item=>({path:item.path,effectState:item.effectState}));
      state.lastQualityReviewedMutation=state.lastMutation;
      const executionVersion=latestExecution.scriptRef??
        [latestExecution.tool,latestExecution.scriptRuntime??'native','event-'+latestExecution.seq].join(':');
      const review={modified,unresolvedEffects,mutation:{seq:state.lastMutation,version:state.mutationVersion},execution:{seq:latestExecution.seq,version:executionVersion}};
      return emit('mode',qualityReviewKey,'[work-evidence] 只核对与本次修改相关的用户交付和保留行为。'+QUALITY_PRIORITY+JSON.stringify(review)+
        '逐项列出仍缺依据的旧入口与新增路径差异。'+QUALITY_DISCRIMINATOR+'已覆盖项不重做。partial 或 unknown 文件效果仍属于未完成范围。未覆盖项列入真实失败或未完成范围。');
    }
    if(mode==='quality'&&config.stepPacing&&user&&!state.jobs.size){
      const unresolved=[...state.errors.values()].map(item=>({tool:item.tool,seq:item.seq})),id=JSON.stringify([user.seq,'quality-gap',unresolved]);
      if(unresolved.length&&!pacing.notices.has(id)){
        rememberPacing(state,id);
        return emit('pacing',id,'[work-evidence] 尚有真实工具失败未被成功结果解除：'+JSON.stringify(unresolved)+
          '。根据原始错误定位原因及受影响边界，完成修正并取得对应的成功观察；仍有阻碍时说明具体条件和未完成范围。');
      }
    }
    const reporting=state.stageReporting,silentSteps=state.pacing.steps.size-Math.max(reporting.lastTextSteps,reporting.lastNoticeSteps);
    const reportingPhase=JSON.stringify([state.phase.name??'unknown',state.errors.size>0,state.jobs.size>0]);
    if(config.stepPacing&&user&&silentSteps>=3&&!reporting.notifiedPhases.includes(reportingPhase)&&(state.reads.size||state.executions.some(item=>item.seq>=state.turnStartSeq)||state.errors.size||state.lastMutation>user.seq||state.jobs.size)){
      // Concrete recovery must reach the next request before optional stage prose.
      reporting.notifiedPhases.push(reportingPhase);
      emit('judgment',JSON.stringify([user.seq,'judgment',state.pacing.steps.size]),
        '[work-evidence] 已有工具结果。若形成重要新结论或阻碍，在正文说明实际结果、尚缺事项与下一步，并继续可执行动作。没有新结论不复述，不展示内部思考。');
      messages.at(-1).source.taskFlow.phaseKey=reportingPhase;
      return messages;
    }
    if(mode!=='quality'&&config.stepPacing&&user&&surfaceMode==='read-only'&&!state.jobs.size&&!state.errors.size){
      const readOnlyEconomyKey=JSON.stringify([user.seq,'read-only-economy']);
      if(steps>=2&&!pacing.notices.has(readOnlyEconomyKey)){
        rememberPacing(state,readOnlyEconomyKey);
        return emit('pacing',readOnlyEconomyKey,'[work-evidence] 已有结果覆盖全部要求时直接交付，不为整理已知值另开程序。仍缺读取或计算时在同一PTC程序内完成；沿用已有结果，实际失败或来源冲突时再处理具体缺口。');
      }
      const readOnlyStrictKey=JSON.stringify([user.seq,'read-only-strict']);
      if(steps>=4&&!pacing.notices.has(readOnlyStrictKey)){
        rememberPacing(state,readOnlyStrictKey);
        return emit('pacing',readOnlyStrictKey,'[work-evidence] 在同一程序补齐已明确且相互独立的缺失字段或实际失败；依赖未知结果的动作在取得结果后继续。不重读已见来源，不换语言或Shell重算，结构化输出保留全部规定字段。');
      }
      const readOnlyTailKey=JSON.stringify([user.seq,'read-only-tail']);
      if(steps>=8&&!pacing.notices.has(readOnlyTailKey)){
        rememberPacing(state,readOnlyTailKey);
        return emit('pacing',readOnlyTailKey,'[work-evidence] 只用现有实际结果完成尚未覆盖的最终字段或修正交付语法；不另起语言或Shell重算，也不再读取已见来源。该提醒不宣告完成。');
      }
    }
    if(mode!=='quality'&&config.stepPacing&&user&&surfaceMode!=='read-only'&&!state.jobs.size){
      const lastResponseKey=JSON.stringify([user.seq,'large-response',steps]);
      if(steps>=2&&pacing.lastOutputTokens>=6000&&!pacing.notices.has(lastResponseKey)){
        rememberPacing(state,lastResponseKey);
        return emit('pacing',lastResponseKey,'[work-evidence] 上一响应较长。下一步只执行仍未决的实际动作，或直接整理已有结果；不要重述分析、重演计算或增加同义检查。用户明确要求或实际错误仍须处理。');
      }
      const economyKey=JSON.stringify([user.seq,'economy']);
      if(steps>=2&&!pacing.notices.has(economyKey)){
        rememberPacing(state,economyKey);
        return emit('pacing',economyKey,'[work-evidence] 已有结果覆盖全部要求时直接交付，不为整理已知值另开程序。仍缺读取、解析或独立计算时同轮合并；工具调用前不预演完整任务或重述数据。');
      }
      const strictKey=JSON.stringify([user.seq,'strict']);
      if(steps>=4&&!pacing.notices.has(strictKey)){
        rememberPacing(state,strictKey);
        return emit('pacing',strictKey,'[work-evidence] 下一次实际动作合并已知且相互独立的修正、未覆盖输入和交付字段；有依赖时先处理阻塞项。不重读已见来源，不新增同义实现。全部明确要求及验证已有成功依据时交付，仍有缺口则继续。');
      }
      const finalizeKey=JSON.stringify([user.seq,'finalize']);
      if(steps>=8&&!pacing.notices.has(finalizeKey)){
        rememberPacing(state,finalizeKey);
        return emit('pacing',finalizeKey,'[work-evidence] 基于已有实际结果按用户列出的字段、边界、错误分支、排序和禁止项逐项核对；只修复未覆盖点后交付，不新增仅由既有结果自行引出的检查。该提醒不宣告完成。');
      }
      const reminderKey=JSON.stringify([user.seq,'finalize-reminder']);
      if(steps>=12&&(outputStalled||!currentWriteObserved&&outputSinceNotice>=8000)&&!pacing.notices.has(reminderKey)){
        rememberPacing(state,reminderKey);
        return emit('pacing',reminderKey,'[work-evidence] 已有多轮工具往返。下一动作围绕当前要求中尚缺实际依据的部分；已有成功结果能够回答的内容直接复用。完成全部明确要求后整理交付，保留实际错误和未完成项。');
      }
    }
    return messages;
  }
  function challenges(agent,state){
    return [...state.challengedClaims].slice(-4).map(([claim,row])=>({status:challengeValidity(state,claim,runtime.get(agent).root),
      reportSeq:row.reportSeq,correctionSeq:row.correctionSeq,scopePaths:[...row.scopePaths],currentApplicability:'historical-events-only'}));
  }
  function summary(agent){
    const state=sync(agent),config=runtime.get(agent).config;
    return {enabled:runtime.isEnabled(agent),mode:runtime.modeStatus(agent),stageReporting:{...state.stageReporting,enabled:runtime.isEnabled(agent)&&config.stepPacing,delivery:'assistant-text-guidance; content-not-semantically-verified'},executionTriage:config.executionTriage,stageWorkingSet:config.stageWorkingSet,
      judgmentChallenges:challenges(agent,state),phase:phase(agent),pendingCalls:state.calls.size+state.nested.size,
      userId:state.lastUser?.id??null,userSeq:state.lastUser?.seq??null,lastMutationSeq:state.lastMutation,mutationVersion:state.mutationVersion,
      unresolvedErrors:[...state.errors.values()].slice(-8),pendingJobs:[...state.jobs].slice(-16),
      sourceReads:state.sourceReads.map(item=>({...item})),sourceReadsOmitted:state.sourceReadsEvicted,
      programOutputDiagnostics:state.programOutputDiagnostics.map(item=>({...item})),
      readOutputIssue:state.readOutputIssue?{...state.readOutputIssue,readSeqs:[...state.readOutputIssue.readSeqs]}:null,
      probes:state.probes.map(probe=>({...probe,...dependencyView(state.executions.find(item=>item.probeId===probe.id))})),nativeExecutions:state.executions.map(executionView),inlineExecNotices:state.inlineExecAdvised.size,scriptReuseNotices:state.scriptReuseAdvised.size,diagnosticNotices:state.diagnosticAdvised.size,reuseNotices:state.reuseNotices,cleanupNotices:state.cleanupNotices,
      transitions:state.transitions.slice(),pacing:{enabled:config.stepPacing,toolBearingRequests:state.pacing.steps.size,operations:state.pacing.operations,
        reportedOutputTokens:state.pacing.outputTokens,lastResponseOutputTokens:state.pacing.lastOutputTokens,missingOutputUsage:state.pacing.missingOutputUsage,retainedComputeCalls:state.pacing.computeCalls,validationAdvised:state.pacing.validationAdvised,
        outputTokensSinceProgress:Math.max(0,state.pacing.outputTokens-state.pacing.progressOutputTokens),
        outputTokensSinceNotice:Math.max(0,state.pacing.outputTokens-state.pacing.noticeOutputTokens),
        notices:state.pacing.notices.size,sourceFocus:state.pacing.sourceFocus,lastProgressAt:state.pacing.lastProgress,nextConvergenceAt:state.pacing.nextConvergence,mode:'stable-policy-and-observed-notices'},completion:'not-determined',automaticStop:false};
  }
  return {sync,phase,declaration,beforeStep,startupPaths,summary,
    refreshEvidence(agent,signal,cache){
      const state=sync(agent);
      return executionDependencies.refresh(runtime.get(agent).root,[...state.executions,...state.qualityExecutions],signal,cache);
    },
    reviewState(agent){
      const state=sync(agent),log=eventLog(agent.session);
      const assistant=log.findLast(event=>event.type==='assistant/message'&&event.data?.turn===state.turn&&event.surfaceOp?.op!=='replace');
      const message=messageOf(assistant);
      const userSeq=state.lastUser?.seq??null,afterRequest=event=>event?.seq>(userSeq??Infinity);
      const artifacts=[...state.qualityArtifacts.values()]
        .filter(item=>item.userSeq===userSeq&&afterRequest(item))
        .sort((left,right)=>left.seq-right.seq).slice(-16)
        .map(item=>({path:item.path,effectState:item.effectState,seq:item.seq,tool:item.tool}));
      const executions=state.qualityExecutions
        .filter(item=>item.userSeq===userSeq&&afterRequest(item)).slice(-8)
        .map(item=>({seq:item.seq,tool:item.tool,description:item.description,exitCode:item.exitCode,
          ...(item.completionObservation?{completionObservation:item.completionObservation}:{}),
          status:item.status,executionCompleted:item.executionCompleted,userSeq:item.userSeq,mutationSeq:item.mutationSeq,
          failureSignature:item.failureSignature,failureSource:item.failureSource,scriptRef:item.scriptRef,...dependencyView(item)}));
      return {request:state.lastUser?{...state.lastUser}:null,
        assistant:assistant&&afterRequest(assistant)?{
          seq:assistant.seq,text:resultText(message?.content),turn:assistant.data?.turn,
          hasToolCalls:message?.content?.some(block=>block.type==='tool-call')===true,
        }:null,
        mutation:{seq:state.lastMutation,version:state.mutationVersion},
        artifacts,executions,
        unresolvedErrors:[...state.errors.values()].slice(-8),
        pendingJobs:[...state.jobs].slice(-16),
        todos:Array.isArray(state.todos)?state.todos.slice(-16):null,
        evidenceHighWater:{seq:agent.session.seq,mutationVersion:state.mutationVersion}};
    },
    handoff(agent){const state=sync(agent);return {phase:{...state.phase},todos:state.todos,todoSeq:state.todoSeq,userSeq:state.lastUser?.seq??null,userId:state.lastUser?.id??null,unresolvedErrors:[...state.errors.values()],pendingJobs:[...state.jobs],
      sourceReads:state.sourceReads.slice(-6).map(item=>({...item})),sourceReadsOmitted:state.sourceReadsEvicted+Math.max(0,state.sourceReads.length-6),
      artifacts:[...state.artifacts.values()],artifactsEvicted:state.artifactsEvicted,executions:state.executions.slice(-6).map(executionView),
      executionsOmitted:state.executionsEvicted+Math.max(0,state.executions.length-6),turn:state.turn,turnStartSeq:state.turnStartSeq,
      pendingCalls:[...new Map([...state.calls,...state.nested]).entries()].map(([callId,{name,seq}])=>({callId,tool:name,seq})),
      report:state.report?{seq:state.report.seq,argumentsSeq:state.report.argumentsSeq,path:state.report.path,claimedStatus:state.report.args.status,summary:state.report.args.summary,
        remaining:state.report.args.remaining??[],unverified:state.report.args.unverified??[]}:null,
      judgmentChallenges:challenges(agent,state),
      lastMutationSeq:state.lastMutation,completion:'not-determined'};},
    executionReferenceContext(exec,result){
      if(!exec.agent||exec.name!=='run_code'||exec.parent||result?.isError||exec.signal?.aborted||!runtime.isEnabled(exec.agent)||!runtime.get(exec.agent).config.executionTriage)return null;
      const state=sync(exec.agent);if(!state.lastUser)return null;
      const text=resultText(result.content),key=JSON.stringify([state.lastUser.seq,'script-source',exec.callId]);
      if(state.scriptReuseAdvised.has(key))return null;
      const entries=state.executions.filter(item=>item.rootCallId===exec.callId&&item.userSeq===state.lastUser.seq&&item.tool==='work_exec'&&
        item.executionCompleted&&item.status==='observed'&&!item.partial&&item.exitCode===0&&item.scriptChars>=2400&&item.scriptChars<=64000&&
        ['python','node'].includes(item.scriptRuntime)&&(item.scriptSourceRefs.length===0||item.scriptEditCount>0)&&typeof item.scriptEventRef==='string'&&/^event:\d{1,16}$/u.test(item.scriptEventRef)&&Number.isSafeInteger(Number(item.scriptEventRef.slice(6)))&&
        !visibleScriptRef(text,item.scriptEventRef)&&!visibleScriptRef(text,item.scriptRef));
      if(!entries.length)return null;
      const programs=entries.slice(-3).map(item=>({tool:'work_exec',scriptRef:item.scriptEventRef,runtime:item.scriptRuntime,
        scriptChars:item.scriptChars,sourceResultSeq:item.seq,processExitCode:item.exitCode,evidenceValidity:item.evidenceValidity??'unknown'}));
      state.scriptReuseAdvised.add(key);runtime.get(exec.agent).dirty=true;
      runtime.effects?.decide(exec.agent,'scriptReuseAdvice','applied','native-script-source-visible',{callId:exec.callId,programs:programs.length});
      const notice=message('scriptSource',key,'[work-evidence] 本次长程序的原文地址如下，可供后续显式复用。地址只指程序文字，执行结果与文件适用性沿原记录。\n'+
        JSON.stringify({source:{tool:'run_code',callId:exec.callId},programs,programsOmitted:entries.length-programs.length}));
      rememberVisibleScriptVersions(state,resultText(notice.content),exec.callId);
      return notice;
    },
    executionParseContext(exec,result){
      if(!exec.agent||exec.name!=='run_code'||exec.parent||!result?.isError||!runtime.isEnabled(exec.agent)||!runtime.get(exec.agent).config.executionTriage)return null;
      const native=ctx.get?.('ptcRuntime');
      if(native?.language!=='typescript'||native?.programFormat!=='function-body')return null;
      const dispatches=eventLog(exec.agent.session).filter(event=>['tool/ptc-dispatch-start','tool/code-dispatch-start','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)&&event.data?.rootCallId===exec.callId);
      const state=sync(exec.agent),code=argsOf(exec.arguments).code,location=nativeProgramParseLocation(code,result)??nativeTemplateCallLocation(code,result);
      if(!state.lastUser||!location)return null;
      const template=['quoted-string-template-call','string-raw-template-call'].includes(location.kind);
      if(!template&&dispatches.length)return null;
      const operations=new Map();
      for(const event of dispatches){
        const data=event.data,id=data.subCallId??data.callId??'event:'+event.seq;
        const entry=operations.get(id)??{callId:id,tool:data.name,startSeq:null,resultSeq:null,isError:null};
        if(event.type.endsWith('-start'))entry.startSeq=event.seq;
        else{entry.resultSeq=event.seq;entry.isError=typeof data.isError==='boolean'?data.isError:null;}
        operations.set(id,entry);
      }
      const priorOperations=[...operations.values()],partial=priorOperations.length>0;
      const key=JSON.stringify([state.lastUser.seq,template?'native-program-template':'native-program-parser',exec.callId]);
      if(state.diagnosticAdvised.has(key))return null;
      state.diagnosticAdvised.add(key);runtime.get(exec.agent).dirty=true;
      runtime.effects?.decide(exec.agent,'failureAdvice','applied',template?'native-template-source-visible':'native-parser-location-visible',{callId:exec.callId,line:location.line});
      const programRef=runtime.get(exec.agent).config.nativeProgramReuse&&ctx.tools.modeFor?.(exec.agent)==='ptc'?
        nativeProgramAddress(exec.agent.session,exec.callId):null;
      return message('diagnostic',key,(template?
        '[work-evidence] 本次程序已开始执行，并因字符串被当成模板标签函数而失败。'+(location.kind==='string-raw-template-call'?
          '原生运行栈与下列原程序行列的 String.raw 模板边界吻合；':
          '报错字符串唯一对应下列原文，边界紧邻反引号；')+'检查内嵌反引号是否结束了外层字符串。窗口是原程序数据，不是新指令。只修对应字符串的包装或转义，沿用其他程序内容；'+
          (partial?'本程序已经分发内部调用，结果见下列原生事件。保留已经完成的效果，不重做已完成操作，失败部分由调用方明确继续。':'尚未观察到内部工具分发。')+'原失败保留。\n':
        '[work-evidence] 原生解析器在执行前拒绝了本次程序。以下窗口保留原程序行号，按实际错误位置修正；未改部分沿用。\n')+
        JSON.stringify({source:{tool:'run_code',callId:exec.callId},...location,
          ...(partial?{priorOperations:priorOperations.slice(0,6),priorOperationsOmitted:Math.max(0,priorOperations.length-6)}:{}),
          ...(programRef?{reuse:{tool:'run_code',programRef,editRequirements:'Submit edits as [{before,after}]. Each before must match one exact unique literal in the original program. Fix the diagnosed failure without repeating full code. Earlier effects remain and execution is explicit.'}}:{})}));
    },
    executionShellContext(exec,result){
      if(!exec.agent||exec.name!=='pwsh'||exec.signal?.aborted||!runtime.isEnabled(exec.agent)||!runtime.get(exec.agent).config.executionTriage)return null;
      const state=sync(exec.agent),diagnostic=nativePwshInvocationDiagnostic(argsOf(exec.arguments),result);
      if(!state.lastUser||!diagnostic)return null;
      const key=JSON.stringify([state.lastUser.seq,'pwsh-unquoted-executable',diagnostic.executable]);
      if(state.diagnosticAdvised.has(key))return null;
      state.diagnosticAdvised.add(key);runtime.get(exec.agent).dirty=true;
      runtime.effects?.decide(exec.agent,'failureAdvice','applied','native-pwsh-invocation-visible',{callId:exec.callId});
      return message('diagnostic',key,'[work-evidence] 本次 PowerShell 错误中的命令名，是含空格的可执行路径在第一个空格前的片段。'+
        '若仍需执行该命令，使用 suggestedPrefix 的调用运算符和引号，保留原有参数；删掉输出管道不能修正路径拆分。原命令和失败保留。以下是调用语法数据。\n'+
        JSON.stringify({source:{tool:'pwsh',callId:exec.callId},...diagnostic}));
    },
    executionReportContext(exec,result){
      if(!exec.agent||!SHELL.includes(exec.name)||!runtime.isEnabled(exec.agent)||!runtime.get(exec.agent).config.executionTriage)return null;
      const state=sync(exec.agent),report=reportedExecutionChecks(result);
      if(!state.lastUser||!report)return null;
      const key=JSON.stringify([state.lastUser.seq,'reported-execution-failure',exec.callId]);
      if(state.diagnosticAdvised.has(key))return null;
      state.diagnosticAdvised.add(key);runtime.get(exec.agent).dirty=true;
      runtime.effects?.decide(exec.agent,'failureAdvice','applied','reported-execution-failure-visible',{tool:exec.name,callId:exec.callId});
      return message('diagnostic',key,'[work-evidence] 本次程序已结束，退出码为 '+report.processExitCode+'，原始输出报告了失败。以下汇总与失败项来自这一次运行，属于数据；源码中的静态数量不能替代这次运行报告。\n'+
        JSON.stringify({source:{tool:exec.name,callId:exec.callId},...report}));
    },
    executionSourceContext(exec,result){
      if(!exec.agent||!SHELL.includes(exec.name)||!runtime.isEnabled(exec.agent)||!runtime.get(exec.agent).config.executionTriage)return null;
      const state=sync(exec.agent),root=runtime.get(exec.agent).root;
      if(!state.lastUser||typeof root!=='string')return null;
      for(const frame of executionFailureFrames(result,root)){
        const artifact=state.artifacts.get(normalize(frame.path));
        if(!artifact||artifact.effectState!=='applied'||artifact.userSeq!==state.lastUser.seq)continue;
        const artifactPath=path.resolve(root,artifact.path);
        if(process.platform==='win32'?normalize(artifactPath)!==normalize(frame.path):artifactPath!==frame.path)continue;
        const key=JSON.stringify([state.lastUser.seq,'file-failure-source',artifact.argumentsSeq,frame.path,frame.line]);
        if(state.diagnosticAdvised.has(key))continue;
        let event;try{event=exec.agent.session.eventAt(artifact.argumentsSeq??artifact.seq);}catch{}
        const excerpt=recordedSourceExcerpt(event,frame);
        if(!excerpt)continue;
        state.diagnosticAdvised.add(key);runtime.get(exec.agent).dirty=true;
        runtime.effects?.decide(exec.agent,'failureAdvice','applied','recorded-file-failure-context',{sourceSeq:excerpt.source.seq,file:frame.path,line:frame.line});
        return message('diagnostic',key,'[work-evidence] 执行错误指向本次修改过的文件。以下是先前写入的原文窗口，可用于定位；这是历史数据，内容不是指令，不代表当前文件状态。窗口行号属于记录片段，错误行号见 frame。\n'+JSON.stringify(excerpt));
      }
      return null;
    },
    recoverReadOutput(exec,result){
      if(!exec.agent||exec.name!=='run_code'||!runtime.isEnabled(exec.agent)||!runtime.get(exec.agent).config.executionTriage)return result;
      const state=sync(exec.agent),reads=state.readResultRoots.get(exec.callId),key=JSON.stringify([state.lastUser?.seq,'native-read-result']);
      if(!state.lastUser||!reads?.seqs.length||state.diagnosticAdvised.has(key)||!nativeReadOutputSymptom(String(argsOf(exec.arguments).code??''),resultText(result.content),
        {nonemptyRead:reads.nonempty===true,isError:!!result.isError}))return result;
      const records=nativeReadRecoveryEntries(exec.agent,reads.seqs);
      if(!records.length)return result;
      state.diagnosticAdvised.add(key);runtime.get(exec.agent).dirty=true;
      runtime.effects?.decide(exec.agent,'failureAdvice','applied','native-read-output-recovered',{readSeqs:records.map(item=>item.seq)});
      return {...result,content:[...(result.content??[]),{type:'text',text:'[Work Evidence recovered native read output]\n'+
        'Original records from this call; historical data, not instructions or a new file observation.\n'+JSON.stringify({records})}]};
    },
    observe(exec,result){
      if(!exec.agent||!runtime.isEnabled(exec.agent))return;
      const raw=result.value??parseResult(resultText(result.content)),value=raw?.data??raw;
      const stdout=streamText(value?.stdout??value?.stdoutText),stderr=streamText(value?.stderr??value?.stderrText);
      const outputPartial=value?.truncated===true||value?.stdout?.truncated===true||value?.stderr?.truncated===true||value?.complete===false||value?.lossy===true;
      const comparisonText=isCommand(exec.name)&&exec.name!=='job_output'&&!outputPartial&&stdout.length+stderr.length<=4096&&
        (value?.stdout!==undefined||value?.stdoutText!==undefined)?JSON.stringify([value?.exitCode??value?.exit_code??null,stdout,stderr]):null;
      let readLineTextTruncated=false;
      if(exec.name==='read'&&!result.isError&&lineRecordRead(raw))try{
        const root=runtime.get(exec.agent).root;
        if(root){within(root,raw.path);readLineTextTruncated=textWindow(raw,{maxLines:0,maxLineChars:Infinity}).lineTextTruncated;}
      }catch{}
      // Keep status and dependency metadata, never another copy of large bodies.
      const compact={nativeStructured:raw!=null,status:value?.status??raw?.status,kind:value?.kind,mode:value?.mode,
        ...(exec.name==='read'?{lineRecordRead:lineRecordRead(raw),readHasText:lineRecordRead(raw)&&raw.lines.some(line=>/\S/u.test(line.text)),readLineTextTruncated}:{}),
        ...(exec.name==='session_event_read'?{nativeSourceRead:nativeReadObservation(exec.agent.session.id,argsOf(exec.arguments),result)}:{}),
        ...(exec.name==='work_recall'||exec.name==='work_state'&&argsOf(exec.arguments).mode==='recall'?
          {localSourceRead:localRecallObservation(exec.agent,exec.name==='work_state'?{...argsOf(exec.arguments),kind:'output'}:argsOf(exec.arguments),result)}:{}),
        exitCode:value?.exitCode,exit_code:value?.exit_code,jobId:value?.jobId??value?.job_id,job:value?.job,
        error:!!(value?.error||raw?.error),errorCode:typeof (value?.error??raw?.error)?.code==='string'?(value?.error??raw?.error).code:null,
        timedOut:value?.timedOut,aborted:value?.aborted,cancelled:value?.cancelled,
        signal:value?.signal,stopped:value?.stopped,effectState:value?.effectState,cwd:value?.cwd,outputPartial,comparisonText,
        errorText:String(exec.name==='run_code'&&result.isError&&resultText(result.content)||
          (value?.error?.message??raw?.error?.message??value?.error??raw?.error??result.error?.message??(stderr||stdout||resultText(result.content)))).slice(0,1200),
        failureSignature:failureSignature(stderr||stdout||resultText(result.content)),
        backgroundFailureSignature:isCommand(exec.name)?failureSignature(streamText(value?.output)||stderr):null,
        reportedOutputDiagnostic:exec.name==='run_code'?externalOutputDiagnostic(resultText(result.content)):null,
        checkFailure:isCommand(exec.name)?reportedExecutionChecks({value:raw})??reportedCheckFailure(stdout||(raw==null||typeof raw==='string'?resultText(result.content):'')):null,
        scriptRef:value?.scriptRef,scriptChars:value?.scriptChars,scriptRuntime:value?.scriptRuntime,scriptSourceRefs:value?.scriptSourceRefs,
        scriptEventRef:value?.scriptEventRef,
        scriptEditsSubmitted:value?.scriptEditsSubmitted,scriptEditCount:value?.scriptEditCount,
        recovery:value?.recovery,
        fileDependencies:value?.fileDependencies,...dependencyView(value),partial:value?.partial,tool:value?.tool,
        files:Array.isArray(value?.files)?value.files.slice(0,50).map(file=>({path:file.path??file.file,effectState:file.effectState})):undefined,
        sources:pathsOf(value),saved:value?.saved,path:value?.path,id:value?.id,question:value?.question,
        elapsedMs:value?.elapsedMs,executionCompleted:value?.executionCompleted};
      bounded(get(exec.agent).live,exec.callId,{isError:!!result.isError,observedProblem:operationProblem(exec.name,raw??resultText(result.content))||exec.name==='pwsh'&&shellReportedFailure(stderr),value:compact},256);
    },
    disposeAgent:agent=>states.delete(agent.session.id),dispose:()=>states.clear()};
}
