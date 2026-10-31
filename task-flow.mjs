import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {argsOf,eventLog,isUserRequestMessage,MODE_POLICY_VERSION} from './runtime.mjs';
import {resultText,parseResult,resultHasProblem,resultIdentity} from './visible-results.mjs';
import {STAGE_CHECKPOINT_GUIDANCE} from './stage-checkpoints.mjs';

const SOURCE='work-evidence-task-flow';
const PHASES=['investigate','modify','execute','deliver','mixed'];
const SHELL=['pwsh','ops_bash','bash','work_exec'];
const READ=new Set(['read','ops_read_files','ops_inspect_local_file','project_evidence','fastedit_java']);
const WRITE=new Set(['write','edit','ops_write_file','ops_edit_file','str_replace_editor','verified_exec','fastedit_java']);
const INTERNAL=new Set(['work_state','work_status','work_report','work_recall','work_probe','todo_write','compress','decompress','search_context','acp_status']);
export const TASK_FLOW_GUIDANCE='Work Evidence：遵守用户范围、文件保护和完整交付；每步处理一个尚未由实际结果回答的缺口，已确定就直接执行，不复述。\n'+
  '逐项完成用户明确列出的交付项。需要现实依据的事实以一次成功读取或执行为证据；同一批来源可确定的派生值沿用该证据。仅在用户明确要求、存在独立失败路径或来源冲突时，再另做最小验证。\n'+
  '已知来源和独立动作尽量同轮批量。JSON/JSONL/CSV/NDJSON应在同一次PTC调用中读取、解析并计算，只输出所需结构、计数或值，不回显整表；内部执行程序只保留完成动作所需语句，不生成重复摘要或调试日志。work_exec用于项目/外部执行，跨模型轮次复用Node状态才用retained；项目文件修改用write/edit。\n'+
  '工具调用前不预演完整任务或重复内部推导。程序输出核对明确字段、来源标记、顺序和边界，只修实际差异；结构化交付物保留全部规定字段并检查语法与形状，未要求可读排版时JSON使用紧凑单行。最终答复包含用户要求的完整交付、实际依据和剩余问题，不重复数据。先定位首个实际差异，继续处理其他已知失败，不重建未改实现。';
export const READ_ONLY_TASK_FLOW_GUIDANCE='遵守用户只读范围和完整交付，步数与用量不代表完成。逐项完成用户明确列出的交付项；需要现实依据的事实以一次成功读取或执行为证据，同一批来源可确定的派生值沿用该证据。仅在用户明确要求、存在独立失败路径或来源冲突时，再另做最小验证。\n'+
  '用一个PTC程序按用户顺序读取明确来源、解析并计算；JSON/JSONL/CSV/NDJSON不逐个调用read回显，也不在后续轮次重读，只输出所需结构或值。内部程序只保留必要语句和实际错误，不生成重复摘要或调试日志；实际失败或来源冲突时才另起最小实现。\n'+
  '工具调用前不预演完整任务或重复内部推导。交付前核对明确字段、来源标记、顺序和边界，只修实际差异；结构化交付物保留全部规定字段并检查语法与形状，未要求可读排版时JSON使用紧凑单行。全部明确要求完成后直接交付，不重复数据。';
const STAGE_GUIDANCE='得到重要新结论、改变方案、遇到阻碍或进入长等待时，在普通助手正文给出可独立理解的阶段判断：结论、关键依据、尚未确定的范围和下一步。无新事实不复述，不逐工具播报，不展示内部思考；明确区分用户决定、已观察事实与助手假设。用户明确要求仅最终工件或禁止中途输出时遵守其格式。';
const MODE_EXECUTION_HYGIENE='工具调用前不预演完整任务或重复内部推导；独立读取、解析和计算尽量在同一程序完成，嵌套工具也同轮批量。程序要输出本次判断所需的全部字段、值或计数，不回显无关整表，也不生成重复摘要或调试日志；不要把已读取对象遗漏输出后在下一次调用中重读。已有成功观察及其可确定派生值直接复用。项目文件修改用write/edit；入口可用且确需运行完整Node/Python程序时用work_exec，并按项目实际模块格式设置format。';
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
const AGGRESSIVE_GUIDANCE='激进优化：以减少本次任务总Token为首要优化目标。读取关键入口后直接实现，独立动作同轮批量；只写决定下一动作所需的推理，不预演完整过程。用户明确要求的交付和检查必须完成；检查通过即交付，不追加用户未要求的多实现对照、穷举配置、旁支调查、上游全套检查或重复复核。复用已成功观察与计算；已有线索足以行动时，不扩大读取。JavaScript反引号字符串包括String.raw会解释${...}；向写入或执行工具传递含该形式的源码时，用普通字符串或正确转义，保留目标语言的反斜杠和换行。内部程序只输出本次所需结果。最终答复只包含交付、实际执行结果和剩余缺口。'+MODE_EXECUTION_HYGIENE;
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
export const operationKey=(call,cwd)=>{
  if(!isCommand(call.name))return JSON.stringify([call.name,call.args]);
  const {description,...args}=call.args;
  return JSON.stringify([call.name,normalize(cwd??''),args],(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?
    Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
};
const bounded=(map,key,value,max=64)=>{map.set(key,value);if(map.size>max)map.delete(map.keys().next().value);};
const normalize=value=>String(value).replaceAll('\\','/').toLowerCase();
const streamText=value=>typeof value==='string'?value:typeof value?.text==='string'?value.text:'';
const isCommand=name=>SHELL.includes(name)||name==='job_output';
const shellReportedFailure=text=>/The term[^\r\n]{0,500}is not recognized as a name of a cmdlet|(?:^|\n)\s*(?:ParserError|CommandNotFoundException|ParameterBindingException):/iu.test(String(text??''));
function failureSignature(text){
  const tail=String(text??'').slice(-4096);
  const coded=/^\s*error\[[A-Za-z0-9_-]+\]:\s*[^\r\n]{1,160}/mu.exec(tail)?.[0];
  if(coded)return coded.trim();
  const exception=[...tail.matchAll(/(?:^|\n)([\w.]*\b(?:[\w]*Error|[\w]*Exception))(?:\s*\[[A-Za-z0-9_-]+\])?:\s*([^\r\n]{0,160})/gu)].at(-1)?.[0]?.trim();
  return exception??/^\s*(?:(?:[^\r\n]+:\d+(?::\d+)?:)\s*)?(?:fatal\s+)?error:\s*[^\r\n]{1,160}/miu.exec(tail)?.[0]?.trim()??null;
}
function reportedCheckFailure(text){
  // A successful process may still report failed comparisons. Require a
  // self-consistent summary and explicit failed entries, not arbitrary JSON.
  if(typeof text==='string'&&text.length<=64000){
    let summary;try{summary=JSON.parse(text);}catch{}
    const failed=summary?.failures;
    if(Number.isSafeInteger(summary?.passed)&&Number.isSafeInteger(summary?.total)&&summary.passed>=0&&summary.total>summary.passed&&
      Array.isArray(failed)&&failed.length===summary.total-summary.passed&&failed.every(item=>item&&typeof item==='object'&&
        (item.pass===false||item.passed===false)&&typeof item.name==='string'&&item.name.trim()))
      return {signature:'Reported comparisons: '+failed.length+'/'+summary.total+' failed; '+failed[0].name.trim().slice(0,140)};
  }
  const lines=String(text??'').slice(-12000).split(/\r?\n/u);
  const numericMarkers=new Set();let summary=null;
  for(const line of lines){
    const match=/^\s*(?:FAIL(?:ED|URES?|_TOTAL|_COUNT)?)\s*[:=(]\s*(\d+)\b/iu.exec(line)??
      /^\s*(?:checks?|tests?|total)\b[^\r\n]{0,160}?\b(?:failed|failures)\s*[:=]\s*(\d+)\b/iu.exec(line)??
      /^\s*(?:checks?|tests?|total)\b[^\r\n]{0,160}?\b(\d+)\s+(?:failed|failures)\b/iu.exec(line)??
      /^\s*(\d+)\s+(?:failed|failures)\b/iu.exec(line);
    if(match){numericMarkers.add(line);if(Number(match[1])>0)summary=line.trim().slice(0,180);}
  }
  const first=lines.find(line=>!numericMarkers.has(line)&&/^\s*FAIL(?:ED)?\s*:\s*\S/iu.test(line))?.trim().slice(0,180);
  return summary||first?{signature:first??summary}:null;
}
function presentationLimit(text){
  const matches=[...String(text).matchAll(/(?:不超过|至多|最多)\s*(\d{1,6})\s*(?:个\s*)?(汉字|字符)/gu)];
  const limits=[...new Map(matches.map(match=>[match[1]+match[2],{max:Number(match[1]),unit:match[2]}])).values()];
  return limits.length===1?limits[0]:null;
}
function presentationCounts(args,text){
  const description=String(args?.description??'');
  if(!/解释|答复|说明|文本|篇幅|定稿/u.test(description)||!/长度|字数|字符/u.test(description)||typeof text!=='string'||text.length>4096)return null;
  const select=pattern=>{
    const values=[...text.matchAll(pattern)].map(match=>Number(match[1]));
    return values.length===1&&Number.isSafeInteger(values[0])?values[0]:null;
  };
  const han=select(/汉字\s*[：:=]?\s*(\d+)/gu),characters=select(/总字符\s*[：:=]?\s*(\d+)/gu);
  return han!==null||characters!==null?{汉字:han,字符:characters}:null;
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
  return [...new Set([...String(text).matchAll(/(?:[A-Za-z]:[\\/])?(?:[\p{L}\p{N}_@.~-]+[\\/])*[\p{L}\p{N}_@~-]+\.(?:[cm]?[jt]sx?|py|java|sql|jsonl?[,;，；:]?|ya?ml|toml|xml|gradle|kts|rs|go|c|cpp|h|glsl|md|ini|csv|ndjson|txt)\b/gu)].map(match=>match[0].replace(/[,;，；:]$/u,'')))].slice(0,16);
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

export function createTaskFlow(ctx,runtime,{nativeFiles,call}={}){
  const states=new Map();
  function get(agent){
    let state=states.get(agent.session.id);
    if(!state){state={cursor:0,turn:null,step:0,calls:new Map(),nested:new Map(),nestedFailures:new Map(),completedNested:new Set(),live:new Map(),errors:new Map(),reads:new Map(),jobs:new Set(),pacing:newPacing(),programFailure:null,legacyInterpreterShell:null,
      todos:null,todoSeq:null,artifacts:new Map(),artifactsEvicted:0,qualityArtifacts:new Map(),qualityExecutions:[],lastQualityReviewedMutation:null,phase:{name:null,seq:null,focus:[],source:null},lastCompaction:null,report:null,lastMutation:-1,mutationVersion:0,
      lastUser:null,stageReporting:{lastTextSeq:null,lastTextSteps:0,lastNoticeSteps:0,notices:0},lastInlineExec:-1,inlineExecAdvised:new Set(),scriptReuseAdvised:new Set(),diagnosticAdvised:new Set(),advised:new Set(),finishAdvised:new Set(),reuseAdvised:new Set(),cleanupAdvised:new Set(),presentationAdvised:new Set(),
      probes:[],executions:[],repeatedExecution:null,cleanup:null,presentation:null,transitions:[],opportunities:0,finishNotices:0,reuseNotices:0,cleanupNotices:0,presentationNotices:0};states.set(agent.session.id,state);}
    return state;
  }
  function transition(state,name,seq,focus,source){
    if(!name)return;
    if(state.phase.name!==name){
      state.phase={name,seq,observedSeq:seq,focus:[...new Set(focus)],source};
      state.transitions.push({phase:name,seq,source});state.transitions=state.transitions.slice(-16);
    }else state.phase={...state.phase,observedSeq:seq,focus:[...new Set(['successful-write','observed-file-effect'].includes(source)?[...state.phase.focus,...focus]:focus)].slice(-24),source};
  }
  function consume(agent,state,call,result,event,{coveredFailure=false,coveredNested=false}={}){
    if(call.name==='work_exec')state.lastInlineExec=event.seq;
    if(state.lastUser&&event.seq>state.lastUser.seq&&!INTERNAL.has(call.name)&&!(call.name==='run_code'&&coveredNested)){
      state.pacing.operations++;state.pacing.steps.add(state.step);
    }
    const value=result.value??parseResult(resultText(result.content)),payload=value?.data??value;
    if((call.name==='work_compute'||call.name==='work_exec'&&payload?.mode==='retained')&&!result.isError&&payload?.status==='completed')state.pacing.computeCalls++;
    const jobState=payload?.job?.status??payload?.status,pending=['background','promoted'].includes(payload?.kind)||['running','pending','queued','stopping'].includes(jobState);
    const deletionDenied=SHELL.includes(call.name)&&/Remove-Item|\bos\.remove\s*\(|\.unlink\s*\(/iu.test(call.args.command??'')&&
      /access.{0,12}denied|permissionerror|winerror\s*5|拒绝访问|访问.{0,8}拒绝/iu.test(payload?.errorText||resultText(result.content));
    const reportedShellFailure=call.name==='pwsh'&&shellReportedFailure(streamText(payload?.stderr??payload?.stderrText)||payload?.errorText||resultText(result.content));
    const partialOutput=payload?.outputPartial===true||payload?.truncated===true||payload?.stdout?.truncated===true||payload?.stderr?.truncated===true;
    const checkFailure=SHELL.includes(call.name)&&!pending&&!partialOutput?payload?.checkFailure??reportedCheckFailure(streamText(payload?.stdout??payload?.stdoutText)):null;
    const failed=!!result.isError||deletionDenied||reportedShellFailure||!!checkFailure||!pending&&(result.observedProblem||resultHasProblem(value??resultText(result.content)))||['failed','killed'].includes(jobState)||
      SHELL.includes(call.name)&&(value==null||payload?.nativeStructured===false);
    const cwd=payload?.cwd??call.args.workdir??runtime.get(agent).root??null;
    const exitCode=Number.isInteger(payload?.exitCode)?payload.exitCode:Number.isInteger(payload?.exit_code)?payload.exit_code:null;
    const complete=!failed&&!pending&&payload?.nativeStructured!==false&&value!=null&&
      (exitCode===0||jobState==='completed')&&payload?.outputPartial!==true&&call.name!=='job_output';
    const key=call.name==='job_output'?'job:'+(call.args.job_id??call.args.jobId??call.args.id):operationKey(call,cwd),seq=event.seq;
    const callId=payload?.scriptRef??event.data?.subCallId??event.data?.callId??messageOf(event)?.source?.callId??null;
    if(!INTERNAL.has(call.name)&&!(call.name==='run_code'&&coveredFailure&&failed&&!result.isError)){
      if(failed)bounded(state.errors,key,{tool:call.name,seq,callId});
      else if(!SHELL.includes(call.name)||complete)state.errors.delete(key);
    }
    if(call.name==='run_code'&&complete){
      state.programFailure=null;
    }
    if(call.name==='run_code'&&failed&&state.lastUser&&event.seq>state.lastUser.seq&&String(call.args.code??'').length>=1000)
      state.programFailure={seq,userSeq:state.lastUser.seq,chars:String(call.args.code??'').length,dispatched:!!coveredNested};
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
    if(isCommand(call.name)&&(['executionTriage','stageWorkingSet','finishAdvice'].some(key=>runtimeConfig[key])||
      runtime.activeMode(agent)==='quality'&&runtimeConfig.qualityReview)){
      const entry={seq,tool:call.name,command:String(call.args.command??'').slice(0,180),description:String(call.args.description??'').slice(0,180),
        cwd,exitCode,
        status:pending?'pending':failed?'failed':complete?'observed':'partial',executionCompleted:complete,
        userSeq:state.lastUser?.seq??null,mutationSeq:state.lastMutation,key,
        comparisonText:payload?.comparisonText??null,
        scriptRef:call.name==='work_exec'&&typeof payload?.scriptRef==='string'?payload.scriptRef:null,
        scriptEditCount:call.name==='work_exec'&&Array.isArray(call.args.edits)?call.args.edits.length:0,
        scriptChars:call.name==='work_exec'?payload?.scriptChars??call.args.code?.length??0:0,scriptRuntime:call.name==='work_exec'?payload?.scriptRuntime??call.args.runtime:null,
        scriptSourceRefs:call.name==='work_exec'&&Array.isArray(payload?.scriptSourceRefs)?payload.scriptSourceRefs.filter(id=>typeof id==='string'):[],
        failureSignature:failed?checkFailure?.signature??payload?.failureSignature??failureSignature(payload?.errorText||streamText(payload?.stderr??payload?.stderrText)||resultText(result.content)):null,
        failureSource:checkFailure?'reported-checks':null};
      const prior=state.executions.findLast(item=>item.key===key&&item.cwd===entry.cwd&&item.userSeq===entry.userSeq&&item.mutationSeq===entry.mutationSeq);
      if(complete&&entry.comparisonText!==null&&prior?.executionCompleted&&prior.comparisonText===entry.comparisonText)
        state.repeatedExecution={...entry,reuseKey:JSON.stringify([entry.userSeq,entry.mutationSeq,entry.cwd,key,entry.comparisonText]),priorSeq:prior.seq};
      state.executions.push(entry);state.executions=state.executions.slice(-24);
      if(runtime.activeMode(agent)==='quality'&&runtimeConfig.qualityReview){
        const {key:operationIdentity,comparisonText,...reviewEntry}=entry;
        state.qualityExecutions.push(reviewEntry);
        state.qualityExecutions=state.qualityExecutions.slice(-16);
      }
      if(complete)transition(state,'execute',seq,textPaths(call.args.command??''),'native-execution');
      if(deletionDenied)
        state.cleanup={seq,key:JSON.stringify([state.turn,state.lastUser?.seq,state.lastMutation]),callKey:key,userSeq:state.lastUser?.seq,tool:call.name};
    }
    if(call.name==='run_code'&&!failed){
      const limit=presentationLimit(state.lastUser?.text),counts=payload?.presentationCounts??presentationCounts(call.args,resultText(result.content));
      const count=limit?counts?.[limit.unit]:null;
      if(limit&&count!==null&&count!==undefined){
        state.presentation=null;
        if(count<=limit.max)state.presentation={...limit,count,seq,userSeq:state.lastUser?.seq,
          key:JSON.stringify([state.turn,state.lastUser?.seq,limit.unit,limit.max])};
      }
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
        const effect=conditional?(Array.isArray(payload?.files)?payload.files.find(item=>typeof item.file==='string'&&fileKey(item.file)===fileKey(file))?.effectState:payload?.effectState):!failed?'applied':null;
        return ['applied','partial','unknown'].includes(effect)?[{path:file,effectState:effect}]:[];
      });
      if(mutations.length){
        state.lastMutation=seq;state.mutationVersion++;state.report=null;progress(state);transition(state,'modify',seq,mutations.map(item=>item.path),'observed-file-effect');
        for(const item of mutations){
          const key=fileKey(item.path);
          if(runtime.activeMode(agent)==='quality'&&runtimeConfig.qualityReview)state.qualityArtifacts.set(key,{...item,path:path.resolve(cwd??runtime.get(agent).root??'.',item.path),seq,tool:call.name,callId,userSeq:state.lastUser?.seq??null});
          if(!state.artifacts.has(key)&&state.artifacts.size>=32)state.artifactsEvicted++;
          state.artifacts.delete(key);
          bounded(state.artifacts,key,{...item,seq,tool:call.name,callId,userSeq:state.lastUser?.seq??null},32);
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
      state.report={seq,args:call.args,path:payload.path};
      if(call.args.status==='complete'&&!call.args.remaining?.length)transition(state,'deliver',seq,[],'reported-conclusion');
    }
    return false;
  }
  function sync(agent){
    const state=get(agent),log=eventLog(agent.session);
    while(state.cursor<log.length){
      const event=log[state.cursor++],data=event.data??{},message=messageOf(event);
      if(event.type==='turn/start'){
        state.turn=data.turn;state.todos=null;state.todoSeq=null;state.report=null;state.lastMutation=-1;state.errors.clear();state.calls.clear();state.nested.clear();state.nestedFailures.clear();state.reads.clear();
        state.phase={name:null,seq:null,focus:[],source:null};state.executions=[];state.repeatedExecution=null;state.cleanup=null;state.presentation=null;
        state.pacing=newPacing();state.completedNested.clear();state.programFailure=null;state.legacyInterpreterShell=null;
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
          if(advice?.kind==='execution'&&!state.advised.has(advice.key)){state.advised.add(advice.key);state.opportunities++;}
          if(advice?.kind==='finish'&&!state.finishAdvised.has(advice.key)){state.finishAdvised.add(advice.key);state.finishNotices++;}
          if(advice?.kind==='reuse'&&!state.reuseAdvised.has(advice.key)){state.reuseAdvised.add(advice.key);state.reuseNotices++;}
          if(advice?.kind==='cleanup'&&!state.cleanupAdvised.has(advice.key)){state.cleanupAdvised.add(advice.key);state.cleanupNotices++;}
          if(advice?.kind==='presentation'&&!state.presentationAdvised.has(advice.key)){state.presentationAdvised.add(advice.key);state.presentationNotices++;}
          if(advice?.kind==='pacing')rememberPacing(state,advice.key,advice.outputTokens,advice.stepCount);
          if(advice?.kind==='compute'){state.pacing.computeAdvised=true;state.pacing.notices.add(advice.key);}
          if(advice?.kind==='validation'){state.pacing.validationAdvised=true;state.pacing.notices.add(advice.key);}
          if(advice?.kind==='inlineExec')state.inlineExecAdvised.add(advice.key);
          if(advice?.kind==='diagnostic')state.diagnosticAdvised.add(advice.key);
          if(advice?.kind==='scriptReuse'||advice?.kind==='scriptVersion')state.scriptReuseAdvised.add(advice.key);
          if(advice?.kind==='judgment'){state.stageReporting.lastNoticeSteps=state.pacing.steps.size;state.stageReporting.notices++;}
          if(advice?.kind==='mode')state.pacing.notices.add(advice.key);
        }else if(isUserRequestMessage(message)){
          state.lastUser={id:message.id,seq:event.seq,text:resultText(message?.content)};state.report=null;state.presentation=null;state.pacing=newPacing();
          state.stageReporting={lastTextSeq:null,lastTextSteps:0,lastNoticeSteps:0,notices:0};
          state.programFailure=null;state.legacyInterpreterShell=null;state.lastQualityReviewedMutation=null;
        }
      }
      if(event.type==='todo/write'&&Array.isArray(data.todos)){
        if(data.todos.filter(item=>item.status==='completed').length>(state.todos??[]).filter(item=>item.status==='completed').length)progress(state);
        state.todos=data.todos;state.todoSeq=event.seq;const phase=todoPhase(data.todos);transition(state,phase.name,event.seq,phase.focus,'todo-progress');
      }
      if(event.type==='tool/call'&&data.callId)bounded(state.calls,data.callId,{name:data.name,args:argsOf(data.arguments)},256);
      if(event.type==='assistant/message'){
        if(resultText(message?.content).trim()){state.stageReporting.lastTextSeq=event.seq;state.stageReporting.lastTextSteps=state.pacing.steps.size;}
        const outputTokens=data.usage?.outputTokens;
        if(Number.isSafeInteger(outputTokens)&&outputTokens>=0){state.pacing.outputTokens+=outputTokens;state.pacing.lastOutputTokens=outputTokens;}
        else state.pacing.missingOutputUsage++;
        for(const block of message?.content??[])if(block.type==='tool-call')bounded(state.calls,block.id,{name:block.name,args:argsOf(block.arguments)},256);
      }
      if(['tool/ptc-dispatch-start','tool/code-dispatch-start'].includes(event.type))bounded(state.nested,data.subCallId??data.callId??data.rootCallId,{name:data.name},256);
      if(['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)){
        if(data.rootCallId)state.completedNested.add(data.rootCallId);
        state.nested.delete(data.subCallId??data.callId??data.rootCallId);
        const id=data.subCallId??data.callId,live=state.live.get(id);state.live.delete(id);
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
          {coveredFailure:state.nestedFailures.get(id)?.has(resultIdentity(message.content))===true,coveredNested:state.completedNested.has(id)});
        state.completedNested.delete(id);
        state.nestedFailures.delete(id);
        state.calls.delete(id);
      }
      if(state.advised.size>64)state.advised.delete(state.advised.values().next().value);
      if(state.finishAdvised.size>64)state.finishAdvised.delete(state.finishAdvised.values().next().value);
      for(const notices of [state.reuseAdvised,state.cleanupAdvised,state.presentationAdvised,state.diagnosticAdvised,state.scriptReuseAdvised])if(notices.size>64)notices.delete(notices.values().next().value);
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
    const text=resultText(incoming.content),files=[...new Set(textPaths(text))].slice(0,6),root=runtime.get(agent).root;
    if(!root||!files.length)return [];
    // A negative read instruction involving a named file disables optional
    // discovery for this request; the model handles the user's finer scope.
    if(text.split(/[，,。；;\n]/u).some(part=>/(?:不要|不得|禁止|不允许|不读取|do not read|don't read|never read)/iu.test(part)&&files.some(file=>part.includes(file))))return [];
    const found=await Promise.allSettled(files.map(async file=>{
      let info;
      try{info=await nativeFiles.stat(root,file,signal);}catch(error){if(!['ENOENT','FS_NOT_FOUND'].includes(error.code))throw error;info={exists:false};}
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
      runtime.effects?.decide(agent,({execution:'executionAdvice',reuse:'reuseAdvice',cleanup:'cleanupAdvice',finish:'finishAdvice',presentation:'presentationAdvice',pacing:'stepPacing',compute:'retainedComputeAdvice',validation:'stepPacing',inlineExec:'inlineExecAdvice',diagnostic:'failureAdvice',scriptReuse:'scriptReuseAdvice',scriptVersion:'scriptReuseAdvice',review:'qualityReview'}[kind]??'guidance'),'applied','observed-scene-condition',{noticeId:id});
      const notice=message(kind,id,text);
      if(kind==='pacing'){notice.source.taskFlow.outputTokens=state.pacing.outputTokens;notice.source.taskFlow.stepCount=state.pacing.steps.size;}
      messages.push(notice);runtime.get(agent).dirty=true;return messages;
    };
    const incoming=pendingMessages.findLast(isUserRequestMessage);
    if(incoming){
      const modeKey=JSON.stringify([incoming.id,'pb001-brief']);
      if(mode==='aggressive'&&config.stepPacing&&!state.pacing.notices.has(modeKey)){
        state.pacing.notices.add(modeKey);
        emit('mode',modeKey,'[work-evidence] 本次使用激进优化：直接推进最短交付路径，只执行用户要求的检查及实际失败所需的修正；已有检查通过时立即整理交付，不追加覆盖和重复复核。');
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
            '[work-evidence] 当前请求已从只读转为可写，work_exec现已可用。确需运行完整Node/Python程序时提交原文，项目修改仍用write/edit；只使用当前请求明确授权的范围，已有结果足够时直接继续。');
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
            retained+'只访问这些已明确范围。');
        }
      }
      return messages;
    }
    const reporting=state.stageReporting,silentSteps=state.pacing.steps.size-Math.max(reporting.lastTextSteps,reporting.lastNoticeSteps);
    if(config.stepPacing&&user&&silentSteps>=3&&(state.reads.size||state.executions.length||state.errors.size||state.lastMutation>user.seq||state.jobs.size)){
      // Request a visible conclusion; never manufacture one from exit codes or counts.
      return emit('judgment',JSON.stringify([user.seq,'judgment',state.pacing.steps.size]),
        '[work-evidence] 已有工具观察，但连续多轮没有面向用户的阶段正文。若已有重要判断、方向变化或实际阻碍，先说明结论、对应依据、未决范围与下一步；只有未知时如实说明未知，不制造结论，不展示内部思考。'+STAGE_CHECKPOINT_GUIDANCE);
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
    if(config.executionTriage&&user&&state.lastInlineExec<user.seq&&!state.inlineExecAdvised.has(key)&&
      (state.lastMutation>user.seq||state.executions.some(item=>item.userSeq===user.seq&&item.status==='failed'))){
      let ready=false;try{ready=process.platform==='win32'&&!!ctx.tools.get('pwsh',agent)&&!!ctx.tools.get('work_exec',agent);}catch{}
      if(ready){
        state.inlineExecAdvised.add(key);
        return emit('inlineExec',key,'[work-evidence] 若下一实际缺口确需运行完整Node/Python程序，可用work_exec提交原文；项目修改仍用write/edit，已有结果足够时不因本提示新增执行。');
      }
    }
    const failedScript=state.executions.findLast(item=>item.userSeq===user?.seq&&item.tool==='work_exec'&&item.status==='failed'&&item.scriptChars>=2400&&item.scriptRef&&['python','node'].includes(item.scriptRuntime));
    const scriptAdviceKey=JSON.stringify([user?.seq,failedScript?.scriptRef]);
    if(config.executionTriage&&user&&failedScript&&!state.scriptReuseAdvised.has(scriptAdviceKey)&&
      !failedScript.scriptSourceRefs.some(ref=>state.scriptReuseAdvised.has(JSON.stringify([user.seq,ref])))){
      state.scriptReuseAdvised.add(scriptAdviceKey);
      return emit('scriptReuse',scriptAdviceKey,'[work-evidence] 事件'+failedScript.seq+'的完整脚本可用work_exec({runtime:'+JSON.stringify(failedScript.scriptRuntime)+',scriptRef:'+JSON.stringify(failedScript.scriptRef)+',edits:[{before:"唯一原文",after:"替换原文"}]})复用。只修首个实际差异，保留错误及未完成要求；替换须唯一匹配，成功执行会返回新scriptRef。');
    }
    const editedScript=state.executions.findLast(item=>item.userSeq===user?.seq&&item.tool==='work_exec'&&item.executionCompleted&&item.scriptEditCount>0&&item.scriptRef);
    const versionAdviceKey=JSON.stringify([user?.seq,'edited-script-version']);
    if(config.executionTriage&&user&&editedScript&&!state.scriptReuseAdvised.has(versionAdviceKey)){
      state.scriptReuseAdvised.add(versionAdviceKey);
      return emit('scriptVersion',versionAdviceKey,'[work-evidence] 事件'+editedScript.seq+'成功执行的脚本版本为'+JSON.stringify(editedScript.scriptRef)+'。后续增量修改引用此ref，并保留下一次返回的新ref；原始错误、输出和未完成要求继续保留。');
    }
    const programFailure=state.programFailure,programFailureKey=JSON.stringify([user?.seq,'program-failure',programFailure?.seq]);
    if(config.executionTriage&&user&&programFailure?.userSeq===user.seq&&!state.diagnosticAdvised.has(programFailureKey)){
      state.diagnosticAdvised.add(programFailureKey);
      let retainedAvailable=false;try{retainedAvailable=!!ctx.tools.get('work_exec',agent);}catch{}
      return emit('diagnostic',programFailureKey,programFailure.dispatched?
        '[work-evidence] 事件'+programFailure.seq+'的程序已实际调用内部工具，随后在'+programFailure.chars+'字符程序中报错。保留已取得结果，只修首个实际异常；'+
          (retainedAvailable?'若后续计算跨回合复用这些输入或对象，可用work_exec retained承接；':'')+
          '否则复用上一条程序并只改失败部分，不重建未改实现。':
        '[work-evidence] 事件'+programFailure.seq+'的run_code在分发内部工具前失败，完整程序的'+programFailure.chars+
        '字符未实际执行。以上一条代码为来源，只修正导致外层解析或序列化的最小差异；复用未更改的实现和意图，不重新推导或重生成未改部分。内部工具确有错误时再按实际结果处理。');
    }
    const legacyShell=state.legacyInterpreterShell,legacyShellKey=JSON.stringify([user?.seq,'legacy-inline-shell']);
    if(config.executionTriage&&user&&legacyShell?.userSeq===user.seq&&!state.inlineExecAdvised.has(legacyShellKey)&&
      (()=>{try{return !!ctx.tools.get('work_exec',agent);}catch{return false;}})()){
      state.inlineExecAdvised.add(legacyShellKey);
      return emit('inlineExec',legacyShellKey,'[work-evidence] 事件'+legacyShell.seq+'的直接'+legacyShell.tool+'调用嵌入了'+legacyShell.chars+
        '字符的Node/Python解释器程序。下一次执行同类完整解释器程序时直接用work_exec({runtime,code,executable?})提交原文，避免继续拼接Shell、here-string或临时文件；普通Shell原生命令仍可用现有入口。');
    }
    const measured=state.presentation;
    if(config.finishAdvice&&measured&&measured.userSeq===user?.seq&&!state.presentationAdvised.has(measured.key)){
      state.presentationAdvised.add(measured.key);state.presentationNotices++;
      return emit('presentation',measured.key,'[work-evidence] 用户明确的篇幅上限为'+measured.max+'个'+measured.unit+'；事件'+measured.seq+
        '显示的对应计数为'+measured.count+'，该次计数已在上限内。'+(measured.unit==='汉字'?'汉字数量与总字符数量是两个计量口径。':'')+
        '若这对应准备交付的说明，保留所需内容并整理答复，无需为了更紧贴上限反复改写计数；其他具体要求或错误仍需处理。本提示只核对这条已显示的计量条件，不宣告整个任务完成。');
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
        return emit('diagnostic',id,'[work-evidence] 事件'+failures[0].seq+'与'+failures[1].seq+'的执行连续因同一错误中断：'+failures[0].failureSignature+
          '。先聚焦首个失败输入，保留完整实际值并对照来源规则，区分实现错误与执行脚本自身的预期或取值错误，再处理具体原因。当前其他要求仍须完成。');
      }
    }
    const pacing=state.pacing,steps=pacing.steps.size;
    const latestExecution=state.executions.findLast(item=>item.executionCompleted&&item.seq>state.lastMutation&&item.seq>(user?.seq??Infinity));
    const report=state.report,args=report?.args;
    const reportReady=report&&args?.status==='complete'&&args.observed?.length&&!args.remaining?.length&&!args.unverified?.length&&
      !(args.claims??[]).some(claim=>['unknown','challenged'].includes(claim.status)||claim.remaining)&&report.seq>state.lastMutation&&report.seq>(user?.seq??-1);
    const finishKey=JSON.stringify([state.turn,user?.seq,state.lastMutation,state.todos?.map(item=>item.content)]);
    if(mode!=='quality'&&config.finishAdvice&&(reportReady||!report&&latestExecution)&&state.todos?.length&&state.todos.every(item=>item.status==='completed')&&
      !state.errors.size&&!state.jobs.size&&!state.finishAdvised.has(finishKey)){
      state.finishAdvised.add(finishKey);state.finishNotices++;
      return emit('finish',finishKey,'[work-evidence] 已有计划全部标为完成，近期原生观察或结论记录可用于答复，未观察到待完成调用或未解决工具错误。先核对现有结果是否覆盖用户要求，覆盖时直接整理完整答复；仍有具体缺口则继续。无需为获得此提醒另写报告，不自动宣告完成、拒绝调用或截断输出。');
    }
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
    if(mode!=='quality'&&config.stepPacing&&user&&surfaceMode==='read-only'&&!state.jobs.size&&!state.errors.size){
      const readOnlyEconomyKey=JSON.stringify([user.seq,'read-only-economy']);
      if(steps>=2&&!pacing.notices.has(readOnlyEconomyKey)){
        rememberPacing(state,readOnlyEconomyKey);
        return emit('pacing',readOnlyEconomyKey,'[work-evidence] 下一动作在同一个PTC程序内完成尚缺的真实读取、计算和序列化；已有结果能确定的派生值沿用它，只有实际失败或来源冲突时才另起最小检查。');
      }
      const readOnlyStrictKey=JSON.stringify([user.seq,'read-only-strict']);
      if(steps>=4&&!pacing.notices.has(readOnlyStrictKey)){
        rememberPacing(state,readOnlyStrictKey);
        return emit('pacing',readOnlyStrictKey,'[work-evidence] 只补首个仍未覆盖的最终字段或实际失败；不重读已见来源，不换语言或Shell重算，结构化输出只保留规定字段。');
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
        return emit('pacing',economyKey,'[work-evidence] 已有多次含工具的模型往返。把尚缺的读取、解析和独立计算合并到一个程序；工具调用前不预演完整任务或重述数据，已有结果足够时直接进入下一次实际动作。');
      }
      const strictKey=JSON.stringify([user.seq,'strict']);
      if(steps>=4&&!pacing.notices.has(strictKey)){
        rememberPacing(state,strictKey);
        return emit('pacing',strictKey,'[work-evidence] 下一次实际动作只处理首个未解决错误、明确未覆盖输入或交付字段；不重读已见来源，不新开仅由既有结果自行引出的同义实现。没有这些具体缺口时核对并交付，用户明确要求的验证仍须完成。');
      }
      const finalizeKey=JSON.stringify([user.seq,'finalize']);
      if(steps>=8&&!pacing.notices.has(finalizeKey)){
        rememberPacing(state,finalizeKey);
        return emit('pacing',finalizeKey,'[work-evidence] 基于已有实际结果按用户列出的字段、边界、错误分支、排序和禁止项逐项核对；只修复未覆盖点后交付，不新增仅由既有结果自行引出的检查。该提醒不宣告完成。');
      }
      const reminderKey=JSON.stringify([user.seq,'finalize-reminder',Math.floor(steps/4)]);
      if(steps>=12&&(outputStalled||!currentWriteObserved&&outputSinceNotice>=8000)&&!pacing.notices.has(reminderKey)){
        rememberPacing(state,reminderKey);
        return emit('pacing',reminderKey,'[work-evidence] 最近一段工具往返没有带来新的覆盖或进展。先指出仍未覆盖的唯一缺口并处理；没有该缺口就直接交付，保留已观察错误与未完成项。');
      }
    }
    const executableQuestion=/返回(?:值|什么|结果|结构)|输出(?:什么|结果|是)|运行(?:结果|行为)|执行(?:结果|行为)|遇到.+(?:怎样|如何)|实际(?:版本|结构)|安装.*版本|what\b.{0,80}\b(?:return|output)|installed\s+version|runtime\s+behavior|response\s+shape/iu.test(text);
    const concreteInput=/["'`][^"'`\n]+["'`]|\b\d+\b|[\[{][^\]}\n]+[\]}]|\w+\s*=|无参|no\s+arg|实际版本|安装.*版本|installed\s+version|接口.*结构|response\s+shape/iu.test(text);
    const sources=[...state.reads.values()].filter(item=>item.seq>(user?.seq??Infinity)&&item.seq>state.lastMutation).slice(-4).map(item=>item.path);
    if(config.executionTriage&&config.executionAdvice&&executableQuestion&&concreteInput&&sources.length&&!latestExecution&&!state.jobs.size&&!state.advised.has(key)&&SHELL.some(name=>{try{return !!ctx.tools.get(name,agent);}catch{return false;}})&&
      !state.probes.some(probe=>probe.seq>(user?.seq??Infinity))){
      state.advised.add(key);state.opportunities++;
      const probeNote=config.toolSurface==='full'
        ?'；确需明确预期比较时可用当前已暴露的work_probe，已有结果足够时直接解释'
        :'；已有结果足够时直接解释，缺少运行条件时继续必要推理';
      return emit('execution',key,'[work-evidence] 当前具体问题可以优先考虑已有代码的原生执行。已观察来源：'+JSON.stringify(sources)+
        '。在当前授权内直接使用已有运行入口，短程序可通过解释器标准输入运行；原生调用会自动记录观察，无需另建重复执行记录'+probeNote+'。');
    }
    return messages;
  }
  function summary(agent){
    const state=sync(agent),config=runtime.get(agent).config;
    return {enabled:runtime.isEnabled(agent),mode:runtime.modeStatus(agent),stageReporting:{...state.stageReporting,enabled:runtime.isEnabled(agent)&&config.stepPacing,delivery:'assistant-text-guidance; content-not-semantically-verified'},executionTriage:config.executionTriage,executionAdvice:config.executionAdvice,stageWorkingSet:config.stageWorkingSet,finishAdvice:config.finishAdvice,
      phase:phase(agent),opportunities:state.opportunities,finishNotices:state.finishNotices,pendingCalls:state.calls.size+state.nested.size,
      userId:state.lastUser?.id??null,userSeq:state.lastUser?.seq??null,lastMutationSeq:state.lastMutation,mutationVersion:state.mutationVersion,
      unresolvedErrors:[...state.errors.values()].slice(-8),pendingJobs:[...state.jobs].slice(-16),
      probes:state.probes.slice(),nativeExecutions:state.executions.map(({key,comparisonText,...entry})=>entry),inlineExecNotices:state.inlineExecAdvised.size,scriptReuseNotices:state.scriptReuseAdvised.size,diagnosticNotices:state.diagnosticAdvised.size,reuseNotices:state.reuseNotices,cleanupNotices:state.cleanupNotices,presentationNotices:state.presentationNotices,
      transitions:state.transitions.slice(),pacing:{enabled:config.stepPacing,toolBearingRequests:state.pacing.steps.size,operations:state.pacing.operations,
        reportedOutputTokens:state.pacing.outputTokens,lastResponseOutputTokens:state.pacing.lastOutputTokens,missingOutputUsage:state.pacing.missingOutputUsage,retainedComputeCalls:state.pacing.computeCalls,validationAdvised:state.pacing.validationAdvised,
        outputTokensSinceProgress:Math.max(0,state.pacing.outputTokens-state.pacing.progressOutputTokens),
        outputTokensSinceNotice:Math.max(0,state.pacing.outputTokens-state.pacing.noticeOutputTokens),
        notices:state.pacing.notices.size,sourceFocus:state.pacing.sourceFocus,lastProgressAt:state.pacing.lastProgress,nextConvergenceAt:state.pacing.nextConvergence,mode:'stable-policy-and-observed-notices'},completion:'not-determined',automaticStop:false};
  }
  return {sync,phase,declaration,beforeStep,startupPaths,summary,
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
          status:item.status,executionCompleted:item.executionCompleted,userSeq:item.userSeq,mutationSeq:item.mutationSeq,
          failureSignature:item.failureSignature,failureSource:item.failureSource,scriptRef:item.scriptRef}));
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
      artifacts:[...state.artifacts.values()],artifactsEvicted:state.artifactsEvicted,executions:state.executions.slice(-6).map(({key,comparisonText,...item})=>item),lastMutationSeq:state.lastMutation,completion:'not-determined'};},
    observe(exec,result){
      if(!exec.agent||!runtime.isEnabled(exec.agent))return;
      const raw=result.value??parseResult(resultText(result.content)),value=raw?.data??raw;
      const stdout=streamText(value?.stdout??value?.stdoutText),stderr=streamText(value?.stderr??value?.stderrText);
      const outputPartial=value?.truncated===true||value?.stdout?.truncated===true||value?.stderr?.truncated===true||value?.complete===false||value?.lossy===true;
      const comparisonText=isCommand(exec.name)&&exec.name!=='job_output'&&!outputPartial&&stdout.length+stderr.length<=4096&&
        (value?.stdout!==undefined||value?.stdoutText!==undefined)?JSON.stringify([value?.exitCode??value?.exit_code??null,stdout,stderr]):null;
      // Keep status and dependency metadata, never another copy of large bodies.
      const compact={nativeStructured:raw!=null,status:value?.status??raw?.status,kind:value?.kind,mode:value?.mode,
        exitCode:value?.exitCode,exit_code:value?.exit_code,jobId:value?.jobId??value?.job_id,job:value?.job,
        error:!!(value?.error||raw?.error),timedOut:value?.timedOut,aborted:value?.aborted,cancelled:value?.cancelled,
        signal:value?.signal,stopped:value?.stopped,effectState:value?.effectState,cwd:value?.cwd,outputPartial,comparisonText,
        errorText:String(value?.error?.message??raw?.error?.message??value?.error??raw?.error??result.error?.message??(stderr||stdout||resultText(result.content))).slice(0,1200),
        failureSignature:failureSignature(stderr||stdout||resultText(result.content)),
        checkFailure:isCommand(exec.name)?reportedCheckFailure(stdout):null,
        scriptRef:value?.scriptRef,scriptChars:value?.scriptChars,scriptRuntime:value?.scriptRuntime,scriptSourceRefs:value?.scriptSourceRefs,
        files:Array.isArray(value?.files)?value.files.slice(0,50).map(file=>({path:file.path??file.file,effectState:file.effectState})):undefined,
        sources:pathsOf(value),saved:value?.saved,path:value?.path,id:value?.id,question:value?.question,
        elapsedMs:value?.elapsedMs,executionCompleted:value?.executionCompleted};
      if(exec.name==='run_code'&&!result.isError)compact.presentationCounts=presentationCounts(exec.arguments,resultText(result.content));
      bounded(get(exec.agent).live,exec.callId,{isError:!!result.isError,observedProblem:resultHasProblem(raw??resultText(result.content))||exec.name==='pwsh'&&shellReportedFailure(stderr),value:compact},256);
    },
    disposeAgent:agent=>states.delete(agent.session.id),dispose:()=>states.clear()};
}
