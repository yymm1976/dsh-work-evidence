import path from 'node:path';
import {argsOf,eventLog} from './runtime.mjs';
import {planContextPrune,readDispatch,hasPruneProblem} from './context-pruning.mjs';
import {resultText,surfaceReferences} from './visible-results.mjs';
import {renderedReads} from './observation-ledger.mjs';

const AGE=2,MIN_CODE=800,MIN_SAVING=512;
const READ_ONLY=new Set(['read','glob','grep','ops_read_files','ops_inspect_local_file','ops_glob','ops_grep','project_evidence']);
const messageOf=event=>event.data?.message??(event.data?.role?event.data:null);
const callIdOf=message=>message?.source?.callId??message?.toolCallId;
const scopedCall=(turn,step,id)=>Number.isSafeInteger(turn)&&Number.isSafeInteger(step)&&typeof id==='string'&&id
  ?JSON.stringify([turn,step,id]):null;
const messageCall=(messageId,id)=>typeof messageId==='string'&&messageId&&typeof id==='string'&&id
  ?JSON.stringify([messageId,id]):null;
const fileKey=(root,file)=>{
  const value=path.resolve(root??'.',file).replaceAll('\\','/');
  return process.platform==='win32'?value.toLowerCase():value;
};

export function recallCall(agent,{seq,offset=0,maxChars=16000}={}){
  if(!Number.isSafeInteger(seq)||seq<0||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(maxChars)||maxChars<256||maxChars>64000)throw new Error('Invalid historical call window');
  const event=agent.session.eventAt(seq),data=event?.data;
  if(!['tool/call','tool/ptc-dispatch','tool/code-dispatch'].includes(event?.type))return {status:'unavailable',seq,reason:'This event is not a recorded tool call.'};
  const text=typeof data.arguments==='string'?data.arguments:JSON.stringify(data.arguments??{}),end=Math.min(text.length,offset+maxChars);
  return {status:'observed',historical:true,kind:'call',seq,tool:data.name,offset,totalChars:text.length,text:text.slice(offset,end),nextOffset:end<text.length?end:null,
    complete:end>=text.length,note:'Original recorded arguments. The operation was not rerun.'};
}

/** A request view only; canonical events and reasoning remain complete. */
export function createHistoryHygiene(runtime,taskFlow,{isProtected=()=>false,retainedSource=()=>false,canRecall=()=>false}={}){
  const states=new Map();
  function get(agent){
    let state=states.get(agent.session.id);
    if(!state){state={cursor:0,step:0,calls:new Map(),callOwners:new Map(),nativeCallScopes:new Set(),programCalls:new Map(),results:new Map(),failures:new Set(),pinnedCalls:new Set(),pinnedResults:new Set(),retainedSources:new Set(),
      programPlans:new Map(),outputPlans:new Map(),hiddenResults:new Set(),omittedSources:new Set(),liveReads:new Map(),nativeNames:new Map(),observedPaths:new Map(),requests:0,programs:0,outputs:0,chars:0,restores:0,rereadPromotions:0};states.set(agent.session.id,state);}
    return state;
  }
  function rememberRead(state,root,read){
    if(!root||!read)return;
    const reads=state.liveReads.get(root)??new Map();
    if(reads.size<33&&!reads.has(read.callId))reads.set(read.callId,read);
    state.liveReads.set(root,reads);
  }
  function observe(exec,result){
    if(!exec.agent||!runtime.isEnabled(exec.agent)||!runtime.get(exec.agent).config.historyHygiene)return;
    const state=get(exec.agent),root=exec.rootCallId??exec.callId;
    rememberRead(state,root,readDispatch({...exec,subCallId:exec.callId,...result}));
    if(result.isError||hasPruneProblem(result.content??[],result.value))state.failures.add(root);
  }
  function sync(agent){
    const state=get(agent),events=eventLog(agent.session);
    while(state.cursor<events.length){
      const event=events[state.cursor++],data=event.data??{},message=messageOf(event);
      if(event.type==='step/start')state.step++;
      if(event.type==='assistant/message')for(const block of message?.content??[])if(block.type==='tool-call'){
        const key=scopedCall(data.turn,data.step,block.id),owner=messageCall(message?.id,block.id);
        if(key&&owner){
          if(state.callOwners.has(key)){
            const previous=state.callOwners.get(key);
            if(previous){state.programCalls.delete(previous);state.programPlans.delete(previous);}
            state.callOwners.set(key,null);
          }else state.callOwners.set(key,owner);
        }
      }
      if(event.type==='tool/call'){
        const call={seq:event.seq,name:data.name,args:argsOf(data.arguments),step:state.step};
        state.calls.set(data.callId,call);
        const key=scopedCall(data.turn,data.step,data.callId),owner=state.callOwners.get(key);
        if(key&&state.nativeCallScopes.has(key)){
          if(owner){state.programCalls.delete(owner);state.programPlans.delete(owner);}
          state.callOwners.set(key,null);
        }else if(key){
          state.nativeCallScopes.add(key);
          if(owner){
            if(state.programCalls.has(owner)){state.programCalls.set(owner,null);state.programPlans.delete(owner);}
            else state.programCalls.set(owner,call);
          }
        }
      }
      if(['tool/call','tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)){
        const args=argsOf(data.arguments);
        if(data.name==='work_recall'||data.name==='work_state'&&args.mode==='recall'){
          const pins=args.kind==='call'?state.pinnedCalls:state.pinnedResults;
          if(Number.isSafeInteger(args.seq)&&!pins.has(args.seq)){
            pins.add(args.seq);state.restores++;
            if(args.kind!=='call'){
              const entry=[...state.results.values()].find(entry=>entry.seq===args.seq);
              const paths=[...(entry?.paths??[]),...(entry?.reads??[]).flatMap(read=>[read.meta?.path,read.value?.path,read.arguments?.file_path,read.arguments?.path])];
              for(const file of paths)if(typeof file==='string')state.retainedSources.add(fileKey(runtime.get(agent).root,file));
            }
          }
        }
      }
      if(['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)){
        const root=data.rootCallId;
        if(!root)continue;
        rememberRead(state,root,readDispatch(data));
        if(data.isError||hasPruneProblem(data.content??[],data.value))state.failures.add(root);
        const names=state.nativeNames.get(root)??new Set();names.add(data.name);state.nativeNames.set(root,names);
        const args=argsOf(data.arguments),paths=state.observedPaths.get(root)??new Set();
        for(const field of ['file_path','path','file'])if(typeof args[field]==='string'&&paths.size<12)paths.add(args[field]);
        state.observedPaths.set(root,paths);
      }
      if(event.type==='tool/result'&&event.surfaceOp?.op!=='replace'&&message){
        const id=callIdOf(message),call=state.calls.get(id);
        const failed=!!message.isError||hasPruneProblem(message.content??[])||state.failures.has(id)||isProtected(agent,id);
        const record={seq:event.seq,step:state.step,callId:id,failed,reads:[...(state.liveReads.get(id)?.values()??[])],
          names:[...(state.nativeNames.get(id)??[])],paths:[...(state.observedPaths.get(id)??[])]};
        state.results.set(message.id,record);if(call)call.result=record;
        if(!failed&&record.reads.length){
          const printed=renderedReads(record.reads,resultText(message.content));
          for(const window of printed?.value?.items??[]){
            const key=fileKey(runtime.get(agent).root,window.path);
            if(state.omittedSources.has(key)&&!state.retainedSources.has(key)){state.retainedSources.add(key);state.rereadPromotions++;}
          }
        }
        state.liveReads.delete(id);state.nativeNames.delete(id);state.observedPaths.delete(id);
      }
    }
    return state;
  }
  function codeView(call,block){
    const args=argsOf(block.arguments);
    if(typeof args.code!=='string'||args.code.length<MIN_CODE)return null;
    const result=call.result;
    // A successful write's arguments are the current implementation. Removing
    // them after one replay caused the model to reread its own fresh changes.
    if(result.names.some(name=>!READ_ONLY.has(name)))return null;
    const summary=[`// Historical completed program; original arguments: work_recall({seq:${call.seq},kind:"call"}).`,
      '// History view only. The operation was not rerun.',
      args.description?'// '+String(args.description).replace(/[\r\n]+/g,' ').slice(0,220):'',
      result.names.length?'// Observed nested tools: '+result.names.join(', '):'',
      result.paths.length?'// Observed paths: '+result.paths.join(', ').slice(0,400):''].filter(Boolean).join('\n');
    const original=typeof block.arguments==='string'?block.arguments:JSON.stringify(args),after=JSON.stringify({...args,code:summary});
    return original.length-after.length>=MIN_SAVING?{...block,arguments:after}:null;
  }
  function project(agent,messages,{record=true}={}){
    if(!runtime.isEnabled(agent)||!runtime.get(agent).config.historyHygiene)return messages;
    if(!canRecall(agent)){if(record)get(agent).hiddenResults.clear();return messages;}
    const allowed=(feature,before,after,seq)=>{
      const economics=runtime.contextControl?.assess(agent,{messages:[before],proposedMessages:undefined,
        savedChars:JSON.stringify(before.content).length-JSON.stringify(after.content).length,changedSeq:seq,changedMessageId:before.id});
      if(record&&economics){runtime.contextControl.remember(agent,economics,feature);
        runtime.effects?.decide(agent,feature,economics.allowed?'approved':'deferred',economics.reason,{sourceSeq:seq,economics});}
      return economics?.allowed===true;
    };
    const state=sync(agent),pins=surfaceReferences(agent.session),root=runtime.get(agent).root,flow=taskFlow.phase(agent),focus=new Set((flow.focus??[]).map(file=>fileKey(root,file)));
    let programs=0,outputs=0,saved=0;const hidden=new Set();
    const result=messages.map(message=>{
      if(message.role==='assistant'&&runtime.get(agent).config.programHistory){
        let changed=false;
        const content=(message.content??[]).map(block=>{
          if(block.type!=='tool-call'||block.name!=='run_code')return block;
          const key=messageCall(message.id,block.id),call=key?state.programCalls.get(key):null;
          if(!call?.result||call.result.failed||isProtected(agent,block.id)||state.step-call.result.step<2||state.pinnedCalls.has(call.seq))return block;
          let view=state.programPlans.get(key);
          if(!view){
            view=codeView(call,block);
            if(view&&!allowed('programHistory',message,{...message,content:message.content.map(item=>item===block?view:item)},call.seq))view=null;
            if(view&&record)state.programPlans.set(key,view);
          }
          if(!view)return block;
          changed=true;programs++;
          saved+=String(block.arguments??'').length-view.arguments.length;
          return view;
        });
        if(!changed)return message;
        const after={...message,content};
        if(record)runtime.effects?.rewrite(agent,{feature:'programHistory',afterMessage:after,beforeMessages:[message]});
        return after;
      }
      if(message.role!=='tool')return message;
      const entry=state.results.get(message.id);
      if(!entry||entry.failed||isProtected(agent,entry.callId)||state.step-entry.step<AGE||state.pinnedResults.has(entry.seq)||pins.opaque||pins.targets.has(entry.seq))return message;
      // Reading is not evidence that the middle of a source is disposable.
      // Leave source windows to the existing larger, recoverable protocol.
      if(entry.reads.length)return message;
      const protect=file=>retainedSource(agent,file)||state.retainedSources.has(fileKey(root,file))||focus.has(fileKey(root,file));
      const original=agent.session.eventAt(entry.seq)?.data?.message;
      if(!original)return message;
      const existing=state.outputPlans.get(entry.seq);
      const planned=existing??planContextPrune(original,entry.reads,{seq:entry.seq,thresholdChars:8000,headChars:4096,tailChars:1024,retainSource:protect});
      if(!planned)return message;
      const reduction=resultText(message.content).length-resultText(planned.content).length;
      if(reduction<MIN_SAVING)return message;
      const after={...message,content:planned.content};
      if(!existing&&!allowed('historyOutput',message,after,entry.seq))return message;
      outputs++;saved+=reduction;
      hidden.add(entry.seq);
      if(record){
        state.outputPlans.set(entry.seq,planned);
        for(const range of planned.ranges)if(range.path)state.omittedSources.add(fileKey(root,range.path));
        runtime.effects?.rewrite(agent,{feature:'historyOutput',afterMessage:after,beforeMessages:[message],sourceSeqs:[entry.seq]});
        if(planned.dedupStats?.length)runtime.effects?.decide(agent,'blockDedup','applied','history-output-segments',{seq:entry.seq,segments:planned.dedupStats});
      }
      return after;
    });
    if(record){state.hiddenResults=hidden;state.requests++;state.programs+=programs;state.outputs+=outputs;state.chars+=saved;}
    return programs||outputs?result:messages;
  }
  return {project(agent,messages,options){
      if(get(agent).suspended)return messages;
      try{return project(agent,messages,options);}catch(error){get(agent).suspended=true;get(agent).hiddenResults.clear();runtime.problem?.(runtime.get(agent),'history-hygiene',String(error.message));return messages;}
    },observe,
    needsRecall(agent){
      if(!runtime.isEnabled(agent)||!runtime.get(agent).config.historyHygiene)return false;
      const s=sync(agent);if(s.suspended)return false;
      for(const call of s.calls.values())if(call.result&&!call.result.failed&&s.step-call.result.step>=1&&!s.pinnedCalls.has(call.seq)&&
        codeView(call,{arguments:JSON.stringify(call.args)}))return true;
      return [...s.results.values()].some(entry=>!entry.failed&&!entry.reads.length&&s.step-entry.step>=1&&
        resultText(agent.session.eventAt(entry.seq)?.data?.message?.content).length>8000);
    },
    bodyVisible(agent,seq){return !runtime.isEnabled(agent)||!runtime.get(agent).config.historyHygiene||get(agent).suspended||!get(agent).hiddenResults.has(seq);},
    manages(agent,seq){return runtime.isEnabled(agent)&&runtime.get(agent).config.historyHygiene&&!get(agent).suspended&&get(agent).hiddenResults.has(seq);},
    retainsSource(agent,file){return get(agent).retainedSources.has(fileKey(runtime.get(agent).root,file));},
    summary(agent){const s=sync(agent);return {enabled:runtime.isEnabled(agent)&&runtime.get(agent).config.historyHygiene,requestViews:s.requests,programViews:s.programs,outputViews:s.outputs,
      charsRemovedAcrossViews:s.chars,explicitRecoveries:s.restores,rereadPromotions:s.rereadPromotions,retainedCalls:s.pinnedCalls.size,retainedResults:s.pinnedResults.size,suspended:!!s.suspended,reasoning:'unchanged',canonicalHistory:'unchanged'};},
    disposeAgent:agent=>states.delete(agent.session.id),dispose:()=>states.clear()};
}
