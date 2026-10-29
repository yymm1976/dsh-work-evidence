import {eventLog,isUserRequestMessage} from './runtime.mjs';
import {resultText} from './visible-results.mjs';

const MODELS=new Set(['cline/cline-pass/deepseek-v4.1-flash-1017','opendesign/deepseek-v4.1-flash']),EVENT='work-evidence/task-effort',CHECKPOINT='work-evidence/task-effort-state';
const messageOf=event=>event.data?.message??event.data;
const maxRequested=text=>/(?:推理|思考|reasoning|effort).{0,24}(?:max(?:imum)?\b|最高|最大)|(?:最高|最大|最强|max(?:imum)?).{0,16}(?:推理|思考|reasoning|effort)/iu.test(text);
const continuation=user=>user.source?.kind==='user-question-reply'||/^(?:(?:好的?|是|yes)[，,\s]*)?(?:请)?(?:继续(?:工作|处理|推进|优化)?|接着|接下来继续|continue|go on|proceed|carry on)(?:[，,。.!！\s]|$)/iu.test(resultText(user.content).trim());
export function selectTaskEffort(text){
  if(maxRequested(text))return {effort:'max',reason:'explicit-max-requirement'};
  if(!text||text.length>12000)return {effort:'max',reason:'missing-or-extended-requirement'};
  if(/多阶段|事务|并发|迁移|兼容|race condition|transaction|migration/iu.test(text))
    return {effort:'high',reason:'complex-requirement'};
  if(text.length>2400)return {effort:'high',reason:'extended-requirements'};
  const implementation=/(?:^|[。；;\n，,])\s*(?:请(?:你)?|需要(?:你)?|仅|只)?\s*(?:修复|实现|编写|重构|修改)|(?:^|[.;\n])\s*(?:please\s+)?(?:fix|implement|refactor|modify)\b/iu.test(text);
  const boundedSource=/\b(?:README|rules?|spec(?:ification)?|docs?)\b|规则|规范|完整要求|\.(?:py|[cm]?[jt]sx?|sql|rs|go|java)\b/iu.test(text);
  if(implementation&&boundedSource)return {effort:'low',reason:'specified-implementation'};
  if(/只读|read.only/iu.test(text))return /返回值|可观察行为|真实.{0,8}返回|stateAfter|return value/iu.test(text)
    ?{effort:'low',reason:'concrete-read-only-execution'}:{effort:'high',reason:'read-only-reconciliation'};
  return {effort:'high',reason:'open-requirement'};
}

/** Opt-in request policy, before native adapter binding and request/header logging. */
export function createTaskEffort(ctx,runtime,taskFlow){
  const states=new Map();
  function restored(agent){
    const log=eventLog(agent.session),saved=log.findLast(event=>[EVENT,CHECKPOINT].includes(event.type))?.data;
    if(!saved||saved.provider!=='magpie'||!MODELS.has(saved.model)||saved.model!==agent.options?.model||!['low','high','max'].includes(saved.effort))return null;
    const user=log.filter(event=>event.type==='user/message').map(messageOf).findLast(message=>isUserRequestMessage(message)&&message.id===saved.userId);
    if(!user)return null;
    return {userId:user.id,effort:saved.effort,initialEffort:saved.initialEffort??saved.effort,reason:saved.reason,
      owned:true,model:saved.model,recordedModel:saved.model,recordedEffort:saved.effort,mutationSeq:saved.mutationSeq??-1,observedExecutionSeq:saved.observedExecutionSeq??0,
      lastFailure:saved.lastFailure??null};
  }
  function capture(agent,messages){
    const user=messages.findLast(isUserRequestMessage);
    if(!user)return;
    const prior=states.get(agent.session.id)??restored(agent);
    if(prior?.userId===user.id){states.set(agent.session.id,prior);return;}
    if(prior&&continuation(user)&&!maxRequested(resultText(user.content))){
      states.set(agent.session.id,{...prior,userId:user.id,recordedEffort:undefined,recordedCheckpoint:undefined,inherited:true});
      return;
    }
    const selected=selectTaskEffort(resultText(user.content));
    states.set(agent.session.id,{userId:user.id,...selected,initialEffort:selected.effort,owned:prior?.owned??false,
      mutationSeq:-1,observedExecutionSeq:0,lastFailure:null,inherited:false});
  }
  function get(agent){
    if(!states.has(agent.session.id)){
      const log=eventLog(agent.session),user=log.filter(event=>event.type==='user/message').map(messageOf).findLast(isUserRequestMessage);
      capture(agent,user?[user]:[]);
    }
    return states.get(agent.session.id);
  }
  function release(agent){
    if(states.get(agent.session.id)?.owned&&typeof agent.requestHeaderLogged==='boolean')agent.requestHeaderLogged=false;
    states.delete(agent.session.id);
  }
  ctx.on('agent/request',async(payload,next)=>{
    const proposal=await next(),agent=payload.agent;
    if(!agent)return proposal;
    await runtime.init(agent,payload.signal);
    const state=get(agent),routeMatches=proposal.provider==='magpie'&&MODELS.has(proposal.model);
    const enabled=runtime.isEnabled(agent)&&runtime.get(agent).config.taskEffort&&routeMatches&&
      agent.options?.reasoningEffort==='max'&&typeof agent.requestHeaderLogged==='boolean';
    if(!enabled){
      if(state?.owned&&routeMatches)return {...proposal,reasoningEffort:agent.options?.reasoningEffort??'max'};
      return proposal;
    }
    if(!state)return proposal;
    const flow=taskFlow.summary(agent);let repeated=null;
    // One failed probe can be a wrong expectation or a wrapper typo. Escalate
    // only after the same failure repeats without an intervening execution or
    // source change; retain max afterwards to avoid another cache transition.
    if(flow.userId===state.userId){
      const executions=flow.nativeExecutions.filter(item=>item.userSeq===flow.userSeq&&item.seq>state.observedExecutionSeq);
      for(const execution of executions){
        const mutationSeq=Math.max(state.mutationSeq,execution.mutationSeq);
        const failed=execution.status==='failed'&&execution.failureSignature;
        if(failed){
          const prior=state.lastFailure;
          repeated=prior&&prior.signature===execution.failureSignature&&prior.mutationSeq===mutationSeq?[prior.seq,execution.seq]:null;
          state.lastFailure={seq:execution.seq,signature:execution.failureSignature,mutationSeq};
        }else{state.lastFailure=null;repeated=null;}
        state.mutationSeq=mutationSeq;state.observedExecutionSeq=execution.seq;
      }
      state.mutationSeq=Math.max(state.mutationSeq,flow.lastMutationSeq);
      if(state.lastFailure&&(state.lastFailure.mutationSeq!==state.mutationSeq||executions.length&&!flow.unresolvedErrors.some(error=>error.seq===state.lastFailure.seq))){
        state.lastFailure=null;repeated=null;
      }
    }
    if(repeated){state.effort='max';state.reason='same-execution-failure-without-progress';}
    const saved={userId:state.userId,provider:proposal.provider,model:proposal.model,configuredEffort:'max',initialEffort:state.initialEffort,
      effort:state.effort,reason:state.reason,inherited:!!state.inherited,mutationSeq:state.mutationSeq,
      observedExecutionSeq:state.observedExecutionSeq,lastFailure:state.lastFailure};
    if(state.recordedEffort!==state.effort||state.recordedModel!==proposal.model){
      agent.session.append(EVENT,{...saved,repeatedFailureSeqs:repeated??[]});
      state.recordedEffort=state.effort;
      state.model=state.recordedModel=proposal.model;
      runtime.effects?.decide(agent,'taskEffort','applied',state.reason,{configuredEffort:'max',effort:state.effort});
    }
    const checkpoint=JSON.stringify([state.userId,state.mutationSeq,state.observedExecutionSeq,state.lastFailure]);
    if(state.observedExecutionSeq&&state.recordedCheckpoint!==checkpoint){agent.session.append(CHECKPOINT,saved);state.recordedCheckpoint=checkpoint;}
    state.owned=true;
    return {...proposal,reasoningEffort:state.effort};
  });
  ctx.effect(()=>()=>{for(const id of [...states.keys()]){const agent=ctx.agents.get(id);if(agent)release(agent);}states.clear();});
  return {capture,release,summary(agent){const state=get(agent),enabled=runtime.isEnabled(agent)&&runtime.get(agent).config.taskEffort;return {enabled,
    model:state?.model??agent.options?.model??null,configuredEffort:agent.options?.reasoningEffort??null,initialEffort:enabled?state?.initialEffort??null:null,
    selectedEffort:enabled?state?.recordedEffort??null:null,reason:enabled?state?.reason??'not-selected':'disabled',classifierModelCalls:0};}};
}
