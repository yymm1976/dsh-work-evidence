import path from 'node:path';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertExistingFileWithin} from './evidence.mjs';
import {resultText,parseResult} from './visible-results.mjs';

const TOOLS=['pwsh','ops_bash','bash','job_output','read','grep','glob','ops_stat','ops_read_files','ops_inspect_local_file'];
const SHELL=new Set(['pwsh','ops_bash','bash']);
const OBSERVED=new Set(['pwsh','ops_bash','bash','job_output']);
const MAX_RECORD_BYTES=1500000;
const MAX_PENDING=32;
const MAX_RECORDS=32;
const MAX_SEEN=4096;
const MAX_SUMMARY_RECORDS=8;
const clip=(value,size)=>{const text=typeof value==='string'?value:JSON.stringify(value??null);return text.length<=size?text:text.slice(0,Math.floor(size/2))+'\n…\n'+text.slice(-Math.floor(size/2));};
const stream=value=>typeof value==='string'?{text:value,truncated:false}:value&&typeof value==='object'?{text:typeof value.text==='string'?value.text:'',truncated:value.truncated===true,spillPath:value.spillPath??null}:{text:'',truncated:false};
const payloadOf=value=>value?.data&&typeof value.data==='object'?value.data:value;
const statusOf=value=>value===undefined||value===null?'':String(value).toLowerCase();

function nativeElapsed(payload,value){
  for(const [source,candidate] of [
    ['payload.elapsedMs',payload?.elapsedMs],['payload.elapsed_ms',payload?.elapsed_ms],
    ['payload.durationMs',payload?.durationMs],['payload.duration_ms',payload?.duration_ms],
    ['value.elapsedMs',value?.elapsedMs],['value.elapsed_ms',value?.elapsed_ms],
    ['value.durationMs',value?.durationMs],['value.duration_ms',value?.duration_ms],
  ])if(typeof candidate==='number'&&Number.isFinite(candidate)&&candidate>=0)return {elapsedMs:candidate,elapsedSource:source};
  return {elapsedMs:null,elapsedSource:null};
}

function nativeQuestion(tool,args){
  const description=typeof args?.description==='string'&&args.description.trim()?args.description:null;
  const command=typeof args?.command==='string'&&args.command.trim()?args.command:null;
  const jobId=args?.job_id??args?.jobId??args?.id;
  const text=description??command??(tool==='job_output'&&jobId!=null?`job_output ${String(jobId)}`:`${tool} native call`);
  return {question:clip(text,400),questionComplete:text.length<=400,
    questionSource:description?'native-description':command?'native-command':'native-tool'};
}

function atPointer(value,pointer){
  if(pointer==='')return {found:true,value};
  if(!pointer.startsWith('/')||/\~(?:[^01]|$)/.test(pointer))return {found:false,reason:'invalid-json-pointer'};
  for(const part of pointer.slice(1).split('/')){
    const key=part.replaceAll('~1','/').replaceAll('~0','~');
    if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return {found:false,reason:'missing-json-pointer'};
    value=value[key];
  }
  return {found:true,value};
}

function checked(input){
  const known=new Set(['mode','question','tool','arguments','sources','cases','maxChars','id','offset']);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!known.has(key)))throw new Error('Unknown work_probe field');
  const mode=input.mode??'execute',maxChars=input.maxChars??6000;
  if(!['execute','recall','inspect'].includes(mode))throw new Error('Invalid work_probe mode');
  if(!Number.isInteger(maxChars)||maxChars<1024||maxChars>12000)throw new Error('maxChars must be from 1024 to 12000');
  if(mode!=='execute')return {...input,mode,maxChars};
  if(typeof input.question!=='string'||!input.question.trim()||input.question.length>2000)throw new Error('question must describe one concrete unresolved question');
  if(!TOOLS.includes(input.tool))throw new Error('Choose an existing supported native tool');
  if(!input.arguments||typeof input.arguments!=='object'||Array.isArray(input.arguments)||JSON.stringify(input.arguments).length>64000)throw new Error('arguments must be a bounded native tool argument object');
  if(SHELL.has(input.tool)){
    if(typeof input.arguments.command!=='string'||!input.arguments.command.trim())throw new Error('The native command must already be explicit');
    if(input.arguments.timeoutMs!==undefined&&(!Number.isInteger(input.arguments.timeoutMs)||input.arguments.timeoutMs<1||input.arguments.timeoutMs>60000))throw new Error('Use native tools directly for foreground waits longer than 60000ms');
  }
  if(input.tool==='job_output'&&input.arguments.timeout_ms!==undefined&&(!Number.isInteger(input.arguments.timeout_ms)||input.arguments.timeout_ms<1||input.arguments.timeout_ms>60000))throw new Error('job_output timeout_ms must be from 1 to 60000');
  const sources=input.sources??[];
  if(!Array.isArray(sources)||sources.length>16||sources.some(source=>typeof source!=='string'||!source.trim()||source.length>2000))throw new Error('sources must be at most 16 explicit source paths or URLs');
  const cases=input.cases??[];
  if(!Array.isArray(cases)||cases.length>8)throw new Error('At most eight concrete observations are supported');
  const names=new Set();
  for(const item of cases){
    if(!item||typeof item!=='object'||Object.keys(item).some(key=>!['name','target','pointer','expectedJson'].includes(key))||
      typeof item.name!=='string'||!item.name.trim()||item.name.length>160||names.has(item.name)||
      !['stdout','result'].includes(item.target??'stdout')||typeof item.pointer!=='string'||item.pointer.length>1000||
      item.pointer!==''&&(!item.pointer.startsWith('/')||/\~(?:[^01]|$)/.test(item.pointer)))throw new Error('Each case needs a unique name, target and JSON pointer');
    names.add(item.name);
    if(item.expectedJson!==undefined){
      if(typeof item.expectedJson!=='string'||item.expectedJson.length>16000)throw new Error('expectedJson must be bounded JSON text');
      JSON.parse(item.expectedJson);
    }
  }
  return {...input,mode,maxChars,sources,cases};
}

export function createExecutionEvidence(ctx,runtime,call){
  const evidenceStates=new Map(),explicitExecutions=new Map();
  const available=agent=>TOOLS.filter(name=>{try{return !!ctx.tools.get(name,agent);}catch{return false;}});
  const retrieveOriginal=id=>({tool:'work_probe',arguments:{mode:'recall',id,offset:0}});

  function evidenceState(agent){
    const id=agent.session.id;
    let state=evidenceStates.get(id);
    if(!state){
      state={records:[],pending:[],seen:new Set(),observed:0,nativeObserved:0,explicitObserved:0,saved:0,nativeSaved:0,explicitSaved:0,saveFailures:0,
        skips:{sessionDisabled:0,featureDisabled:0,duplicateCallId:0,explicitWorkProbe:0,pendingFull:0,missingCallId:0,observeError:0},
        flushPromise:null,lastFlush:null};
      evidenceStates.set(id,state);
    }
    return state;
  }

  function skip(state,reason){state.skips[reason]=(state.skips[reason]||0)+1;}

  function beginExplicit(agent){
    const execution=runtime.get(agent).execution;
    if(!execution)return ()=>{};
    const marker={execution,callId:execution.callId||null,rootCallId:execution.rootCallId||null,token:execution.token||null};
    const markers=explicitExecutions.get(agent.session.id)||[];
    markers.push(marker);explicitExecutions.set(agent.session.id,markers);
    return ()=>{
      const current=explicitExecutions.get(agent.session.id)||[];
      const index=current.indexOf(marker);
      if(index>=0)current.splice(index,1);
      if(current.length)explicitExecutions.set(agent.session.id,current);else explicitExecutions.delete(agent.session.id);
    };
  }

  function isExplicitInternal(agent,exec){
    const markers=explicitExecutions.get(agent.session.id)||[];
    if(!markers.length)return false;
    if(exec.parent&&markers.some(marker=>marker.token))return markers.some(marker=>marker.token&&exec.parent===marker.token);
    if(markers.some(marker=>marker.rootCallId&&exec.rootCallId===marker.rootCallId))return true;
    if(markers.some(marker=>marker.callId&&exec.rootCallId===marker.callId))return true;
    if(markers.some(marker=>marker.token&&exec.parent===marker.token))return true;
    const active=runtime.get(agent).execution;
    return markers.some(marker=>marker.execution===active&&active?.name==='work_probe'&&!exec.rootCallId&&!exec.parent);
  }

  async function recall(agent,input,signal){
    if(!/^probe-[0-9a-f-]{36}$/.test(input.id??''))throw new Error('recall requires a probe id from this session');
    const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error('offset must be non-negative');
    const s=runtime.get(agent),file=path.join(s.dir,'probes',s.id,input.id+'.json');
    try{
      const target=await assertExistingFileWithin(s.root,file);signal.throwIfAborted();
      const handle=await fs.open(target.real,'r');let bytes;
      try{if((await handle.stat()).size>MAX_RECORD_BYTES)throw new Error('Probe record exceeds its size limit');bytes=await handle.readFile();}finally{await handle.close();}
      if(bytes.length>MAX_RECORD_BYTES)throw new Error('Probe record exceeds its size limit');
      const source={text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
      const record=JSON.parse(source.text);
      if(record.sessionId!==s.id||record.id!==input.id)throw new Error('Probe record does not belong to this session');
      const end=Math.min(source.text.length,offset+input.maxChars);
      return {status:'observed',historical:true,id:input.id,observedAt:record.observedAt,offset,totalChars:source.text.length,
        text:source.text.slice(offset,end),complete:end>=source.text.length,nextOffset:end<source.text.length?end:null,
        note:'Recorded execution evidence; current file, process and service state are not asserted.'};
    }catch(error){signal.throwIfAborted();return {status:'unavailable',historical:true,id:input.id,error:String(error.message).slice(0,500)};}
  }

  function normalizeObservation({id,recordOrigin,question,questionSource,questionScope,tool,args,result,sources,requestedCases,maxChars,
    observedAt,elapsedMs,elapsedSource,scope,sourceScope,s}){
    const value=result.value??parseResult(resultText(result.content));
    const payload=payloadOf(value);
    const chunks=tool==='job_output'&&Array.isArray(payload?.chunks)?payload.chunks:null;
    const stdout=stream(payload?.stdout??payload?.stdoutText??(chunks?chunks.filter(chunk=>chunk.channel!=='stderr').map(chunk=>chunk.text??'').join(''):tool==='job_output'?payload?.text:undefined)),
      stderr=stream(payload?.stderr??payload?.stderrText??(chunks?chunks.filter(chunk=>chunk.channel==='stderr').map(chunk=>chunk.text??'').join(''):undefined));
    // The native job_output contract is a consuming delta, never the complete process stream.
    if(tool==='job_output')stdout.truncated=true;
    const statusRaw=payload?.status??value?.status??payload?.job?.status??value?.job?.status??null;
    const nativeStatus=statusOf(statusRaw);
    const background=['background','promoted'].includes(payload?.kind)||['background','promoted'].includes(value?.kind)||payload?.job?.kind==='background'||nativeStatus==='background';
    const pending=background||['running','pending','queued','stopping'].includes(nativeStatus);
    const jobId=payload?.jobId??payload?.job_id??payload?.job?.id??value?.jobId??value?.job_id??value?.job?.id??null;
    const exitRaw=payload?.exitCode??payload?.exit_code??value?.exitCode??value?.exit_code;
    const exitCode=Number.isInteger(exitRaw)?exitRaw:null;
    const failed=!!result.isError||!!(payload?.error||value?.error)||['error','failed','killed','cancelled','rejected'].includes(nativeStatus)||
      payload?.timedOut===true||payload?.aborted===true||payload?.cancelled===true||payload?.signal!=null||payload?.stopped!==undefined||
      exitCode!==null&&exitCode!==0;
    const nativePartial=nativeStatus==='partial'||payload?.complete===false||value?.complete===false||payload?.truncated===true||payload?.lossy===true;
    const uncertain=['unknown','unavailable','deopt'].includes(nativeStatus);
    const conclusive=!pending&&!failed&&!nativePartial&&!uncertain&&
      (exitCode===0||nativeStatus==='completed'||!SHELL.has(tool)&&value!==null&&value!==undefined&&tool!=='job_output');
    let stdoutJson,stdoutJsonAvailable=false;
    if(!stdout.truncated)try{stdoutJson=JSON.parse(stdout.text);stdoutJsonAvailable=true;}catch{}
    const perCase=Math.max(80,Math.floor(maxChars/(2*(requestedCases.length+3))));
    const cases=requestedCases.map(item=>{
      const target=item.target??'stdout',ready=target==='result'?value!==undefined&&value!==null:stdoutJsonAvailable;
      const selected=ready?atPointer(target==='result'?value:stdoutJson,item.pointer):{found:false,reason:'complete-json-output-unavailable'};
      const hasExpected=item.expectedJson!==undefined;
      return {name:item.name,target,pointer:item.pointer,status:!conclusive?'unresolved':!selected.found?'unresolved':hasExpected?
        isDeepStrictEqual(selected.value,JSON.parse(item.expectedJson))?'matched':'different':'observed',
        ...(selected.found?{actualJson:clip(JSON.stringify(selected.value),perCase),actualComplete:JSON.stringify(selected.value).length<=perCase}:{reason:selected.reason}),
        ...(hasExpected?{expectedJson:clip(item.expectedJson,perCase),expectedComplete:item.expectedJson.length<=perCase}:{})};
    });
    const finalStatus=pending?'pending':failed?'failed':nativePartial?'partial':!conclusive?'unknown':
      cases.some(item=>item.status==='different')?'different':cases.some(item=>item.status==='unresolved')||stdout.truncated||stderr.truncated?'partial':'observed';
    const executionState=pending?background?'background':'pending':failed?'failed':nativePartial?'partial':
      !conclusive?'unknown':stdout.truncated||stderr.truncated?'partial':'success';
    const cwdRequested=args?.workdir??args?.cwd??null;
    const hasNativeCwd=payload&&typeof payload==='object'&&Object.hasOwn(payload,'cwd')&&payload.cwd!=null;
    const rawError=payload?.error??value?.error??result.error??(result.isError?resultText(result.content):null);
    const observation={id,question:clip(question,400),questionComplete:question.length<=400,questionSource,questionScope,tool,observedAt,elapsedMs,elapsedSource,
      status:finalStatus,executionState,nativeStatus,background,partial:nativePartial||stdout.truncated||stderr.truncated,
      executionCompleted:conclusive,exitCode,jobId,cwd:hasNativeCwd?payload.cwd:(SHELL.has(tool)?cwdRequested??s.root:null),
      cwdSource:hasNativeCwd?'native-tool':SHELL.has(tool)?cwdRequested?'requested-workdir':'workspace-default':'not-observed',
      sources:sources.slice(0,8).map(source=>clip(source,240)),sourcesComplete:sources.length<=8&&sources.every(source=>source.length<=240),cases,
      stdout:{...stdout,text:clip(stdout.text,Math.floor(maxChars/3)),previewComplete:stdout.text.length<=Math.floor(maxChars/3)},
      stderr:{...stderr,text:clip(stderr.text,Math.floor(maxChars/4)),previewComplete:stderr.text.length<=Math.floor(maxChars/4)},
      error:failed?clip(rawError??'Native tool returned an error',1000):null,
      outputScope:tool==='job_output'?'consuming-job-output-delta':'native-tool-observation',sourceScope,
      effectState:'not-inferred',recordOrigin,scope};
    if(!['pwsh','ops_bash','bash','job_output'].includes(tool)&&!stdout.text&&!cases.length)
      observation.resultPreview=clip(value??resultText(result.content),Math.floor(maxChars/3));
    return observation;
  }

  function makeRecord({s,id,recordOrigin,callId=null,rootCallId=null,observedAt,question,tool,args,sources,requestedCases,observation,result}){
    return {version:1,id,sessionId:s.id,recordOrigin,callId,rootCallId,observedAt,question,tool,arguments:args,sources,requestedCases,observation,
      result:{value:result.value??null,content:result.content??[],isError:!!result.isError,error:result.error??null}};
  }

  async function saveRecord(agent,s,record,signal){
    try{
      signal?.throwIfAborted();
      const text=JSON.stringify(record,null,2)+'\n';
      if(Buffer.byteLength(text)>MAX_RECORD_BYTES)throw new Error('Native output exceeds the evidence record budget; use its original output or spill file');
      await runtime.save(agent,path.join(s.dir,'probes',s.id,record.id+'.json'),text,signal);
      return {saved:true};
    }catch(error){
      if(signal?.aborted)throw error;
      return {saved:false,error:String(error?.message??error).slice(0,500)};
    }
  }

  function finishRecord(state,record,outcome){
    const observation=record.observation;
    observation.evidenceSaved=outcome.saved===true;
    if(observation.evidenceSaved){
      observation.retrieveOriginal=retrieveOriginal(record.id);
      state.saved++;
      if(record.recordOrigin==='native-observation')state.nativeSaved++;else state.explicitSaved++;
    }else{
      delete observation.retrieveOriginal;
      observation.evidenceError=String(outcome.error??'Evidence record was not saved').slice(0,500);
      state.saveFailures++;
    }
    state.records.push({id:record.id,origin:record.recordOrigin,callId:record.callId,rootCallId:record.rootCallId,
      question:observation.question,questionScope:observation.questionScope,tool:record.tool,observedAt:record.observedAt,
      elapsedMs:observation.elapsedMs,elapsedSource:observation.elapsedSource,status:observation.status,executionState:observation.executionState,
      nativeStatus:observation.nativeStatus,background:observation.background,partial:observation.partial,exitCode:observation.exitCode,jobId:observation.jobId,
      cwd:observation.cwd,cwdSource:observation.cwdSource,error:observation.error,evidenceSaved:observation.evidenceSaved,
      ...(observation.evidenceSaved?{retrieveOriginal:observation.retrieveOriginal}:{evidenceError:observation.evidenceError})});
    if(state.records.length>MAX_RECORDS)state.records.splice(0,state.records.length-MAX_RECORDS);
  }

  function observe(exec,result){
    let state=null;
    try{
      if(!exec?.agent||!OBSERVED.has(exec.name))return {status:'ignored',reason:'unsupported-tool'};
      const agent=exec.agent,s=runtime.get(agent);state=evidenceState(agent);
      if(!runtime.isEnabled(agent)){skip(state,'sessionDisabled');return {status:'skipped',reason:'session-disabled'};}
      if(s.config.nativeExecutionEvidence!==true){skip(state,'featureDisabled');return {status:'skipped',reason:'native-execution-evidence-disabled'};}
      const callId=typeof exec.callId==='string'&&exec.callId?exec.callId:null;
      if(!callId){skip(state,'missingCallId');return {status:'skipped',reason:'missing-call-id'};}
      if(state.seen.has(callId)){skip(state,'duplicateCallId');return {status:'skipped',reason:'duplicate-call-id',callId};}
      if(isExplicitInternal(agent,exec)){
        state.seen.add(callId);
        if(state.seen.size>MAX_SEEN)state.seen.delete(state.seen.values().next().value);
        skip(state,'explicitWorkProbe');
        return {status:'skipped',reason:'explicit-work-probe-internal',callId};
      }
      if(state.pending.length>=MAX_PENDING){
        state.seen.add(callId);
        if(state.seen.size>MAX_SEEN)state.seen.delete(state.seen.values().next().value);
        skip(state,'pendingFull');return {status:'skipped',reason:'pending-full',callId};
      }
      state.seen.add(callId);
      if(state.seen.size>MAX_SEEN)state.seen.delete(state.seen.values().next().value);
      const args=exec.arguments&&typeof exec.arguments==='object'&&!Array.isArray(exec.arguments)?exec.arguments:{};
      const value=result?.value??parseResult(resultText(result?.content));
      const {elapsedMs,elapsedSource}=nativeElapsed(payloadOf(value),value);
      const asked=nativeQuestion(exec.name,args);
      const id='probe-'+randomUUID(),observedAt=new Date().toISOString();
      const observation=normalizeObservation({
        id,recordOrigin:'native-observation',question:asked.question,questionSource:asked.questionSource,
        questionScope:'native-observation; no inferred user expectation',tool:exec.name,args,result:result??{},sources:[],requestedCases:[],
        maxChars:6000,observedAt,elapsedMs,elapsedSource,s,
        sourceScope:'Native call result only; source freshness, task correctness and issue resolution are not asserted.',
        scope:'Passive observation of an already-completed native call. Exit zero only records that execution state; it does not mean the user problem is resolved.'
      });
      const record=makeRecord({s,id,recordOrigin:'native-observation',callId,rootCallId:exec.rootCallId??null,observedAt,
        question:asked.question,tool:exec.name,args:exec.arguments??null,sources:[],requestedCases:[],observation,result:result??{}});
      state.observed++;state.nativeObserved++;state.pending.push(record);s.dirty=true;
      return {status:'pending',id,callId};
    }catch(error){
      if(state)skip(state,'observeError');
      return {status:'skipped',reason:'observe-error',error:String(error?.message??error).slice(0,500)};
    }
  }

  async function execute(agent,input,signal){
    const plan=checked(input),s=await runtime.init(agent,signal);
    if(plan.mode==='recall')return s.config.executionTriage||s.config.nativeExecutionEvidence?recall(agent,plan,signal):
      {status:'disabled',feature:'executionTriage/nativeExecutionEvidence'};
    if(!s.config.executionTriage)return {status:'disabled',feature:'executionTriage'};
    if(plan.mode==='inspect')return {status:'available',tools:available(agent),
      note:'Use a concrete question and an already formed native call within the current task. No command or case is generated automatically.'};
    if(!available(agent).includes(plan.tool))return {status:'deopt',reason:'requested-native-tool-unavailable',tool:plan.tool,executionOccurred:false};
    const id='probe-'+randomUUID(),started=performance.now(),observedAt=new Date().toISOString();
    const args={...plan.arguments};
    if(SHELL.has(plan.tool)){args.description??=plan.question.slice(0,180);args.timeoutMs??=10000;}
    let result;
    const explicitExecution=runtime.get(agent).execution,finishExplicit=beginExplicit(agent);
    try{result=await call(plan.tool,args,runtime.execFor(agent,signal));}
    catch(error){signal.throwIfAborted();result={isError:true,error:{message:String(error.message),code:error.code??null},content:[]};}
    finally{finishExplicit();}
    const elapsedMs=Math.round(performance.now()-started);
    const observation=normalizeObservation({id,recordOrigin:'work_probe',question:plan.question,questionSource:'work-probe-input',
      questionScope:'caller-declared-unresolved-question',tool:plan.tool,args,result,sources:plan.sources,requestedCases:plan.cases,maxChars:plan.maxChars,
      observedAt,elapsedMs,elapsedSource:'work_probe-wall-clock',s,
      sourceScope:'supplied dependency labels; not proof of source freshness',
      scope:'Only the supplied call, inputs and observed environment; no general correctness or task completion claim.'});
    const record=makeRecord({s,id,recordOrigin:'work_probe',callId:explicitExecution?.callId??null,rootCallId:explicitExecution?.rootCallId??explicitExecution?.callId??null,
      observedAt,question:plan.question,tool:plan.tool,args,sources:plan.sources,requestedCases:plan.cases,observation,result});
    const state=evidenceState(agent);state.observed++;state.explicitObserved++;
    const outcome=await saveRecord(agent,s,record,signal);
    finishRecord(state,record,outcome);
    s.dirty=true;
    return observation;
  }

  async function flush(agent,signal){
    if(!agent)return {status:'disabled',reason:'agent-required',saved:0,saveFailures:0,pending:0};
    const s=runtime.get(agent),state=evidenceState(agent);
    if(!runtime.isEnabled(agent)||s.config.nativeExecutionEvidence!==true){
      const result={status:'skipped',reason:!runtime.isEnabled(agent)?'session-disabled':'native-execution-evidence-disabled',
        saved:0,saveFailures:0,pending:state.pending.length};
      state.lastFlush={...result,at:new Date().toISOString()};return result;
    }
    if(state.flushPromise)return state.flushPromise;
    const promise=(async()=>{
      let saved=0,saveFailures=0;
      while(state.pending.length){
        const record=state.pending[0];
        let outcome;
        try{
          signal?.throwIfAborted();
          outcome=await saveRecord(agent,s,record,signal);
        }catch(error){
          if(signal?.aborted){
            const result={status:'aborted',saved,saveFailures,pending:state.pending.length};
            state.lastFlush={...result,at:new Date().toISOString()};return result;
          }
          outcome={saved:false,error:String(error?.message??error)};
        }
        state.pending.shift();
        finishRecord(state,record,outcome);
        if(outcome.saved)saved++;else saveFailures++;
        s.dirty=true;
      }
      const result={status:'flushed',saved,saveFailures,pending:0};
      state.lastFlush={...result,at:new Date().toISOString()};
      return result;
    })();
    state.flushPromise=promise;
    try{return await promise;}
    finally{if(state.flushPromise===promise)state.flushPromise=null;}
  }

  function summary(agent){
    if(!agent)return null;
    const s=runtime.get(agent),state=evidenceState(agent),skips={...state.skips};
    const skipped=Object.values(skips).reduce((total,value)=>total+(Number.isFinite(value)?value:0),0);
    return {sessionId:s.id,sessionEnabled:runtime.isEnabled(agent),featureEnabled:s.config.nativeExecutionEvidence===true,
      active:runtime.isEnabled(agent)&&s.config.nativeExecutionEvidence===true,pending:state.pending.length,observed:state.observed,
      nativeObserved:state.nativeObserved,explicitObserved:state.explicitObserved,nativeSaved:state.nativeSaved,explicitSaved:state.explicitSaved,
      saved:state.saved,saveFailures:state.saveFailures,skipped,skips,recordCount:state.records.length,
      recent:state.records.slice(-MAX_SUMMARY_RECORDS).map(record=>({...record,
        ...(record.evidenceSaved===true?{retrieveOriginal:record.retrieveOriginal}:{})})),
      lastFlush:state.lastFlush?{...state.lastFlush}:null,
      scope:'Native and explicit observations are counted separately. Saved retrieval is historical; execution success is not task completion.'};
  }

  function disposeAgent(agent){
    const id=agent?.session?.id;
    if(id){evidenceStates.delete(id);explicitExecutions.delete(id);}
  }

  function dispose(){evidenceStates.clear();explicitExecutions.clear();}

  return {execute,available,observe,flush,summary,disposeAgent,dispose};
}
