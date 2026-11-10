import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {within,references,assertExistingFileWithin,readUtf8File} from './evidence.mjs';
import {recoveryFor,recoveryOf} from './recovery.mjs';

export const VERSION='1.1.1';
export const RETIRED_SETTINGS=Object.freeze(['taskEffort','nativeReadView','nativeExecutionEvidence','reasoningHistory','cacheOrderedStub','archiveEntries','ledgerFoldPlan','ledgerFoldWrite','programHistory','executionAdvice','finishAdvice']);
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
    fastEditEnabled:true,fastEditPython:path.join(import.meta.dirname,'.fastedit-venv','Scripts','python.exe'),
    stateLedger:true,stateInform:true,completionNotice:false,archiveReadRouting:true,readArgumentRecovery:true,requestAccounting:true,evidenceViews:true,memberParsing:true,mavenSourceBinding:true,
    contextProtocol:true,contextPruningPolicy:'forecast',historyHygiene:true,contextPruneMinChars:8000,contextPruneHeadChars:4096,contextPruneTailChars:1024,
    ledgerReceipt:true,ledgerUnresolved:true,
    swLedger:false,swEviction:false,swEvictionSteps:3,
    requestProjection:false,projectionRestore:false,compressionControl:true,compactionTiming:'native',
    deferPressureCompaction:false,stubSummary:false,
    executionTriage:true,nativeProgramReuse:false,structuredCalls:false,nativeReasoningReplay:false,stageWorkingSet:true,stepPacing:true,retainedCompute:true,finalJsonGuard:true,finalJsonResultGuard:false,qualityReview:false,qualityReviewEffort:'auto',qualityReviewScope:'auto',
    projectionMinChars:64000,projectionRecentSteps:6,projectionStableSteps:8,projectionHorizonSteps:16,projectionPricing:[],
    toolSurface:'compact',
    defaultResponseView:'reference-if-visible',...raw};
  // Settings that chose default mode before aggressiveMode existed keep handing
  // that decision to the host instead of silently enabling aggressive.
  if(config.mode==='default'&&raw.aggressiveMode===undefined)config.aggressiveMode=false;
  const known=new Set(['enabled','aggressiveMode','mode','selfIndex','modelTimeoutMs','modelMaxTokens','modelRoute','fastEditEnabled','fastEditPython','stateLedger','stateInform','archiveReadRouting','readArgumentRecovery','requestAccounting','evidenceViews','memberParsing','mavenSourceBinding',
    'contextProtocol','contextPruningPolicy','historyHygiene','programHistory','reasoningHistory','retainedCompute','contextPruneMinChars','contextPruneHeadChars','contextPruneTailChars','completionNotice',
    'ledgerReceipt','ledgerUnresolved','ledgerFoldPlan','ledgerFoldWrite','defaultResponseView','swLedger','swEviction','swEvictionSteps','nativeProgramReuse','structuredCalls','nativeReasoningReplay',
    'requestProjection','projectionRestore','compressionControl','compactionTiming','deferPressureCompaction','stubSummary','cacheOrderedStub','archiveEntries','executionTriage','executionAdvice','stageWorkingSet','finishAdvice','stepPacing','taskEffort','finalJsonGuard','finalJsonResultGuard','qualityReview','qualityReviewEffort','qualityReviewScope','nativeReadView','nativeExecutionEvidence','projectionMinChars','projectionRecentSteps','projectionStableSteps','projectionHorizonSteps','projectionPricing','toolSurface']);
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!known.has(k)))throw new Error('Unknown work-evidence setting');
  // Accept old workspaces without loading removed modules or re-enabling their hooks.
  for(const key of RETIRED_SETTINGS){
    if(raw[key]!==undefined&&typeof raw[key]!=='boolean')throw new Error('Invalid '+key);
    config[key]=false;
  }
  checkedMode(config.mode);
  if(!['forecast','online-batch'].includes(config.contextPruningPolicy))throw new Error('Invalid contextPruningPolicy');
  config.contextPruningPolicy='forecast';
  if(!['native','adaptive'].includes(config.compactionTiming))throw new Error('Invalid compactionTiming');
  config.compactionTiming='native';
  for(const key of ['enabled','aggressiveMode','selfIndex','fastEditEnabled','stateLedger','stateInform','archiveReadRouting','readArgumentRecovery','requestAccounting','evidenceViews','memberParsing','mavenSourceBinding','contextProtocol','historyHygiene','programHistory','reasoningHistory',
    'ledgerReceipt','ledgerUnresolved','ledgerFoldPlan','ledgerFoldWrite','swLedger','swEviction','requestProjection','projectionRestore','compressionControl','deferPressureCompaction','stubSummary','cacheOrderedStub','archiveEntries','executionTriage','nativeProgramReuse','structuredCalls','nativeReasoningReplay','executionAdvice','stageWorkingSet','finishAdvice','stepPacing','retainedCompute','taskEffort','finalJsonGuard','finalJsonResultGuard','qualityReview','nativeReadView','nativeExecutionEvidence','completionNotice'])if(typeof config[key]!=='boolean')throw new Error('Invalid '+key);
  if(!Number.isInteger(config.swEvictionSteps)||config.swEvictionSteps<3||config.swEvictionSteps>50)throw new Error('Invalid swEvictionSteps');
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
      failures:[],writes:[],emptyLookups:new Map(),readPages:new Map(),automaticEvidence:new Set(),active:false,pendingFailure:null,pendingLookupFact:null,pendingStateNotice:null,pendingOpsAdvice:[],
      commandRoots:new Map(),failureRoots:new Set(),requestObservations:[],auxiliarySignals:new WeakSet(),selectedPreset:agent.session.header?.agentPreset||null,evidenceViewReasons:{},viewEpoch:0,
      reads:[],searches:[],index:[],indexLoaded:false,indexDirty:false,
      ledger:{observations:[],searches:[],mutations:[]},
      sessionEnabledOverride:null,sessionPolicyPath:null,sessionPolicyLoaded:false,sessionDefaultResponseView:null,sessionModeOverride:null,taskMode:null,taskModePersisted:true,claimedRequest:null,policyQueue:Promise.resolve(),
      lastReceipt:0,dirty:true,effortCache:null,metrics:{nativeEvents:0,ptcResults:0,liveResults:0,failuresObserved:0,evidenceAttempts:0,evidenceDelivered:0,
        evidenceLocated:0,evidenceIncomplete:0,evidenceUnavailable:0,evidenceNoSource:0,indexLearned:0,indexRejected:0,indexHits:0,auxiliaryCalls:0,auxiliaryFailures:0,auxiliaryUnknownCalls:0,auxiliaryJsonRecoveries:0,
        auxiliaryUsage:{},auxiliaryMs:0,candidatePredictions:0,candidateRuns:0,verifiedExecPreviews:0,contextProtocolPrunedResults:0,contextProtocolPrunedChars:0,
        verifiedExecApplies:0,verifiedExecPartial:0,verifiedExecDeopts:0,verifiedExecValidationFailures:0,
        ptcFastpathRuns:0,ptcFastpathSuccesses:0,ptcFastpathDeopts:0,fastEditPreviews:0,fastEditApplies:0,fastEditPartial:0,fastEditDeopts:0,
        fastEditEntityFinds:0,fastEditEntityReads:0,stateObservations:0,stateSearches:0,stateStaleObservations:0,stateStaleSearches:0,
        stateNotices:0,stateNoticeChars:0,opsErrorNotices:0,partialResultsObserved:0,opaqueOpsResults:0,longWaitRedirects:0,
        ledgerObservations:0,ledgerReceipts:0,ledgerReceiptCharsSaved:0,ledgerStale:0,ledgerUnresolvedInjected:0,
        archiveReadRoutes:0,readArgumentCorrections:0,readArgumentNormalizations:0,contextRequests:0,contextRequestChars:0,contextModelTextChars:0,
        evidenceVisibleViews:0,evidenceFullViews:0,evidenceReferenceViews:0,evidenceReferenceMisses:0,evidenceViewOutputChars:0},problems:[]};states.set(id,s);}
    if(agent.ctx||agent.options||!s.agentRef)s.agentRef=agent;
    return s;
  }
  const execFor=(agent,signal)=>{const execution=get(agent).execution;return {agent,signal,rootCallId:execution?.rootCallId,token:execution?.token};};
  async function withExecution(exec,fn){const s=get(exec.agent),prior=s.execution;s.execution=exec;try{return await fn();}finally{s.execution=prior;}}
  async function init(agent,signal){
    const s=get(agent);
    // Session policy is re-read on every init cycle: the policy file may be written by an
    // experiment harness (or a user) after the agent/created prepare pass already cached a
    // missing result. The file is tiny, so re-reading is cheaper than the staleness.
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
    if(s.initPromise)return s.initPromise;
    s.initPromise=(async()=>{
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
      s.sessionPolicyLoaded=true;
      s.configured=true;return s;
    })();
    try{return await s.initPromise;}finally{s.initPromise=null;}
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
    s.active=false;s.pendingFailure=null;s.pendingLookupFact=null;s.pendingStateNotice=null;s.pendingOpsAdvice=[];s.readPages=new Map();s.queuedMessages=[];s.dirty=true;
    s.opsAdviceSeen=new Set();
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
      s.sessionEnabledOverride=checked.enabled;s.sessionModeOverride=checked.mode;s.taskMode=checked.taskMode;s.taskModePersisted=true;s.dirty=true;
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
    const s=await init(agent,signal),key=path.join(s.dir,'config.json');
    const operation=(workspaceQueues.get(key)??Promise.resolve()).catch(()=>{}).then(async()=>{
      signal?.throwIfAborted();
      await init(agent,signal);
      if(!s.workspaceConfigValid)throw new Error('Workspace configuration is unavailable or invalid');
      const before=isEnabled(agent),next=defaults({...s.config,...patch});
      await save(agent,key,next,signal);
      s.config=next;s.workspaceFileSeen=true;s.workspaceFileMissing=false;s.dirty=true;
      if(before!==isEnabled(agent))clearSessionState(agent);
      return {path:key,scope:'workspace',settings:{...patch},effectiveFrom:'next-model-request'};
    });
    workspaceQueues.set(key,operation);
    try{return await operation;}finally{if(workspaceQueues.get(key)===operation)workspaceQueues.delete(key);}
  }
  async function beginRequest(agent,signal){
    const s=get(agent);
    let incoming=s.claimedRequest;
    if(!incoming){
      for(const event of eventLog(agent.session)){const message=event.data?.message??event.data;if(event.type==='user/message'&&isUserRequestMessage(message))incoming=message;}
    }
    if(!incoming?.id){s.claimedRequest=null;return modeStatus(s);}
    const selected=modeStatus(agent);
    s.selectedMode=selected.selected;
    const taskMode={requestId:incoming.id,mode:selected.selected,source:'effort-selection',policyVersion:MODE_POLICY_VERSION};
    if(s.taskMode?.requestId===incoming.id&&s.taskMode.mode===taskMode.mode&&s.taskMode.source===taskMode.source){s.claimedRequest=null;return modeStatus(s);}
    try{await updateSessionPolicy(agent,{taskMode},signal);}
    catch(error){
      signal?.throwIfAborted();
      // Fix the current request even when storage is unavailable; report that it cannot survive a reload.
      s.taskMode=taskMode;s.taskModePersisted=false;problem(s,'task-mode-save',error.message);
    }
    s.claimedRequest=null;
    return modeStatus(s);
  }
  async function setSessionEnabled(agent,enabled,signal){
    if(enabled!==null&&typeof enabled!=='boolean')throw new Error('Session enabled must be boolean or null');
    const s=await init(agent,signal),before=isEnabled(agent);
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
  function ledgerPath(s,value){
    if(typeof value!=='string'||!value.trim()||!s.root)return null;
    const full=path.resolve(s.root,value),relative=path.relative(s.root,full);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return null;
    return {full,display:relative.replaceAll('\\','/')||'.',key:process.platform==='win32'?full.toLowerCase():full};
  }
  function boundedPush(list,value,max){list.push(value);if(list.length>max)list.splice(0,list.length-max);}
  function markStateStale(s,files=[]){
    let observations=0,searches=0;const changed=[];
    for(const file of files){
      if(!file)continue;changed.push(file.display);
      for(const observation of s.ledger.observations){
        if(observation.stale||observation.pathKey!==file.key||(file.revision&&observation.revision===file.revision))continue;
        observation.stale=true;observation.staleAt=new Date().toISOString();observations++;
      }
      for(const search of s.ledger.searches){
        if(search.stale)continue;
        const scope=ledgerPath(s,search.scope||'.');
        if(!scope||file.key===scope.key||file.key.startsWith(scope.key+path.sep)){
          search.stale=true;search.staleAt=new Date().toISOString();searches++;
        }
      }
    }
    if(!observations&&!searches)return;
    s.metrics.stateStaleObservations+=observations;s.metrics.stateStaleSearches+=searches;
    const pending=s.pendingStateNotice||{observations:0,searches:0,files:new Set(),revisions:new Map(),at:new Date().toISOString()};
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
      glob:exec.arguments?.glob||null,complete:outcome(result.value).status==='completed'&&outcome(result.value).data.complete!==false,
      callId:exec.callId||null,seq,step:s.step,stale:false,observedAt:new Date().toISOString()},48);
    s.metrics.stateSearches++;s.dirty=true;
  }
  function recordMutation(agent,{tool='write',file,revision=null,callId=null,seq=null}={}){
    const s=get(agent);if(!s.config.stateLedger)return null;
    const target=ledgerPath(s,file);if(!target)return null;
    const mutation={tool,path:target.display,pathKey:target.key,revision:revisionPattern.test(String(revision||''))?revision:null,
      callId,seq,step:s.step,at:new Date().toISOString()};
    boundedPush(s.ledger.mutations,mutation,32);
    markStateStale(s,[{...target,revision:mutation.revision}]);
    s.active=true;s.dirty=true;return mutation;
  }
  function recordReadObservation(agent,value){
    const s=get(agent);if(!s.config.stateLedger)return null;
    return recordObservation(s,{name:value.tool||'fastedit_java',arguments:{path:value.file},callId:value.callId||'fastedit:'+randomUUID()},
      {value:{status:'completed',data:{revision:value.revision}}},value.seq??null,value);
  }
  function stateSnapshot(s,detail=false){
    const observations=s.ledger.observations.map(({pathKey,...item})=>item);
    const searches=s.ledger.searches.map(({scopeKey,...item})=>item);
    const mutations=s.ledger.mutations.map(({pathKey,...item})=>item);
    if(!detail)return {counts:{observations:observations.length,searches:searches.length,mutations:mutations.length,
      staleObservations:observations.filter(item=>item.stale).length,staleSearches:searches.filter(item=>item.stale).length},
      recentObservations:observations.slice(-8),recentSearches:searches.slice(-5),recentMutations:mutations.slice(-8),
      pendingNotice:!!s.pendingStateNotice};
    return {counts:{observations:observations.length,searches:searches.length,mutations:mutations.length,
      returnedObservations:Math.min(24,observations.length),returnedSearches:Math.min(16,searches.length),returnedMutations:Math.min(12,mutations.length)},
      observations:observations.slice(-24),searches:searches.slice(-16),mutations:mutations.slice(-12)};
  }
  function consumeStateNotice(s){
    if(!s.pendingStateNotice)return null;
    const notice=s.pendingStateNotice;s.pendingStateNotice=null;
    const files=[...notice.files].slice(0,5),extra=Math.max(0,notice.files.size-files.length);
    const revisions=[...notice.revisions].slice(0,5).map(([file,revision])=>`${file}@${revision.slice(0,12)}`);
    const text=`工程状态已失效：写入 ${files.join('、')}${extra?' 等'+extra+'个文件':''} 后，${notice.observations} 个旧源码观察和 ${notice.searches} 个旧搜索命中不再代表当前工作区。不要继续复用修改前的行内容或搜索结果；需要时按当前内容重读。${revisions.length?' 当前协作 revision：'+revisions.join('、'):''}`;
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
  async function save(agent,file,value,signal){
    const text=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',exec=execFor(agent,signal);
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
    if(event.type==='turn/start'){s.turn=d.turn;s.active=false;s.reportedCurrentTurn=false;s.writes=[];s.automaticEvidence.clear();s.autoAttemptsThisTurn=0;s.pendingFailure=null;s.pendingLookupFact=null;s.pendingStateNotice=null;s.pendingOpsAdvice=[];s.readPages=new Map();s.opsAdviceSeen=new Set();}
    if(event.type==='step/start')s.step++;
    if(event.type==='tool/call'){s.calls.set(d.callId,{name:d.name,arguments:argsOf(d.arguments)});if(['pwsh','bash','ops_bash'].includes(d.name))s.commandRoots.set(d.callId,{tool:d.name,command:argsOf(d.arguments).command||''});}
    if(['tool/ptc-dispatch-start','tool/code-dispatch-start'].includes(event.type)&&['pwsh','bash','ops_bash'].includes(d.name))s.commandRoots.set(d.rootCallId,{tool:d.name,command:argsOf(d.arguments).command||''});
    if(s.commandRoots.size>256)s.commandRoots.delete(s.commandRoots.keys().next().value);
    if(event.type==='tool/ptc-dispatch'||event.type==='tool/code-dispatch'){
      s.metrics.ptcResults++;
      observe(agent,{name:d.name,arguments:argsOf(d.arguments),callId:d.subCallId,rootCallId:d.rootCallId},
        {isError:!!d.isError,error:d.error?{info:d.error,message:textOf(d)}:undefined,content:d.content,value:parseValue(d)},event.seq);
    }else if(event.type==='tool/result'&&event.surfaceOp?.op!=='replace'){
      const id=d.message?.source?.callId,c=s.calls.get(id);
      if(c){observe(agent,{...c,callId:id},{isError:!!d.message?.isError,error:{message:textOf(d.message)},content:d.message?.content,value:parseValue(d.message)},event.seq);s.calls.delete(id);}
    }
    if(s.calls.size>100)s.calls.delete(s.calls.keys().next().value);
  }
  function parseValue(value){try{return JSON.parse(textOf(value));}catch{return undefined;}}
  function observe(agent,exec,result,seq=null){
    if(!isEnabled(agent))return;
    const s=get(agent);if(String(exec.callId||'').startsWith('work-evidence:')||String(exec.rootCallId||'').startsWith('work-evidence-runtime:'))return;
    // Stored display text can be clipped mid-JSON. Do not let this lossy event
    // claim the call ID before the live structured result can be observed.
    if(seq!==null&&exec.name.startsWith('ops_')&&result.value===undefined&&!result.isError){s.metrics.opaqueOpsResults++;return;}
    if(s.seen.has(exec.callId))return;s.seen.add(exec.callId);if(s.seen.size>4096)s.seen.delete(s.seen.values().next().value);
    if(seq===null)s.metrics.liveResults++;
    const argumentRecovery=recoveryOf(result);
    if(argumentRecovery?.applied&&argumentRecovery.correctedArguments){
      exec={...exec,arguments:argumentRecovery.correctedArguments};
      if(argumentRecovery.stage!=='before-dispatch')s.metrics.failuresObserved++;
    }
    const args=argsOf(exec.arguments),detail=textOf(result),parsed=outcome(result.value),opsError=exec.name.startsWith('ops_')&&(parsed.status==='error'||parsed.status==='unknown'||!!parsed.error||Number(parsed.data.failed)>0);
    const error=parsed.error||result.error;
    const code=error?.info?.code||error?.code||((exec.name==='read'&&/: not found\s*$/.test(detail))?'FS_NOT_FOUND':'');
    const missingItem=Array.isArray(parsed.data.items)?parsed.data.items.find(item=>item?.status==='error'&&item.error?.code==='NOT_FOUND'&&typeof item.path==='string'):null;
    const missingFile=code==='FS_NOT_FOUND'||(opsError&&(code==='NOT_FOUND'||!!missingItem));
    if(opsError){
      const advice={tool:exec.name,code:code||'OPS_ERROR',message:String(error?.message||detail).slice(0,400),nextAction:String(error?.nextAction||'Inspect this result before reading its data.').slice(0,240)};
      if(code==='INVALID_ARGUMENT'){
        const recovery=recoveryFor(exec.name,args,result);
        if(recovery){advice.shape=recovery.shape;advice.retry=recovery.retry;if(recovery.correctedCall)advice.correctedArguments=recovery.correctedCall.arguments;}
      }
      if(code==='RESULT_PARTIAL'){
        s.metrics.partialResultsObserved++;
        advice.scope='已返回items只证明所列范围；未覆盖部分保持未知。nextIndex到达total但failed>0时，处理失败项，不原样翻页或断言不存在。';
        if(missingItem)advice.failedPath=missingItem.path;
      }
      if(code==='RESULT_UNKNOWN')advice.scope='执行结果未知，不是零匹配或程序根因。只读查询可换更窄范围或现有读取工具取得事实；写操作先查实际状态，不能盲目重跑。';
      // Repeat failures remain in metrics; identical advice need not bloat
      // every subsequent request. Changed arguments/errors receive new advice.
      const key=JSON.stringify([exec.name,code,args,advice.message]);
      s.opsAdviceSeen??=new Set();
      if(!argumentRecovery&&!s.opsAdviceSeen.has(key)){
        s.opsAdviceSeen.add(key);if(s.opsAdviceSeen.size>64)s.opsAdviceSeen.delete(s.opsAdviceSeen.values().next().value);
        boundedPush(s.pendingOpsAdvice,advice,3);
      }
    }
    if(result.isError||opsError||(Number.isFinite(result.value?.exitCode)&&result.value.exitCode!==0)){
      if(exec.name==='run_code'&&s.failureRoots.has(exec.rootCallId||exec.callId))return;
      if(exec.name!=='run_code'&&exec.rootCallId){s.failureRoots.add(exec.rootCallId);if(s.failureRoots.size>256)s.failureRoots.delete(s.failureRoots.values().next().value);}
      const filePath=missingItem?.path||args.file_path||args.path;
      const lookupPattern=['ops_grep','grep'].includes(exec.name)&&typeof args.pattern==='string'&&args.pattern.length<=300?args.pattern:null;
      const failure={tool:exec.name,callId:exec.callId||null,code:missingFile?'FS_NOT_FOUND':code,detail:detail.slice(0,2000),...(typeof filePath==='string'?{filePath}:{}),...(lookupPattern?{lookupPattern}:{}),
        sourceSeq:seq??null,observedAt:new Date().toISOString()};
      s.active=true;s.failures.push(failure);if(s.failures.length>6)s.failures.shift();s.metrics.failuresObserved++;
      s.dirty=true;
      // Retain real, successful items in a partial result without promoting
      // its missing items or incomplete search to a complete observation.
      if(!opsError||code!=='RESULT_PARTIAL')return;
    }
    if(exec.name==='work_report'&&result.value?.saved===true){s.reportedCurrentTurn=true;s.lastReport=result.value.path;s.active=true;s.dirty=true;}
    const observed=outcome(result.value),data=observed.data;
    if(!opsError&&['edit','write','str_replace_editor','ops_edit_file','ops_write_file'].includes(exec.name)){
      s.active=true;s.reportedCurrentTurn=false;const file=args.file_path||args.path;
      if(file){s.writes.push({tool:exec.name,path:file,callId:exec.callId});if(s.writes.length>12)s.writes.shift();recordMutation(agent,{tool:exec.name,file,revision:data.revision,callId:exec.callId,seq});}
      s.dirty=true;
    }
    if(exec.name==='ops_batch'&&Array.isArray(data.items)){
      for(const item of data.items)if(item?.status==='completed'&&typeof item.path==='string')recordMutation(agent,{tool:exec.name,file:item.path,revision:item.revision,callId:exec.callId,seq});
    }
    if(exec.name==='ops_read_files'&&Array.isArray(args.files)&&Array.isArray(data.items)){
      for(let index=0;index<Math.min(args.files.length,data.items.length);index++){
        const item=data.items[index],requested=args.files[index];
        if(item?.complete===true&&Array.isArray(item.items)&&!item.items.length){
          const key=JSON.stringify(['ops_read_files',requested]);
          const prior=s.readPages.get(key),nextOffset=Number.isInteger(item.nextOffset)?item.nextOffset:null;
          const code=prior?'READ_REPEAT_NO_PROGRESS':'READ_EMPTY_PAGE';
          s.opsAdviceSeen??=new Set();
          if(!prior?.noted&&!s.opsAdviceSeen?.has(JSON.stringify([exec.name,code,key,nextOffset]))){
            s.opsAdviceSeen.add(JSON.stringify([exec.name,code,key,nextOffset]));
            boundedPush(s.pendingOpsAdvice,{tool:exec.name,code,path:item.path||requested?.path||null,complete:true,nextOffset,
              scope:'This page returned no source lines. A non-null nextOffset does not prove another useful page exists. Stop cursor-based pagination unless a changed, relevant range still needs evidence.',
              nextAction:'Do not repeat the same page or loop on nextOffset; request a different relevant range only if it is needed.'},3);
            s.dirty=true;
          }
          s.readPages.set(key,{time:Date.now(),noted:true,callId:exec.callId,nextOffset});
          if(s.readPages.size>32)s.readPages.delete(s.readPages.keys().next().value);
        }
        if(!item||!['completed','partial'].includes(String(item.status))||!Array.isArray(item.items)||!item.items.length||!revisionPattern.test(String(item.revision||'')))continue;
        const first=Array.isArray(item.items)?item.items[0]?.line:null,last=Array.isArray(item.items)?item.items.at(-1)?.line:null;
        recordObservation(s,{...exec,arguments:{path:item.path||requested?.path,offset:requested?.offset}},result,seq,
          {file:item.path||requested?.path,revision:item.revision,lineStart:first||requested?.offset||1,lineEnd:last||null});
      }
    }else if(exec.name==='ops_inspect_local_file'&&revisionPattern.test(String(data.revision||''))){
      const lineStart=Number.isInteger(args.offset)&&args.offset>0?args.offset:1;
      const lineEnd=Number.isInteger(data.lineCount)&&Number.isInteger(args.limit)?Math.min(data.lineCount,lineStart+args.limit-1):null;
      recordObservation(s,exec,result,seq,{file:data.path||args.path,revision:data.revision,lineStart,lineEnd});
    }else if(exec.name==='read'&&args.file_path){
      s.reads.push({path:args.file_path,line:args.offset||1,seq,step:s.step});if(s.reads.length>12)s.reads.shift();
      recordObservation(s,exec,result,seq,{file:args.file_path,lineStart:args.offset||1,lineEnd:Number.isInteger(args.limit)?(args.offset||1)+args.limit-1:null});
    }
    if(['grep','glob'].includes(exec.name)){
      const items=exec.name==='grep'?result.value?.matches:result.value?.paths;
      s.searches.push({tool:exec.name,query:args.pattern||'',scope:args.path||'.',seq,step:s.step,empty:Array.isArray(items)&&!items.length});if(s.searches.length>12)s.searches.shift();
      recordSearch(s,exec,result,seq);
      if(Array.isArray(items)&&!items.length){const key=JSON.stringify([exec.name,args]),prior=s.emptyLookups.get(key),now=Date.now();if(prior&&now-prior.time<120000&&!prior.noted){prior.noted=true;s.pendingLookupFact={tool:exec.name,arguments:args,firstCallId:prior.callId,repeatedCallId:exec.callId};s.active=true;}else if(!prior||now-prior.time>=120000)s.emptyLookups.set(key,{time:now,callId:exec.callId,noted:false});if(s.emptyLookups.size>24)s.emptyLookups.delete(s.emptyLookups.keys().next().value);}
    }else if(['ops_grep','ops_glob'].includes(exec.name)){
      recordSearch(s,exec,result,seq);
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
      features:{aggressiveMode:s.config.aggressiveMode,selfIndex:s.config.selfIndex,completionNotice:s.config.completionNotice,ptcPatterns:true,ptcFastpath:true,verifiedExec:true,fastEdit:s.config.fastEditEnabled,contextProtocol:s.config.contextProtocol,historyHygiene:s.config.historyHygiene,
      stateLedger:s.config.stateLedger,stateInform:s.config.stateInform,archiveReadRouting:s.config.archiveReadRouting,readArgumentRecovery:s.config.readArgumentRecovery,requestAccounting:s.config.requestAccounting,evidenceViews:s.config.evidenceViews,memberParsing:s.config.memberParsing,mavenSourceBinding:s.config.mavenSourceBinding,
      ledgerReceipt:s.config.ledgerReceipt,ledgerUnresolved:s.config.ledgerUnresolved,
      swLedger:s.config.swLedger,swEviction:s.config.swEviction,swEvictionSteps:s.config.swEvictionSteps,defaultResponseView:s.sessionDefaultResponseView??s.config.defaultResponseView,
      requestProjection:s.config.requestProjection,projectionRestore:s.config.projectionRestore,compressionControl:s.config.compressionControl,compactionTiming:s.config.compactionTiming,deferPressureCompaction:s.config.deferPressureCompaction,stubSummary:s.config.stubSummary,
      executionTriage:s.config.executionTriage,nativeProgramReuse:s.config.nativeProgramReuse,structuredCalls:s.config.structuredCalls,nativeReasoningReplay:s.config.nativeReasoningReplay,stageWorkingSet:s.config.stageWorkingSet,stepPacing:s.config.stepPacing,retainedCompute:s.config.retainedCompute,
      qualityReview:s.config.qualityReview,qualityReviewEffort:s.config.qualityReviewEffort,qualityReviewScope:s.config.qualityReviewScope},
    contextSettings:{requestProjection:s.config.requestProjection,projectionRestore:s.config.projectionRestore,compressionControl:s.config.compressionControl,compactionTiming:s.config.compactionTiming,deferPressureCompaction:s.config.deferPressureCompaction,stubSummary:s.config.stubSummary,
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
  return {get,init,isEnabled,currentSelection:effortSelection,clearSessionState,setSessionEnabled,setSessionMode,setWorkspaceMode,setAggressiveMode,setWorkspaceConfig,modeStatus,activeMode,beginRequest,sync,observe,save,loadJson,problem,snapshot,stateSnapshot,consumeStateNotice,recordMutation,recordReadObservation,
    setContextSnapshot:reader=>{runtimeContextSnapshot=reader;},
    receipt,execFor,withExecution,dispose:id=>states.delete(id)};
}
