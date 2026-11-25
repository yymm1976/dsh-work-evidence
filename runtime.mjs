import path from 'node:path';
import fs from 'node:fs/promises';
// The synchronous realpath lives on the callback/sync API, not on fs/promises.
import {realpathSync} from 'node:fs';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {within,references,assertExistingFileWithin,readUtf8File} from './evidence.mjs';
import {recoveryOf} from './recovery.mjs';

export const VERSION='1.1.2';
// opsAdapters and fastEditEnabled were removed with the dsh-ops adapters and
// fastedit_java. They stay tombstoned so an older workspace file still loads
// instead of disabling the plugin; neither value can enable any behavior.
export const RETIRED_SETTINGS=Object.freeze(['taskEffort','nativeReadView','nativeExecutionEvidence','reasoningHistory','cacheOrderedStub','archiveEntries','ledgerFoldPlan','ledgerFoldWrite','programHistory','executionAdvice','finishAdvice','opsAdapters','fastEditEnabled']);
export const MODES=Object.freeze(['default','aggressive','quality']);
export const MODE_POLICY_VERSION='pb001-v39';
export function checkedMode(mode){if(!MODES.includes(mode))throw new Error('mode must be default, aggressive or quality');return mode;}
export const SESSION_POLICY_SCHEMA='work-evidence.session-policy.v1';
export const textOf=value=>(value?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
export function argsOf(value){if(typeof value==='string'){try{return JSON.parse(value);}catch{return {};}}return value&&typeof value==='object'?value:{};}
export const eventLog=session=>session.log||session.events||[];
export function isUserRequestMessage(message){
  // User-role context is extensible in DSH; only declared human input changes the task.
  return message?.role==='user'&&(message.source?.kind==='user'||
    message.source?.kind==='user-question-reply'&&message.source.outcome==='answered');
}
function checkedSessionPolicy(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['schema','version','enabled','updatedAt','defaultResponseView','mode','taskMode'].includes(key)))throw new Error('Unrecognized session policy');
  if(value.schema!==SESSION_POLICY_SCHEMA||value.version!==1)throw new Error('Unsupported session policy version');
  if(value.enabled!==null&&typeof value.enabled!=='boolean')throw new Error('Session enabled must be boolean or null');
  const view=value.defaultResponseView;
  if(view!==undefined&&!['full','reference-if-visible'].includes(view))throw new Error('Invalid session defaultResponseView');
  const mode=value.mode??null;if(mode!==null)checkedMode(mode);
  const task=value.taskMode??null;
  if(task!==null&&(!task||typeof task!=='object'||Array.isArray(task)||Object.keys(task).some(key=>!['requestId','mode','source','policyVersion'].includes(key))||
    typeof task.requestId!=='string'||!task.requestId||task.requestId.length>300||!MODES.includes(task.mode)||!['session-setting','workspace-setting','effort-selection'].includes(task.source)||!/^pb001-v\d+$/.test(task.policyVersion)))throw new Error('Invalid taskMode');
  return {enabled:value.enabled,updatedAt:typeof value.updatedAt==='string'?value.updatedAt:null,sessionDefaultResponseView:view??null,mode,taskMode:task};
}
export function defaults(raw={}){
  const config={enabled:true,aggressiveMode:true,mode:'aggressive',selfIndex:true,modelTimeoutMs:20000,modelMaxTokens:1200,modelRoute:null,
    fastEditPython:path.join(import.meta.dirname,'.fastedit-venv','Scripts','python.exe'),
    stateLedger:true,stateInform:true,completionNotice:false,archiveReadRouting:true,readArgumentRecovery:true,requestAccounting:true,strictObservability:false,evidenceViews:true,memberParsing:true,mavenSourceBinding:true,
    contextProtocol:true,contextPruningPolicy:'forecast',historyHygiene:true,definitionSummary:'off',contextPruneMinChars:8000,contextPruneHeadChars:4096,contextPruneTailChars:1024,
    ledgerReceipt:true,ledgerUnresolved:true,nativeVerifiedEdits:false,fileProfiling:false,structuredJson:false,
    swLedger:false,swEviction:false,swEvictionSteps:3,
    requestProjection:false,projectionRestore:false,compressionControl:true,compactionTiming:'native',
    deferPressureCompaction:false,stubSummary:false,
    executionTriage:true,nativeProgramReuse:false,hostNodeFallback:false,nativeShellScriptReuse:false,probeReplay:false,structuredCalls:false,nativeReasoningReplay:false,stageWorkingSet:true,stepPacing:true,retainedCompute:true,finalJsonGuard:true,finalJsonResultGuard:false,qualityReview:false,qualityReviewEffort:'auto',qualityReviewScope:'auto',boundedPatch:false,
    projectionMinChars:64000,projectionRecentSteps:6,projectionStableSteps:8,projectionHorizonSteps:16,projectionPricing:[],
    sourceReadDefaultLines:null,
    toolSurface:'compact',
    defaultResponseView:'reference-if-visible',...raw};
  // Settings that chose default mode before aggressiveMode existed keep handing
  // that decision to the host instead of silently enabling aggressive.
  if(config.mode==='default'&&raw.aggressiveMode===undefined)config.aggressiveMode=false;
  // Retired keys stay accepted so a workspace file written before their removal
  // still loads; the tombstone loop below forces them to false.
  const known=new Set(['enabled','aggressiveMode','mode','selfIndex','modelTimeoutMs','modelMaxTokens','modelRoute','fastEditPython','stateLedger','stateInform','archiveReadRouting','readArgumentRecovery','requestAccounting','strictObservability','evidenceViews','memberParsing','mavenSourceBinding',
    'contextProtocol','contextPruningPolicy','historyHygiene','definitionSummary','programHistory','reasoningHistory','retainedCompute','contextPruneMinChars','contextPruneHeadChars','contextPruneTailChars','completionNotice','opsAdapters','fastEditEnabled',
    'ledgerReceipt','ledgerUnresolved','nativeVerifiedEdits','fileProfiling','structuredJson','ledgerFoldPlan','ledgerFoldWrite','defaultResponseView','swLedger','swEviction','swEvictionSteps','nativeProgramReuse','hostNodeFallback','nativeShellScriptReuse','probeReplay','structuredCalls','nativeReasoningReplay',
    'requestProjection','projectionRestore','compressionControl','compactionTiming','deferPressureCompaction','stubSummary','cacheOrderedStub','archiveEntries','executionTriage','executionAdvice','stageWorkingSet','finishAdvice','stepPacing','taskEffort','finalJsonGuard','finalJsonResultGuard','qualityReview','qualityReviewEffort','qualityReviewScope','boundedPatch','nativeReadView','nativeExecutionEvidence','projectionMinChars','projectionRecentSteps','projectionStableSteps','projectionHorizonSteps','projectionPricing','toolSurface']);
  known.add('sourceReadDefaultLines');
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!known.has(k)))throw new Error('Unknown work-evidence setting');
  // Accept old workspaces without loading removed modules or re-enabling their hooks.
  for(const key of RETIRED_SETTINGS){
    if(raw[key]!==undefined&&typeof raw[key]!=='boolean')throw new Error('Invalid '+key);
    config[key]=false;
  }
  checkedMode(config.mode);
  if(!['forecast','online-batch'].includes(config.contextPruningPolicy))throw new Error('Invalid contextPruningPolicy');
  config.contextPruningPolicy='forecast';
  if(!['off','on'].includes(config.definitionSummary))throw new Error('Invalid definitionSummary');
  if(!['native','adaptive'].includes(config.compactionTiming))throw new Error('Invalid compactionTiming');
  config.compactionTiming='native';
  for(const key of ['enabled','aggressiveMode','selfIndex','stateLedger','stateInform','archiveReadRouting','readArgumentRecovery','requestAccounting','strictObservability','evidenceViews','memberParsing','mavenSourceBinding','contextProtocol','historyHygiene','programHistory','reasoningHistory',
    'ledgerReceipt','ledgerUnresolved','nativeVerifiedEdits','fileProfiling','structuredJson','ledgerFoldPlan','ledgerFoldWrite','swLedger','swEviction','requestProjection','projectionRestore','compressionControl','deferPressureCompaction','stubSummary','cacheOrderedStub','archiveEntries','executionTriage','nativeProgramReuse','hostNodeFallback','nativeShellScriptReuse','probeReplay','structuredCalls','nativeReasoningReplay','executionAdvice','stageWorkingSet','finishAdvice','stepPacing','retainedCompute','taskEffort','finalJsonGuard','finalJsonResultGuard','qualityReview','boundedPatch','nativeReadView','nativeExecutionEvidence','completionNotice'])if(typeof config[key]!=='boolean')throw new Error('Invalid '+key);
  if(!Number.isInteger(config.swEvictionSteps)||config.swEvictionSteps<3||config.swEvictionSteps>50)throw new Error('Invalid swEvictionSteps');
  if(config.sourceReadDefaultLines!==null&&(!Number.isInteger(config.sourceReadDefaultLines)||config.sourceReadDefaultLines<40||config.sourceReadDefaultLines>1000))
    throw new Error('sourceReadDefaultLines must be null or an integer from 40 to 1000');
  for(const [key,min,max] of [['projectionMinChars',16000,2000000],['projectionRecentSteps',3,50],['projectionStableSteps',4,100],['projectionHorizonSteps',1,64]])
    if(!Number.isInteger(config[key])||config[key]<min||config[key]>max)throw new Error('Invalid '+key);
  if(!Number.isInteger(config.contextPruneMinChars)||config.contextPruneMinChars<8000||config.contextPruneMinChars>512000)throw new Error('Invalid contextPruneMinChars');
  for(const key of ['contextPruneHeadChars','contextPruneTailChars'])if(!Number.isInteger(config[key])||config[key]<0||config[key]>512000)throw new Error('Invalid '+key);
  if(config.contextPruneHeadChars+config.contextPruneTailChars+256>config.contextPruneMinChars)throw new Error('Invalid context pruning budgets: head + tail + recovery marker must fit below contextPruneMinChars');
  if(!Array.isArray(config.projectionPricing)||config.projectionPricing.length>32)throw new Error('Invalid projectionPricing');
  if(!['compact','full'].includes(config.toolSurface))throw new Error('toolSurface must be compact or full');
  const priceRoutes=new Set();
  for(const row of config.projectionPricing){
    if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!['provider','model','input','cacheRead','cacheWrite','output','currency'].includes(key))||
      typeof row.provider!=='string'||!row.provider.trim()||row.provider.length>200||typeof row.model!=='string'||!row.model.trim()||row.model.length>300||
      typeof row.currency!=='string'||!row.currency.trim()||row.currency.length>16||
      ['input','cacheRead','output'].some(key=>typeof row[key]!=='number'||!Number.isFinite(row[key])||row[key]<0)||
      row.cacheWrite!==undefined&&(typeof row.cacheWrite!=='number'||!Number.isFinite(row.cacheWrite)||row.cacheWrite<0))throw new Error('Invalid exact-route projection price; prices are per million tokens');
    const key=JSON.stringify([row.provider,row.model]);if(priceRoutes.has(key))throw new Error('Duplicate projection price route');priceRoutes.add(key);
  }
  if(!['full','reference-if-visible'].includes(config.defaultResponseView))throw new Error('Invalid defaultResponseView');
  if(!['auto','inherit','low','medium','high','max'].includes(config.qualityReviewEffort))throw new Error('Invalid qualityReviewEffort');
  if(!['auto','full'].includes(config.qualityReviewScope))throw new Error('Invalid qualityReviewScope');
  for(const [key,min,max] of [['modelTimeoutMs',1000,60000],['modelMaxTokens',128,4096]])if(!Number.isInteger(config[key])||config[key]<min||config[key]>max)throw new Error('Invalid '+key);
  if(typeof config.fastEditPython!=='string'||!path.isAbsolute(config.fastEditPython)||config.fastEditPython.length>1000)throw new Error('Invalid fastEditPython');
  if(config.modelRoute!==null&&(!config.modelRoute||typeof config.modelRoute.provider!=='string'||typeof config.modelRoute.model!=='string'||!config.modelRoute.provider.trim()||!config.modelRoute.model.trim()||config.modelRoute.provider.length>200||config.modelRoute.model.length>300||Object.keys(config.modelRoute).some(k=>!['provider','model','reasoningEffort'].includes(k))||(config.modelRoute.reasoningEffort!==undefined&&(typeof config.modelRoute.reasoningEffort!=='string'||config.modelRoute.reasoningEffort.length>64))))throw new Error('Invalid model route');
  return config;
}
export function createRuntime(ctx,call,initial={}){
  const states=new Map(),workspaceQueues=new Map();
  function workspaceConfig(value){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Workspace settings must be an object');
    const merged={...defaults(initial),...value};
    if(merged.mode==='default'&&value.aggressiveMode===undefined)merged.aggressiveMode=undefined;
    return defaults(merged);
  }
  async function loadLocalJson(root,file,signal){
    signal?.throwIfAborted();
    try{
      const target=await assertExistingFileWithin(root,file);
      const source=await readUtf8File(target.real,{maxBytes:100000});
      return {ok:true,value:JSON.parse(source.text)};
    }catch(error){
      return {ok:false,missing:error.code==='ENOENT',error};
    }
  }
  function get(agent){
    const id=agent.session.id;
    let s=states.get(id);
    if(!s){s={id,cursor:0,step:0,turn:null,config:defaults(initial),workspaceConfigValid:false,workspaceFileSeen:false,workspaceFileMissing:false,sessionFileSeen:false,sessionFileMissing:false,root:null,telemetryDir:null,telemetryScope:null,configured:false,initPromise:null,seen:new Set(),calls:new Map(),
      failures:[],writes:[],emptyLookups:new Map(),readPages:new Map(),automaticEvidence:new Set(),active:false,pendingFailure:null,pendingLookupFact:null,pendingStateNotice:null,
      commandRoots:new Map(),failureRoots:new Set(),requestObservations:[],auxiliarySignals:new WeakSet(),selectedPreset:agent.session.header?.agentPreset||null,evidenceViewReasons:{},viewEpoch:0,
      reads:[],searches:[],index:[],indexLoaded:false,indexDirty:false,
      ledger:{observations:[],searches:[],mutations:[]},
      sessionEnabledOverride:null,sessionPolicyPath:null,sessionPolicyLoaded:false,sessionDefaultResponseView:null,sessionModeOverride:null,taskMode:null,taskModePersisted:true,claimedRequest:null,policyQueue:Promise.resolve(),
      lastReceipt:0,dirty:true,effortCache:null,metrics:{nativeEvents:0,ptcResults:0,liveResults:0,failuresObserved:0,evidenceAttempts:0,evidenceDelivered:0,
        evidenceLocated:0,evidenceIncomplete:0,evidenceUnavailable:0,evidenceNoSource:0,indexLearned:0,indexRejected:0,indexHits:0,auxiliaryCalls:0,auxiliaryFailures:0,auxiliaryUnknownCalls:0,auxiliaryJsonRecoveries:0,
        auxiliaryUsage:{},auxiliaryMs:0,candidatePredictions:0,candidateRuns:0,verifiedExecPreviews:0,contextProtocolPrunedResults:0,contextProtocolPrunedChars:0,
        verifiedExecApplies:0,verifiedExecPartial:0,verifiedExecDeopts:0,verifiedExecValidationFailures:0,
        ptcFastpathRuns:0,ptcFastpathSuccesses:0,ptcFastpathDeopts:0,stateObservations:0,stateSearches:0,stateStaleObservations:0,stateStaleSearches:0,
        stateNotices:0,stateNoticeChars:0,longWaitRedirects:0,
        ledgerObservations:0,ledgerReceipts:0,ledgerReceiptCharsSaved:0,ledgerStale:0,ledgerUnresolvedInjected:0,
        archiveReadRoutes:0,readArgumentCorrections:0,readArgumentNormalizations:0,contextRequests:0,contextRequestChars:0,contextModelTextChars:0,
        evidenceVisibleViewRecords:0,evidenceVisibleViewTurns:0,evidenceFullViews:0,evidenceReferenceViews:0,evidenceReferenceMisses:0,evidenceViewOutputChars:0},problems:[]};states.set(id,s);}
    if(agent.ctx||agent.options||!s.agentRef)s.agentRef=agent;
    return s;
  }
  const execFor=(agent,signal)=>{const execution=get(agent).execution;return {agent,signal,rootCallId:execution?.rootCallId,token:execution?.token};};
  async function withExecution(exec,fn){const s=get(exec.agent),prior=s.execution;s.execution=exec;try{return await fn();}finally{s.execution=prior;}}
  async function init(agent,signal){
    const s=get(agent);
    if(s.configured)return s;
    if(s.initPromise)return s.initPromise;
    const pending=refresh(agent,signal);
    s.initPromise=pending;
    try{return await pending;}finally{if(s.initPromise===pending)s.initPromise=null;}
  }
  async function refresh(agent,signal){
    const s=get(agent);
    // Settings are re-read at request boundaries and explicit status/control checks, not
    // from every pre-step and tool dispatch. Those repeated reads did not change the
    // documented rule that a workspace setting starts at the next model request.
    if(s.configured&&s.sessionPolicyLoaded&&s.sessionPolicyPath){
      const before=s.workspaceConfigValid&&(s.sessionEnabledOverride??s.config.enabled);
      try{
        const workspace=await loadLocalJson(s.root,path.join(s.dir,'config.json'),signal);
        signal?.throwIfAborted();
        if(workspace.ok){s.workspaceConfigValid=false;s.config=workspaceConfig(workspace.value);s.workspaceConfigValid=true;s.workspaceFileSeen=true;s.workspaceFileMissing=false;}
        else if(workspace.missing){
          if(s.workspaceFileSeen&&!s.workspaceFileMissing)problem(s,'config-missing','Workspace settings file is missing; retaining the settings already loaded in this session.');
          s.workspaceFileMissing=s.workspaceFileSeen;s.workspaceConfigValid=true;
        }
        else{s.workspaceConfigValid=false;problem(s,'config-read',workspace.error?.message||'Workspace settings unavailable');}
        const policy=await loadLocalJson(s.root,s.sessionPolicyPath,signal);
        signal?.throwIfAborted();
        if(policy.ok){
          const value=checkedSessionPolicy(policy.value);
          s.sessionEnabledOverride=value.enabled;s.sessionDefaultResponseView=value.sessionDefaultResponseView;s.sessionModeOverride=value.mode;
          s.sessionFileSeen=true;s.sessionFileMissing=false;
          s.taskMode??=value.taskMode;
        }else if(policy.missing){
          if(s.sessionFileSeen&&!s.sessionFileMissing)problem(s,'session-policy-missing','Session settings file is missing; retaining the current session choice.');
          s.sessionFileMissing=s.sessionFileSeen;
        }
        else{s.sessionEnabledOverride=false;problem(s,'session-policy-read',policy.error?.message||'Session settings unavailable');}
      }catch(error){signal?.throwIfAborted();s.sessionEnabledOverride=false;problem(s,'configuration-refresh',error.message);}
      if(before!==(s.workspaceConfigValid&&(s.sessionEnabledOverride??s.config.enabled)))clearSessionState(agent);
    }
    if(s.configured)return s;
    const initialized=(async()=>{
      if(!/^[-a-zA-Z0-9_][-.a-zA-Z0-9_]{0,127}$/.test(s.id))throw new Error('Unsafe session id');
      s.root=await ctx.workingDirectory.ensure(agent,signal);
      s.dir=within(s.root,path.join('.dsh','work-evidence'));
      // Automatic records belong beside the host session, outside project discovery.
      let location;
      try{location=ctx.sessionPersistence?.locate?.({...agent.session.header,id:s.id,cwd:s.root});}catch(error){problem(s,'telemetry-location',error.message);}
      const outside=file=>{const relative=path.relative(s.root,file);return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);};
      const hosted=typeof location?.path==='string'&&path.isAbsolute(location.path)?path.join(path.dirname(location.path),'work-evidence'):null;
      const fallback=path.join(os.homedir(),'.dsh','work-evidence','sessions',s.id);
      if(hosted&&outside(hosted)){s.telemetryDir=hosted;s.telemetryScope='native-session';}
      else if(outside(fallback)){s.telemetryDir=fallback;s.telemetryScope='user-session';}
      else problem(s,'telemetry-location','No persistent observability directory outside the workspace is available');
      const result=await loadLocalJson(s.root,path.join(s.dir,'config.json'),signal);
      if(result.ok){try{s.config=workspaceConfig(result.value);s.workspaceConfigValid=true;s.workspaceFileSeen=true;}catch(e){s.workspaceConfigValid=false;problem(s,'config',e.message);}}
      else if(result.missing)s.workspaceConfigValid=true;
      else{s.workspaceConfigValid=false;problem(s,'config-read',result.error?.message||'Config unavailable');}
      s.sessionPolicyPath=path.join(s.dir,'sessions',s.id+'.json');
      const policy=await loadLocalJson(s.root,s.sessionPolicyPath,signal);
      if(policy.ok){
        try{
          const value=checkedSessionPolicy(policy.value);
          s.sessionEnabledOverride=value.enabled;s.sessionDefaultResponseView=value.sessionDefaultResponseView;s.sessionModeOverride=value.mode;s.taskMode=value.taskMode;
          s.sessionFileSeen=true;
        }catch(e){
          s.sessionEnabledOverride=false;
          problem(s,'session-policy',e.message);
        }
      }else if(!policy.missing){
        s.sessionEnabledOverride=false;
        problem(s,'session-policy-read',policy.error?.message||'Session policy unavailable');
      }
      if(s.telemetryDir){
        s.taskModePath=path.join(s.telemetryDir,s.id+'.task-mode.json');
        const recorded=await loadLocalJson(s.telemetryDir,s.taskModePath,signal);
        if(recorded.ok){
          try{s.taskMode=checkedSessionPolicy(recorded.value).taskMode??s.taskMode;}
          catch(error){problem(s,'task-mode-read',error.message);}
        }else if(!recorded.missing)problem(s,'task-mode-read',recorded.error?.message||'Task mode unavailable');
      }
      signal?.throwIfAborted();
      s.sessionPolicyLoaded=true;
      s.configured=true;return s;
    })();
    return initialized;
  }
  function isEnabled(agent){
    const s=get(agent);
    if(!s.sessionPolicyLoaded||!s.workspaceConfigValid)return false;
    const enabled=s.sessionEnabledOverride===null?s.config.enabled:s.sessionEnabledOverride;
    return enabled&&(s.config.aggressiveMode||effortSelection(agent)?.reasoningEffort==='ultra');
  }
  function clearSessionState(agent){
    const s=get(agent);
    s.viewEpoch++;s.requestObservations=[];
    s.ledger={observations:[],searches:[],mutations:[]};s.reads=[];s.searches=[];
    s.active=false;s.pendingFailure=null;s.pendingLookupFact=null;s.pendingStateNotice=null;s.queuedMessages=[];s.dirty=true;
  }
  function effortSelection(agent){
    let projection;
    try{projection=ctx.get?.('sessionProjections')?.stateOf?.(agent.session,'modelSelection');}catch{}
    // agentDefaultModel is an optional host service; direct property access throws without inject.
    let hostDefault;try{hostDefault=ctx.get?.('agentDefaultModel')?.currentSelection?.();}catch{}
    const fallback=agent.session.requestHeader?.()?.config??hostDefault??agent.options;
    if(projection&&Object.hasOwn(projection,'pending'))return projection.pending??projection.lastUsed??fallback;
    const s=get(agent),events=eventLog(agent.session);
    if(!s.effortCache||s.effortCache.cursor>events.length)s.effortCache={cursor:0,selection:null,header:null};
    const cache=s.effortCache;
    while(cache.cursor<events.length){
      const event=events[cache.cursor++];
      if(event.type==='model/selection')cache.selection=event;
      if(event.type==='request/header')cache.header=event;
    }
    // preStep runs before the request header is written, so a pending host
    // selection is always the freshest one and must win over the old header.
    return cache.selection&&(!cache.header||cache.selection.seq>cache.header.seq)?cache.selection.data:fallback;
  }
  function modeStatus(agentOrState){
    const agent=agentOrState.session?agentOrState:null,s=agent?get(agent):agentOrState;
    const selected=agent?(effortSelection(agent)?.reasoningEffort==='ultra'?'quality':s.config.aggressiveMode?'aggressive':'default'):(s.selectedMode??s.taskMode?.mode??(s.config.aggressiveMode?'aggressive':'default'));
    return {selected,source:'effort-selection',workspace:s.config.mode,sessionOverride:s.sessionModeOverride,legacySettingsIgnored:true,
      task:s.taskMode?{...s.taskMode}:null,taskModePersisted:s.taskMode? s.taskModePersisted:null,pendingChange:!!s.taskMode&&s.taskMode.mode!==selected,policyVersion:MODE_POLICY_VERSION,
      aggressiveMode:s.config.aggressiveMode,guidanceEnabled:selected!=='default'&&s.sessionPolicyLoaded&&s.workspaceConfigValid&&(s.sessionEnabledOverride??s.config.enabled)&&s.config.stepPacing,effectiveFrom:'next-model-request'};
  }
  function activeMode(agent){const s=get(agent);return s.taskMode?.mode??modeStatus(s).selected;}
  function updateSessionPolicy(agent,patch,signal){
    const s=get(agent);
    const operation=s.policyQueue.catch(()=>{}).then(async()=>{
      await init(agent,signal);
      const value={schema:SESSION_POLICY_SCHEMA,version:1,enabled:s.sessionEnabledOverride,mode:s.sessionModeOverride,taskMode:s.taskMode,
        ...(s.sessionDefaultResponseView?{defaultResponseView:s.sessionDefaultResponseView}:{}),...patch,updatedAt:new Date().toISOString()};
      const checked=checkedSessionPolicy(value);
      await save(agent,s.sessionPolicyPath,value,signal);
      s.sessionFileSeen=true;s.sessionFileMissing=false;
      s.sessionEnabledOverride=checked.enabled;s.sessionModeOverride=checked.mode;s.dirty=true;
      return value;
    });
    s.policyQueue=operation;return operation;
  }
  async function setSessionMode(agent,mode,signal){
    throw new Error('Mode follows the selected reasoning effort: Ultra uses quality; other efforts use aggressive.');
  }
  async function setWorkspaceMode(agent,mode,signal){
    throw new Error('Mode follows the selected reasoning effort: Ultra uses quality; other efforts use aggressive.');
  }
  async function setAggressiveMode(agent,enabled,signal){
    await setWorkspaceConfig(agent,{aggressiveMode:enabled},signal);
    return modeStatus(agent);
  }
  async function setWorkspaceConfig(agent,patch,signal){
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('Workspace settings must be an object');
    if(Object.hasOwn(patch,'mode'))throw new Error('Mode follows the selected reasoning effort.');
    for(const key of RETIRED_SETTINGS)if(patch[key]===true)throw new Error('Setting '+key+' is retired and has no active implementation.');
    if(patch.contextPruningPolicy!==undefined&&patch.contextPruningPolicy!=='forecast')throw new Error('Only forecast context pruning is supported.');
    if(patch.compactionTiming!==undefined&&patch.compactionTiming!=='native')throw new Error('Only native compaction timing is supported.');
    const s=await refresh(agent,signal),key=path.join(s.dir,'config.json');
    const operation=(workspaceQueues.get(key)??Promise.resolve()).catch(()=>{}).then(async()=>{
      signal?.throwIfAborted();
      await refresh(agent,signal);
      if(!s.workspaceConfigValid)throw new Error('Workspace configuration is unavailable or invalid');
      const before=isEnabled(agent);
      // workspaceConfig() folds every retired key to false so old workspaces keep
      // loading, but that also puts the key on s.config. Persisting it here would
      // write retired settings back into the user's file, which ROLLBACK-1.1.2
      // tells them this build does not do.
      const next=defaults({...s.config,...patch});
      for(const retired of RETIRED_SETTINGS)delete next[retired];
      await save(agent,key,next,signal);
      s.config=next;s.workspaceFileSeen=true;s.workspaceFileMissing=false;s.dirty=true;
      if(before!==isEnabled(agent))clearSessionState(agent);
      return {path:key,scope:'workspace',settings:{...patch},effectiveFrom:'next-model-request'};
    });
    workspaceQueues.set(key,operation);
    try{return await operation;}finally{if(workspaceQueues.get(key)===operation)workspaceQueues.delete(key);}
  }
  function currentRequest(agent){
    const s=get(agent);
    if(s.claimedRequest)return s.claimedRequest;
    const log=eventLog(agent.session);
    let history=s.requestHistory;
    if(!history||history.cursor>log.length||history.cursor>0&&log[history.cursor-1]?.seq!==history.lastSeq)
      history=s.requestHistory={cursor:0,lastSeq:null,message:null};
    while(history.cursor<log.length){
      const event=log[history.cursor++];
      history.lastSeq=event.seq;
      if(event.type!=='user/message')continue;
      const message=event.data?.message??event.data;
      if(isUserRequestMessage(message))history.message=message;
    }
    return history.message;
  }
  async function beginRequest(agent,signal){
    const s=get(agent),incoming=currentRequest(agent);
    if(!incoming?.id){s.claimedRequest=null;return modeStatus(s);}
    const selected=modeStatus(agent);
    s.selectedMode=selected.selected;
    const taskMode={requestId:incoming.id,mode:selected.selected,source:'effort-selection',policyVersion:MODE_POLICY_VERSION};
    if(s.taskModePersisted&&s.taskMode?.requestId===incoming.id&&s.taskMode.mode===taskMode.mode&&s.taskMode.source===taskMode.source){s.claimedRequest=null;return modeStatus(s);}
    s.taskMode=taskMode;s.taskModePersisted=false;s.dirty=true;
    try{
      if(!s.taskModePath)throw new Error('No session storage outside the workspace');
      const recorded={schema:SESSION_POLICY_SCHEMA,version:1,enabled:null,taskMode,updatedAt:new Date().toISOString()};
      checkedSessionPolicy(recorded);
      signal?.throwIfAborted();
      await fs.mkdir(s.telemetryDir,{recursive:true});
      const temp=s.taskModePath+'.'+randomUUID()+'.tmp';
      try{
        await fs.writeFile(temp,JSON.stringify(recorded)+'\n',{encoding:'utf8',flag:'wx',signal});
        signal?.throwIfAborted();
        await fs.rename(temp,s.taskModePath);
      }catch(error){
        await fs.rm(temp,{force:true}).catch(()=>{});
        throw error;
      }
      s.taskModePersisted=true;
    }catch(error){
      signal?.throwIfAborted();
      problem(s,'task-mode-save',error.message);
    }
    s.claimedRequest=null;
    return modeStatus(s);
  }
  async function setSessionEnabled(agent,enabled,signal){
    if(enabled!==null&&typeof enabled!=='boolean')throw new Error('Session enabled must be boolean or null');
    const s=await refresh(agent,signal),before=isEnabled(agent);
    await updateSessionPolicy(agent,{enabled},signal);
    s.sessionEnabledOverride=enabled;s.sessionPolicyLoaded=true;s.dirty=true;
    const effective=isEnabled(agent);
    if(before!==effective)clearSessionState(agent);
    return {enabled,effective,override:enabled===null?'workspace-setting':'session-setting',path:s.sessionPolicyPath};
  }
  const revisionPattern=/^[a-f0-9]{64}$/;
  function outcome(value){
    const data=value?.data&&typeof value.data==='object'?value.data:value;
    // The transport may say error while retaining partial data. The inner
    // receipt must not hide that error (including failed batch items).
    return {status:value?.status||value?.data?.status||null,data:data&&typeof data==='object'?data:{},error:value?.error||value?.data?.error||null};
  }
  // A tool record can carry the filesystem's realpath while the workspace root can be
  // reached through a symlink or junction, so the lexical resolution alone would key the
  // two differently. Both sides resolve the realpath and fall back to the lexical form
  // for a path that does not exist yet. The mapping is read fresh on every call: a
  // session can outlive a symlink retarget, and a cached target would keep attributing
  // observations and mutations to the old file.
  const realKeyOf=full=>{
    let key=full;
    try{const real=realpathSync.native(full);key=real;}catch{/* not on disk: keep the lexical key */}
    return key;
  };
  function ledgerPath(s,value){
    if(typeof value!=='string'||!value.trim()||!s.root)return null;
    const full=path.resolve(s.root,value);
    // The containment check uses the realpath of the root as well, so a record that
    // arrives through a symlinked root is still recognised as inside the workspace.
    const realRoot=realKeyOf(path.resolve(s.root)),key=realKeyOf(full);
    const relativeToReal=path.relative(realRoot,key);
    if(relativeToReal==='..'||relativeToReal.startsWith('..'+path.sep)||path.isAbsolute(relativeToReal)){
      const lexical=path.relative(s.root,full);
      if(lexical==='..'||lexical.startsWith('..'+path.sep)||path.isAbsolute(lexical))return null;
      return {full,display:lexical.replaceAll('\\','/')||'.',key};
    }
    return {full,display:relativeToReal.replaceAll('\\','/')||'.',key};
  }
  function boundedPush(list,value,max){list.push(value);if(list.length>max)list.splice(0,list.length-max);}
  function searchCanIncludeFile(search,scope,file){
    // Ripgrep can bypass a glob filter for an explicitly named file.
    if(scope.key===file.key)return true;
    const filter=search.tool==='glob'?search.pattern:search.glob;
    if(typeof filter!=='string')return true;
    const suffix=/^(?:\*\*\/)?\*\.([\w-]+)$/u.exec(filter)?.[1]?.toLowerCase();
    if(suffix)return [file.full,file.key].some(value=>path.basename(value).toLowerCase().endsWith('.'+suffix));
    const directories=/^\*\*\/(?:([\w.-]+)|\{([\w.-]+(?:,[\w.-]+)+)\})\/\*\*\/\*$/u.exec(filter);
    if(!directories)return true;
    // These patterns require an ancestor with one of the literal directory names.
    // Consider both names when the written path resolves through a symlink.
    const names=(directories[1]??directories[2]).toLowerCase().split(',');
    return [file.full,file.key].some(value=>path.dirname(value).toLowerCase().split(path.sep).some(name=>names.includes(name)));
  }
  function markStateStale(s,files=[],tool){
    let observations=0,searches=0;
    for(const file of files){
      if(!file)continue;
      for(const observation of s.ledger.observations){
        if(observation.stale||observation.pathKey!==file.key||(file.revision&&observation.revision===file.revision))continue;
        observation.stale=true;observation.staleAt=new Date().toISOString();observations++;
      }
      for(const search of s.ledger.searches){
        if(search.stale)continue;
        const scope=ledgerPath(s,search.scope||'.');
        if(!scope||((file.key===scope.key||file.key.startsWith(scope.key+path.sep))&&searchCanIncludeFile(search,scope,file))){
          search.stale=true;search.staleAt=new Date().toISOString();searches++;
        }
      }
    }
    if(!observations&&!searches)return;
    s.metrics.stateStaleObservations+=observations;s.metrics.stateStaleSearches+=searches;
    s.dirty=true;
    // A content edit invalidates older searches, but a search-only change is not
    // evidence that any now-stale hit is still needed.
    const contentEdit=tool==='edit';
    if(!observations&&!s.pendingStateNotice&&contentEdit)return;
    const pending=s.pendingStateNotice||{observations:0,searches:0,files:new Set(),revisions:new Map(),at:new Date().toISOString()};
    pending.contentEditsOnly=(pending.contentEditsOnly??true)&&contentEdit;
    pending.observations+=observations;pending.searches+=searches;pending.at=new Date().toISOString();
    for(const file of files)if(file){pending.files.add(file.display);if(revisionPattern.test(String(file.revision||'')))pending.revisions.set(file.display,file.revision);}
    s.pendingStateNotice=pending;s.dirty=true;
  }
  function recordObservation(s,exec,result,seq,extra={}){
    if(!s.config.stateLedger)return;
    const parsed=outcome(result.value),data=parsed.data,file=ledgerPath(s,extra.file||exec.arguments?.file_path||exec.arguments?.path);
    if(!file)return;
    const revision=revisionPattern.test(String(extra.revision||data.revision||''))?String(extra.revision||data.revision):null;
    const observation={tool:extra.tool||exec.name,path:file.display,pathKey:file.key,revision,
      lineStart:Number.isInteger(extra.lineStart)?extra.lineStart:(Number.isInteger(exec.arguments?.offset)?exec.arguments.offset:1),
      lineEnd:Number.isInteger(extra.lineEnd)?extra.lineEnd:null,callId:exec.callId||null,seq,step:s.step,stale:false,observedAt:new Date().toISOString()};
    const prior=s.ledger.observations.findIndex(item=>!item.stale&&item.pathKey===observation.pathKey&&item.revision===observation.revision&&item.lineStart===observation.lineStart&&item.lineEnd===observation.lineEnd);
    if(prior>=0)s.ledger.observations.splice(prior,1);
    boundedPush(s.ledger.observations,observation,64);s.metrics.stateObservations++;s.dirty=true;
  }
  function recordSearch(s,exec,result,seq){
    if(!s.config.stateLedger)return;
    const file=ledgerPath(s,exec.arguments?.path||'.');
    if(!file)return;
    boundedPush(s.ledger.searches,{tool:exec.name,scope:file.display,scopeKey:file.key,pattern:exec.arguments?.pattern||null,
      glob:exec.arguments?.include||exec.arguments?.glob||null,complete:outcome(result.value).status==='completed'&&outcome(result.value).data.complete!==false,
      callId:exec.callId||null,seq,step:s.step,stale:false,observedAt:new Date().toISOString()},48);
    s.metrics.stateSearches++;s.dirty=true;
  }
  function recordMutation(agent,{tool='write',file,revision=null,callId=null,seq=null}={}){
    const s=get(agent);if(!s.config.stateLedger)return null;
    const target=ledgerPath(s,file);if(!target)return null;
    const mutation={tool,path:target.display,pathKey:target.key,revision:revisionPattern.test(String(revision||''))?revision:null,
      callId,seq,step:s.step,at:new Date().toISOString()};
    boundedPush(s.ledger.mutations,mutation,32);
    markStateStale(s,[{...target,revision:mutation.revision}],tool);
    s.active=true;s.dirty=true;return mutation;
  }
  function recordStateObservation(agent,value){
    const s=get(agent);if(!s.config.stateLedger)return null;
    return recordObservation(s,{name:value.tool,arguments:{path:value.file},callId:value.callId||'state:'+randomUUID()},
      {value:{status:'completed',data:{revision:value.revision}}},value.seq??null,value);
  }
  function stateSnapshot(s,detail=false){
    const observations=s.ledger.observations.map(({pathKey,...item})=>item);
    const searches=s.ledger.searches.map(({scopeKey,...item})=>item);
    const mutations=s.ledger.mutations.map(({pathKey,...item})=>item);
    // Keep the legacy status fields, without manufacturing reread obligations.
    if(!detail)return {counts:{observations:observations.length,searches:searches.length,mutations:mutations.length,
      staleObservations:observations.filter(item=>item.stale).length,staleSearches:searches.filter(item=>item.stale).length,revisitObligations:0,
      // Emissions, not appearances. A notice injected at one step is carried in the history
      // of every later request, so counting occurrences in a captured transcript reports a
      // correct single delivery as many. This counter existed in s.metrics and was never
      // exposed here, which meant the only way to check "one reminder" was the transcript.
      stateNotices:s.metrics.stateNotices},
      recentObservations:observations.slice(-8),recentSearches:searches.slice(-5),recentMutations:mutations.slice(-8),
      pendingNotice:!!s.pendingStateNotice};
    return {counts:{observations:observations.length,searches:searches.length,mutations:mutations.length,
      returnedObservations:Math.min(24,observations.length),returnedSearches:Math.min(16,searches.length),returnedMutations:Math.min(12,mutations.length),
      stateNotices:s.metrics.stateNotices},
      observations:observations.slice(-24),searches:searches.slice(-16),mutations:mutations.slice(-12),revisitObligations:[]};
  }
  function consumeStateNotice(s){
    if(!s.pendingStateNotice&&s.pendingNarrowSearch&&!s.narrowSearchNotified&&s.step>0){
      const {pattern,scope}=s.pendingNarrowSearch;
      s.pendingNarrowSearch=null;
      s.pendingStateNotice={observations:0,searches:0,files:new Set(),revisions:new Map(),
        at:new Date().toISOString(),narrowSearch:{pattern,scope}};
    }
    if(!s.pendingStateNotice)return null;

    const notice=s.pendingStateNotice;s.pendingStateNotice=null;
    if(notice.contentEditsOnly&&!notice.observations)return null;
    if(notice.narrowSearch){
      const {pattern,scope}=notice.narrowSearch;
      s.narrowSearchNotified=true;
      const text=`\`${scope}\` 中找到 \`${pattern}\` 的定义。若需要判断它与其他层的关系，只追已经看到的调用方或同一标识符。已有调用路径能解释问题时，直接处理当前分支。`;
      s.metrics.stateNotices++;s.metrics.stateNoticeChars+=text.length;s.dirty=true;
      return {text,observations:0,searches:0,files:[],extraFiles:0,revisions:[],narrowSearch:true};
    }
    const files=[...notice.files].slice(0,5),extra=Math.max(0,notice.files.size-files.length);
    const revisions=[...notice.revisions].slice(0,5).map(([file,revision])=>`${file}@${revision.slice(0,12)}`);
    // Invalidated evidence is a fact about an old observation, not evidence of a
    // new defect. A search-only invalidation cannot require a source reread or a
    // second implementation hunt; a write without a later read is not a failed edit.
    const text=`工程状态已失效（已修改 ${files.join('、')}${extra?' 等'+extra+'个文件':''}）：${notice.observations} 个旧源码观察和 ${notice.searches} 个旧搜索命中对应修改前的内容。`+
        (notice.observations>0?'旧源码观察不能证明当前正文；后续判断需要引用这些内容时，读取对应区段。':'')+
        (notice.searches>0?'旧搜索命中不能证明修改后的命中或完整范围；只有后续判断依赖这些搜索事实时，才重新检索对应范围。':'')+
        `本次写入本身不新增源码回读或调用链调查要求。${revisions.length?' 当前 revision：'+revisions.join('、'):''}`;
    s.metrics.stateNotices++;s.metrics.stateNoticeChars+=text.length;s.dirty=true;
    return {text,observations:notice.observations,searches:notice.searches,files,extraFiles:extra,revisions};
  }
  function problem(s,kind,message){s.problems.push({at:new Date().toISOString(),kind,message:String(message).slice(0,240)});if(s.problems.length>12)s.problems.shift();s.dirty=true;}
  async function loadJson(agent,file,signal){
    const lines=[];let offset=1,chars=0;
    for(let page=0;page<64;page++){
      const r=await call('read',{file_path:file,offset,limit:200},execFor(agent,signal));if(r.isError)return {ok:false,error:r.error};
      if(!Array.isArray(r.value?.lines)||!r.value.lines.length)throw new Error('Stored record has no readable JSON');
      for(const line of r.value.lines){if(/\.\.\. \(line truncated to \d+ chars\)$/.test(line.text))throw new Error('Stored JSON contains an overlong native read line');chars+=line.text.length;lines.push(line.text);}
      if(chars>1000000)throw new Error('Stored record exceeds the local read budget');
      offset=r.value.lines.at(-1).number+1;
      if(offset>r.value.totalLines)return {ok:true,value:JSON.parse(lines.join('\n'))};
    }
    throw new Error('Stored record exceeds the local page budget');
  }
  async function save(agent,file,value,signal,{background=false}={}){
    const text=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',exec=execFor(agent,signal);
    if(background){
      const s=get(agent),targetPath=within(s.root,file),relative=path.relative(s.dir,targetPath);
      if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Background Work Evidence writes must remain inside its storage directory');
      const backend=ctx.get('fs'),policy=ctx.get('sandboxPolicy')?.resolve({session:agent.session});
      if(!backend?.writeText||!policy||!['workspace-write','danger-full-access'].includes(policy.mode))
        throw new Error('Background report storage requires an authorized native file provider');
      const workspace=await backend.resolve(s.root,{cwd:s.root,signal}),storage=await backend.resolve(s.dir,{cwd:s.root,signal}),target=await backend.resolve(targetPath,{cwd:s.root,signal});
      if(!backend.contains(workspace,storage)||!backend.contains(storage,target))throw new Error('Background report storage resolves outside its workspace storage directory');
      const info=await backend.stat(target,signal);
      if(info&&info.type!=='file')throw new Error('Background report target is not a regular file');
      await backend.writeText(target,text,info?{kind:'replaceIfVersion',version:info.version}:{kind:'createIfAbsent'},signal,policy);
      return file;
    }
    if(!exec.token){
      const s=await init(agent,signal),target=within(s.root,file),relative=path.relative(s.dir,target);
      if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Background Work Evidence writes must remain inside its storage directory');
      signal?.throwIfAborted();
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target,text,'utf8');
      return file;
    }
    const r=await call('write',{file_path:file,content:text},exec);
    if(r.isError)throw new Error(r.error?.message||'Native write rejected');
    return file;
  }
  function record(agent,event){
    const s=get(agent),d=event.data||{};
    if(event.type==='agent-preset/selected')s.selectedPreset=d.agentPreset??null;
    s.metrics.nativeEvents++;
    const ownRewrite=event.type==='compaction/summary'&&d.provider==='work-evidence-ledger'||event.type==='user/message'&&d.message?.source?.kind==='work-evidence-working-set'&&d.message.source.workingSet?.action==='project'||event.type==='tool/result'&&event.surfaceOp?.op==='replace'&&parseValue(d.message)?.kind==='work-evidence-reference';
    if(ownRewrite)s.lastHistoryRewriteSeq=Math.max(s.lastHistoryRewriteSeq??-1,event.seq);
    if(event.type==='turn/start'){s.turn=d.turn;s.active=false;s.reportedCurrentTurn=false;s.writes=[];s.automaticEvidence.clear();s.autoAttemptsThisTurn=0;s.malformedResponseRetry=false;s.pendingFailure=null;s.pendingLookupFact=null;s.pendingStateNotice=null;}
    if(event.type==='step/start')s.step++;
    // The step the call was issued at is recorded with it: a result can arrive in a
    // later step than the one that dispatched it, and only the issue step shows
    // whether a read predates a write that was armed in between.
    if(event.type==='tool/call'){s.calls.set(d.callId,{name:d.name,arguments:argsOf(d.arguments),issuedStep:s.step});if(['pwsh','bash'].includes(d.name))s.commandRoots.set(d.callId,{tool:d.name,command:argsOf(d.arguments).command||''});}
    if(['tool/ptc-dispatch-start','tool/code-dispatch-start'].includes(event.type)&&['pwsh','bash'].includes(d.name))s.commandRoots.set(d.rootCallId,{tool:d.name,command:argsOf(d.arguments).command||''});
    if(s.commandRoots.size>256)s.commandRoots.delete(s.commandRoots.keys().next().value);
    if(event.type==='tool/ptc-dispatch'||event.type==='tool/code-dispatch'){
      s.metrics.ptcResults++;
      // A nested dispatch carries no issue step of its own. There is no dispatch-start hook
      // for `tool/ptc-dispatch` (only `commandRoots` is tracked there), so the value available
      // here is the step this COMPLETION event is processed in, which can be later than the
      // issue. The obligation check treats a completion with issuedStep > pending.atStep as
      // satisfying, so a read that started before a write and finished after it can be
      // credited when it should not be. This is a known approximation, recorded as such
      // instead of claiming to be the issue step; closing it needs a dispatch-start hook.
      const issuedStep=Number.isInteger(s.step)?s.step:null;
      observe(agent,{name:d.name,arguments:argsOf(d.arguments),callId:d.subCallId,rootCallId:d.rootCallId,issuedStep},
        {isError:!!d.isError,error:d.error?{info:d.error,message:textOf(d)}:undefined,content:d.content,value:parseValue(d)},event.seq);
    }else if(event.type==='tool/result'&&event.surfaceOp?.op!=='replace'){
      const id=d.message?.source?.callId,c=s.calls.get(id);
      if(c){observe(agent,{...c,callId:id},{isError:!!d.message?.isError,error:{message:textOf(d.message)},content:d.message?.content,value:parseValue(d.message),meta:d.message?.meta},event.seq);s.calls.delete(id);}
    }
    if(s.calls.size>100)s.calls.delete(s.calls.keys().next().value);
  }
  function parseValue(value){try{return JSON.parse(textOf(value));}catch{return undefined;}}
  function observe(agent,exec,result,seq=null){
    if(!isEnabled(agent))return;
    const s=get(agent);if(String(exec.callId||'').startsWith('work-evidence:')||String(exec.rootCallId||'').startsWith('work-evidence-runtime:'))return;
    if(s.seen.has(exec.callId))return;s.seen.add(exec.callId);if(s.seen.size>4096)s.seen.delete(s.seen.values().next().value);
    if(seq===null)s.metrics.liveResults++;
    const argumentRecovery=recoveryOf(result);
    if(argumentRecovery?.applied&&argumentRecovery.correctedArguments){
      exec={...exec,arguments:argumentRecovery.correctedArguments};
      if(argumentRecovery.stage!=='before-dispatch')s.metrics.failuresObserved++;
    }
    const args=argsOf(exec.arguments),detail=textOf(result),parsed=outcome(result.value);
    const error=parsed.error||result.error;
    const code=error?.info?.code||error?.code||((exec.name==='read'&&/: not found\s*$/.test(detail))?'FS_NOT_FOUND':'');
    if(result.isError||(Number.isFinite(result.value?.exitCode)&&result.value.exitCode!==0)){
      if(exec.name==='run_code'&&s.failureRoots.has(exec.rootCallId||exec.callId))return;
      if(exec.name!=='run_code'&&exec.rootCallId){s.failureRoots.add(exec.rootCallId);if(s.failureRoots.size>256)s.failureRoots.delete(s.failureRoots.values().next().value);}
      const filePath=args.file_path||args.path;
      const lookupPattern=exec.name==='grep'&&typeof args.pattern==='string'&&args.pattern.length<=300?args.pattern:null;
      const failure={tool:exec.name,callId:exec.callId||null,code,detail:detail.slice(0,2000),...(typeof filePath==='string'?{filePath}:{}),...(lookupPattern?{lookupPattern}:{}),
        sourceSeq:seq??null,observedAt:new Date().toISOString()};
      s.active=true;s.failures.push(failure);if(s.failures.length>6)s.failures.shift();s.metrics.failuresObserved++;
      s.dirty=true;
      return;
    }
    if(exec.name==='work_report'&&result.value?.saved===true){s.reportedCurrentTurn=true;s.lastReport=result.value.path;s.active=true;s.dirty=true;}
    const observed=outcome(result.value),data=observed.data;
    if(['edit','write','str_replace_editor'].includes(exec.name)){
      s.active=true;s.reportedCurrentTurn=false;const file=args.file_path||args.path;
      if(file){s.writes.push({tool:exec.name,path:file,callId:exec.callId});if(s.writes.length>12)s.writes.shift();recordMutation(agent,{tool:exec.name,file,revision:data.revision,callId:exec.callId,seq});}
      s.dirty=true;
    }
    if(exec.name==='read'&&args.file_path){
      s.reads.push({path:args.file_path,line:args.offset||1,seq,step:s.step});if(s.reads.length>12)s.reads.shift();
      recordObservation(s,exec,result,seq,{file:args.file_path,lineStart:args.offset||1,lineEnd:Number.isInteger(args.limit)?(args.offset||1)+args.limit-1:null});
    }
    if(['grep','glob'].includes(exec.name)){
      const items=exec.name==='grep'?result.value?.matches:result.value?.paths;
      s.searches.push({tool:exec.name,query:args.pattern||'',scope:args.path||'.',seq,step:s.step,empty:Array.isArray(items)&&!items.length});if(s.searches.length>12)s.searches.shift();
      recordSearch(s,exec,result,seq);
      if(Array.isArray(items)&&!items.length){const key=JSON.stringify([exec.name,args]),prior=s.emptyLookups.get(key),now=Date.now();if(prior&&now-prior.time<120000&&!prior.noted){prior.noted=true;s.pendingLookupFact={tool:exec.name,arguments:args,firstCallId:prior.callId,repeatedCallId:exec.callId};s.active=true;}else if(!prior||now-prior.time>=120000)s.emptyLookups.set(key,{time:now,callId:exec.callId,noted:false});if(s.emptyLookups.size>24)s.emptyLookups.delete(s.emptyLookups.keys().next().value);}
      if(exec.name==='grep'&&Array.isArray(items)&&items.length&&!s.pendingNarrowSearch&&!s.narrowSearchNotified){
        const pattern=typeof args.pattern==='string'?args.pattern.trim():'';
        // A definition query, not a free-text search: one identifier, optionally the
        // language's definition keyword. Anything wider is a normal search.
        if(/^(?:def|func|function|class|interface|struct|fn|fun|void|public|private|protected|static|final|abstract)?\s*[A-Za-z_$][\w$]{2,64}$/u.test(pattern)){
          const bareName=pattern.replace(/^[A-Za-z_$][\w$]*\s+/u,'').trim(),name=bareName.split(/\s+/u).at(-1);
          // A match is only a definition site when the matched line declares THIS name.
          // A line that merely starts with a declaration keyword declares something
          // else, and an import or a call is a reference; calling either a definition
          // would mislead and spend the one notice.
          const declares=line=>{
            const text=typeof line==='string'?line:'';
            if(!text)return false;
            const escaped=name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
            if(!new RegExp('(^|[^\\w$])'+escaped+'(?![\\w$])','u').test(text))return false;
            // The declaration must bind the name: keyword then name, allowing modifiers
            // and an annotation between them (Java), and `export`/`default`/`async` in JS.
            return new RegExp('(?:^|[;{}\\s])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+|abstract\\s+|synchronized\\s+)?(?:def|func|fn|fun|function|class|interface|struct|type|enum|const|let|var|val)\\s+'+escaped+'(?![\\w$])','u').test(text)
              ||new RegExp('(?:^|[;{}\\s])(?:public|private|protected|static|final|abstract|synchronized|native|transient|volatile)[\\w\\s<>\\[\\],.?@()]*\\s+'+escaped+'\\s*\\(','u').test(text);
          };
          const sites=new Map();
          for(const match of items){
            const path=typeof match?.path==='string'?match.path:null;
            if(path&&declares(match.line??match.text??''))sites.set(path,(sites.get(path)??0)+1);
          }
          if(sites.size===1&&items.length===1&&!s.pendingNarrowSearch&&!s.narrowSearchNotified&&
            typeof args.path==='string'&&/\.(?:[cm]?[jt]sx?|py|java|rs|go|rb|php|cs|cpp|h)$/iu.test(args.path)){
            s.pendingNarrowSearch={pattern,scope:args.path.split(/[\\/]/u).pop()};
          }
        }
      }
    }
  }
  function sync(agent){const s=get(agent),log=eventLog(agent.session);while(s.cursor<log.length){const event=log[s.cursor++];record(agent,event);}return s;}
  function snapshot(agentOrState,{detail=true}={}){
    const agent=agentOrState.session?agentOrState:agentOrState.agentRef;
    const s=agent?get(agent):agentOrState;
    const effective=agent?isEnabled(agent):(s.sessionPolicyLoaded&&s.workspaceConfigValid&&(s.sessionEnabledOverride===null?s.config.enabled:s.sessionEnabledOverride)&&(s.config.aggressiveMode||s.selectedMode==='quality'));
    return {version:VERSION,sessionId:s.id,at:new Date().toISOString(),turn:s.turn,steps:s.step,
    mode:modeStatus(agent??s),
    enabled:effective,workspaceDefaultEnabled:s.config.enabled,session:{enabled:effective,override:s.sessionEnabledOverride,source:s.sessionEnabledOverride===null?'workspace-setting':'session-setting',defaultResponseView:s.sessionDefaultResponseView??s.config.defaultResponseView,
      policyPath:s.sessionPolicyPath,loaded:s.sessionPolicyLoaded,settingsRetainedInMemory:s.sessionFileMissing},
    telemetry:{directory:s.telemetryDir,scope:s.telemetryScope,workspaceConfiguration:s.dir},workspaceConfigValid:s.workspaceConfigValid,workspaceSettingsRetainedInMemory:s.workspaceFileMissing,
      features:{enabled:s.config.enabled,aggressiveMode:s.config.aggressiveMode,selfIndex:s.config.selfIndex,completionNotice:s.config.completionNotice,ptcPatterns:true,ptcFastpath:true,verifiedExec:true,contextProtocol:s.config.contextProtocol,historyHygiene:s.config.historyHygiene,definitionSummary:s.config.definitionSummary,
      stateLedger:s.config.stateLedger,stateInform:s.config.stateInform,archiveReadRouting:s.config.archiveReadRouting,readArgumentRecovery:s.config.readArgumentRecovery,requestAccounting:s.config.requestAccounting,evidenceViews:s.config.evidenceViews,memberParsing:s.config.memberParsing,mavenSourceBinding:s.config.mavenSourceBinding,
      ledgerReceipt:s.config.ledgerReceipt,ledgerUnresolved:s.config.ledgerUnresolved,nativeVerifiedEdits:s.config.nativeVerifiedEdits,fileProfiling:s.config.fileProfiling,structuredJson:s.config.structuredJson,
      swLedger:s.config.swLedger,swEviction:s.config.swEviction,swEvictionSteps:s.config.swEvictionSteps,defaultResponseView:s.sessionDefaultResponseView??s.config.defaultResponseView,
      requestProjection:s.config.requestProjection,projectionRestore:s.config.projectionRestore,compressionControl:s.config.compressionControl,compactionTiming:s.config.compactionTiming,deferPressureCompaction:s.config.deferPressureCompaction,stubSummary:s.config.stubSummary,
      executionTriage:s.config.executionTriage,nativeProgramReuse:s.config.nativeProgramReuse,hostNodeFallback:s.config.hostNodeFallback,nativeShellScriptReuse:s.config.nativeShellScriptReuse,probeReplay:s.config.probeReplay,structuredCalls:s.config.structuredCalls,nativeReasoningReplay:s.config.nativeReasoningReplay,stageWorkingSet:s.config.stageWorkingSet,stepPacing:s.config.stepPacing,retainedCompute:s.config.retainedCompute,finalJsonGuard:s.config.finalJsonGuard,finalJsonResultGuard:s.config.finalJsonResultGuard,
      qualityReview:s.config.qualityReview,boundedPatch:s.config.boundedPatch,qualityReviewEffort:s.config.qualityReviewEffort,qualityReviewScope:s.config.qualityReviewScope,toolSurface:s.config.toolSurface},
    contextSettings:{requestProjection:s.config.requestProjection,projectionRestore:s.config.projectionRestore,compressionControl:s.config.compressionControl,compactionTiming:s.config.compactionTiming,deferPressureCompaction:s.config.deferPressureCompaction,stubSummary:s.config.stubSummary,definitionSummary:s.config.definitionSummary,
      projectionMinChars:s.config.projectionMinChars,projectionRecentSteps:s.config.projectionRecentSteps,projectionStableSteps:s.config.projectionStableSteps,
      projectionHorizonSteps:s.config.projectionHorizonSteps,projectionPricing:s.config.projectionPricing,toolSurface:s.config.toolSurface,
      contextProtocol:s.config.contextProtocol,contextPruningPolicy:s.config.contextPruningPolicy,contextPruneMinChars:s.config.contextPruneMinChars,
      contextPruneHeadChars:s.config.contextPruneHeadChars,contextPruneTailChars:s.config.contextPruneTailChars},
    ...(detail?{requestObservations:s.requestObservations.map(record=>({...record}))}:
      {requestObservationWindow:{count:s.requestObservations.length,details:{tool:'work_status',arguments:{detail:true}}}}),
    reasoningReplay:{enabled:effective&&s.config.nativeReasoningReplay,requests:s.reasoningReplay?.requests??0,translatedMessages:s.reasoningReplay?.translatedMessages??0,scope:'Readable DeepSeek history field mapping; original reasoning text and canonical history are retained.'},
    evidenceViewReasons:{...s.evidenceViewReasons},
    ...(runtimeContextSnapshot?.(s.id,{detail})??{}),
    metrics:{...s.metrics},problems:[...s.problems],reportedCurrentTurn:!!s.reportedCurrentTurn,taskCompletion:'unknown',
    state:stateSnapshot(s,false),
    note:'Counters describe plugin activity, not task correctness or causal savings.'};}
  async function receipt(agent,signal,force=false){const s=get(agent);if(!s.root||!s.telemetryDir||(!force&&s.step-s.lastReceipt<20))return;
    // This plugin-owned snapshot also has background writers. Do not mix native
    // edit observations with filesystem writes and invalidate the next native CAS.
    const step=s.step,text=JSON.stringify(snapshot(agent),null,2)+'\n';
    const pending=(s.receiptQueue??Promise.resolve()).then(async()=>{
      signal?.throwIfAborted();
      await fs.mkdir(s.telemetryDir,{recursive:true});
      await fs.writeFile(path.join(s.telemetryDir,s.id+'.runtime.json'),text,'utf8');
      s.lastReceipt=step;if(s.step===step)s.dirty=false;
    });
    s.receiptQueue=pending.catch(()=>{});
    try{await pending;}catch(e){
      if(signal?.aborted&&e===signal.reason)return;
      const message=e instanceof Error?e.message:String(e);
      problem(s,'receipt-write',message);ctx.logger.warn('work-evidence: activity record unavailable: '+message);
    }}
  let runtimeContextSnapshot=null;
  return {get,init,refresh,isEnabled,currentSelection:effortSelection,currentRequest,clearSessionState,setSessionEnabled,setSessionMode,setWorkspaceMode,setAggressiveMode,setWorkspaceConfig,modeStatus,activeMode,beginRequest,sync,observe,save,loadJson,problem,snapshot,stateSnapshot,consumeStateNotice,recordMutation,recordStateObservation,
    setContextSnapshot:reader=>{runtimeContextSnapshot=reader;},
    receipt,execFor,withExecution,dispose:id=>states.delete(id)};
}
