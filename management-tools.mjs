import {VERSION} from "./runtime.mjs";
import {toolModeFor} from './tool-execution.mjs';
import path from 'node:path';
import {stat} from 'node:fs/promises';
import {recallHistory} from "./compaction-handoff.mjs";
import {recallCall} from "./history-hygiene.mjs";
import {inlineCommand,resolveInlineScript,declaredInlineExecutable,namedInlineExecutable,inlineFailureLocation,inlineFormatRecovery,inlineScriptEventRef} from './inline-exec.mjs';
import {declaredFileSources,dependencyExecutionComplete} from './execution-dependencies.mjs';
import {reportedExecutionChecks} from './recovery.mjs';

export function registerManagementTools({ctx,runtime,state,effects,available,featureControl,capabilityDiagnostic,contextEconomics,taskFlow,taskHandoff,retainedCompute,finalJson,qualityReview,executionEvidence,executionDependencies,refreshExecutionEvidence,hostReferences,workingSet,compressionControl,compactionHandoff,contextWindow,observationLedger,historyCoordinator,clearPluginState,index,candidates,ptcPatterns,ptcFastpath,verifiedExec,fastEditJava,preserveContextResult,retainRecalledSources,hasHistoricalReferences,applyToolSurface,call,disabledResult,output,COMPACT_HIDDEN_TOOLS,assertParameterBounds,parameters}){
  const register=(name,description,properties,required,execute,{gate=true,resultSchema=output.schema}={})=>ctx.tools.register({name,description,
    parameters:{...parameters(properties),required},output:{...output,schema:resultSchema},isConcurrencySafe:()=>false,execute:async(args,exec)=>runtime.withExecution(exec,async()=>{
      if(!exec.agent)throw new Error('Agent required');await runtime.init(exec.agent,exec.signal);await effects.load(exec.agent);runtime.sync(exec.agent);
      try{
        if(gate&&!runtime.isEnabled(exec.agent))return disabledResult(exec.agent,name);
        assertParameterBounds({type:'object',properties},args);
        const result=await execute(args,exec);
        const feature=name==='work_exec'&&args?.mode==='retained'?'retainedCompute':{work_exec:'inlineExec',work_compute:'retainedCompute',work_probe:'probe',evidence_index:'index',candidate_select:'candidate',ptc_patterns:'patterns',ptc_fastpath:'fastpath',verified_exec:'verifiedEdit',fastedit_java:'fastEdit'}[name];
        if(feature){
          const status=result?.status;
          if(name==='work_exec'&&args?.mode!=='retained'){
            const pending=['promoted','background'].includes(result?.kind)||['running','pending','queued','stopping'].includes(result?.status??result?.job?.status);
            const unavailable=['deopt','unavailable','disabled'].includes(status);
            const reportedFailure=reportedExecutionChecks(result);
            const failed=!!reportedFailure||result?.isError===true||!!result?.error||Number.isFinite(result?.exitCode)&&result.exitCode!==0||
              Number.isFinite(result?.exit_code)&&result.exit_code!==0||result?.timedOut===true||result?.aborted===true||
              ['failed','cancelled','killed'].includes(status);
            const complete=dependencyExecutionComplete({value:result,isError:result?.isError===true});
            effects.decide(exec.agent,feature,unavailable?'unavailable':pending?'deferred':failed?'failed':complete?'applied':'deferred',
              result?.reason??(unavailable?status:pending?'native-execution-pending':failed?reportedFailure?'reported-checks-failed':'native-execution-failed':complete?'native-execution-completed':'native-execution-incomplete'));
          }else effects.decide(exec.agent,feature,['deopt','unavailable','disabled'].includes(status)?'unavailable':['failed','partial','unknown','different'].includes(status)?'failed':'applied',result?.reason??status??'explicit-tool-executed');
        }
        return result;
      }finally{await runtime.receipt(exec.agent,exec.signal,true);}
    })});
  register('work_compute','Retained read-only Node REPL. Data, functions and imports persist between calls. Do not redeclare an existing const/let name in a later cell; reuse the binding, choose a new name, or pass reset:true only for a self-contained cell. Top-level await is allowed, return is not; print values or end with JSON. tools has only read/glob/grep/work_recall and OPS reads. State resets after DSH write/edit tools, tool-surface/session changes or interruption; shell/work_exec writes are not detected, so pass reset:true after them. Use normal tools for project edits and work_exec scriptRef for whole-program revisions.',
    {code:{type:'string',description:'REPL statements up to 64000 characters. Reuse retained data/functions and submit only new input or local changes.'},
      reset:{type:'boolean',description:'Explicitly clear this agent\'s retained environment before running code.'},
      timeoutMs:{type:'integer',minimum:1,maximum:600000}},['code'],async(args,exec)=>{
        preserveContextResult(exec.agent.session.id,exec.rootCallId??exec.callId);
        return retainedCompute.execute(args,exec);
      },{resultSchema:{type:'object',additionalProperties:true,properties:{status:{type:'string'},logs:{type:'array',items:{type:'string'}},
        resetCount:{type:'integer'},resetReason:{type:'string'},error:{type:'object',additionalProperties:true},sandbox:{type:'object',additionalProperties:true}}}});
  register('work_exec','Run Node/Python in the project. Supply runtime+code, or scriptRef with literal edits. Node defaults to ESM. Use write/edit for project files. Returns stdout, stderr, exit and script address.',
    {runtime:{type:'string',enum:['python','node'],description:'Runtime for new code; scriptRef can inherit it.'},code:{type:'string',description:'Complete program up to 64000 characters.'},
      scriptRef:{type:'string',description:'Exact prior script address or short event:number.'},
      edits:{type:'array',maxItems:16,items:{type:'object',additionalProperties:false,properties:{before:{type:'string',minLength:1},after:{type:'string'}},required:['before','after']},description:'With scriptRef: unique literal replacements; omit to rerun.'},
      executable:{type:'string',description:'Exact existing interpreter path when not on PATH.'},format:{type:'string',enum:['module','commonjs'],description:'Node only; default module.'},
      mode:{type:'string',enum:['once','retained'],description:'once is a fresh process; retained persists Node state.'},
      reset:{type:'boolean',description:'Retained mode: clear Node state.'},
      sources:{type:'array',maxItems:16,items:{type:'string'},description:'Declared project files for applicability.'},
      timeoutMs:{type:'integer',minimum:1,maximum:600000,description:'Foreground wait before background promotion; default 10000 ms.'}},[],async(args,exec)=>{
      args=args??{};
      if(args.mode==='retained'){
        if(args.runtime!=='node')throw new Error('retained mode requires runtime: node');
        if(args.scriptRef!==undefined||args.edits!==undefined||args.executable!==undefined||args.format!==undefined||args.sources!==undefined)
          throw new Error('retained mode accepts code, reset and timeoutMs only');
        preserveContextResult(exec.agent.session.id,exec.rootCallId??exec.callId);
        const result=await retainedCompute.execute({code:args.code,reset:args.reset,timeoutMs:args.timeoutMs},exec);
        return {...result,mode:'retained'};
      }
      if(args.reset!==undefined)throw new Error('reset requires mode: retained');
      const sources=declaredFileSources(args.sources);
      if(process.platform!=='win32'||!available(exec.agent,'pwsh'))return {status:'unavailable',reason:'native-pwsh-unavailable',executionOccurred:false};
      let script;
      try{script=resolveInlineScript(args,exec.agent.session,exec.signal);}catch(error){
        if(error.message==='runtime must be python or node'&&args.runtime===undefined&&args.language===undefined&&typeof args.code==='string'&&args.code.trim()&&args.code.length<=64000&&exec.callId)
          return {status:'failed',isError:true,executionOccurred:false,error:{message:error.message},scriptRef:exec.callId,scriptChars:args.code.length,
            retry:'The complete original code is retained. Call work_exec with runtime: python or node and this scriptRef; supply the task\'s existing executable path when needed. No program was executed.'};
        throw error;
      }
      const pathFallback=typeof args.executable==='string'&&['python','node'].includes(args.executable)&&args.executable===script.runtime;
      if(pathFallback)script={...script,executable:args.executable};
      const requiredExecutable=declaredInlineExecutable(exec.agent.session,script.runtime);
      const namedExecutable=namedInlineExecutable(exec.agent.session,script.runtime);
      const declaredExecutable=script.executable===undefined?requiredExecutable:null;
      if(declaredExecutable)script={...script,executable:declaredExecutable.executable};
      const root=await ctx.workingDirectory.ensure(exec.agent,exec.signal);
      if(script.executable!==undefined&&path.isAbsolute(script.executable)){
        let missing=false;
        try{missing=!(await stat(script.executable)).isFile();}catch(error){
          // Permission and other indeterminate errors remain the native executor's decision.
          missing=['ENOENT','ENOTDIR'].includes(error.code);
        }
        if(missing)return {status:'failed',isError:true,executionOccurred:false,
          error:{code:'WORK_EXEC_EXECUTABLE_NOT_FOUND',message:'The explicit interpreter path does not identify an existing file: '+script.executable},
          scriptRef:exec.callId??null,scriptChars:script.code.length,scriptRuntime:script.runtime,scriptExecutable:script.executable,
          retry:requiredExecutable?'No program was executed. The task requires a specific interpreter. Supply that interpreter at an existing absolute path or report the unmet requirement; do not substitute PATH. Reuse the returned scriptRef to retain the complete program.':
            namedExecutable?'No program was executed. The task names a specific interpreter path. Supply that interpreter at an existing absolute path or report the unmet requirement; do not substitute PATH. Reuse the returned scriptRef to retain the complete program.':
            'No program was executed. Supply an existing absolute interpreter path. If the task permits changing environments, explicitly set executable to python or node (matching the runtime) to use PATH. Omitting executable retains the recorded or declared path. Reuse the returned scriptRef to retain the complete program.'};
      }
      const command=inlineCommand(script,root);
      // Inline scripts may print source files. Their output has no native read
      // windows, so it must not be treated as disposable generic shell output.
      preserveContextResult(exec.agent.session.id,exec.rootCallId??exec.callId);
      const dependencies=await executionDependencies.capture(root,sources,exec.signal);
      const result=await call('pwsh',{command,description:'Run '+script.runtime+' script via stdin',timeoutMs:script.timeoutMs??10000},exec);
      const fileEvidence=await executionDependencies.finish(dependencies,dependencyExecutionComplete(result),exec.signal);
      const scriptEditsSubmitted=args.edits?.length??0,scriptEditCount=(args.edits??[]).filter(edit=>edit.before!==edit.after).length;
      if(args.scriptRef)effects.decide(exec.agent,'inlineScriptReuse','applied','explicit-same-session-script-reference',{scriptChars:script.code.length,sourceCallId:args.scriptRef,scriptEditsSubmitted,scriptEditCount});
      const aliases=['language','interpreter','cwd','workdir'].filter(key=>Object.hasOwn(args,key));
      if(aliases.length)effects.decide(exec.agent,'inlineArgumentRecovery','applied','unambiguous-explicit-script-arguments',{aliases});
      const scriptEventRef=inlineScriptEventRef(exec.agent.session,exec.callId);
      const failureLocation=inlineFailureLocation(script,result.value??result),recovery=inlineFormatRecovery(script,result.value??result,scriptEventRef??exec.callId,failureLocation);
      const metadata={...fileEvidence,scriptRef:exec.callId??null,scriptEventRef,scriptChars:script.code.length,scriptRuntime:script.runtime,scriptExecutable:script.executable??script.runtime,scriptEditsSubmitted,scriptEditCount,
        scriptExecutableSource:declaredExecutable?.source??null,scriptSourceRefs:script.sourceCallIds??[],scriptReused:!!args.scriptRef,
        failureLocation,...(recovery?{recovery}:{})};
      const reportedChecks=reportedExecutionChecks(result);
      if(reportedChecks)metadata.reportedChecks=reportedChecks;
      return result.value!==undefined?{...result.value,...metadata,isError:!!result.isError}:{...metadata,isError:!!result.isError,error:result.error,content:result.content};
    },{resultSchema:{type:'object',additionalProperties:true,properties:{
      status:{type:'string'},mode:{type:'string'},logs:{type:'array',items:{type:'string'}},scriptRef:{oneOf:[{type:'string'},{type:'null'}]},
      scriptEventRef:{oneOf:[{type:'string'},{type:'null'}],description:'Address for later scriptRef reuse.'},exitCode:{oneOf:[{type:'number'},{type:'null'}]},
      kind:{type:'string'},jobId:{type:'string'},timedOut:{type:'boolean'},aborted:{type:'boolean'},
      stdout:{type:'object',additionalProperties:true,properties:{text:{type:'string'},truncated:{type:'boolean'}}},
      stderr:{type:'object',additionalProperties:true,properties:{text:{type:'string'},truncated:{type:'boolean'}}},
      isError:{type:'boolean'},error:{type:'object',additionalProperties:true},reportedChecks:{type:'object',additionalProperties:true}
    }}});
  register('work_status','Inspect status; detail:true includes request diagnostics.',
    {detail:{type:'boolean',description:'Full request diagnostics.'},config:{type:'object',description:'Workspace settings. toolSurface: compact (work_exec/work_recall), full (management/research tools). Forecast cost gates history rewrites. stepPacing guides without blocking. projectionPricing: exact provider/model rates per million tokens.'},
      session_enabled:{anyOf:[{type:'boolean'},{type:'null'}],description:'This session: true on, false off, null inherit workspace.'},
      quality_review_retry:{type:'boolean',description:'Resume this session route after an unavailable review, only when the user explicitly requests another attempt.'}},[],async(args,exec)=>{
      args=args||{};
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['detail','config','session_enabled','quality_review_retry'].includes(key)))throw new Error('Unrecognized work_status field');
      if(args.detail!==undefined&&typeof args.detail!=='boolean')throw new Error('detail must be a boolean');
      if(args.quality_review_retry!==undefined&&typeof args.quality_review_retry!=='boolean')throw new Error('quality_review_retry must be a boolean');
      await runtime.init(exec.agent,exec.signal??AbortSignal.timeout(10000)).catch(()=>{});
      const s=state(exec.agent);
      if(!runtime.isEnabled(exec.agent)&&(args.config!==undefined||Object.hasOwn(args,'session_enabled')||args.quality_review_retry))
        throw new Error('Work Evidence is disabled. Configuration changes require the user to enable it with /work-evidence on.');
      await effects.flush(exec.agent);
      await qualityReview.load(exec.agent);
      if(args.quality_review_retry)await qualityReview.retry(exec.agent);
      if(args.config!==undefined){
        if(!args.config||typeof args.config!=='object'||Array.isArray(args.config))throw new Error('config must be an object');
        if(Object.hasOwn(args.config,'mode'))throw new Error('Mode follows the selected reasoning effort.');
        if(!s.workspaceConfigValid)throw new Error('Workspace configuration is unavailable or invalid');
        const before=runtime.isEnabled(exec.agent);
        await runtime.setWorkspaceConfig(exec.agent,args.config,exec.signal);
        applyToolSurface(exec.agent);
        if(before!==runtime.isEnabled(exec.agent)){runtime.clearSessionState(exec.agent);clearPluginState(exec.agent);}
      }
      let sessionChange=null;
      if(Object.hasOwn(args,'session_enabled')){
        const before=runtime.isEnabled(exec.agent);sessionChange=await runtime.setSessionEnabled(exec.agent,args.session_enabled,exec.signal);
        if(before!==runtime.isEnabled(exec.agent))clearPluginState(exec.agent);
        applyToolSurface(exec.agent);
      }
      const toolNames=['read','write','edit','glob','grep','ops_glob','ops_grep','ops_inspect_local_file','ops_read_files','ops_stat','ops_edit_file','ops_write_file','ops_bash','bash','pwsh'];
      const pluginTools=COMPACT_HIDDEN_TOOLS;
      let mode=null;try{mode=toolModeFor(ctx,exec.agent);}catch{}
      await refreshExecutionEvidence(exec.agent,exec.signal);
      const snapshot=runtime.snapshot(s,{detail:args.detail===true}),effective=runtime.isEnabled(exec.agent);
      const activeCounters=['evidenceAttempts','evidenceDelivered','evidenceLocated','evidenceIncomplete','evidenceUnavailable','evidenceNoSource','indexLearned','indexHits','candidatePredictions','candidateRuns','ptcFastpathRuns',
        'verifiedExecPreviews','verifiedExecApplies','fastEditEntityFinds','fastEditEntityReads','fastEditPreviews','fastEditApplies',
        'stateObservations','stateSearches','stateNotices','ledgerObservations','ledgerReceipts','ledgerStale','ledgerUnresolvedInjected','nativeReadViews'];
      return {...snapshot,mode:runtime.modeStatus(exec.agent),loaded:true,version:VERSION,effective,ledger:observationLedger.metrics(exec.agent),sw:contextWindow.metrics(exec.agent),diagnostic:{
        loaded:true,version:VERSION,effective,sessionId:s.id,ptcMode:mode,sessionPolicyLoaded:s.sessionPolicyLoaded,
        pluginTools:Object.fromEntries(pluginTools.map(name=>[name,available(exec.agent,name)])),
        toolSurface:{mode:s.config.toolSurface,hidden:pluginTools.filter(name=>!available(exec.agent,name)),
          exposed:pluginTools.filter(name=>available(exec.agent,name))},
        toolAvailability:Object.fromEntries(toolNames.map(name=>[name,available(exec.agent,name)])),
        ...capabilityDiagnostic(exec.agent),
        featureReadiness:await featureControl.summary(exec.agent),
        activityObserved:activeCounters.reduce((sum,key)=>sum+(Number(s.metrics[key])||0),0)>0||(snapshot.nativeExecution?.observed??0)>0,
        sessionChange,
        note:'loaded=true 表示当前进程已执行本插件代码；effective=true 表示当前会话开关允许插件工作。actual activity 只在相应工具真正运行后增加，工具存在不等于任务正确。'},
      };
    },{gate:false});
  register('work_state','Inspect session evidence; handoff exports bounded task records and source-session references as JSON, without a model call or workspace write. recall retrieves historical tool text by seq, not current disk. stage records focus; clear preserves projection plans.',
    {mode:{type:'string',enum:['summary','detail','handoff','clear','recall','stage']},phase:{type:'string',enum:['investigate','modify','execute','deliver','mixed']},focus:{type:'array',maxItems:24,items:{type:'string'}},seq:{type:'integer',minimum:0,description:'recall: original tool result event in this session.'},
      offset:{type:'integer',minimum:0,description:'recall: character offset, initially zero.'},maxChars:{type:'integer',minimum:256,maximum:64000,description:'handoff: total serialized JSON limit, 8000–64000, default 32000. recall: text page limit.'},
      incremental:{type:'boolean',description:'handoff: request a full delivery ID for later incremental exports.'},
      baseDeliveryId:{type:'string',minLength:1,maxLength:128,description:'handoff: the prior complete full delivery ID. Returns a JSON Patch only while that complete delivery remains visible and the patch is substantially smaller; otherwise returns full JSON.'}},[],async(args,exec)=>{
      const s=state(exec.agent),mode=args.mode||'summary';
      if(mode==='handoff')return taskHandoff(exec.agent,{maxChars:args.maxChars,incremental:args.incremental,baseDeliveryId:args.baseDeliveryId,signal:exec.signal,
        excludeCallIds:[exec.callId,exec.rootCallId].filter(Boolean)});
      if(mode==='stage')return s.config.stageWorkingSet?taskFlow.declaration(args):{status:'disabled',feature:'stageWorkingSet'};
      if(mode==='recall'){
        const result=contextWindow.recall(exec.agent,args);
        if(result.status==='observed'){preserveContextResult(exec.agent.session.id,exec.callId);preserveContextResult(exec.agent.session.id,exec.rootCallId);retainRecalledSources(exec.agent,args.seq);}
        return result;
      }
      if(mode==='clear'){s.ledger={observations:[],searches:[],mutations:[]};s.pendingStateNotice=null;s.dirty=true;observationLedger.clear(exec.agent);contextWindow.clear(exec.agent);return {status:'cleared'};}
      await refreshExecutionEvidence(exec.agent,exec.signal);
      return {status:'observed',...(runtime.stateSnapshot(s,mode==='detail')),
        ledger:mode==='detail'?observationLedger.detail(exec.agent):observationLedger.metrics(exec.agent),
        observability:effects.snapshot(exec.agent,{detail:mode==='detail'}),coordination:historyCoordinator.summary(exec.agent),workingSet:mode==='detail'?workingSet.detail(exec.agent):workingSet.metrics(exec.agent),
        contextEconomics:contextEconomics.summary(exec.agent),compression:{...compressionControl.metrics(exec.agent),nativeHandoff:compactionHandoff.metrics(exec.agent)},taskFlow:taskFlow.summary(exec.agent),finalJson:finalJson.summary(exec.agent),qualityReview:qualityReview.summary(exec.agent),nativeExecution:executionEvidence.summary(exec.agent),
        sw:mode==='detail'?{...contextWindow.metrics(exec.agent),...contextWindow.detail(exec.agent)}:contextWindow.metrics(exec.agent)};
    });
  register('work_recall','Retrieve recorded text without rerunning work. kind: output/call/event/history/reference. sourceSessionId must be this session; foreign raw logs are never opened. History pages use throughSeq and nextSeq.',
    {seq:{type:'integer',minimum:0},sourceSessionId:{type:'string',maxLength:128,description:'Use source.sessionId; other sessions are refused.'},kind:{type:'string',enum:['output','call','event','history','reference']},referenceSessionId:{type:'string',maxLength:4096,description:'Reference host snapshot source.'},filter:{type:'string',enum:['all','human','assistant','tool'],description:'History rows by author.'},query:{type:'string',maxLength:3000,description:'History literal text search.'},throughSeq:{type:'integer',minimum:0,description:'History upper event bound.'},offset:{type:'integer',minimum:0},maxChars:{type:'integer',minimum:256,maximum:64000}},['seq'],async(args,exec)=>{
      if(args.sourceSessionId!==undefined&&args.sourceSessionId!==exec.agent.session.id)return {
        status:'unavailable',reason:'source-session-mismatch',sourceSessionId:args.sourceSessionId,
        currentSessionId:exec.agent.session.id,executionOccurred:false};
      if(!runtime.isEnabled(exec.agent)&&!hasHistoricalReferences(exec.agent))return disabledResult(exec.agent,'work_recall');
      if(args.referenceSessionId!==undefined&&args.kind!=='reference')throw new Error('referenceSessionId requires kind: reference');
      const result=args.kind==='reference'?await hostReferences.recall(exec.agent,args,exec.signal):args.kind==='call'?recallCall(exec.agent,args):['event','history'].includes(args.kind)?recallHistory(exec.agent,args):contextWindow.recall(exec.agent,args);
      if(result.status==='observed'){
        preserveContextResult(exec.agent.session.id,exec.callId);preserveContextResult(exec.agent.session.id,exec.rootCallId);
        if(args.kind!=='reference')retainRecalledSources(exec.agent,args.seq);
        effects.decide(exec.agent,'contextRecall','applied','explicit-historical-recall',{seq:args.seq,offset:args.offset??0});
      }
      return result;
    },{gate:false});
  register('work_probe','用已有原生调用回答一个具体问题并返回紧凑的实际证据。只运行当前任务允许且已形成的调用，不生成命令、安装依赖或宣告业务完成。mode=execute 使用 question/tool/arguments；cases 最多8项，JSON pointer 从 stdout JSON 或完整原生 result 选值，可用 expectedJson 比较已明确预期。非零退出、截断及后台任务保持未解决；沿原任务ID继续，不重发命令。mode=recall 按id分页取回同一会话记录；inspect只列可用工具。',
    {mode:{type:'string',enum:['execute','recall','inspect']},question:{type:'string'},tool:{type:'string',enum:['pwsh','ops_bash','bash','job_output','read','grep','glob','ops_stat','ops_read_files','ops_inspect_local_file']},arguments:{type:'object'},
      sources:{type:'array',maxItems:16,items:{type:'string'},description:'Explicit dependencies for this observation. File paths are relative to the project directory. Native file metadata is observed around execution; URLs and missing metadata remain unknown.'},cases:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,properties:{name:{type:'string'},target:{type:'string',enum:['stdout','result']},pointer:{type:'string'},expectedJson:{type:'string'}},required:['name','pointer']}},
      id:{type:'string'},offset:{type:'integer',minimum:0},maxChars:{type:'integer',minimum:1024,maximum:12000}},[],(args,exec)=>executionEvidence.execute(exec.agent,args,exec.signal));
  register('evidence_index','查询或维护有真实源码支持的附加检索入口；query读取当前源码核对，learn保留原入口，semantic=true时额外调用模型核对别名。',
    {mode:{type:'string',enum:['query','learn']},query:{type:'string'},file:{type:'string'},line:{type:'integer',minimum:1},quote:{type:'string'},semantic:{type:'boolean'}},['mode','query'],(args,exec)=>args.mode==='query'?index.query(exec.agent,args.query,exec.signal):index.learn(exec.agent,args,exec.signal));
  register('candidate_select','FOREAGENT式有证据的候选比较：读取真实候选源码与数据报告，以有界模型调用预测偏好，低置信度弃答。execute=true才经原生shell执行所选已有命令；不生成候选、不宣告业务成功。',
    {task:{type:'string'},data_report:{type:'string'},evidence_paths:{type:'array',items:{type:'string'},minItems:1,maxItems:3},estimated_run_ms:{type:'number',minimum:0},execute:{type:'boolean'},
      candidates:{type:'array',minItems:2,maxItems:4,items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},file_path:{type:'string'},offset:{type:'integer',minimum:1},tool:{type:'string',enum:['pwsh','bash']},command:{type:'string'}},required:['id','file_path','command']}}},['task','data_report','evidence_paths','candidates'],(args,exec)=>candidates.select(exec.agent,args,exec.signal));
  register('ptc_patterns','只读扫描当前工作区最近的DSH会话，从真实run_code源码与PTC嵌套派发事件提取跨多个模型请求的重复调用链、参数结构、数据依赖和阻塞原因，并保存到.dsh/work-evidence/ptc-patterns.json。不会执行候选、修改文件或声称减少Token；跨请求输入绑定和净收益仍未证明。',
    {scope:{type:'string',enum:['workspace','session']},sessionId:{type:'string'},maxSessions:{type:'integer',minimum:1,maximum:32},maxEventsPerSession:{type:'integer',minimum:2000,maximum:50000},minSupport:{type:'integer',minimum:1,maximum:20},minToolCalls:{type:'integer',minimum:2,maximum:32},maxCandidates:{type:'integer',minimum:1,maximum:30}},
    [],(args,exec)=>ptcPatterns.scan(exec.agent,args,exec.signal));
  register('ptc_fastpath','保存并运行当前任务内已明确的一至八个只读步骤，支持DSH原生read/grep/glob与可选OPS。mode=define提供具体工具、输入与步骤，可引用$input.*和$steps.<id>.*，用$map绑定数组；mode=run运行已保存定义，工具缺失、参数不完整、失败或不完整则deopt。只读，无shell或源码写入。候选结构本身不扩大授权。',
    {mode:{type:'string',enum:['define','list','run','remove']},name:{type:'string'},candidate_id:{type:'string'},definition:{type:'object'},inputs:{type:'object'}},
    ['mode'],async(args,exec)=>{
      if(args.mode==='list')return ptcFastpath.list(exec.agent,exec.signal);
      if(args.mode==='remove')return ptcFastpath.remove(exec.agent,args.name,exec.signal);
      if(args.mode==='define'){
        const definition={...(args.definition||{})};
        if(args.candidate_id)definition.candidate_id=args.candidate_id;
        return ptcFastpath.define(exec.agent,{...args,definition},exec.signal);
      }
      return ptcFastpath.run(exec.agent,args,exec.signal);
    });
  register('verified_exec','对已明确的文件修改做精确替换或创建，通过OPS当前revision应用；冲突时deopt，跨文件写入逐文件生效。apply=false只生成修改预览。validations可省略，只在当前任务要求外部命令时显式提供；没有命令时返回applied，有命令且成功才返回validated，均不代表全部需求完成。',
    {summary:{type:'string'},apply:{type:'boolean'},
      edits:{type:'array',minItems:1,maxItems:50,items:{type:'object',additionalProperties:false,properties:{
        file:{type:'string'},mode:{type:'string',enum:['replace_exact','create']},old_text:{type:'string'},new_text:{type:'string'},content:{type:'string'}
      },required:['file','mode']}},
      validations:{type:'array',minItems:0,maxItems:10,items:{type:'object',additionalProperties:false,properties:{
        command:{type:'string'},description:{type:'string'},timeout_ms:{type:'integer',minimum:1000,maximum:600000},
        tool:{type:'string',enum:['ops_bash','bash','pwsh']}
      },required:['command','description']}}},
    ['summary','edits'],(args,exec)=>verifiedExec.execute(exec.agent,args,exec.signal));
  register('fastedit_java','按Java符号定位、读取或修改一个方法或类。find_entity取得候选及行范围；read_entity读取唯一实体；replace_symbol、replace_symbol_full、after_symbol用snippet生成修改，apply=true通过OPS当前revision应用。仅在当前任务要求外部命令时提供validations。歧义、实体过大、匹配或语法解析失败时deopt；预览不修改源文件。',
    {file:{type:'string'},operation:{type:'string',enum:['find_entity','read_entity','replace_symbol','replace_symbol_full','after_symbol']},symbol:{type:'string'},snippet:{type:'string'},
      apply:{type:'boolean'},validations:{type:'array',minItems:0,maxItems:10,items:{type:'object',additionalProperties:false,properties:{
        command:{type:'string'},description:{type:'string'},timeout_ms:{type:'integer',minimum:1000,maximum:600000},
        tool:{type:'string',enum:['ops_bash','bash','pwsh']}
      },required:['command','description']}}},
    ['file','operation','symbol'],(args,exec)=>fastEditJava.execute(exec.agent,args,exec.signal));
}
