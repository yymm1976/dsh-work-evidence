import {compactionActive,rewriteSpacingReady} from './visible-results.mjs';

/** SW rewrites and request projection share the same cache transition interval. */
export function createHistoryCoordinator(runtime,sw,economics){
  const states=new Map();
  const state=agent=>{let value=states.get(agent.session.id);if(!value){value={boundaries:0,selected:0,lastRewriteStep:null,lastChoice:null};states.set(agent.session.id,value);}return value;};
  function beforeStep(payload,decision,generation){
    const agent=payload.agent;if(!agent||!runtime.isEnabled(agent)||decision.kind!=='enter')return decision;
    const session=agent.session,current=state(agent);current.boundaries++;
    const config=runtime.get(agent).config;
    if(!config.swEviction||sw.hasDuplicates(agent)===false)return decision;
    if(session.surface.contentGeneration!==generation||decision.messages.some(message=>message.source?.kind==='compact-checkpoint')||compactionActive(session))return decision;
    if(!rewriteSpacingReady(session,runtime.get(agent)))return decision;
    const proposal=sw.propose(agent);if(!proposal)return decision;
    const pressure=economics.pressure(agent);
    const cost=config.compressionControl?economics.remember(agent,economics.assess(agent,{savedChars:proposal.saving,changedSeq:proposal.changedSeq,emergency:pressure.emergency}),'coordinated-'+proposal.feature):{allowed:proposal.saving>=4*proposal.suffixChars,reason:'suffix-bound',savedTokensEstimate:Math.floor(proposal.saving/3.5)};
    if(!cost.allowed){runtime.effects?.decide(agent,proposal.feature,'deferred',cost.reason,{savedChars:proposal.saving,cost});return decision;}
    try{
      const result=proposal.apply();if(!result||result.replaced===0)return decision;
      current.selected++;current.lastRewriteStep=runtime.get(agent).step;current.lastChoice={feature:proposal.feature,targets:proposal.targets,savedChars:result.saved,cost};
    }catch(error){runtime.effects?.decide(agent,proposal.feature,'failed','history-commit-failed',{message:String(error.message).slice(0,240)});runtime.problem(runtime.get(agent),'history-coordination',error.message);}
    return decision;
  }
  return {beforeStep,mayProject(agent){return state(agent).lastRewriteStep!==runtime.get(agent).step;},summary(agent){return {...state(agent),policy:'SW prefix-cost and rewrite spacing; projection-follows-history'};},disposeAgent:agent=>states.delete(agent.session.id)};
}
