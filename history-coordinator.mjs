import {compactionActive,rewriteSpacingReady} from './visible-results.mjs';

/** P3 and SW propose before either mutates; one cache transition owns each exchange boundary. */
export function createHistoryCoordinator(runtime,ledger,sw,economics){
  const states=new Map();
  const state=agent=>{let value=states.get(agent.session.id);if(!value){value={boundaries:0,selected:0,overlapAvoided:0,lastRewriteStep:null,lastChoice:null};states.set(agent.session.id,value);}return value;};
  function beforeStep(payload,decision,generation){
    const agent=payload.agent;if(!agent||!runtime.isEnabled(agent)||decision.kind!=='enter')return decision;
    const session=agent.session,current=state(agent);current.boundaries++;
    const config=runtime.get(agent).config;
    if(!config.ledgerFoldWrite&&!config.swEviction)return decision;
    if(session.surface.contentGeneration!==generation||decision.messages.some(message=>message.source?.kind==='compact-checkpoint')||compactionActive(session))return decision;
    if(!rewriteSpacingReady(session,runtime.get(agent)))return decision;
    const candidates=[...ledger.planFolds(payload,decision,generation),sw.propose(agent)].filter(Boolean),viable=[];
    const pressure=economics.pressure(agent);
    for(const proposal of candidates){
      const cost=runtime.get(agent).config.compressionControl?economics.remember(agent,economics.assess(agent,{savedChars:proposal.saving,changedSeq:proposal.changedSeq,emergency:pressure.emergency}),'coordinated-'+proposal.feature):{allowed:proposal.saving>=4*proposal.suffixChars,reason:'suffix-bound',savedTokensEstimate:Math.floor(proposal.saving/3.5)};
      if(!cost.allowed){runtime.effects?.decide(agent,proposal.feature,'deferred',cost.reason,{savedChars:proposal.saving,cost});continue;}
      const score=cost.futureSavingEstimate!==null&&cost.futureSavingEstimate!==undefined?cost.futureSavingEstimate-1.25*(cost.refillCostEstimate??0):cost.savedTokensEstimate;
      viable.push({...proposal,cost,score});
    }
    viable.sort((a,b)=>b.score-a.score||b.saving-a.saving||b.changedSeq-a.changedSeq);
    const selected=viable[0];if(!selected)return decision;
    const owned=new Set(selected.targets);
    for(const other of viable.slice(1)){const overlap=other.targets.some(seq=>owned.has(seq));if(overlap)current.overlapAvoided++;runtime.effects?.decide(agent,other.feature,'deferred',overlap?'covered-by-selected-plan':'coalesced-cache-transition',{selected:selected.feature,targets:other.targets});}
    try{
      const result=selected.apply();if(!result||result.replaced===0)return decision;
      current.selected++;current.lastRewriteStep=runtime.get(agent).step;current.lastChoice={feature:selected.feature,targets:selected.targets,savedChars:selected.saving,cost:selected.cost};
    }catch(error){runtime.effects?.decide(agent,selected.feature,'failed','history-commit-failed',{message:String(error.message).slice(0,240)});runtime.problem(runtime.get(agent),'history-coordination',error.message);}
    return decision;
  }
  return {beforeStep,mayProject(agent){return state(agent).lastRewriteStep!==runtime.get(agent).step;},summary(agent){return {...state(agent),policy:'shared-candidates; one-owner-per-boundary; shared-prefix-cost; projection-follows-history'};},disposeAgent:agent=>states.delete(agent.session.id)};
}
