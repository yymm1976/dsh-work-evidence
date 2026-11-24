import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonicalUsage,messageTokens,textTokens,requestKindOf} from './context-economics.mjs';

const contentKey=message=>JSON.stringify({role:message.role,content:message.content,toolCallId:message.toolCallId,isError:message.isError});
const chars=messages=>messages.reduce((sum,message)=>sum+(message.content??[]).reduce((n,block)=>n+String(block.text??(block.type==='tool-call'?JSON.stringify(block.arguments??{}):'')).length,0),0);
const tokens=messages=>messages.reduce((sum,message)=>sum+messageTokens(message),0);
const FEATURES={historyOutput:'historyHygiene',receipt:'ledgerReceipt',evidenceView:'evidenceViews',contextPrune:'contextProtocol',swFold:'swEviction',projection:'requestProjection',restoration:'projectionRestore',state:'stateLedger',unresolved:'ledgerUnresolved',reuseAdvice:'executionTriage',cleanupAdvice:'executionTriage',stepPacing:'stepPacing',contextRecall:'contextProtocol',argumentRecovery:'readArgumentRecovery',archive:'archiveReadRouting',stage:'stageWorkingSet',automaticIndex:'selfIndex',index:null,candidate:null,patterns:null,fastpath:null,verifiedEdit:null,probe:'executionTriage',report:null};
const unknownProjectionObservation=reason=>({status:'unknown',planSeq:null,planMessageId:null,resultSeqs:[],reason});
function decisionBatchRow(sessionId,decisions,step=0){
  const ids=decisions.map(item=>item?.id).filter(value=>typeof value==='string');
  const batchId=createHash('sha256').update(ids.join('\n')).digest('hex').slice(0,32);
  return {schema:'work-evidence.pending-decisions.v1',sessionId,batchId,
    at:decisions[0]?.at??new Date().toISOString(),step:decisions[0]?.step??step,decisions};
}
function stableRowIdentity(row,kind){
  const id=row?.requestId??row?.batchId??row?.id;
  if(typeof id!=='string'||!id)return null;
  return kind+':'+(row.schema??'')+':'+(row.requestId?'request':row.batchId?'batch':'record')+':'+id;
}
FEATURES.inlineExec=null;
FEATURES.inlineExecAdvice='executionTriage';
FEATURES.failureAdvice='executionTriage';
FEATURES.scriptReuseAdvice='executionTriage';
FEATURES.inlineScriptReuse=null;
FEATURES.nativeProgramReuse='nativeProgramReuse';
FEATURES.hostNodeFallback='hostNodeFallback';
FEATURES.nativeShellScriptReuse='nativeShellScriptReuse';
FEATURES.probeReplay='probeReplay';
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
FEATURES.historyTestOutput='historyHygiene';
FEATURES.contextBlockDedup='contextProtocol';
FEATURES.nativeVerifiedEdit='nativeVerifiedEdits';
FEATURES.fileProfile='fileProfiling';
FEATURES.structuredJson='structuredJson';
FEATURES.boundedPatch='boundedPatch';
const PLUGIN_TOOLS=new Set(['project_evidence','work_report','work_status','work_state','work_recall','work_exec','work_compute','work_probe','evidence_index','candidate_select','ptc_patterns','ptc_fastpath','verified_exec','file_profile','structured_json']);
const RETIRED_FEATURES=new Set(['programHistory','ledgerFold','foldPlan','reasoningHistory','executionAdvice','finishAdvice','presentationAdvice','nativeProgramReference','fastEdit']);
const NOTICE_FEATURES=new Map([
  ['work-evidence-completion','completionNotice'],
  ['work-evidence-ledger','unresolved'],
  ['work-evidence-quality-review','qualityReview'],
  ['work-evidence-state','stateInform'],
  ['work-evidence-source-outline','stepPacing'],
]);
export const featureSetting=name=>FEATURES[name]??null;

/** Measures changes on the same task trajectory. Provider usage is never attributed by subtraction. */
export function createEffectObserver(ctx,runtime,{io=fs}={}){
  const states=new Map();
  const nativeAttempts=new WeakMap();
  const storageFor=agent=>{const s=runtime.get(agent);return s.telemetryDir===undefined?s.dir:s.telemetryDir;};
  const get=agent=>{let state=states.get(agent.session.id);if(!state){state={agent,features:Object.create(null),effects:new Map(),decisions:[],pendingDecisions:[],pendingOverflow:[],decisionSeq:0,overflowWriting:false,overflowQueue:Promise.resolve(),pendingStartRows:[],pendingRequestRows:[],requestRowWriting:false,requestRowQueue:Promise.resolve(),pendingLinkRows:[],linkWriting:false,linkQueue:Promise.resolve(),finishQueue:Promise.resolve(),finishPending:0,finishFailed:false,ambiguousRows:new Map(),persistenceUnavailable:false,persistenceConflict:false,storageDir:null,recoveredRequestStarts:0,recoveredRequestLinks:0,unsettledRequestStarts:0,recentRequests:[],requests:0,mainRequests:0,auxiliaryRequests:0,compactionRequests:0,completeUsageRequests:0,missingUsage:0,unknownConsumption:0,reported:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0},rawReported:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0},totals:{directTokensEstimate:0,directChars:0,instructionTokensEstimate:0,systemTokensEstimate:0,messageTokensEstimate:0,toolSchemaTokensEstimate:0,requestReconstructionMisses:0},queue:Promise.resolve(),writeErrors:[],effectBytes:0,loaded:false,loadComplete:false,loadErrors:0,snippets:new Map(),needsLeadingNewline:new Set()};states.set(agent.session.id,state);}return state;};
  // Storage must survive a destroyed runtime: disposal keeps the telemetry directory on the
  // state so a later flush can still reach the records it has not written yet.
  const rememberStorage=(state,agent)=>{if(!state.storageDir){const value=storageFor(agent);if(value)state.storageDir=value;}return state.storageDir??null;};
  function feature(state,name){return state.features[name]??=( {decisions:0,applied:0,deferred:0,notApplicable:0,unavailable:0,failed:0,requestsAffected:0,directTokensEstimate:0,directChars:0,reasons:Object.create(null)} );}
  function decide(agent,name,status,reason,details={}){
    const state=get(agent),item=feature(state,name),at=new Date().toISOString(),step=runtime.get(agent).step,seq=++state.decisionSeq;
    item.decisions++;item[status==='not-applicable'?'notApplicable':status]=(item[status==='not-applicable'?'notApplicable':status]??0)+1;item.lastStatus=status;item.lastReason=reason;item.lastAt=at;item.lastStep=step;item.lastSeq=seq;item.reasons[reason]=(item.reasons[reason]??0)+1;
    // `details` is spread for the payload but must not overwrite the generated identity.
    // Callers pass `{seq,...}` where that `seq` names a SOURCE event — the prune path passes
    // the pruned result's sequence. With decisions about source events 100 and 20, the live
    // feature reported 20 as latest while a restored decision log picked 100, because the two
    // read the same field for different meanings. The source event travels in its own field.
    // `details` may carry its own `reason` — reviewOutcomes passes the review object, which
    // has one. Spreading it over the generated `reason` made the live feature count
    // "projection-outcome" while a restored log counted the review's reason, so the same
    // history produced two different tallies. The generated reason wins; the caller's is kept
    // under `detailReason` when both are present and differ.
    const {seq:sourceSeq=null,economics:decisionEconomics,reason:detailReason,...rest}=details;
    const decision={id:randomUUID(),at,step,seq,feature:name,status,reason,...rest,
      ...(sourceSeq===null?{}:{sourceSeq}),...(decisionEconomics===undefined?{}:{economics:decisionEconomics}),
      ...(detailReason===undefined||detailReason===reason?{}:{detailReason})};
    state.decisions.push(decision);state.pendingDecisions.push(decision);
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
  async function repairAppendBoundary(state,file,kind){
    state.lastRepairError=null;
    // appendFile is not transactional: a rejected append can leave a JSON prefix at EOF.
    // The next newline alone cannot repair that prefix, so retain complete rows and remove
    // only the unparseable tail before any later append. A complete unterminated row only
    // needs its newline; if that repair also fails, keep the conservative leading-newline
    // marker for the next attempt.
    state.needsLeadingNewline.add(kind);
    let raw;
    // A missing file has a clean boundary: the first append creates it.
    try{raw=await io.readFile(file);}catch(error){
      // A missing file has a clean boundary: the first append creates it, so the marker
      // this call set must be cleared or the next append reports a repair failure that
      // never happened and prepends a newline to an empty file.
      if(error?.code==='ENOENT'){state.needsLeadingNewline.delete(kind);return true;}
      state.lastRepairError=String(error?.code??error?.message??'unknown').slice(0,120);
      return false;
    }
    // truncate() takes a byte offset, so the last newline must be located in the
    // buffer: a string index is short whenever a retained row holds non-ASCII text.
    const boundary=raw.lastIndexOf(0x0a)+1,tail=raw.subarray(boundary).toString('utf8');
    if(!tail){state.needsLeadingNewline.delete(kind);return true;}
    // A complete row without its trailing newline is still data. If a partial append
    // follows it, retain the first complete JSON object and drop only the unparseable
    // remainder instead of truncating the row together with the fragment.
    let keep=null;
    try{JSON.parse(tail);keep=tail;}catch{}
    if(keep===null&&tail.startsWith('{')){
      let depth=0,inString=false,escape=false;
      for(let index=0;index<tail.length;index++){
        const character=tail[index];
        if(inString){
          if(escape)escape=false;
          else if(character==='\\')escape=true;
          else if(character==='"')inString=false;
        }else if(character==='"')inString=true;
        else if(character==='{')depth++;
        else if(character==='}'&&--depth===0){
          const candidate=tail.slice(0,index+1);
          try{JSON.parse(candidate);keep=candidate;}catch{}
          break;
        }
      }
    }
    try{
      if(keep!==null){
        const keepBytes=Buffer.byteLength(keep,'utf8');
        await io.truncate(file,boundary+keepBytes);
        await io.appendFile(file,'\n','utf8');
      }else await io.truncate(file,boundary);
      state.needsLeadingNewline.delete(kind);
      return true;
    }catch(error){
      // The reason travels with the failure: a read-only ledger fails with EPERM/EACCES and
      // an operator needs that code to tell a permission problem from a corrupt tail.
      state.lastRepairError=String(error?.code??error?.message??'unknown').slice(0,120);
      return false;
    }
  }
  async function inspectPersistedRow(file,row,serialized){
    let raw;
    try{raw=await io.readFile(file,'utf8');}
    catch(error){
      if(error?.code==='ENOENT')return {state:'absent',complete:true};
      return {state:'unreadable'};
    }
    const complete=raw.endsWith('\n');
    for(const line of raw.split('\n')){
      if(!line)continue;
      if(line===serialized)return {state:'exact',complete};
      if(!row.requestId&&!row.batchId&&!row.id)continue;
      try{
        const item=JSON.parse(line);
        const same=row.requestId?item.requestId===row.requestId
          :row.batchId?item.batchId===row.batchId
            :item.id===row.id;
        if(item.schema===row.schema&&same)return {state:'conflict'};
      }catch{}
    }
    return {state:complete?'absent':'unreadable'};
  }
  function staleIdentityConflict(state,row){
    state.persistenceConflict=true;
    state.writeErrors.push('Conflicting '+row.schema+' row retained for request '+(row.requestId??row.batchId??row.id)+'; the pending row was not dropped');
    state.writeErrors=state.writeErrors.slice(-8);
  }
  function queue(state,agent,row,kind='observability'){
    const dir=rememberStorage(state,agent);if(!dir){state.writeErrors.push('Observability storage outside the workspace is unavailable');state.writeErrors=state.writeErrors.slice(-8);return Promise.resolve(false);}
    if(!/^[-a-zA-Z0-9_][-.a-zA-Z0-9_]{0,127}$/.test(agent.session.id)){state.writeErrors.push('Invalid session ID for observability record');return Promise.resolve(false);}
    if(state.persistenceConflict){state.writeErrors.push('Observability persistence is stopped after a conflicting stable identity');state.writeErrors=state.writeErrors.slice(-8);return Promise.resolve(false);}
    const file=path.join(dir,agent.session.id+'.'+kind+'.jsonl');
    const serialized=JSON.stringify(row),identity=stableRowIdentity(row,kind);
    // Boundary inspection and repair stay in this same queue, so a later row cannot
    // overtake recovery and turn a partial append into a corrupt persistent ledger.
    state.queue=state.queue.catch(()=>{}).then(async()=>{await io.mkdir(dir,{recursive:true});
      // An append can publish a complete row and then reject. If its readback also
      // fails, a later retry must prove whether that row exists before appending it
      // again. Only this ambiguous case pays for a read; a normal append stays O(1).
      if(identity&&state.ambiguousRows.get(identity)===serialized){
        const observed=await inspectPersistedRow(file,row,serialized);
        if(observed.state==='exact'){
          if(!observed.complete&&!await repairAppendBoundary(state,file,kind)){
            state.ambiguousRows.set(identity,serialized);
            return false;
          }
          state.ambiguousRows.delete(identity);
          state.needsLeadingNewline.delete(kind);
          return true;
        }
        if(observed.state==='conflict'){staleIdentityConflict(state,row);return false;}
        if(observed.state==='unreadable'){
          await repairAppendBoundary(state,file,kind);
          return false;
        }
        state.ambiguousRows.delete(identity);
      }
      // A repair that failed last time left the boundary unknown. Retry it before
      // appending: if it still fails, appending would seal the fragment and destroy the
      // joined row, so the row stays pending instead.
      if(state.needsLeadingNewline.has(kind)){
        state.writeErrors.push('Boundary repair retry failed; the row stays pending');
        state.writeErrors=state.writeErrors.slice(-8);
        if(!await repairAppendBoundary(state,file,kind))return false;
      }
      await io.appendFile(file,(state.needsLeadingNewline.has(kind)?'\n':'')+serialized+'\n','utf8');
      if(identity)state.ambiguousRows.delete(identity);
      state.needsLeadingNewline.delete(kind);return true;}).catch(async error=>{
      state.writeErrors.push(String(error.message).slice(0,240));state.writeErrors=state.writeErrors.slice(-8);
      // appendFile may publish a complete row and still reject. Confirm that exact row
      // before any retry; a conflicting row with the same stable identity stops writes
      // instead of choosing one of two different records.
      const observed=await inspectPersistedRow(file,row,serialized);
      if(observed.state==='exact'){
        if(!observed.complete&&!await repairAppendBoundary(state,file,kind)){
          if(identity)state.ambiguousRows.set(identity,serialized);
          return false;
        }
        if(identity)state.ambiguousRows.delete(identity);
        state.needsLeadingNewline.delete(kind);
        return true;
      }
      if(observed.state==='conflict'){staleIdentityConflict(state,row);return false;}
      if(observed.state==='unreadable'&&identity)state.ambiguousRows.set(identity,serialized);
      // No exact row and no conflicting identity were proven. Repair only the
      // unparseable boundary; the new row remains pending until its own append.
      await repairAppendBoundary(state,file,kind);return false;});
    return state.queue;
  }
  function persistOverflow(state,agent){
    if(state.overflowWriting||!state.pendingOverflow.length)return;
    state.overflowWriting=true;
    state.overflowQueue=state.overflowQueue.catch(()=>{}).then(async()=>{
      let ok=true;
      while(ok&&state.pendingOverflow.length){
        const batch=state.pendingOverflow.slice();
        ok=await queue(state,agent,decisionBatchRow(agent.session.id,batch,runtime.get(agent).step));
        if(ok){
          const ids=new Set(batch.map(item=>item.id));
          state.pendingOverflow=state.pendingOverflow.filter(item=>!ids.has(item.id));
        }
      }
      state.overflowWriting=false;
      return ok;
    }).catch(()=>{state.overflowWriting=false;return false;});
  }
  function flushRequestRows(state,agent){
    if(state.requestRowWriting)return state.requestRowQueue;
    if(!state.pendingRequestRows.length)return Promise.resolve(true);
    state.requestRowWriting=true;
    state.requestRowQueue=state.requestRowQueue.catch(()=>{}).then(async()=>{
      let ok=true;
      while(state.pendingRequestRows.length){
        const row=state.pendingRequestRows[0];
        ok=await queue(state,agent,row);
        if(!ok)break;
        state.pendingRequestRows.shift();
        const carried=row.decisions??[];
        if(carried.length){
          const ids=new Set(carried.map(item=>item?.id));
          state.pendingDecisions=state.pendingDecisions.filter(item=>!ids.has(item?.id));
        }
      }
      state.requestRowWriting=false;
      if(!state.pendingRequestRows.length)state.finishFailed=false;
      return ok;
    }).catch(()=>{state.requestRowWriting=false;return false;});
    return state.requestRowQueue;
  }
  function flushLinkRows(state,agent){
    if(state.linkWriting)return state.linkQueue;
    if(!state.pendingLinkRows.length)return Promise.resolve(true);
    state.linkWriting=true;
    state.linkQueue=state.linkQueue.catch(()=>{}).then(async()=>{
      while(state.pendingLinkRows.length){
        const row=state.pendingLinkRows[0],ok=await queue(state,agent,row);
        if(!ok){state.linkWriting=false;return false;}
        state.pendingLinkRows.shift();
      }
      state.linkWriting=false;return true;
    }).catch(()=>{state.linkWriting=false;return false;});
    return state.linkQueue;
  }
  function begin(agent,options,{auxiliary=false,requestKind}={}){
    requestKind=requestKindOf({purpose:options.purpose,auxiliary,requestKind});
    const main=requestKind==='main',state=get(agent),byFeature={},used=new Set();let misses=0,delta=0,charDelta=0;
    const expand=(message,depth=0)=>{
      if(depth>16){misses++;return;}
      const list=state.effects.get(message.id),key=list?contentKey(message):null;
      const effect=list?.findLast(item=>item.key===key&&!used.has(item.id));
      if(effect){
        used.add(effect.id);
        const before=effect.before,value=byFeature[effect.feature]??={tokensEstimate:0,chars:0,effects:0,sourceSeqs:[],retainedSeqs:[]};
        const tokenChange=tokens(before)-messageTokens(message),charChange=chars(before)-chars([message]);
        value.tokensEstimate+=tokenChange;value.chars+=charChange;value.effects++;
        delta+=tokenChange;charDelta+=charChange;
        value.sourceSeqs=[...new Set([...value.sourceSeqs,...(effect.sourceSeqs?.length?effect.sourceSeqs:Number.isSafeInteger(effect.seq)?[effect.seq]:[])])].slice(0,128);
        value.retainedSeqs=[...new Set([...value.retainedSeqs,...(effect.retainedSeqs??[])])].slice(0,128);
        for(const item of before)expand(item,depth+1);
        return;
      }
      const source=String(message.source?.kind??'');
      if(source.startsWith('work-evidence')&&source!=='work-evidence-working-set'){
        const kind=message.source?.taskFlow?.kind;
        const name=source==='work-evidence-final-json'?(message.source?.finalJson?.kind==='observed-result-repair'?'finalJsonResult':'finalJson'):
          NOTICE_FEATURES.get(source)??(
          kind?({judgment:'stageJudgment',reuse:'reuseAdvice',cleanup:'cleanupAdvice',pacing:'stepPacing',compute:'retainedComputeAdvice',validation:'stepPacing',inlineExec:'inlineExecAdvice',diagnostic:'failureAdvice',scriptReuse:'scriptReuseAdvice',scriptSource:'scriptReuseAdvice'}[kind]??'guidance'):'guidance');
        const value=byFeature[name]??={tokensEstimate:0,chars:0,effects:0};
        const removedTokens=messageTokens(message),removedChars=chars([message]);
        value.tokensEstimate-=removedTokens;value.chars-=removedChars;value.effects++;
        delta-=removedTokens;charDelta-=removedChars;
      }
    };
    // Adding the changes along the attribution chain cancels every intermediate view.
    if(main)for(const message of options.messages)expand(message);
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
    // The decisions are copied, not taken: the row is only known to be persisted once
    // the append resolved, and a failed append must leave them available for the
    // cleanup flush instead of losing everything recorded for this request.
    const rowDecisions=main?state.pendingDecisions.slice():[];
    return {schema:'work-evidence.request-effects.v1',sessionId:agent.session.id,requestId,nativeAttempt,at:new Date().toISOString(),provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort??null,requestKind,auxiliary:requestKind==='auxiliary',
      projectionObservation,
      usage:null,usageChunks:0,usageAggregation:'last-non-null-adapter-value-per-field',settled:false,failureCode:null,finishReason:null,
      toolSurface:runtime.get(agent).config.toolSurface??null,mode:runtime.modeStatus(agent),purpose:options.purpose??null,
      effects:{directTokensEstimate:delta-instruction-schemaOverhead,directChars:charDelta,instructionTokensEstimate:instruction,schemaTokensEstimate:schemaOverhead,
        systemTokensEstimate:systemTokens,messageTokensEstimate,byFeature,reconstructionMisses:misses,
        coverage:'Recorded body changes, recognizable guidance and top-level plugin schemas; host-generated PTC SDK/prelude overhead is not reconstructed',
        method:'same-trajectory message reconstruction; local text-density estimate; provider tokenization not observed',causalTaskSaving:false},
      localRequestTokensEstimate:messageTokensEstimate+textTokens(JSON.stringify({system:options.system??null,tools:options.tools??[]})),
      decisions:rowDecisions,sourceSeq:agent.session.seq,step:runtime.get(agent).step};
  }
  async function start(agent,row,{strict=false}={}){
    const state=get(agent);
    if(!rememberStorage(state,agent)){
      row.startRecorded=false;
      row.startOutcome='storage-unavailable';
      state.persistenceUnavailable=true;
      state.writeErrors.push('request-start not persisted: session storage is unavailable');
      state.writeErrors=state.writeErrors.slice(-8);
      if(strict){
        const error=new Error('Effect ledger requires persistent storage in strict mode; the request was not dispatched.');
        error.code='EFFECT_PERSISTENCE_UNAVAILABLE';error.effectsDispatched=false;throw error;
      }
      return;
    }
    await state.finishQueue;
    await flushRequestRows(state,agent);
    await flushLinkRows(state,agent);
    for(const pending of state.pendingStartRows.slice()){
      if(!await queue(state,agent,pending))break;
      state.pendingStartRows=state.pendingStartRows.filter(item=>item!==pending);
    }
    if(state.pendingStartRows.length||state.pendingRequestRows.length||state.finishFailed){
      if(strict){
        const error=new Error('Effect ledger could not persist the preceding request record; the next request was not dispatched.');
        error.code='EFFECT_PERSISTENCE_UNAVAILABLE';error.effectsDispatched=false;throw error;
      }
      state.writeErrors.push('Preceding request rows remain pending; continuing with degraded observability');
      state.writeErrors=state.writeErrors.slice(-8);
    }
    const startRow={schema:'work-evidence.request-start.v1',sessionId:agent.session.id,
      requestId:row.requestId,at:row.at,sourceSeq:row.sourceSeq,requestKind:row.requestKind,purpose:row.purpose,
      provider:row.provider,model:row.model,reasoningEffort:row.reasoningEffort,nativeAttempt:row.nativeAttempt};
    startRow.dispatchState=row.dispatchState??'dispatch-intent';
    row.startRecorded=await queue(state,agent,startRow);
    if(!row.startRecorded){
      row.startOutcome='not-persisted';
      if(strict){
        const notDispatched={...startRow,dispatchState:'not-dispatched'};
        if(!state.pendingStartRows.some(item=>item.requestId===notDispatched.requestId))
          state.pendingStartRows.push(notDispatched);
        const error=new Error('Effect ledger could not persist the request-start record in strict mode; the request was not dispatched.');
        error.code='EFFECT_PERSISTENCE_UNAVAILABLE';error.effectsDispatched=false;throw error;
      }
      row.dispatchState='dispatch-intent-degraded';
      if(!state.pendingStartRows.some(item=>item.requestId===startRow.requestId))
        state.pendingStartRows.push({...startRow,dispatchState:row.dispatchState});
      state.writeErrors.push('Request-start record remains pending; the model request may still be dispatched in normal mode');
      state.writeErrors=state.writeErrors.slice(-8);
    }
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
    value.decisions++;value[key]=(value[key]??0)+1;value.reasons[decision.reason]=(value.reasons[decision.reason]??0)+1;
    // A retried overflow append can restore an older decision after newer rows were
    // written. The counters still accumulate, but the "last" fields describe the
    // newest decision, so they only move forward in sequence order.
    if(!Number.isSafeInteger(value.lastSeq)||seq>=value.lastSeq){
      value.lastStatus=decision.status;value.lastReason=decision.reason;
      value.lastAt=decision.at??at;value.lastStep=decision.step??step;value.lastSeq=seq;
    }
    // The rolling window is read in order, so insert before the first entry with a
    // larger seq rather than appending at the end.
    const restored=name===decision.feature?decision:{...decision,feature:name};
    const index=state.decisions.findIndex(item=>Number.isSafeInteger(item.seq)&&item.seq>seq);
    if(index<0)state.decisions.push(restored);else state.decisions.splice(index,0,restored);
    if(state.decisions.length>64)state.decisions.shift();
  }
  function finish(agent,row){
    const state=get(agent);normalizeRow(row);accumulate(state,row);
    if(!rememberStorage(state,agent)){
      state.persistenceUnavailable=true;
      state.writeErrors.push('request-effects not persisted: session storage is unavailable');
      state.writeErrors=state.writeErrors.slice(-8);
      state.pendingRequestRows.push(row);
      runtime.get(agent).dirty=true;
      return;
    }
    // The row carries a copy of the pending decisions, so they are only removed once
    // the append succeeded. A failed append keeps them for the cleanup flush and for a
    // later retry instead of dropping everything recorded for this request.
    const carried=row.decisions??[];
    state.finishPending++;
    state.finishQueue=state.finishQueue.catch(()=>{}).then(async()=>{
      await flushRequestRows(state,agent);
      let ok=false;
      try{ok=await queue(state,agent,row);}
      catch{ok=false;}
      state.finishFailed=!ok;
      if(ok&&carried.length){
        const ids=new Set(carried.map(item=>item?.id));
        state.pendingDecisions=state.pendingDecisions.filter(item=>!ids.has(item?.id));
      }
      if(!ok){
        state.pendingRequestRows.push(row);
        await flushRequestRows(state,agent);
      }
      return ok;
    }).finally(()=>{state.finishPending=Math.max(0,state.finishPending-1);});
    runtime.get(agent).dirty=true;
  }
  async function load(agent){
    const state=get(agent);if(state.loaded)return;if(state.loading)return state.loading.catch(()=>{});
    const dir=storageFor(agent);if(!dir)return;
    state.loadComplete=true;state.loadErrors=0;
    state.loading=(async()=>{
      const startedRequests=new Set(),settledRequests=new Set(),startStates=new Map();
      for(const kind of ['attribution','observability']){
        const file=path.join(dir,agent.session.id+'.'+kind+'.jsonl');let raw;
        try{
          try{await io.access(file);}catch(error){
            if(error.code!=='ENOENT')throw error;
            const legacyDir=runtime.get(agent).dir;
            if(!legacyDir||legacyDir===dir)throw error;
            const legacy=path.join(legacyDir,agent.session.id+'.'+kind+'.jsonl');
            if((await io.stat(legacy)).size>64*1024*1024)throw new Error('Legacy observability file exceeds 64 MiB load limit');
            await io.mkdir(dir,{recursive:true});
            try{await io.writeFile(file,await io.readFile(legacy),{flag:'wx',mode:0o600});}catch(copyError){if(copyError.code!=='EEXIST')throw copyError;}
          }
          if((await io.stat(file)).size>64*1024*1024)throw new Error('Observability file exceeds 64 MiB load limit');raw=await io.readFile(file,'utf8');
        }catch(error){
          if(error.code!=='ENOENT'){
            state.loadErrors++;state.loadComplete=false;
            state.writeErrors.push('load: '+String(error.message??error).slice(0,200));
          }
          continue;
        }
        if(raw&&!raw.endsWith('\n')){try{
          const repaired=await repairAppendBoundary(state,file,kind);
          if(repaired)raw=await io.readFile(file,'utf8');
          else{state.needsLeadingNewline.add(kind);state.writeErrors.push('newline repair: '+(state.lastRepairError??'boundary not repairable'));}
        }catch(error){state.needsLeadingNewline.add(kind);state.writeErrors.push('newline repair: '+String(error.message??error).slice(0,200));}}
        const seen=new Set(),seenRows=new Map(),decisionIds=new Set();
        let corruptLines=0;
        for(const line of raw.split('\n').filter(Boolean))try{
          const item=JSON.parse(line);
          if(kind==='observability'&&!['work-evidence.request-start.v1','work-evidence.request-effects.v1',
            'work-evidence.request-link.v1','work-evidence.pending-decisions.v1'].includes(item.schema))continue;
          if(item.sessionId!==undefined&&item.sessionId!==agent.session.id)throw new Error('Observability row belongs to another session');
          const id=kind==='observability'
            ? item.schema==='work-evidence.pending-decisions.v1'?undefined:`${item.schema}:${item.requestId??item.at??''}`
            : item.id;
          if(kind==='observability'&&id!==undefined){
            const prior=seenRows.get(id);
            if(prior!==undefined){
              if(prior!==line){state.persistenceConflict=true;state.writeErrors.push('Conflicting persistent row retained: '+id);}
              continue;
            }
            seenRows.set(id,line);
          }else if(id!==undefined){if(seen.has(id))continue;seen.add(id);}
          if(kind==='attribution'&&item.schema==='work-evidence.attribution.v1'&&typeof item.messageId==='string'&&Array.isArray(item.before)){
            if(state.effectBytes+(item.bytes??0)>16*1024*1024){state.writeErrors.push('attribution restore exceeds memory limit');break;}
            const list=state.effects.get(item.messageId)??[];if(!list.some(effect=>effect.id===item.id)){list.push(item);state.effects.set(item.messageId,list);state.effectBytes+=item.bytes??0;}
          }else if(kind==='observability'&&item.schema==='work-evidence.request-start.v1'&&typeof item.requestId==='string'){
            startedRequests.add(item.requestId);startStates.set(item.requestId,item.dispatchState??'dispatch-intent');state.recoveredRequestStarts++;
          }else if(kind==='observability'&&item.schema==='work-evidence.request-link.v1'&&typeof item.requestId==='string'){
            state.recoveredRequestLinks++;
          }else if(kind==='observability'&&item.schema==='work-evidence.request-effects.v1'){
            // A persisted row keeps the verdicts stored with it; only rows written before
            // that field existed are canonicalized here, and only once.
            normalizeRow(item);
            accumulate(state,item);
            if(typeof item.requestId==='string')settledRequests.add(item.requestId);
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
        }catch(error){corruptLines++;state.loadErrors++;state.loadComplete=false;
          state.writeErrors.push('Unreadable '+kind+' row retained: '+String(error.message??error).slice(0,200));}
      }
      state.unsettledRequestStarts=[...startedRequests].filter(requestId=>
        !settledRequests.has(requestId)&&startStates.get(requestId)!=='not-dispatched').length;
    })().catch(error=>{state.loadComplete=false;state.loadErrors++;state.writeErrors.push('load: '+String(error.message??error).slice(0,200));})
      .finally(()=>{state.writeErrors=state.writeErrors.slice(-8);state.loaded=true;});
    try{await state.loading;}
    catch(error){state.writeErrors.push('load: '+String(error.message??error).slice(0,200));}
    finally{state.loading=null;}
  }
  function snapshot(agent,options={}){const state=get(agent),config=runtime.get(agent).config,features={};for(const name of new Set([...Object.keys(FEATURES),...Object.keys(state.features)])){const base=state.features[name]??{decisions:0,applied:0};const setting=FEATURES[name],retired=RETIRED_FEATURES.has(name);features[name]={enabled:!retired&&runtime.isEnabled(agent)&&(setting?!!config[setting]:true),...(retired?{retired:true}:{}),...base,lastStatus:base.lastStatus??'not-observed',lastReason:base.lastReason??(base.decisions?'no-effect-applied':'no-opportunity-observed')};}
    // Direct savings are negative deltas (a rewrite removed text), while the
    // injected guidance and tool schemas are positive costs. Report both sides and
    // the ratio, so "did this plugin pay for itself" is answerable from one row
    // instead of requiring a manual subtraction across three counters.
    // Integer-only arithmetic and a rounded integer ratio keep this payload
    // lossless JSON; a raw division produced a value the host rejected.
    // begin() stores directTokensEstimate as delta - instruction - schemaOverhead,
    // i.e. the saving with both overheads already subtracted. Recover the gross
    // saving by adding the overhead back; negating would report a net cost as if it
    // were a saving, and with schema-only changes the two would cancel to zero.
    const spentTokens=Math.round((state.totals.instructionTokensEstimate||0)+(state.totals.toolSchemaTokensEstimate||0));
    // A zero total must stay a plain zero: the host rejects -0 as non-lossless JSON.
    const plain=value=>value===0?0:value;
    const savedTokens=plain(Math.round((state.totals.directTokensEstimate||0)+spentTokens));
    const balance={savedTokensEstimate:savedTokens,spentTokensEstimate:spentTokens,
      netTokensEstimate:plain(savedTokens-spentTokens),
      ...(spentTokens>0?{ratioPercent:plain(Math.round((savedTokens*100)/spentTokens))}:{}),
      scope:'local same-trajectory text estimate; savedTokensEstimate is gross of the overheads listed in spentTokensEstimate; not a provider billing measurement'};
    const full={version:1,schema:'work-evidence.observability.v1',requests:{count:state.requests,main:state.mainRequests,compaction:state.compactionRequests,auxiliary:state.auxiliaryRequests,missingUsage:state.missingUsage,unknownConsumption:state.unknownConsumption,completeUsageRequests:state.completeUsageRequests,providerReported:{...state.reported},providerReportedRaw:{...state.rawReported}},
      totals:{...state.totals,balance},features,recentRequests:state.recentRequests.slice(),decisions:state.decisions.slice(-24),
      persistence:{file:rememberStorage(state,agent)?path.join(rememberStorage(state,agent),agent.session.id+'.observability.jsonl'):null,writeErrors:state.writeErrors.slice(),
        pendingStartRows:state.pendingStartRows.length,pendingRequestRows:state.pendingRequestRows.length,pendingLinkRows:state.pendingLinkRows.length,
        pendingDecisions:state.pendingDecisions.length,pendingOverflow:state.pendingOverflow.length,finishPending:state.finishPending,finishFailed:state.finishFailed,
        storageAvailable:!!rememberStorage(state,agent),persistenceUnavailable:state.persistenceUnavailable,persistenceConflict:state.persistenceConflict,
        recoveredRequestStarts:state.recoveredRequestStarts,recoveredRequestLinks:state.recoveredRequestLinks,unsettledRequestStarts:state.unsettledRequestStarts,
        queueEmpty:state.pendingStartRows.length===0&&state.pendingRequestRows.length===0&&state.pendingLinkRows.length===0&&
          state.pendingDecisions.length===0&&state.pendingOverflow.length===0&&!state.finishFailed&&state.finishPending===0,
        historyLoaded:state.loaded,historyComplete:state.loadComplete,readCoverage:state.loaded?(state.loadComplete?'complete':'partial'):'unread',
        consumptionComplete:state.unknownConsumption===0&&state.missingUsage===0,
        complete:state.loaded&&state.loadComplete&&state.pendingStartRows.length===0&&state.pendingRequestRows.length===0&&state.pendingLinkRows.length===0&&
          state.pendingDecisions.length===0&&state.pendingOverflow.length===0&&!state.finishFailed&&state.finishPending===0&&
          !state.persistenceUnavailable&&!state.persistenceConflict&&state.unsettledRequestStarts===0,
        scope:'session-local start/settlement records and native event links outside workspace discovery; no prompt bodies; survives rolling status window'},
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
    const state=get(agent),row={schema:'work-evidence.request-link.v1',sessionId:agent.session.id,requestId:active.requestId,
      nativeAttempt:{attemptId:active.attemptId,turn:active.turn,step:active.step},at:new Date().toISOString(),
      outcome:frame.outcome?.kind??'unknown',eventType:frame.outcome?.eventType??null,sourceSeq:frame.outcome?.seq??null};
    state.pendingLinkRows.push(row);flushLinkRows(state,agent);
  });
  async function flushAll(state,agent){
    let result=null,previousRemaining=Infinity;
    for(let attempt=0;attempt<3;attempt++){
      await state.finishQueue.catch(()=>{});await state.overflowQueue.catch(()=>{});await state.queue.catch(()=>{});
      if(state.pendingOverflow.length){persistOverflow(state,agent);await state.overflowQueue.catch(()=>{});}
      await flushRequestRows(state,agent);await flushLinkRows(state,agent);
      for(const pending of state.pendingStartRows.slice()){
        if(!await queue(state,agent,pending))break;
        state.pendingStartRows=state.pendingStartRows.filter(item=>item!==pending);
      }
      if(state.pendingDecisions.length){
        const decisions=state.pendingDecisions.slice();
        const written=await queue(state,agent,decisionBatchRow(agent.session.id,decisions,runtime.get(agent).step));
        if(written){
          const ids=new Set(decisions.map(item=>item?.id));
          state.pendingDecisions=state.pendingDecisions.filter(item=>!ids.has(item?.id));
        }
      }
      const pending={pendingStartRows:state.pendingStartRows.length,pendingRequestRows:state.pendingRequestRows.length,
        pendingLinkRows:state.pendingLinkRows.length,pendingDecisions:state.pendingDecisions.length,pendingOverflow:state.pendingOverflow.length,
        finishPending:state.finishPending,finishFailed:state.finishFailed,persistenceUnavailable:state.persistenceUnavailable,persistenceConflict:state.persistenceConflict,
        unsettledRequestStarts:state.unsettledRequestStarts};
      const complete=!state.pendingStartRows.length&&!state.pendingRequestRows.length&&!state.pendingLinkRows.length&&
        !state.pendingOverflow.length&&!state.pendingDecisions.length&&!state.finishPending&&!state.finishFailed&&
        !state.persistenceUnavailable&&!state.persistenceConflict&&state.unsettledRequestStarts===0;
      result={complete,...pending,historyComplete:state.loadComplete,readCoverage:state.loaded?(state.loadComplete?'complete':'partial'):'unread'};
      if(complete)return result;
      const remaining=pending.pendingStartRows+pending.pendingRequestRows+pending.pendingLinkRows+
        pending.pendingDecisions+pending.pendingOverflow+pending.finishPending+(pending.finishFailed?1:0);
      if(attempt>0&&remaining>=previousRemaining)break;
      previousRemaining=remaining;
    }
    return result;
  }
  return {decide,rewrite,benefit,begin,start,finish,load,snippet,snapshot,instructions:(agent,text)=>{get(agent).instructionText=text;},flush:async agent=>flushAll(get(agent),agent),
    async disposeAgent(agent){
      const state=get(agent);
      const flushed=await flushAll(state,agent);
      if(!flushed.complete)return {status:state.persistenceConflict||!rememberStorage(state,agent)?'unrecoverable':'pending',...flushed};
      nativeAttempts.delete(agent);states.delete(agent.session.id);
      return {status:'disposed',...flushed};
    },async dispose(){
      for(const stop of [unsubscribe,unsubscribeStreams])if(typeof stop==='function')stop();
      const results=await Promise.allSettled([...states.entries()].map(async([id,state])=>{
        const flushed=await flushAll(state,state.agent);
        return {id,...flushed};
      }));
      const remaining=[...states.entries()].filter(([,state])=>state.pendingOverflow.length||state.pendingDecisions.length||
        state.pendingStartRows.length||state.pendingRequestRows.length||state.pendingLinkRows.length||state.finishFailed||
        state.finishPending||state.persistenceUnavailable||state.persistenceConflict||state.unsettledRequestStarts>0);
      if(!remaining.length)states.clear();
      const unrecoverable=remaining.some(([,state])=>state.persistenceConflict||!rememberStorage(state,state.agent));
      return {status:unrecoverable?'unrecoverable':remaining.length?'pending':'disposed',
        states:results.map(result=>result.status==='fulfilled'?result.value:{status:'failed',error:String(result.reason?.message??result.reason)})};
    }};
}
