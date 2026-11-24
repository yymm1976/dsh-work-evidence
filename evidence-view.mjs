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
  const proof=new Map();
  if(!state.records.length)return proof;
  const roots=new Set(state.records.flatMap(record=>record.roots));
  const messagesByRoot=new Map(),calls=new Map(),messageIds=new Map();
  for(const message of options.messages){
    if(message.id)messageIds.set(message.id,(messageIds.get(message.id)??0)+1);
    if(message.role==='assistant'&&message.source?.kind==='model'){
      for(const block of message.content??[]){
        if(block.type!=='tool-call'||!roots.has(block.id))continue;
        const prior=calls.get(block.id);
        calls.set(block.id,{name:block.name,count:(prior?.count??0)+1});
      }
    }
    const root=message.toolCallId;
    if(message.role!=='tool'||message.isError||!message.id||message.source?.kind!=='tool'||message.source.callId!==root||!roots.has(root))continue;
    const call=calls.get(root);
    if(call?.count===1&&['run_code','project_evidence'].includes(call.name)){
      const candidates=messagesByRoot.get(root)??[];
      candidates.push(message);
      messagesByRoot.set(root,candidates);
    }
  }
  for(const record of state.records){
    const candidates=record.roots.flatMap(root=>calls.get(root)?.count===1?messagesByRoot.get(root)??[]:[]);
    for(const message of candidates){
      if(messageIds.get(message.id)!==1)continue;
      if((message.content||[]).some(block=>block.type==='text'&&block.text.length<=2_000_000&&
        (includesValue(block.text,record.body)||record.renderedBody&&includesValue(block.text,record.renderedBody)))){
        proof.set(record,{messageId:message.id,callId:message.toolCallId});break;
      }
    }
  }
  return proof;
}

/** Only explicit views may omit a body; current source authority is checked by the reader first. */
export function createEvidenceViews(ctx,runtime,{needsCurrentBody=()=>false}={}){
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
    // evidenceVisibleViews counts visible records per request, so one reused body
    // adds its size every turn. That number grows with the session length and says
    // nothing about how many distinct bodies were ever visible; keep both, and name
    // the accumulating one for what it is.
    const s=runtime.get(agent);
    s.metrics.evidenceVisibleViewRecords+=state.proof.size;
    s.metrics.evidenceVisibleViewTurns=(s.metrics.evidenceVisibleViewTurns??0)+1;
    s.dirty=true;
  });
  ctx.on('session/event',(session,event)=>{if(event.type==='sandbox/mode')states.delete(session.id);});
  ctx.on('agent/disposed',({agent})=>states.delete(agent.session.id));
  ctx.on('session/disposed',session=>states.delete(session.id));
  ctx.on('dispose',()=>states.clear());
  return {async present(facts,args,exec,renderText=JSON.stringify){
    if(!['read','archive','source'].includes(args.mode))return facts;
    const s=runtime.get(exec.agent),state=current(exec.agent);
    const configuredView=s?.sessionDefaultResponseView??s?.config?.defaultResponseView??'full';
    const configured=configuredView==='reference-if-visible'?'reference-if-visible':'full';
    const view=args.responseView||configured,defaulted=!args.responseView;
    const observeDefault=(status,reason,details={})=>{
      if(defaulted)runtime.effects?.decide(exec.agent,'defaultResponseView',status,reason,{configured,...details});
    };
    if(!state){
      observeDefault('unavailable',!runtime.isEnabled(exec.agent)?'plugin-disabled':!s.config.evidenceViews?'evidence-views-disabled':'context-generation-unavailable');
      return args.responseView?{...facts,responseView:{kind:'full',bodyEmbedded:!!bodyEmbedded(facts),requestedBodiesComplete:facts.sources.length>0&&facts.sources.every(completeSource),reason:'disabled-or-context-generation-unavailable'}}:facts;
    }
    const eligible=facts.sources.length>0&&facts.sources.every(completeSource)&&!facts.budgetTruncated&&!facts.references?.truncated;
    const writtenSource=facts.sources.some(source=>needsCurrentBody(exec.agent,source.path));
    const requestKey=stable(Object.fromEntries(Object.entries(args).filter(([key])=>key!=='responseView')));
    const sourceKey=JSON.stringify(facts.sources.map(source=>[source.path,source.archive||null,source.entry||null]));
    const signature=stable({requestKey,facts});
    let identity=null;
    if(eligible&&!writtenSource)try{identity=await identities(facts.sources,facts.workspace,exec);}catch{ /* No identity proof means full delivery. */ }
    const live=current(exec.agent)===state;
    const prior=live&&identity&&[...state.proof].find(([record])=>record.signature===signature&&record.identity===identity);
    if(view==='reference-if-visible'&&prior){
      const [record,proof]=prior;
      const result={mode:args.mode,workspace:facts.workspace,observedAt:facts.observedAt,responseView:{kind:'reference',receiptId:record.id,
        messageId:proof.messageId,callId:proof.callId,generation:state.generation,firstObservedAt:record.observedAt,bodyEmbedded:false},
        sources:facts.sources.map((source,index)=>({path:source.path,state:'referenced',...(source.archive?{archive:source.archive,entry:source.entry}:{}),
          ...(source.requestedRange?{requestedRange:source.requestedRange}:{}),
          retrieveCurrent:{tool:'project_evidence',arguments:{...args,...(args.mode==='read'?{files:[args.files[index]]}:{}),responseView:'full'}}})),
        coverage:'Exact prior full receipt remains in the current model request. Re-read current source with responseView full. Historical text is separate evidence, not the current file.'};
      const beforeText=renderText(facts),afterText=renderText(result);
      if(afterText.length<beforeText.length&&(!runtime.effects||runtime.effects.benefit(exec.agent,'evidenceView',beforeText,afterText))){
        runtime.effects?.snippet(exec.agent,{callIds:[exec.callId,exec.rootCallId],feature:'evidenceView',beforeText,afterText});
        runtime.effects?.decide(exec.agent,'evidenceView','applied','current-request-proof');
        observeDefault('applied','configured-reference-if-visible');
        s.metrics.evidenceReferenceViews++;s.metrics.evidenceViewOutputChars+=measureText(result).stringUnits;s.dirty=true;return result;
      }
    }
    const previous=live&&state.records.findLast(record=>record.requestKey===requestKey);
    const sameSource=live&&state.records.some(record=>record.sourceKey===sourceKey);
    const missingReason=!live?'session-state-reset':previous
      ?previous.identity!==identity?'source-identity-changed':previous.signature!==signature?'source-or-selection-changed':previous.everVisible?'body-no-longer-visible':'body-not-confirmed-visible'
      :sameSource?'range-or-arguments-changed':state.resetReason||'first-delivery';
    const reason=view==='full'?(args.responseView==='full'?'explicit-full-view':'default-full-view'):writtenSource?'current-body-after-write':!eligible?'incomplete-source':!identity?'identity-unavailable':!prior?missingReason:'reference-not-smaller';
    s.metrics.evidenceFullViews++;if(view==='reference-if-visible')s.metrics.evidenceReferenceMisses++;    s.evidenceViewReasons[reason]=(s.evidenceViewReasons[reason]||0)+1;
    const id=randomUUID(),result={...facts,responseView:{kind:'full',receiptId:id,bodyEmbedded:!!bodyEmbedded(facts),requestedBodiesComplete:eligible,reason}};
    const rendered=renderText(result);
    s.metrics.evidenceViewOutputChars+=rendered.length;s.dirty=true;
    observeDefault(view==='full'?'applied':'not-applicable',view==='full'?'configured-full-view':'reference-precondition-not-met',{reason});
    if(live&&eligible&&identity){
      const body=JSON.stringify(result);
      state.records.push({id,requestKey,sourceKey,signature,identity,everVisible:false,body,
        renderedBody:rendered===body?null:rendered,observedAt:facts.observedAt,roots:[...new Set([exec.callId,exec.rootCallId].filter(Boolean))]});
      while(state.records.length>48||state.records.reduce((sum,record)=>sum+record.body.length+(record.renderedBody?.length??0),0)>1_000_000){const removed=state.records.shift();state.proof.delete(removed);}
    }
    return result;
  }};
}
