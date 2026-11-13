import path from 'node:path';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertExistingFileWithin} from './evidence.mjs';
import {resultText,parseResult} from './visible-results.mjs';
import {createExecutionDependencies,declaredFileSources,dependencyView} from './execution-dependencies.mjs';
import {argsOf,eventLog} from './runtime.mjs';

const TOOLS=['pwsh','ops_bash','bash','job_output','read','grep','glob','ops_stat','ops_read_files','ops_inspect_local_file'];
const SHELL=new Set(['pwsh','ops_bash','bash']);
const MAX_RECORD_BYTES=1500000;
const MAX_RECORDS=32;
const MAX_SUMMARY_RECORDS=8;
const clip=(value,size)=>{const text=typeof value==='string'?value:JSON.stringify(value??null);return text.length<=size?text:text.slice(0,Math.floor(size/2))+'\n…\n'+text.slice(-Math.floor(size/2));};
const stream=value=>typeof value==='string'?{text:value,truncated:false}:value&&typeof value==='object'?{text:typeof value.text==='string'?value.text:'',truncated:value.truncated===true||value.complete===false,spillPath:value.spillPath??null}:{text:'',truncated:false};
const payloadOf=value=>value?.data&&typeof value.data==='object'?value.data:value;
const statusOf=value=>value===undefined||value===null?'':String(value).toLowerCase();

export function recordedProcessCompletion(events,execution,beforeSeq){
  const event=events.find(item=>item.seq===execution.seq),data=event?.data,message=data?.message??data;
  const callId=data?.subCallId??data?.callId??message?.source?.callId??message?.toolCallId;
  if(!callId)return null;
  const rootCallId=data?.rootCallId??callId;
  const matches=events.filter(item=>item.type==='job/registered'&&item.seq<=execution.seq&&
    item.data?.toolCall?.callId===callId&&item.data?.toolCall?.rootCallId===rootCallId);
  if(matches.length!==1)return null;
  const registered=matches[0],job=registered.data;
  if([job.jobId,job.owner,job.kind].some(value=>typeof value!=='string'||!value))return null;
  const settled=events.filter(item=>item.type==='job/settled'&&item.seq>registered.seq&&item.seq<beforeSeq&&item.data?.jobId===job.jobId);
  if(settled.length!==1)return null;
  const result=settled[0],value=result.data,code=/^exit code: (-?\d+)$/u.exec(value.detail??'');
  if(value.owner!==job.owner||value.kind!==job.kind||value.toolCall?.callId!==callId||value.toolCall?.rootCallId!==rootCallId||
    value.producerReported!==true||value.cause!=='producer'||!['completed','failed'].includes(value.status)||!code)return null;
  const exitCode=Number(code[1]);
  if(!Number.isSafeInteger(exitCode)||value.status==='failed'&&exitCode===0)return null;
  return {seq:result.seq,registrationSeq:registered.seq,jobId:job.jobId,callId,rootCallId,status:value.status,exitCode,processCompleted:true,
    meaning:'Recorded producer completion for this exact native call. This does not establish output completeness, file applicability or task correctness.'};
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
  if(!['execute','recall','inspect','replay'].includes(mode))throw new Error('Invalid work_probe mode');
  if(!Number.isInteger(maxChars)||maxChars<1024||maxChars>12000)throw new Error('maxChars must be from 1024 to 12000');
  if(mode==='replay'){
    if(Object.keys(input).some(key=>!['mode','id','maxChars'].includes(key))||!/^probe-[0-9a-f-]{36}$/u.test(input.id??''))
      throw new Error('Probe replay accepts only a same-session probe id and display maxChars; recorded inputs and expectations cannot be overridden');
    return {...input,mode,maxChars};
  }
  if(mode!=='execute')return {...input,mode,maxChars};
  if(typeof input.question!=='string'||!input.question.trim()||input.question.length>2000)throw new Error('question must describe one concrete unresolved question');
  if(!TOOLS.includes(input.tool))throw new Error('Choose an existing supported native tool');
  if(!input.arguments||typeof input.arguments!=='object'||Array.isArray(input.arguments)||JSON.stringify(input.arguments).length>64000)throw new Error('arguments must be a bounded native tool argument object');
  if(SHELL.has(input.tool)){
    if(typeof input.arguments.command!=='string'||!input.arguments.command.trim())throw new Error('The native command must already be explicit');
    if(input.arguments.timeoutMs!==undefined&&(!Number.isInteger(input.arguments.timeoutMs)||input.arguments.timeoutMs<1||input.arguments.timeoutMs>60000))throw new Error('Use native tools directly for foreground waits longer than 60000ms');
  }
  if(input.tool==='job_output'&&input.arguments.timeout_ms!==undefined&&(!Number.isInteger(input.arguments.timeout_ms)||input.arguments.timeout_ms<1||input.arguments.timeout_ms>60000))throw new Error('job_output timeout_ms must be from 1 to 60000');
  const sources=declaredFileSources(input.sources);
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

export function createExecutionEvidence(ctx,runtime,call,{executionDependencies=createExecutionDependencies()}={}){
  const evidenceStates=new Map();
  const available=agent=>TOOLS.filter(name=>{try{return !!ctx.tools.get(name,agent);}catch{return false;}});
  const retrieveOriginal=id=>({tool:'work_probe',arguments:{mode:'recall',id,offset:0}});

  function replayPlan(agent,id,maxChars,seen=new Set()){
    if(seen.has(id)||seen.size>=32)throw new Error('Invalid or cyclic probe replay source');
    seen.add(id);
    const events=eventLog(agent.session),calls=new Map();
    const callIdOf=event=>event.type==='tool/result'?event.data?.message?.source?.callId??event.data?.message?.toolCallId??event.data?.callId:
      event.data?.subCallId??event.data?.callId;
    for(const event of events)if(['tool/call','tool/ptc-dispatch-start','tool/code-dispatch-start','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)){
      const key=callIdOf(event),prior=calls.get(key),data=event.data??{};
      if(key)calls.set(key,{name:data.name??prior?.name,args:data.arguments===undefined?prior?.args:argsOf(data.arguments),seq:prior?.seq??event.seq});
    }
    for(const event of events.toReversed()){
      if(!['tool/result','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type))continue;
      const source=calls.get(callIdOf(event));
      if(source?.name!=='work_probe')continue;
      const data=event.data??{},content=event.type==='tool/result'?data.message?.content:data.content;
      const observation=parseResult(resultText(content));
      if(observation?.id!==id||observation.historical===true)continue;
      const original=checked(source.args);
      if(!['execute','replay'].includes(original.mode))continue;
      const recipe=original.mode==='replay'?replayPlan(agent,original.id,maxChars,seen):original;
      return {...recipe,mode:'execute',maxChars,replayOf:{id,sourceCallId:callIdOf(event),sourceResultSeq:event.seq,
        rootProbeId:recipe.replayOf?.rootProbeId??id,inputs:'original-session-call',expectations:'unchanged'}};
    }
    throw new Error('Probe replay requires an original recorded work_probe call and result from this session');
  }

  function assertReplayFamilySettled(agent,rootId){
    const events=eventLog(agent.session),probeCalls=new Set(),pending=[];
    const callIdOf=event=>event.type==='tool/result'?event.data?.message?.source?.callId??event.data?.message?.toolCallId??event.data?.callId:
      event.data?.subCallId??event.data?.callId;
    for(const event of events)if(['tool/call','tool/ptc-dispatch-start','tool/code-dispatch-start','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)&&event.data?.name==='work_probe')probeCalls.add(callIdOf(event));
    for(const event of events){
      if(!['tool/result','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)||!probeCalls.has(callIdOf(event)))continue;
      const data=event.data??{},observation=parseResult(resultText(event.type==='tool/result'?data.message?.content:data.content));
      if(!observation||observation.historical===true||(observation.replayOf?.rootProbeId??observation.id)!==rootId||
        observation.background!==true&&observation.status!=='pending')continue;
      pending.push({observation,seq:event.seq});
    }
    const retained=evidenceState(agent).replayLocks.get(rootId);
    if(retained?.pending)pending.push({observation:retained.pending,seq:retained.seq});
    for(const {observation,seq}of pending){
      const registered=events.filter(item=>item.type==='job/registered'&&item.seq<=seq&&item.data?.jobId===observation.jobId);
      const registration=registered.length===1?registered[0]:null,job=registration?.data;
      const settled=registration?events.filter(item=>item.type==='job/settled'&&item.seq>registration.seq&&item.data?.jobId===job.jobId&&
        item.data.owner===job.owner&&item.data.kind===job.kind&&item.data.toolCall?.callId===job.toolCall?.callId&&
        item.data.toolCall?.rootCallId===job.toolCall?.rootCallId&&item.data.cause==='producer'&&item.data.producerReported===true&&
        ['completed','failed','killed'].includes(item.data.status)):[];
      if(!registration||!job?.toolCall?.callId||!job.toolCall.rootCallId||settled.length!==1)
        throw new Error('This original probe already has a pending or background replay. Monitor its original job id until recorded producer settlement; do not start a duplicate.');
    }
  }

  function evidenceState(agent){
    const id=agent.session.id;
    let state=evidenceStates.get(id);
    if(!state){
      state={records:[],observed:0,explicitObserved:0,saved:0,explicitSaved:0,saveFailures:0,replayLocks:new Map()};
      evidenceStates.set(id,state);
    }
    return state;
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
    const nativePartial=nativeStatus==='partial'||payload?.complete===false||value?.complete===false||payload?.completed===false||value?.completed===false||
      payload?.outputPartial===true||payload?.partial===true||payload?.truncated===true||payload?.lossy===true;
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
      state.explicitSaved++;
    }else{
      delete observation.retrieveOriginal;
      observation.evidenceError=String(outcome.error??'Evidence record was not saved').slice(0,500);
      state.saveFailures++;
    }
    state.records.push({id:record.id,origin:record.recordOrigin,callId:record.callId,rootCallId:record.rootCallId,
      question:observation.question,questionScope:observation.questionScope,tool:record.tool,observedAt:record.observedAt,
      elapsedMs:observation.elapsedMs,elapsedSource:observation.elapsedSource,status:observation.status,executionState:observation.executionState,
      nativeStatus:observation.nativeStatus,background:observation.background,partial:observation.partial,exitCode:observation.exitCode,jobId:observation.jobId,
      executionCompleted:observation.executionCompleted,fileDependencies:observation.fileDependencies,...dependencyView(observation),
      cwd:observation.cwd,cwdSource:observation.cwdSource,error:observation.error,evidenceSaved:observation.evidenceSaved,
      ...(observation.evidenceSaved?{retrieveOriginal:observation.retrieveOriginal}:{evidenceError:observation.evidenceError})});
    if(state.records.length>MAX_RECORDS)state.records.splice(0,state.records.length-MAX_RECORDS);
  }

  async function execute(agent,input,signal){
    let plan=checked(input),replayState=null,replayRoot=null;const s=await runtime.init(agent,signal);
    if(plan.mode==='recall')return s.config.executionTriage?recall(agent,plan,signal):
      {status:'disabled',feature:'executionTriage'};
    if(!s.config.executionTriage)return {status:'disabled',feature:'executionTriage'};
    if(plan.mode==='replay'){
      if(!s.config.probeReplay)return {status:'disabled',feature:'probeReplay',executionOccurred:false};
      plan=replayPlan(agent,plan.id,plan.maxChars);
      replayState=evidenceState(agent);replayRoot=plan.replayOf.rootProbeId;
      if(replayState.replayLocks.get(replayRoot)?.inFlight)return {status:'unavailable',reason:'probe-replay-in-flight',executionOccurred:false,replayOf:plan.replayOf};
      try{assertReplayFamilySettled(agent,plan.replayOf.rootProbeId);}catch(error){return {status:'unavailable',reason:'probe-replay-pending',executionOccurred:false,replayOf:plan.replayOf,error:String(error.message)};}
      replayState.replayLocks.set(replayRoot,{inFlight:true});
    }
    try{
    if(plan.mode==='inspect')return {status:'available',tools:available(agent),
      note:'Use a concrete question and an already formed native call within the current task. No command or case is generated automatically.'};
    if(!available(agent).includes(plan.tool))return {status:'deopt',reason:'requested-native-tool-unavailable',tool:plan.tool,executionOccurred:false};
    if(SHELL.has(plan.tool)&&ctx.get('sandboxPolicy')?.resolve({session:agent.session})?.mode==='read-only')
      return {status:'unavailable',reason:'native-read-only-session',executionOccurred:false,
        error:'A read-only session cannot start an unrestricted Shell probe. Use native read tools or retained read-only calculations.'};
    const dependencies=await executionDependencies.capture(s.root,plan.sources,signal);
    const id='probe-'+randomUUID(),started=performance.now(),observedAt=new Date().toISOString();
    const args={...plan.arguments};
    if(SHELL.has(plan.tool)){args.description??=plan.question.slice(0,180);args.timeoutMs??=10000;}
    let result;
    const explicitExecution=runtime.get(agent).execution;
    try{result=await call(plan.tool,args,runtime.execFor(agent,signal));}
    catch(error){signal.throwIfAborted();result={isError:true,error:{message:String(error.message),code:error.code??null},content:[]};}
    const elapsedMs=Math.round(performance.now()-started);
    const observation=normalizeObservation({id,recordOrigin:'work_probe',question:plan.question,questionSource:'work-probe-input',
      questionScope:'caller-declared-unresolved-question',tool:plan.tool,args,result,sources:plan.sources,requestedCases:plan.cases,maxChars:plan.maxChars,
      observedAt,elapsedMs,elapsedSource:'work_probe-wall-clock',s,
      sourceScope:'Caller-declared sources only. File applicability is assessed separately from execution and task correctness.',
      scope:'Only the supplied call, inputs and observed environment; no general correctness or task completion claim.'});
    if(plan.replayOf)observation.replayOf=plan.replayOf;
    if(replayState&&(observation.background||observation.status==='pending'))
      replayState.replayLocks.set(replayRoot,{pending:observation,seq:agent.session.seq});
    Object.assign(observation,await executionDependencies.finish(dependencies,observation.executionCompleted&&!observation.partial,signal));
    const record=makeRecord({s,id,recordOrigin:'work_probe',callId:explicitExecution?.callId??null,rootCallId:explicitExecution?.rootCallId??explicitExecution?.callId??null,
      observedAt,question:plan.question,tool:plan.tool,args,sources:plan.sources,requestedCases:plan.cases,observation,result});
    const state=evidenceState(agent);state.observed++;state.explicitObserved++;
    const outcome=await saveRecord(agent,s,record,signal);
    finishRecord(state,record,outcome);
    s.dirty=true;
    return observation;
    }finally{if(replayState?.replayLocks.get(replayRoot)?.inFlight)replayState.replayLocks.delete(replayRoot);}
  }

  function summary(agent){
    if(!agent)return null;
    const s=runtime.get(agent),state=evidenceState(agent);
    return {sessionId:s.id,sessionEnabled:runtime.isEnabled(agent),observed:state.observed,
      explicitObserved:state.explicitObserved,explicitSaved:state.explicitSaved,
      saved:state.saved,saveFailures:state.saveFailures,recordCount:state.records.length,
      recent:state.records.slice(-MAX_SUMMARY_RECORDS).map(({fileDependencies,...record})=>({...record,...dependencyView(record),
        ...(record.evidenceSaved===true?{retrieveOriginal:record.retrieveOriginal}:{})})),
      scope:'Explicit observations only. File applicability covers declared files at evidenceAssessment.assessedAt; saved retrieval is historical. Execution success is not task completion.'};
  }

  function disposeAgent(agent){
    const id=agent?.session?.id;
    if(id)evidenceStates.delete(id);
  }

  function dispose(){evidenceStates.clear();}

  return {execute,available,summary,
    refreshEvidence:(agent,signal,cache)=>executionDependencies.refresh(runtime.get(agent).root,evidenceState(agent).records,signal,cache),
    disposeAgent,dispose};
}
