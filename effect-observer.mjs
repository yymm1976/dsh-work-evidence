import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalUsage,messageTokens,textTokens} from './context-economics.mjs';

const contentKey=message=>JSON.stringify({role:message.role,content:message.content,toolCallId:message.toolCallId,isError:message.isError});
const chars=messages=>messages.reduce((sum,message)=>sum+(message.content??[]).reduce((n,block)=>n+String(block.text??(block.type==='tool-call'?JSON.stringify(block.arguments??{}):'')).length,0),0);
const tokens=messages=>messages.reduce((sum,message)=>sum+messageTokens(message),0);
const FEATURES={programHistory:'historyHygiene',historyOutput:'historyHygiene',receipt:'ledgerReceipt',evidenceView:'evidenceViews',contextPrune:'contextProtocol',ledgerFold:'ledgerFoldWrite',swFold:'swEviction',projection:'requestProjection',restoration:'projectionRestore',state:'stateLedger',unresolved:'ledgerUnresolved',executionAdvice:'executionAdvice',reuseAdvice:'executionTriage',cleanupAdvice:'executionTriage',finishAdvice:'finishAdvice',presentationAdvice:'finishAdvice',stepPacing:'stepPacing',contextRecall:'contextProtocol',argumentRecovery:'readArgumentRecovery',archive:'archiveReadRouting',stage:'stageWorkingSet',automaticIndex:'selfIndex',index:null,candidate:null,patterns:null,fastpath:null,verifiedEdit:null,probe:'executionTriage',report:null,fastEdit:'fastEditEnabled',nativeReadView:'nativeReadView',nativeExecutionEvidence:'nativeExecutionEvidence'};
FEATURES.reasoningHistory='reasoningHistory';
FEATURES.programHistory='programHistory';
FEATURES.inlineExec=null;
FEATURES.inlineExecAdvice='executionTriage';
FEATURES.failureAdvice='executionTriage';
FEATURES.scriptReuseAdvice='executionTriage';
FEATURES.inlineScriptReuse=null;
FEATURES.inlineArgumentRecovery=null;
FEATURES.retainedCompute='retainedCompute';
FEATURES.retainedComputeAdvice='retainedCompute';
FEATURES.taskEffort='taskEffort';
FEATURES.finalJson='finalJsonGuard';
FEATURES.qualityReview='qualityReview';
FEATURES.compactionHandoff='compressionControl';
FEATURES.compactionTiming='compactionTiming';
FEATURES.stageJudgment='stepPacing';
const PLUGIN_TOOLS=new Set(['project_evidence','work_report','work_status','work_state','work_recall','work_exec','work_compute','work_probe','evidence_index','candidate_select','ptc_patterns','ptc_fastpath','verified_exec','fastedit_java']);

/** Measures changes on the same task trajectory. Provider usage is never attributed by subtraction. */
export function createEffectObserver(ctx,runtime){
  const states=new Map();
  const storageFor=agent=>{const s=runtime.get(agent);return s.telemetryDir===undefined?s.dir:s.telemetryDir;};
  const get=agent=>{let state=states.get(agent.session.id);if(!state){state={features:{},effects:new Map(),decisions:[],pendingDecisions:[],recentRequests:[],requests:0,mainRequests:0,auxiliaryRequests:0,missingUsage:0,unknownConsumption:0,reported:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0},totals:{directTokensEstimate:0,directChars:0,instructionTokensEstimate:0,systemTokensEstimate:0,messageTokensEstimate:0,toolSchemaTokensEstimate:0,requestReconstructionMisses:0},queue:Promise.resolve(),writeErrors:[],effectBytes:0,loaded:false,snippets:new Map()};states.set(agent.session.id,state);}return state;};
  function feature(state,name){return state.features[name]??=( {decisions:0,applied:0,deferred:0,notApplicable:0,unavailable:0,failed:0,requestsAffected:0,directTokensEstimate:0,directChars:0,reasons:{}} );}
  function decide(agent,name,status,reason,details={}){
    const state=get(agent),item=feature(state,name);item.decisions++;item[status==='not-applicable'?'notApplicable':status]=(item[status==='not-applicable'?'notApplicable':status]??0)+1;item.lastStatus=status;item.lastReason=reason;item.reasons[reason]=(item.reasons[reason]??0)+1;
    const decision={id:randomUUID(),at:new Date().toISOString(),step:runtime.get(agent).step,feature:name,status,reason,...details};state.decisions.push(decision);state.pendingDecisions.push(decision);if(state.pendingDecisions.length>256)state.pendingDecisions.shift();if(state.decisions.length>64)state.decisions.shift();runtime.get(agent).dirty=true;
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
    const dir=storageFor(agent);if(!dir){state.writeErrors.push('Observability storage outside the workspace is unavailable');state.writeErrors=state.writeErrors.slice(-8);return;}
    if(!/^[-a-zA-Z0-9_][-.a-zA-Z0-9_]{0,127}$/.test(agent.session.id)){state.writeErrors.push('Invalid session ID for observability record');return;}
    const file=path.join(dir,agent.session.id+'.'+kind+'.jsonl');
    state.queue=state.queue.catch(()=>{}).then(async()=>{await fs.mkdir(dir,{recursive:true});await fs.appendFile(file,JSON.stringify(row)+'\n','utf8');}).catch(error=>{state.writeErrors.push(String(error.message).slice(0,240));state.writeErrors=state.writeErrors.slice(-8);});
  }
  function begin(agent,options,{auxiliary=false}={}){
    const state=get(agent),byFeature={},used=new Set();let misses=0;
    const expand=(message,depth=0)=>{
      if(depth>16){misses++;return [message];}
      const list=state.effects.get(message.id),effect=list?.findLast(item=>item.key===contentKey(message)&&!used.has(item.id));
      if(effect){used.add(effect.id);const before=effect.before;const value=byFeature[effect.feature]??={tokensEstimate:0,chars:0,effects:0,sourceSeqs:[],retainedSeqs:[]};value.tokensEstimate+=tokens(before)-tokens([message]);value.chars+=chars(before)-chars([message]);value.effects++;value.sourceSeqs=[...new Set([...value.sourceSeqs,...(effect.sourceSeqs?.length?effect.sourceSeqs:Number.isSafeInteger(effect.seq)?[effect.seq]:[])])].slice(0,128);value.retainedSeqs=[...new Set([...value.retainedSeqs,...(effect.retainedSeqs??[])])].slice(0,128);return before.flatMap(item=>expand(item,depth+1));}
      const source=String(message.source?.kind??'');
      if(source.startsWith('work-evidence')&&source!=='work-evidence-working-set'){
        const kind=message.source?.taskFlow?.kind;
        const name=source==='work-evidence-final-json'?'finalJson':source==='work-evidence-quality-review'?'qualityReview':
          kind?({judgment:'stageJudgment',execution:'executionAdvice',reuse:'reuseAdvice',cleanup:'cleanupAdvice',finish:'finishAdvice',presentation:'presentationAdvice',pacing:'stepPacing',compute:'retainedComputeAdvice',validation:'stepPacing',inlineExec:'inlineExecAdvice',diagnostic:'failureAdvice',scriptReuse:'scriptReuseAdvice'}[kind]??'guidance'):'guidance';
        const value=byFeature[name]??={tokensEstimate:0,chars:0,effects:0};value.tokensEstimate-=tokens([message]);value.chars-=chars([message]);value.effects++;return [];
      }
      return [message];
    };
    const reference=auxiliary?options.messages:options.messages.flatMap(message=>expand(message));
    const delta=auxiliary?0:tokens(reference)-tokens(options.messages),charDelta=auxiliary?0:chars(reference)-chars(options.messages);
    const systemTokens=textTokens(typeof options.system==='string'?options.system:JSON.stringify(options.system??null)),messageTokensEstimate=tokens(options.messages);
    const instructionText=state.instructionText??'';
    const instructionPresent=instructionText&&(typeof options.system==='string'&&options.system.includes(instructionText)||
      options.messages.some(message=>message.role==='system'&&(message.content??[]).some(block=>block.type==='text'&&block.text.includes(instructionText))));
    const instruction=instructionPresent?textTokens(instructionText):0;
    const definitions=options.tools??[],withoutPlugin=definitions.filter(tool=>!PLUGIN_TOOLS.has(tool.name??tool.function?.name));
    const schemaOverhead=definitions.length===withoutPlugin.length?0:textTokens(JSON.stringify(definitions))-textTokens(JSON.stringify(withoutPlugin));
    return {schema:'work-evidence.request-effects.v1',requestId:randomUUID(),at:new Date().toISOString(),provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort??null,auxiliary,
      usage:null,usageChunks:0,usageAggregation:'last-non-null-adapter-value-per-field',settled:false,failureCode:null,finishReason:null,
      toolSurface:runtime.get(agent).config.toolSurface??null,mode:runtime.modeStatus(agent),purpose:options.purpose??null,
      effects:{directTokensEstimate:delta-instruction-schemaOverhead,directChars:charDelta,instructionTokensEstimate:instruction,schemaTokensEstimate:schemaOverhead,
        systemTokensEstimate:systemTokens,messageTokensEstimate,byFeature,reconstructionMisses:misses,
        coverage:'Recorded body changes, recognizable guidance and top-level plugin schemas; host-generated PTC SDK/prelude overhead is not reconstructed',
        method:'same-trajectory message reconstruction; local text-density estimate; provider tokenization not observed',causalTaskSaving:false},
      localRequestTokensEstimate:tokens(options.messages)+textTokens(JSON.stringify({system:options.system??null,tools:options.tools??[]})),
      decisions:auxiliary?[]:state.pendingDecisions.splice(0),sourceSeq:agent.session.seq,step:runtime.get(agent).step};
  }
  function normalizeRow(row){
    const canonical=canonicalUsage(row.usage);
    row.usage=canonical.usage;row.usageSources=canonical.sources;row.usageConsistent=canonical.consistent;row.usageComplete=canonical.complete;
    return canonical.usage;
  }
  function accumulate(state,row){
    const usage=normalizeRow(row),required=['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'];
    const missing=!usage||required.some(key=>!Number.isFinite(usage[key]));
    row.usageComplete=!missing;row.unknownConsumption=missing||!row.settled||!['stop','tool-calls','max-tokens','length'].includes(row.finishReason);
    state.requests++;if(row.auxiliary)state.auxiliaryRequests++;else state.mainRequests++;
    if(missing)state.missingUsage++;if(row.unknownConsumption)state.unknownConsumption++;
    for(const key of Object.keys(state.reported))if(Number.isFinite(usage?.[key]))state.reported[key]+=usage[key];
    if(!row.auxiliary){state.totals.directTokensEstimate+=row.effects.directTokensEstimate;state.totals.directChars+=row.effects.directChars;state.totals.instructionTokensEstimate+=row.effects.instructionTokensEstimate;
      state.totals.systemTokensEstimate+=row.effects.systemTokensEstimate??0;state.totals.messageTokensEstimate+=row.effects.messageTokensEstimate??0;
      state.totals.toolSchemaTokensEstimate+=row.effects.schemaTokensEstimate??0;state.totals.requestReconstructionMisses+=row.effects.reconstructionMisses;
      for(const [name,value]of Object.entries(row.effects.byFeature)){const item=feature(state,name);item.requestsAffected++;item.directTokensEstimate+=value.tokensEstimate;item.directChars+=value.chars;}}
    state.recentRequests.push(row);if(state.recentRequests.length>24)state.recentRequests.shift();
  }
  function finish(agent,row){const state=get(agent);normalizeRow(row);accumulate(state,row);queue(state,agent,row);runtime.get(agent).dirty=true;}
  async function load(agent){
    const state=get(agent);if(state.loaded)return;if(state.loading)return state.loading;
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
        const seen=new Set();for(const line of raw.split('\n').filter(Boolean))try{
          const item=JSON.parse(line),id=kind==='observability'?item.requestId:item.id;if(seen.has(id))continue;seen.add(id);
          if(kind==='attribution'&&item.schema==='work-evidence.attribution.v1'&&typeof item.messageId==='string'&&Array.isArray(item.before)){
            if(state.effectBytes+(item.bytes??0)>16*1024*1024){state.writeErrors.push('attribution restore exceeds memory limit');break;}
            const list=state.effects.get(item.messageId)??[];if(!list.some(effect=>effect.id===item.id)){list.push(item);state.effects.set(item.messageId,list);state.effectBytes+=item.bytes??0;}
          }else if(kind==='observability'&&item.schema==='work-evidence.request-effects.v1'){
            accumulate(state,item);
            for(const decision of item.decisions??[]){const value=feature(state,decision.feature),key=decision.status==='not-applicable'?'notApplicable':decision.status;value.decisions++;value[key]=(value[key]??0)+1;value.lastStatus=decision.status;value.lastReason=decision.reason;value.reasons[decision.reason]=(value.reasons[decision.reason]??0)+1;state.decisions.push(decision);if(state.decisions.length>64)state.decisions.shift();}
          }
        }catch(error){state.writeErrors.push('Unreadable '+kind+' row retained: '+error.message);}
        if(raw&&!raw.endsWith('\n'))await fs.appendFile(file,'\n','utf8');
      }
      state.writeErrors=state.writeErrors.slice(-8);state.loaded=true;
    })();try{await state.loading;}finally{state.loading=null;}
  }
  function snapshot(agent){const state=get(agent),config=runtime.get(agent).config,features={};for(const name of new Set([...Object.keys(FEATURES),...Object.keys(state.features)])){const item=state.features[name];const setting=FEATURES[name];features[name]={enabled:runtime.isEnabled(agent)&&(name==='compactionTiming'?config.compactionTiming==='adaptive':setting?!!config[setting]:true),...(item??{decisions:0,applied:0,lastStatus:'not-observed',lastReason:'no-opportunity-observed'} )};}
    return {version:1,schema:'work-evidence.observability.v1',requests:{count:state.requests,main:state.mainRequests,auxiliary:state.auxiliaryRequests,missingUsage:state.missingUsage,unknownConsumption:state.unknownConsumption,providerReported:{...state.reported}},
      totals:{...state.totals},features,recentRequests:state.recentRequests.slice(),decisions:state.decisions.slice(-24),
      persistence:{file:storageFor(agent)?path.join(storageFor(agent),agent.session.id+'.observability.jsonl'):null,writeErrors:state.writeErrors.slice(),scope:'session-local automatic records outside workspace discovery; one settled row per dispatched stream; no prompt bodies; survives rolling status window'},
      interpretation:'Provider usage is observed. Direct feature token deltas are local estimates on the same trajectory, including visible guidance overhead; they are not measured task savings. Unmapped or evicted attribution remains unavailable.'};}
  function snippet(agent,{callIds,feature,beforeText,afterText}){const state=get(agent);for(const id of new Set(callIds.filter(Boolean))){const list=state.snippets.get(id)??[];list.push({feature,beforeText,afterText});state.snippets.set(id,list.slice(-8));}if(state.snippets.size>128)state.snippets.delete(state.snippets.keys().next().value);}
  const unsubscribe=ctx.on('session/event',(session,event)=>{
    if(event.type!=='tool/result'||event.surfaceOp?.op==='replace')return;const agent=ctx.agents?.get?.(session.id);if(!agent)return;const message=event.data?.message,state=get(agent),id=message?.source?.callId??message?.toolCallId,list=state.snippets.get(id);if(!list)return;state.snippets.delete(id);
    const after=(message.content??[]).filter(block=>block.type==='text').map(block=>block.text??'').join('\n');
    for(const name of new Set(list.map(item=>item.feature))){let before=after;for(const item of list.filter(item=>item.feature===name)){const offset=before.indexOf(item.afterText);if(offset<0||before.indexOf(item.afterText,offset+1)>=0)continue;before=before.slice(0,offset)+item.beforeText+before.slice(offset+item.afterText.length);}
      if(before!==after)rewrite(agent,{feature:name,seq:event.seq,afterMessage:message,beforeMessages:[{...message,content:[{type:'text',text:before}]}]});}
  });
  return {decide,rewrite,benefit,begin,finish,load,snippet,snapshot,instructions:(agent,text)=>{get(agent).instructionText=text;},flush:agent=>get(agent).queue,
    async disposeAgent(agent){await get(agent).queue;states.delete(agent.session.id);},async dispose(){if(typeof unsubscribe==='function')unsubscribe();await Promise.allSettled([...states.values()].map(state=>state.queue));states.clear();}};
}
