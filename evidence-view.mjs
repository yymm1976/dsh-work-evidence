import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {measureText} from './request-observation.mjs';

const stable=value=>JSON.stringify(normalize(value));
function normalize(value){
  if(Array.isArray(value))return value.map(normalize);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key=>!['observedAt','elapsedMs','cache','responseView','responseSize'].includes(key)).map(key=>[key,normalize(value[key])]));
}
function completeSource(source){
  if(source.state!=='observed'||source.budgetTruncated||source.lineTextTruncated||source.scanComplete===false)return false;
  if(source.members)return source.members.length>0&&source.members.every(member=>completeMatches(member.matches));
  if(source.matches)return completeMatches(source.matches);
  return source.rangeComplete===true&&source.lines?.length>0;
}
const completeMatches=matches=>Array.isArray(matches)&&matches.length>0&&matches.every(match=>match.complete===true&&match.lines?.length>0&&!match.lines.some(line=>line.lineTextTruncated));
const bodyEmbedded=facts=>facts.sources.some(source=>source.lines?.length||source.matches?.some(match=>match.lines?.length)||source.members?.some(member=>member.matches?.some(match=>match.lines?.length)));
function generation(agent){try{const value=agent.session.surface?.contentGeneration;return Number.isSafeInteger(value)?value:null;}catch{return null;}}
async function identities(sources,workspace,exec){
  const values=[];
  for(const source of sources){
    const stat=await exec.nativeFiles.stat(workspace,source.archive||source.path,exec.signal);
    if(!stat.exists||stat.type!=='file'||stat.version===null)return null;
    values.push([stat.path,stat.version,stat.bytes]);
  }
  return JSON.stringify(values);
}
function includesValue(value,expected,depth=0){
  if(depth>12||value===null||value===undefined)return false;
  if(typeof value==='string'){
    if(value===expected)return true;
    try{return includesValue(JSON.parse(value),expected,depth+1);}catch{return false;}
  }
  if(typeof value!=='object')return false;
  if(value.responseView?.kind==='full'&&JSON.stringify(value)===expected)return true;
  return Object.values(value).some(child=>includesValue(child,expected,depth+1));
}
function proofFor(options,state){
  const proof=new Map(),messages=options.messages;
  for(const record of state.records){
    for(const message of messages){
      if(message.role!=='tool'||message.isError||!message.id||message.source?.kind!=='tool'||message.source.callId!==message.toolCallId||!record.roots.includes(message.toolCallId))continue;
      if(messages.filter(item=>item.id===message.id).length!==1)continue;
      const preceding=messages.slice(0,messages.indexOf(message));
      const calls=preceding.flatMap(item=>item.role==='assistant'&&item.source?.kind==='model'?(item.content||[]).filter(block=>block.type==='tool-call'&&block.id===message.toolCallId):[]);
      if(calls.length!==1||!['run_code','project_evidence'].includes(calls[0].name))continue;
      if((message.content||[]).some(block=>block.type==='text'&&block.text.length<=2_000_000&&includesValue(block.text,record.body))){proof.set(record,{messageId:message.id,callId:message.toolCallId});break;}
    }
  }
  return proof;
}

/** Only explicit views may omit a body; current source authority is checked by the reader first. */
export function createEvidenceViews(ctx,runtime){
  const states=new Map();
  const current=agent=>{
    const s=runtime.get(agent),gen=generation(agent),old=states.get(s.id);
    if(gen===null||!runtime.isEnabled(agent)||!s.config.evidenceViews){states.delete(s.id);return null;}
    if(old?.agent===agent&&old.generation===gen&&old.policyEpoch===(s.viewEpoch||0))return old;
    if(states.size>=16)states.delete(states.keys().next().value);
    const resetReason=old&&old.generation!==gen?'new-context-delivery':old?'session-state-reset':null;
    const value={agent,generation:gen,policyEpoch:s.viewEpoch||0,epoch:0,records:[],proof:new Map(),resetReason};states.set(s.id,value);return value;
  };
  ctx.on('llm/stream',async function*(options,next){
    if(options.purpose){yield* next();return;}
    const agent=options.sessionId?ctx.agents.get(options.sessionId):null;
    if(agent&&runtime.get(agent).auxiliarySignals.has(options.signal)){yield* next();return;}
    if(!agent){for(const state of states.values())state.proof.clear();yield* next();return;}
    const state=current(agent);if(!state){yield* next();return;}
    const epoch=++state.epoch;state.proof.clear();
    const proof=()=>{try{return proofFor(options,state);}catch{return new Map();}};
    const before=proof();let finished=false;
    for await(const chunk of next()){if(chunk.type==='finish')finished=['stop','tool-calls'].includes(chunk.reason?.kind);yield chunk;}
    if(!finished||options.signal?.aborted||current(agent)!==state||state.epoch!==epoch)return;
    const after=proof();
    state.proof=new Map([...before].filter(([record,value])=>after.get(record)?.messageId===value.messageId));
    const newlyVisible=[...state.proof.keys()].filter(record=>!record.everVisible).length;
    for(const record of state.proof.keys())record.everVisible=true;
    runtime.get(agent).metrics.evidenceVisibilityStreams=(runtime.get(agent).metrics.evidenceVisibilityStreams??0)+1;
    runtime.get(agent).metrics.evidenceUniqueVisibleViews=(runtime.get(agent).metrics.evidenceUniqueVisibleViews??0)+newlyVisible;
    const s=runtime.get(agent);s.metrics.evidenceVisibleViews+=state.proof.size;s.dirty=true;
  });
  ctx.on('session/event',(session,event)=>{if(event.type==='sandbox/mode')states.delete(session.id);});
  ctx.on('agent/disposed',({agent})=>states.delete(agent.session.id));
  ctx.on('session/disposed',session=>states.delete(session.id));
  ctx.on('dispose',()=>states.clear());
  return {async present(facts,args,exec){
    if(!['read','archive','source'].includes(args.mode))return facts;
    const s=runtime.get(exec.agent),state=current(exec.agent);
    const configuredView=s?.sessionDefaultResponseView??s?.config?.defaultResponseView??'full';
    const configured=configuredView==='reference-if-visible'?'reference-if-visible':'full';
    const view=args.responseView||configured;
    if(!state)return args.responseView?{...facts,responseView:{kind:'full',bodyEmbedded:!!bodyEmbedded(facts),requestedBodiesComplete:facts.sources.length>0&&facts.sources.every(completeSource),reason:'disabled-or-context-generation-unavailable'}}:facts;
    const eligible=facts.sources.length>0&&facts.sources.every(completeSource)&&!facts.budgetTruncated&&!facts.references?.truncated;
    const requestKey=stable(Object.fromEntries(Object.entries(args).filter(([key])=>key!=='responseView')));
    const sourceKey=JSON.stringify(facts.sources.map(source=>[source.path,source.archive||null,source.entry||null]));
    const signature=stable({requestKey,facts});
    let identity=null;
    if(eligible)try{identity=await identities(facts.sources,facts.workspace,exec);}catch{ /* No identity proof means full delivery. */ }
    const prior=identity&&[...state.proof].find(([record])=>record.signature===signature&&record.identity===identity);
    if(view==='reference-if-visible'&&prior){
      const [record,proof]=prior;
      const result={mode:args.mode,workspace:facts.workspace,observedAt:facts.observedAt,responseView:{kind:'reference',receiptId:record.id,
        messageId:proof.messageId,callId:proof.callId,generation:state.generation,firstObservedAt:record.observedAt,bodyEmbedded:false},
        sources:facts.sources.map((source,index)=>({path:source.path,state:'referenced',...(source.archive?{archive:source.archive,entry:source.entry}:{}),
          ...(source.requestedRange?{requestedRange:source.requestedRange}:{}),
          retrieveCurrent:{tool:'project_evidence',arguments:{...args,...(args.mode==='read'?{files:[args.files[index]]}:{}),responseView:'full'}}})),
        coverage:'Exact prior full receipt remains in the current model request. Re-read current source with responseView full. Historical text is separate evidence, not the current file.'};
      if(measureText(result).stringUnits<measureText(facts).stringUnits&&(!runtime.effects||runtime.effects.benefit(exec.agent,'evidenceView',JSON.stringify(facts),JSON.stringify(result)))){
        runtime.effects?.snippet(exec.agent,{callIds:[exec.callId,exec.rootCallId],feature:'evidenceView',beforeText:JSON.stringify(facts),afterText:JSON.stringify(result)});
        runtime.effects?.decide(exec.agent,'evidenceView','applied','current-request-proof');
        s.metrics.evidenceReferenceViews++;s.metrics.evidenceViewOutputChars+=measureText(result).stringUnits;s.dirty=true;return result;
      }
    }
    const previous=state.records.findLast(record=>record.requestKey===requestKey);
    const sameSource=state.records.some(record=>record.sourceKey===sourceKey);
    const missingReason=previous
      ?previous.identity!==identity?'source-identity-changed':previous.signature!==signature?'source-or-selection-changed':previous.everVisible?'body-no-longer-visible':'body-not-confirmed-visible'
      :sameSource?'range-or-arguments-changed':state.resetReason||'first-delivery';
    const reason=view==='full'?(args.responseView==='full'?'explicit-full-view':'default-full-view'):!eligible?'incomplete-source':!identity?'identity-unavailable':!prior?missingReason:'reference-not-smaller';
    s.metrics.evidenceFullViews++;if(view==='reference-if-visible')s.metrics.evidenceReferenceMisses++;    s.evidenceViewReasons[reason]=(s.evidenceViewReasons[reason]||0)+1;
    const id=randomUUID(),result={...facts,responseView:{kind:'full',receiptId:id,bodyEmbedded:!!bodyEmbedded(facts),requestedBodiesComplete:eligible,reason}};
    s.metrics.evidenceViewOutputChars+=measureText(result).stringUnits;s.dirty=true;
    if(eligible&&identity){
      state.records.push({id,requestKey,sourceKey,signature,identity,everVisible:false,body:JSON.stringify(result),observedAt:facts.observedAt,roots:[...new Set([exec.callId,exec.rootCallId].filter(Boolean))]});
      while(state.records.length>48||state.records.reduce((sum,record)=>sum+record.body.length,0)>1_000_000){const removed=state.records.shift();state.proof.delete(removed);}
    }
    return result;
  }};
}
