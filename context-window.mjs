import {resultText,parseResult,resultHasProblem,resultReference,contentReferences,surfaceReferences,historyBudget,recallResult,compactionActive,rewriteSpacingReady,eventChars} from './visible-results.mjs';

const MAX_OBSERVATIONS=200,MAX_BATCH=8,MIN_SAVING=512;

/** SW retains unique results; only an exact duplicate with a later visible body can leave the surface. */
export function createContextWindow(ctx,runtime){
  const ledgers=new Map(),pendingCalls=new Map();
  const get=agent=>{
    const id=agent.session.id;let state=ledgers.get(id);
    if(!state||state.policyEpoch!==(runtime.get(agent).viewEpoch||0)){state={policyEpoch:runtime.get(agent).viewEpoch||0,observations:[],bodyCounts:new Map(),duplicateBodies:0,observedChars:0,step:0,evictions:[],recoveries:[],problems:[],lastRewriteStep:-Infinity,
      debug:{outerCalls:0,sessionResults:0,matched:0},skips:{}};ledgers.set(id,state);}
    return state;
  };
  const config=agent=>runtime.get(agent).config;
  const skip=(state,reason)=>{state.skips[reason]=(state.skips[reason]??0)+1;};
  function countBody(state,item,delta){
    let bodies=state.bodyCounts.get(item.tool);
    if(!bodies){bodies=new Map();state.bodyCounts.set(item.tool,bodies);}
    const before=bodies.get(item.text)??0,after=before+delta;
    if(before===1&&after===2)state.duplicateBodies++;
    if(before===2&&after===1)state.duplicateBodies--;
    if(after>0)bodies.set(item.text,after);else bodies.delete(item.text);
    if(!bodies.size)state.bodyCounts.delete(item.tool);
  }
  function recordResult(agent,callInfo,event){
    if(!runtime.isEnabled(agent)||!config(agent).swLedger)return;
    const message=event.data?.message,content=message?.content??[],text=resultText(content),state=get(agent);
    if(message?.isError||content.some(block=>block.type!=='text'))return skip(state,'error-or-media');
    if(!agent.session.surface.nodes.includes(event.seq)||!text)return;
    const parsed=parseResult(text);
    if(resultHasProblem(parsed??text))return skip(state,'problem-result');
    if(contentReferences(text).hasReferences)return skip(state,'reference-result');
    if(['work_state','work_status','work_report'].includes(callInfo.name))return;
    if(text.length>1024*1024)return skip(state,'large-result');
    const observation={seq:event.seq,tool:callInfo.name,text,chars:text.length,step:state.step,evicted:false};
    state.observations.push(observation);state.observedChars+=text.length;countBody(state,observation,1);
    while(state.observations.length>MAX_OBSERVATIONS||state.observedChars>8*1024*1024){
      const removed=state.observations.shift();state.observedChars-=removed.chars;
      if(!removed.evicted)countBody(state,removed,-1);
    }
  }
  function candidates(agent){
    const state=get(agent),session=agent.session,settings=config(agent);
    if(!state.duplicateBodies)return [];
    const pins=surfaceReferences(session);
    if(pins.opaque)return [];
    const live=state.observations.filter(item=>!item.evicted&&session.surface.nodes.includes(item.seq)&&
      (runtime.isBodyVisible?.(agent,item.seq)??true)&&!runtime.isProjectionManaged?.(agent,item.seq));
    const out=[],latest=new Map();
    for(const item of live){let byText=latest.get(item.tool);if(!byText){byText=new Map();latest.set(item.tool,byText);}byText.set(item.text,item);}
    for(let index=0;index<live.length;index++){
      const item=live[index];
      if(state.step-item.step<settings.swEvictionSteps||pins.targets.has(item.seq))continue;
      const later=latest.get(item.tool)?.get(item.text);
      if(!later||later.seq<=item.seq||resultText(session.eventAt(later.seq)?.data?.message?.content)!==item.text)continue;
      const body=JSON.stringify(resultReference(later.seq,{originalSeq:item.seq,tool:item.tool}));
      if(item.chars-body.length<MIN_SAVING)continue;
      out.push({...item,targetSeq:later.seq,body,saving:item.chars-body.length});
    }
    return out;
  }
  function propose(agent){
    const state=get(agent),settings=config(agent),session=agent.session;
    if(!runtime.isEnabled(agent)||!settings.swLedger||!settings.swEviction||runtime.canRecall?.(agent)!==true)return null;
    // Unique results cannot produce a safe SW fold. Avoid all history and prefix-cost scans.
    if(!state.duplicateBodies)return null;
    const decline=reason=>{skip(state,reason);runtime.effects?.decide(agent,'swFold','not-applicable',reason);return null;};
    if(!rewriteSpacingReady(session,runtime.get(agent)))return decline('shared-rewrite-spacing');
    if(state.step-state.lastRewriteStep<Math.max(8,settings.swEvictionSteps))return decline('rewrite-spacing');
    if(!historyBudget(session).ready)return decline('small-context');
    const nodes=[...session.surface.nodes],suffix=new Map();let suffixChars=0;
    for(let index=nodes.length-1;index>=0;index--){suffix.set(nodes[index],suffixChars);suffixChars+=eventChars(session.eventAt(nodes[index]));}
    const economicControl=runtime.contextControl&&settings.compressionControl;
    const list=candidates(agent).filter(item=>economicControl||item.saving>=4*suffix.get(item.seq))
      .sort((a,b)=>b.saving/Math.max(1,suffix.get(b.seq))-a.saving/Math.max(1,suffix.get(a.seq))).slice(0,MAX_BATCH);
    if(list.reduce((sum,item)=>sum+item.saving,0)<4096)return decline('small-batch');
    if(compactionActive(session))return decline('active-compaction');
    return {feature:'swFold',saving:list.reduce((sum,item)=>sum+item.saving,0),changedSeq:Math.min(...list.map(item=>item.seq)),targets:list.map(item=>item.seq),retained:list.map(item=>item.targetSeq),
      suffixChars:Math.max(...list.map(item=>suffix.get(item.seq))),apply:()=>applyPlan(agent,list)};
  }
  function beforeStep(agent){
    const proposal=propose(agent);if(!proposal)return null;
    if(runtime.contextControl&&config(agent).compressionControl){
      const decision=runtime.contextControl.remember(agent,runtime.contextControl.assess(agent,{
        savedChars:proposal.saving,changedSeq:proposal.changedSeq,
        emergency:runtime.contextControl.pressure(agent).emergency}),'sw-duplicates');
      if(!decision.allowed){runtime.effects?.decide(agent,'swFold','deferred',decision.reason);return skip(get(agent),decision.reason);}
    }
    return proposal.apply();
  }
  function applyPlan(agent,list){
    const state=get(agent),session=agent.session;
    let replaced=0,saved=0;
    const targets=new Set(list.map(item=>item.targetSeq));
    for(const item of list){
      if(targets.has(item.seq))continue;
      const original=session.eventAt(item.seq),target=session.eventAt(item.targetSeq);
      if(!session.surface.nodes.includes(item.seq)||!session.surface.nodes.includes(item.targetSeq)||
        resultText(original?.data?.message?.content)!==item.text||resultText(target?.data?.message?.content)!==item.text)continue;
      try{
        const replacement=session.append('tool/result',{...original.data,message:{...original.data.message,content:[{type:'text',text:item.body}]}},
          {surfaceOp:{op:'replace',startSeq:item.seq,endSeq:item.seq},sourceEventSeqs:[item.seq]});
        runtime.effects?.rewrite(agent,{feature:'swFold',seq:replacement.seq,sourceSeqs:[item.seq],retainedSeqs:[item.targetSeq],afterMessage:replacement.data.message,beforeMessages:[original.data.message]});
        const observed=state.observations.find(value=>value.seq===item.seq);if(observed){countBody(state,observed,-1);observed.evicted=true;}
        state.evictions.push({seq:item.seq,targetSeq:item.targetSeq,replacementSeq:replacement.seq,charsBefore:item.chars,charsAfter:item.body.length,saved:item.saving});
        replaced++;saved+=item.saving;
      }catch(error){state.problems.push(String(error?.message??error).slice(0,240));}
    }
    if(replaced){state.lastRewriteStep=state.step;runtime.get(agent).lastHistoryRewriteSeq=session.seq;runtime.effects?.decide(agent,'swFold','applied','selected-history-plan',{replaced,charsSaved:saved});}
    state.evictions=state.evictions.slice(-64);state.problems=state.problems.slice(-8);
    return {replaced,saved};
  }
  function observe(){
    ctx.on('tools/execute',async(exec,next)=>{
      if(exec.agent&&!exec.parent&&runtime.isEnabled(exec.agent)&&config(exec.agent).swLedger){
        get(exec.agent).debug.outerCalls++;
        pendingCalls.set(exec.callId,{agent:exec.agent,name:exec.name});
        if(pendingCalls.size>512)pendingCalls.delete(pendingCalls.keys().next().value);
      }
      return next();
    });
    ctx.on('session/event',(session,event)=>{
      const agent=ctx.agents.get(session.id);if(!agent)return;
      if(event.type==='step/start'){get(agent).step++;return;}
      if(event.type!=='tool/result'||event.surfaceOp?.op==='replace')return;
      const state=get(agent);state.debug.sessionResults++;
      const callId=event.data?.message?.source?.callId,call=pendingCalls.get(callId);
      pendingCalls.delete(callId);
      if(!call||call.agent!==agent)return;
      state.debug.matched++;recordResult(agent,call,event);
    });
    ctx.on('agent/disposed',({agent})=>{
      ledgers.delete(agent.session.id);
      for(const [id,call] of pendingCalls)if(call.agent===agent)pendingCalls.delete(id);
    });
    ctx.on('dispose',()=>{ledgers.clear();pendingCalls.clear();});
  }
  return {observe,beforeStep,propose,get,recordResult,hasDuplicates:agent=>get(agent).duplicateBodies>0,
    recall(agent,args){const value=recallResult(agent,args);if(value.status==='observed'){const state=get(agent);state.recoveries.push({seq:args.seq});state.recoveries=state.recoveries.slice(-64);}return value;},
    clear(agent){ledgers.delete(agent.session.id);},
    detail(agent){
      const state=get(agent),legacy=[];
      for(const seq of agent.session.surface.nodes){
        const event=agent.session.eventAt(seq);
        if(event?.type!=='tool/result'||!resultText(event.data?.message?.content).startsWith('[SW evicted]'))continue;
        const originalSeq=event.sourceEventSeqs?.find(source=>agent.session.eventAt(source)?.type==='tool/result');
        if(Number.isSafeInteger(originalSeq))legacy.push({replacementSeq:seq,...resultReference(originalSeq,{legacy:true})});
      }
      return {recentEvictions:state.evictions.slice(-8),legacyRecoveries:legacy.slice(-16),problems:state.problems.slice()};
    },
    metrics(agent){const state=get(agent);return {observations:state.observations.length,duplicateBodies:state.duplicateBodies,retainedChars:state.observedChars,evicted:state.evictions.length,recoveries:state.recoveries.length,
      candidates:candidates(agent).length,charsSaved:state.evictions.reduce((sum,item)=>sum+item.saved,0),
      policy:'later-visible-identical-body',skips:{...state.skips},problems:state.problems.slice(),debug:state.debug};},
  };
}
