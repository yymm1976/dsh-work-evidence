import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalUsage,messageTokens,textTokens,requestKindOf} from './context-economics.mjs';

const contentKey=message=>JSON.stringify({role:message.role,content:message.content,toolCallId:message.toolCallId,isError:message.isError});
const chars=messages=>messages.reduce((sum,message)=>sum+(message.content??[]).reduce((n,block)=>n+String(block.text??(block.type==='tool-call'?JSON.stringify(block.arguments??{}):'')).length,0),0);
const tokens=messages=>messages.reduce((sum,message)=>sum+messageTokens(message),0);
const FEATURES={historyOutput:'historyHygiene',receipt:'ledgerReceipt',evidenceView:'evidenceViews',contextPrune:'contextProtocol',swFold:'swEviction',projection:'requestProjection',restoration:'projectionRestore',state:'stateLedger',unresolved:'ledgerUnresolved',reuseAdvice:'executionTriage',cleanupAdvice:'executionTriage',stepPacing:'stepPacing',contextRecall:'contextProtocol',argumentRecovery:'readArgumentRecovery',archive:'archiveReadRouting',stage:'stageWorkingSet',automaticIndex:'selfIndex',index:null,candidate:null,patterns:null,fastpath:null,verifiedEdit:null,probe:'executionTriage',report:null,fastEdit:'fastEditEnabled'};
const unknownProjectionObservation=reason=>({status:'unknown',planSeq:null,planMessageId:null,resultSeqs:[],reason});
FEATURES.inlineExec=null;
FEATURES.inlineExecAdvice='executionTriage';
FEATURES.failureAdvice='executionTriage';
FEATURES.scriptReuseAdvice='executionTriage';
FEATURES.inlineScriptReuse=null;
FEATURES.nativeProgramReuse='nativeProgramReuse';
FEATURES.nativeProgramReference='nativeProgramReuse';
FEATURES.structuredCalls='structuredCalls';
FEATURES.nativeReasoningReplay='nativeReasoningReplay';
FEATURES.inlineArgumentRecovery=null;
FEATURES.retainedCompute='retainedCompute';
FEATURES.retainedComputeAdvice='retainedCompute';
FEATURES.finalJson='finalJsonGuard';
FEATURES.finalJsonResult='finalJsonResultGuard';
FEATURES.stubSummary='stubSummary';
FEATURES.deferPressureCompaction='deferPressureCompaction';
FEATURES.completionNotice='completionNotice';
FEATURES.stateInform='stateInform';
FEATURES.requestAccounting='requestAccounting';
FEATURES.swLedger='swLedger';
FEATURES.memberParsing='memberParsing';
FEATURES.mavenSourceBinding='mavenSourceBinding';
FEATURES.qualityReview='qualityReview';
FEATURES.compactionHandoff='compressionControl';
FEATURES.stageJudgment='stepPacing';
FEATURES.referenceContext='historyHygiene';
FEATURES.defaultResponseView='defaultResponseView';
FEATURES.toolSurface='toolSurface';
FEATURES.qualityReviewEffort='qualityReviewEffort';
FEATURES.qualityReviewScope='qualityReviewScope';
FEATURES.historyBlockDedup='historyHygiene';
FEATURES.contextBlockDedup='contextProtocol';
const PLUGIN_TOOLS=new Set(['project_evidence','work_report','work_status','work_state','work_recall','work_exec','work_compute','work_probe','evidence_index','candidate_select','ptc_patterns','ptc_fastpath','verified_exec','fastedit_java']);
const RETIRED_FEATURES=new Set(['programHistory','ledgerFold','foldPlan','reasoningHistory','executionAdvice','finishAdvice','presentationAdvice','nativeProgramReference']);
export const featureSetting=name=>FEATURES[name]??null;

/** Measures changes on the same task trajectory. Provider usage is never attributed by subtraction. */
export function createEffectObserver(ctx,runtime){
  const states=new Map();
  const nativeAttempts=new WeakMap();
  const storageFor=agent=>{const s=runtime.get(agent);return s.telemetryDir===undefined?s.dir:s.telemetryDir;};
  const get=agent=>{let state=states.get(agent.session.id);if(!state){state={features:Object.create(null),effects:new Map(),decisions:[],pendingDecisions:[],pendingOverflow:[],decisionSeq:0,overflowWriting:false,overflowQueue:Promise.resolve(),recentRequests:[],requests:0,mainRequests:0,auxiliaryRequests:0,compactionRequests:0,completeUsageRequests:0,missingUsage:0,unknownConsumption:0,reported:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0},rawReported:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0},totals:{directTokensEstimate:0,directChars:0,instructionTokensEstimate:0,systemTokensEstimate:0,messageTokensEstimate:0,toolSchemaTokensEstimate:0,requestReconstructionMisses:0},queue:Promise.resolve(),writeErrors:[],effectBytes:0,loaded:false,snippets:new Map(),needsLeadingNewline:new Set()};states.set(agent.session.id,state);}return state;};
  function feature(state,name){return state.features[name]??=( {decisions:0,applied:0,deferred:0,notApplicable:0,unavailable:0,failed:0,requestsAffected:0,directTokensEstimate:0,directChars:0,reasons:Object.create(null)} );}
  function decide(agent,name,status,reason,details={}){
    const state=get(agent),item=feature(state,name),at=new Date().toISOString(),step=runtime.get(agent).step,seq=++state.decisionSeq;
    item.decisions++;item[status==='not-applicable'?'notApplicable':status]=(item[status==='not-applicable'?'notApplicable':status]??0)+1;item.lastStatus=status;item.lastReason=reason;item.lastAt=at;item.lastStep=step;item.lastSeq=seq;item.reasons[reason]=(item.reasons[reason]??0)+1;
    const decision={id:randomUUID(),at,step,seq,feature:name,status,reason,...details};state.decisions.push(decision);state.pendingDecisions.push(decision);
    if(state.pendingDecisions.length>256){
      const overflow=state.pendingDecisions.splice(0,state.pendingDecisions.length-256);
      state.pendingOverflow.push(...overflow);
    }
    if(state.pendingOverflow.length)persistOverflow(state,agent);
    if(state.decisions.length>64)state.decisions.shift();runtime.get(agent).dirty=true;
  }
  function rewrite(agent,{feature:name,afterMessage,beforeMessages,seq=null,sourceSeqs=[],retainedSeqs=[]}){
    if(!afterMessage?.id||!Array.isArray(beforeMessages))return;
    const state=get(agent),key=contentKey(afterMessage),list=state.effects.get(afterMessage.id)??[];
    if(list.some(item=>item.key===key&&item.feature===name))return;
    const bytes=JSON.stringify(beforeMessages).length+key.length;
    if(bytes>2*1024*1024||state.effectBytes+bytes>16*1024*1024){decide(agent,name,'unavailable','attribution-memory-limit');return;}
    const effect={id:randomUUID(),key,feature:name,before:beforeMessages,seq,sourceSeqs,retainedSeqs,bytes};list.push(effect);state.effects.set(afterMessage.id,list);state.effectBytes+=bytes;
    queue(state,agent,{schema:'work-evidence.attribution.v1',messageId:afterMessage.id,...effect},'attribution');
  }
  function benefit(agent,name,beforeText,afterText){
    const saving=textTokens(beforeText)-textTokens(afterText);
    if(saving<8){decide(agent,name,'not-applicable','no-local-token-benefit',{tokensEstimate:saving});return false;}
    return true;
  }
  function queue(state,agent,row,kind='observability'){
    const dir=storageFor(agent);if(!dir){state.writeErrors.push('Observability storage outside the workspace is unavailable');state.writeErrors=state.writeErrors.slice(-8);return Promise.resolve(false);}
    if(!/^[-a-zA-Z0-9_][-.a-zA-Z0-9_]{0,127}$/.test(agent.session.id)){state.writeErrors.push('Invalid session ID for observability record');return Promise.resolve(false);}
    const file=path.join(dir,agent.session.id+'.'+kind+'.jsonl');
    // After a failed trailing-newline repair the file is known to end mid-line, so the next
    // append for that file starts with its own newline instead of merging two rows.
    state.queue=state.queue.catch(()=>{}).then(async()=>{await fs.mkdir(dir,{recursive:true});
      await fs.appendFile(file,(state.needsLeadingNewline.has(kind)?'\n':'')+JSON.stringify(row)+'\n','utf8');
      // Clear the marker only once a row actually landed: an append that failed wrote nothing,
      // so the file still ends mid-line and the following row must keep its own leading newline.
      state.needsLeadingNewline.delete(kind);return true;}).catch(error=>{state.writeErrors.push(String(error.message).slice(0,240));state.writeErrors=state.writeErrors.slice(-8);return false;});
    return state.queue;
  }
  function persistOverflow(state,agent){
    if(state.overflowWriting||!state.pendingOverflow.length)return;
    state.overflowWriting=true;
    state.overflowQueue=state.overflowQueue.catch(()=>{}).then(async()=>{
      let ok=true;
      while(ok&&state.pendingOverflow.length){
        const batch=state.pendingOverflow.slice();
        ok=await queue(state,agent,{schema:'work-evidence.pending-decisions.v1',sessionId:agent.session.id,
          at:new Date().toISOString(),step:runtime.get(agent).step,decisions:batch});
        if(ok){
          const ids=new Set(batch.map(item=>item.id));
          state.pendingOverflow=state.pendingOverflow.filter(item=>!ids.has(item.id));
        }
      }
      state.overflowWriting=false;
      return ok;
    }).catch(()=>{state.overflowWriting=false;return false;});
  }
  function begin(agent,options,{auxiliary=false,requestKind}={}){
    requestKind=requestKindOf({purpose:options.purpose,auxiliary,requestKind});
    const main=requestKind==='main',state=get(agent),byFeature={},used=new Set();let misses=0;
    const expand=(message,depth=0)=>{
      if(depth>16){misses++;return [message];}
      const list=state.effects.get(message.id),effect=list?.findLast(item=>item.key===contentKey(message)&&!used.has(item.id));
      if(effect){used.add(effect.id);const before=effect.before;const value=byFeature[effect.feature]??={tokensEstimate:0,chars:0,effects:0,sourceSeqs:[],retainedSeqs:[]};value.tokensEstimate+=tokens(before)-tokens([message]);value.chars+=chars(before)-chars([message]);value.effects++;value.sourceSeqs=[...new Set([...value.sourceSeqs,...(effect.sourceSeqs?.length?effect.sourceSeqs:Number.isSafeInteger(effect.seq)?[effect.seq]:[])])].slice(0,128);value.retainedSeqs=[...new Set([...value.retainedSeqs,...(effect.retainedSeqs??[])])].slice(0,128);return before.flatMap(item=>expand(item,depth+1));}
      const source=String(message.source?.kind??'');
      if(source.startsWith('work-evidence')&&source!=='work-evidence-working-set'){
        const kind=message.source?.taskFlow?.kind;
        const name=source==='work-evidence-final-json'?'finalJson':source==='work-evidence-quality-review'?'qualityReview':
          kind?({judgment:'stageJudgment',reuse:'reuseAdvice',cleanup:'cleanupAdvice',pacing:'stepPacing',compute:'retainedComputeAdvice',validation:'stepPacing',inlineExec:'inlineExecAdvice',diagnostic:'failureAdvice',scriptReuse:'scriptReuseAdvice',scriptSource:'scriptReuseAdvice'}[kind]??'guidance'):'guidance';
        const value=byFeature[name]??={tokensEstimate:0,chars:0,effects:0};value.tokensEstimate-=tokens([message]);value.chars-=chars([message]);value.effects++;return [];
      }
      return [message];
    };
    const reference=main?options.messages.flatMap(message=>expand(message)):options.messages;
    const delta=main?tokens(reference)-tokens(options.messages):0,charDelta=main?chars(reference)-chars(options.messages):0;
    const systemTokens=textTokens(typeof options.system==='string'?options.system:JSON.stringify(options.system??null)),messageTokensEstimate=tokens(options.messages);
    const instructionText=state.instructionText??'';
    const instructionPresent=instructionText&&(typeof options.system==='string'&&options.system.includes(instructionText)||
      options.messages.some(message=>message.role==='system'&&(message.content??[]).some(block=>block.type==='text'&&block.text.includes(instructionText))));
    const instruction=instructionPresent?textTokens(instructionText):0;
    const definitions=options.tools??[],withoutPlugin=definitions.filter(tool=>!PLUGIN_TOOLS.has(tool.name??tool.function?.name));
    const schemaOverhead=definitions.length===withoutPlugin.length?0:textTokens(JSON.stringify(definitions))-textTokens(JSON.stringify(withoutPlugin));
    const requestId=randomUUID(),native=main?nativeAttempts.get(agent):null;
    if(main&&runtime.get(agent).config.requestAccounting)decide(agent,'requestAccounting','applied','main-request-observation-started');
    let projectionObservation=unknownProjectionObservation(main?'projection-observer-unavailable':'non-main-request');
    if(main&&typeof runtime.observeRequestProjection==='function'){
      try{projectionObservation=runtime.observeRequestProjection(agent,options.messages)??projectionObservation;}
      catch{projectionObservation=unknownProjectionObservation('projection-observation-error');}
    }
    const nativeAttempt=native&&!native.requestId?{attemptId:native.attemptId,turn:native.turn,step:native.step}:null;
    if(nativeAttempt)native.requestId=requestId;
    return {schema:'work-evidence.request-effects.v1',sessionId:agent.session.id,requestId,nativeAttempt,at:new Date().toISOString(),provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort??null,requestKind,auxiliary:requestKind==='auxiliary',
      projectionObservation,
      usage:null,usageChunks:0,usageAggregation:'last-non-null-adapter-value-per-field',settled:false,failureCode:null,finishReason:null,
      toolSurface:runtime.get(agent).config.toolSurface??null,mode:runtime.modeStatus(agent),purpose:options.purpose??null,
      effects:{directTokensEstimate:delta-instruction-schemaOverhead,directChars:charDelta,instructionTokensEstimate:instruction,schemaTokensEstimate:schemaOverhead,
        systemTokensEstimate:systemTokens,messageTokensEstimate,byFeature,reconstructionMisses:misses,
        coverage:'Recorded body changes, recognizable guidance and top-level plugin schemas; host-generated PTC SDK/prelude overhead is not reconstructed',
        method:'same-trajectory message reconstruction; local text-density estimate; provider tokenization not observed',causalTaskSaving:false},
      localRequestTokensEstimate:tokens(options.messages)+textTokens(JSON.stringify({system:options.system??null,tools:options.tools??[]})),
      decisions:main?state.pendingDecisions.splice(0):[],sourceSeq:agent.session.seq,step:runtime.get(agent).step};
  }
  async function start(agent,row){
    row.startRecorded=await queue(get(agent),agent,{schema:'work-evidence.request-start.v1',sessionId:agent.session.id,
      requestId:row.requestId,at:row.at,sourceSeq:row.sourceSeq,requestKind:row.requestKind,purpose:row.purpose,
      provider:row.provider,model:row.model,reasoningEffort:row.reasoningEffort,nativeAttempt:row.nativeAttempt});
  }
  function normalizeRow(row){
    row.requestKind=requestKindOf(row);row.auxiliary=row.requestKind==='auxiliary';
    // Canonicalize only the raw adapter usage. A caller or a stored row that already carries
    // its source verdicts holds a detached result where a rejected adapter value became a
    // null; re-reading that null as an omission lets a matching reported total prove it zero.
    if(row.usageSources!==undefined)return row.usage;
    const canonical=canonicalUsage(row.usage);
    row.usage=canonical.usage;row.usageSources=canonical.sources;row.usageConsistent=canonical.consistent;row.usageComplete=canonical.complete;
    return canonical.usage;
  }
  // Rows reach accumulate already canonical. Normalizing a second time re-reads the
  // nulls written for a rejected adapter value as omissions, and a matching reported
  // total then turns them into proven zeros.
  function accumulate(state,row){
    const usage=row.usage,required=['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'];
    const missing=!usage||required.some(key=>!Number.isFinite(usage[key]));
    // A canonical or caller verdict already proved whether the disjoint fields are complete and
    // add up to the reported total: four finite parts with a total that does not match is not
    // complete consumption, so the verdict is kept and only rows without one fall back to the
    // local check. The verdict is never upgraded from an explicit false.
    const inconsistent=row.usageConsistent===false;
    row.usageComplete=!inconsistent&&!missing&&row.usageComplete!==false;
    row.unknownConsumption=!row.usageComplete||!row.settled||!['stop','tool-calls','max-tokens','length'].includes(row.finishReason);
    const kind=requestKindOf(row);state.requests++;if(kind==='auxiliary')state.auxiliaryRequests++;else if(kind==='compaction')state.compactionRequests++;else state.mainRequests++;
    if(!row.usageComplete)state.missingUsage++;if(row.unknownConsumption)state.unknownConsumption++;
    if(row.usageComplete)state.completeUsageRequests++;
    for(const key of Object.keys(state.reported))if(Number.isFinite(usage?.[key])){state.rawReported[key]+=usage[key];if(row.usageComplete)state.reported[key]+=usage[key];}
    if(kind==='main'){state.totals.directTokensEstimate+=row.effects.directTokensEstimate;state.totals.directChars+=row.effects.directChars;state.totals.instructionTokensEstimate+=row.effects.instructionTokensEstimate;
      state.totals.systemTokensEstimate+=row.effects.systemTokensEstimate??0;state.totals.messageTokensEstimate+=row.effects.messageTokensEstimate??0;
      state.totals.toolSchemaTokensEstimate+=row.effects.schemaTokensEstimate??0;state.totals.requestReconstructionMisses+=row.effects.reconstructionMisses;
      for(const [name,value]of Object.entries(row.effects.byFeature)){const item=feature(state,name);item.requestsAffected++;item.directTokensEstimate+=value.tokensEstimate;item.directChars+=value.chars;}}
    state.recentRequests.push(row);if(state.recentRequests.length>24)state.recentRequests.shift();
  }
  function restoredFeature(decision){
    const name=decision.feature,reason=String(decision.reason??'');
    if(name==='compactionHandoff'&&['deterministic-stub-summary','stub-not-smaller-than-span','historical-recall-not-exposed'].includes(reason))return 'stubSummary';
    if(name==='finalJson'&&(decision.kind==='observed-result-repair'||reason==='observed-result-repair-requested'))return 'finalJsonResult';
    return name;
  }
  function restoreDecision(state,decision,at,step){
    const name=restoredFeature(decision);
    if(typeof name!=='string'||!name||Object.hasOwn(Object.prototype,name))return;
    const value=feature(state,name),key=decision.status==='not-applicable'?'notApplicable':decision.status;
    const seq=Number.isSafeInteger(decision.seq)?decision.seq:++state.decisionSeq;
    state.decisionSeq=Math.max(state.decisionSeq,seq);
    value.decisions++;value[key]=(value[key]??0)+1;value.lastStatus=decision.status;value.lastReason=decision.reason;
    value.lastAt=decision.at??at;value.lastStep=decision.step??step;value.lastSeq=seq;value.reasons[decision.reason]=(value.reasons[decision.reason]??0)+1;
    state.decisions.push(name===decision.feature?decision:{...decision,feature:name});if(state.decisions.length>64)state.decisions.shift();
  }
  function finish(agent,row){const state=get(agent);normalizeRow(row);accumulate(state,row);queue(state,agent,row);runtime.get(agent).dirty=true;}
  async function load(agent){
    const state=get(agent);if(state.loaded)return;if(state.loading)return state.loading.catch(()=>{});
    const dir=storageFor(agent);if(!dir)return;
    state.loading=(async()=>{
      for(const kind of ['attribution','observability']){
        const file=path.join(dir,agent.session.id+'.'+kind+'.jsonl');let raw;
        try{
          try{await fs.access(file);}catch(error){
            if(error.code!=='ENOENT')throw error;
            const legacyDir=runtime.get(agent).dir;
            if(!legacyDir||legacyDir===dir)throw error;
            const legacy=path.join(legacyDir,agent.session.id+'.'+kind+'.jsonl');
            if((await fs.stat(legacy)).size>64*1024*1024)throw new Error('Legacy observability file exceeds 64 MiB load limit');
            await fs.mkdir(dir,{recursive:true});
            try{await fs.writeFile(file,await fs.readFile(legacy),{flag:'wx',mode:0o600});}catch(copyError){if(copyError.code!=='EEXIST')throw copyError;}
          }
          if((await fs.stat(file)).size>64*1024*1024)throw new Error('Observability file exceeds 64 MiB load limit');raw=await fs.readFile(file,'utf8');
        }catch(error){if(error.code!=='ENOENT')state.writeErrors.push('load: '+error.message);continue;}
        const seen=new Set(),decisionIds=new Set();for(const line of raw.split('\n').filter(Boolean))try{
          const item=JSON.parse(line);
          if(kind==='observability'&&!['work-evidence.request-effects.v1','work-evidence.pending-decisions.v1'].includes(item.schema))continue;
          if(item.sessionId!==undefined&&item.sessionId!==agent.session.id)throw new Error('Observability row belongs to another session');
          const id=kind==='observability'?item.requestId:item.id;if(id!==undefined){if(seen.has(id))continue;seen.add(id);}
          if(kind==='attribution'&&item.schema==='work-evidence.attribution.v1'&&typeof item.messageId==='string'&&Array.isArray(item.before)){
            if(state.effectBytes+(item.bytes??0)>16*1024*1024){state.writeErrors.push('attribution restore exceeds memory limit');break;}
            const list=state.effects.get(item.messageId)??[];if(!list.some(effect=>effect.id===item.id)){list.push(item);state.effects.set(item.messageId,list);state.effectBytes+=item.bytes??0;}
          }else if(kind==='observability'&&item.schema==='work-evidence.request-effects.v1'){
            // A persisted row keeps the verdicts stored with it; only rows written before
            // that field existed are canonicalized here, and only once.
            normalizeRow(item);
            accumulate(state,item);
            for(const decision of item.decisions??[])if(decision&&typeof decision.id==='string'&&!decisionIds.has(decision.id)){
              decisionIds.add(decision.id);restoreDecision(state,decision,item.at,item.step);
            }
          }else if(kind==='observability'&&item.schema==='work-evidence.pending-decisions.v1'&&Array.isArray(item.decisions)){
            // Decisions recorded after the last main request was assembled survive disposal
            // here; restoring by decision id keeps a resumed session from counting one twice.
            for(const decision of item.decisions)if(decision&&typeof decision.id==='string'&&typeof decision.feature==='string'&&
              typeof decision.status==='string'&&typeof decision.reason==='string'&&!decisionIds.has(decision.id)){
              decisionIds.add(decision.id);restoreDecision(state,decision,item.at,item.step);
            }
          }
        }catch(error){state.writeErrors.push('Unreadable '+kind+' row retained: '+error.message);}
        // Repairing a missing trailing newline keeps later appends one row per line. When
        // that write fails the restore itself already succeeded, so record the failure,
        // mark the next append self-terminating and do not re-read on every request.
        if(raw&&!raw.endsWith('\n')){try{await fs.appendFile(file,'\n','utf8');}
          catch(error){state.needsLeadingNewline.add(kind);state.writeErrors.push('newline repair: '+String(error.message??error).slice(0,200));}}
      }
    })().finally(()=>{state.writeErrors=state.writeErrors.slice(-8);state.loaded=true;});
    try{await state.loading;}
    catch(error){state.writeErrors.push('load: '+String(error.message??error).slice(0,200));}
    finally{state.loading=null;}
  }
  function snapshot(agent,options={}){const state=get(agent),config=runtime.get(agent).config,features={};for(const name of new Set([...Object.keys(FEATURES),...Object.keys(state.features)])){const base=state.features[name]??{decisions:0,applied:0};const setting=FEATURES[name],retired=RETIRED_FEATURES.has(name);features[name]={enabled:!retired&&runtime.isEnabled(agent)&&(setting?!!config[setting]:true),...(retired?{retired:true}:{}),...base,lastStatus:base.lastStatus??'not-observed',lastReason:base.lastReason??(base.decisions?'no-effect-applied':'no-opportunity-observed')};}
    const full={version:1,schema:'work-evidence.observability.v1',requests:{count:state.requests,main:state.mainRequests,compaction:state.compactionRequests,auxiliary:state.auxiliaryRequests,missingUsage:state.missingUsage,unknownConsumption:state.unknownConsumption,completeUsageRequests:state.completeUsageRequests,providerReported:{...state.reported},providerReportedRaw:{...state.rawReported}},
      totals:{...state.totals},features,recentRequests:state.recentRequests.slice(),decisions:state.decisions.slice(-24),
      persistence:{file:storageFor(agent)?path.join(storageFor(agent),agent.session.id+'.observability.jsonl'):null,writeErrors:state.writeErrors.slice(),scope:'session-local start/settlement records and native event links outside workspace discovery; no prompt bodies; survives rolling status window'},
      interpretation:'providerReported totals include only complete, internally consistent adapter counts; providerReportedRaw retains finite fields from all rows for diagnosis and does not establish complete consumption. Main, compaction and auxiliary requests are separate. Direct feature token deltas are local estimates on the same trajectory, including visible guidance overhead; they are not measured task savings. Unmapped or evicted attribution remains unavailable.'};
    if(options.detail!==false)return full;
    const summaryFeatures={};for(const [name,item]of Object.entries(features)){const {reasons,...summary}=item;summaryFeatures[name]=summary;}
    const {recentRequests,decisions,...summary}=full;
    const requestDiagnostics=recentRequests.filter(row=>row.failureCode!==null&&row.failureCode!==undefined||row.aborted||row.unknownConsumption||row.settled!==true||!['stop','tool-calls'].includes(row.finishReason)).map(row=>({
      requestId:row.requestId??null,sessionId:row.sessionId??null,sourceSeq:row.sourceSeq??null,requestKind:row.requestKind??null,provider:row.provider??null,model:row.model??null,
      settled:row.settled??null,finishReason:row.finishReason??null,failureCode:row.failureCode??null,aborted:row.aborted??null,usageComplete:row.usageComplete??null,unknownConsumption:row.unknownConsumption??null}));
    return {...summary,features:summaryFeatures,requestDiagnostics,view:'summary',details:{tool:'work_status',arguments:{detail:true},recentRequests:recentRequests.length,decisions:decisions.length,featureReasons:'detail-only'}};}
  function snippet(agent,{callIds,feature,beforeText,afterText}){const state=get(agent);for(const id of new Set(callIds.filter(Boolean))){const list=state.snippets.get(id)??[];list.push({feature,beforeText,afterText});state.snippets.set(id,list.slice(-8));}if(state.snippets.size>128)state.snippets.delete(state.snippets.keys().next().value);}
  const unsubscribe=ctx.on('session/event',(session,event)=>{
    if(event.type!=='tool/result'||event.surfaceOp?.op==='replace')return;const agent=ctx.agents?.get?.(session.id);if(!agent)return;const message=event.data?.message,state=get(agent),id=message?.source?.callId??message?.toolCallId,list=state.snippets.get(id);if(!list)return;state.snippets.delete(id);
    const after=(message.content??[]).filter(block=>block.type==='text').map(block=>block.text??'').join('\n');
    for(const name of new Set(list.map(item=>item.feature))){let before=after;for(const item of list.filter(item=>item.feature===name)){const offset=before.indexOf(item.afterText);if(offset<0||before.indexOf(item.afterText,offset+1)>=0)continue;before=before.slice(0,offset)+item.beforeText+before.slice(offset+item.afterText.length);}
      if(before!==after)rewrite(agent,{feature:name,seq:event.seq,afterMessage:message,beforeMessages:[{...message,content:[{type:'text',text:before}]}]});}
  });
  const unsubscribeStreams=ctx.on('agent/assistant-stream',({agent,frame})=>{
    if(!agent||!frame)return;
    if(frame.type==='start'){
      nativeAttempts.set(agent,{attemptId:frame.attemptId,turn:frame.turn,step:frame.step,requestId:null});return;
    }
    if(frame.type!=='end')return;
    const active=nativeAttempts.get(agent);
    if(!active||active.attemptId!==frame.attemptId)return;
    nativeAttempts.delete(agent);
    if(!active.requestId)return;
    queue(get(agent),agent,{schema:'work-evidence.request-link.v1',sessionId:agent.session.id,requestId:active.requestId,
      nativeAttempt:{attemptId:active.attemptId,turn:active.turn,step:active.step},at:new Date().toISOString(),
      outcome:frame.outcome?.kind??'unknown',eventType:frame.outcome?.eventType??null,sourceSeq:frame.outcome?.seq??null});
  });
  return {decide,rewrite,benefit,begin,start,finish,load,snippet,snapshot,instructions:(agent,text)=>{get(agent).instructionText=text;},flush:async agent=>{const state=get(agent);await state.overflowQueue;await state.queue;},
    async disposeAgent(agent){
      const state=get(agent);
      await state.overflowQueue;
      await state.queue;
      if(state.pendingOverflow.length){
        const decisions=state.pendingOverflow.slice();
        const ok=await queue(state,agent,{schema:'work-evidence.pending-decisions.v1',sessionId:agent.session.id,
          at:new Date().toISOString(),step:runtime.get(agent).step,decisions});
        if(ok){
          const ids=new Set(decisions.map(item=>item.id));
          state.pendingOverflow=state.pendingOverflow.filter(item=>!ids.has(item.id));
        }
      }
      // Decisions recorded after the last main request was assembled have no request row
      // to carry them. Persist them before the in-memory state is dropped.
      if(state.pendingDecisions.length){
        const decisions=state.pendingDecisions.splice(0);
        await queue(state,agent,{schema:'work-evidence.pending-decisions.v1',sessionId:agent.session.id,
          at:new Date().toISOString(),step:runtime.get(agent).step,decisions});
      }
      nativeAttempts.delete(agent);states.delete(agent.session.id);
    },async dispose(){
      for(const stop of [unsubscribe,unsubscribeStreams])if(typeof stop==='function')stop();
      await Promise.allSettled([...states.values()].map(async state=>{await state.overflowQueue;await state.queue;}));states.clear();}};
}
