export const resultText=content=>(content??[]).filter(block=>block?.type==='text').map(block=>block.text??'').join('\n');

export function parseResult(text){
  try{return JSON.parse(text);}catch{return null;}
}

export function historyReferences(message){
  const found=[];
  for(const match of resultText(message?.content).matchAll(/^\[work-evidence history (\{[^\n]*\})\]$/gm)){
    try{const reference=JSON.parse(match[1]);if(Number.isSafeInteger(reference.seq)&&reference.seq>=0)found.push(reference);}catch{}
  }
  return found;
}

// Only an exact complete displayed value can prove that an outer failure is
// the same failure already recorded for a nested operation.
export function resultIdentity(content){
  const text=resultText(content).trim();
  if(!text||text.length>64000)return null;
  return JSON.stringify(parseResult(text)??text);
}

export function resultHasProblem(value){
  if(typeof value==='string')return /\b(?:NOT_FOUND|PERMISSION_DENIED|CANCELLED|PTC-X\d+)\b|(?:^|\n)\s*(?:TypeError|Error|Traceback)\b/.test(value);
  let remaining=2048;
  const visit=(node,depth=0)=>{
    if(--remaining<0||depth>16)return true;
    if(!node||typeof node!=='object')return false;
    if(node.isError===true||node.success===false||node.ok===false||node.error||node.err||typeof node.stderr==='string'&&node.stderr.trim()||
      Number.isFinite(node.exitCode)&&node.exitCode!==0||Number.isFinite(node.exit_code)&&node.exit_code!==0||
      ['error','failed','cancelled','unavailable','disabled','deopt','unknown','partial','not_found','running','pending','queued','blocked','not-attempted'].includes(String(node.status??node.state??'').toLowerCase())||
      node.complete===false||node.rangeComplete===false||node.textComplete===false||node.scanComplete===false||node.truncated===true||node.budgetTruncated===true)return true;
    if(Array.isArray(node))return node.some(item=>visit(item,depth+1));
    // Applicability and optional host capabilities do not change the recorded call's outcome.
    return Object.entries(node).some(([key,item])=>!['text','lines','content','fileDependencies','evidenceAssessment','evidenceValidity','hostTransfer','referencedSessions','sourceReads'].includes(key)&&visit(item,depth+1));
  };
  return visit(value);
}

export function resultReference(seq,details={}){
  return {kind:'work-evidence-reference',seq,...details,
    retrieveOriginal:{tool:'work_recall',arguments:{kind:'output',seq}},
    note:'Historical content is available at the listed event. This reference does not assert that the workspace is unchanged.'};
}

export function contentReferences(content){
  const targets=new Set();let opaque=false,hasReferences=false;
  const add=value=>{const seq=typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value)?Number(value):NaN;if(Number.isSafeInteger(seq)&&seq>=0)targets.add(seq);else opaque=true;};
  const visit=(value,depth=0)=>{
    if(!value)return;
    if(depth>16){opaque=true;return;}
    if(typeof value==='string'){
      if(!/work-evidence-reference|\[work-evidence history |\[work-evidence ledger receipt\]|\[SW evicted\]/.test(value))return;
      hasReferences=true;
      const parsed=parseResult(value);
      if(parsed!==null&&parsed!==value){visit(parsed,depth+1);return;}
      const text=value.replace(/\\+"/g,'"');
      for(const match of text.matchAll(/\[work-evidence history ([^\]\n]*)\]/g)){
        const seq=match[1].match(/"seq"\s*:\s*(\d+)/);if(seq)add(seq[1]);else opaque=true;
      }
      if((text.match(/\[work-evidence history /g)??[]).length!==(text.match(/\[work-evidence history [^\]\n]*\]/g)??[]).length)opaque=true;
      for(const segment of text.split('[work-evidence ledger receipt]').slice(1)){
        const seqs=[...segment.matchAll(/\bseq=(\d+)/g)];if(!seqs.length)opaque=true;
        for(const match of seqs)add(match[1]);
      }
      for(const segment of text.split('work-evidence-reference').slice(1)){
        const seq=segment.match(/^"\s*,\s*"seq"\s*:\s*(\d+)/);if(seq)add(seq[1]);else opaque=true;
      }
      if(text.includes('[SW evicted]'))opaque=true;
      return;
    }
    if(typeof value!=='object')return;
    if(value.kind==='work-evidence-reference'){hasReferences=true;add(value.seq);}
    if(['work_state','work_recall'].includes(value.retrieveOriginal?.tool)){hasReferences=true;add(value.retrieveOriginal.arguments?.seq);}
    for(const [key,child] of Object.entries(value))if(!(key==='kind'&&child==='work-evidence-reference'))visit(child,depth+1);
  };
  visit(content);
  return {targets,opaque,hasReferences};
}

const surfaceReferenceCache=new WeakMap();
const historicalReferenceCache=new WeakMap();
export function hasHistoricalReferences(agent){
  const session=agent.session,nodes=session.surface?.nodes??[],generation=session.surface?.contentGeneration;
  const previous=historicalReferenceCache.get(session);
  const appendOnly=generation!==undefined&&previous?.generation===generation&&nodes.length>=previous.scanned&&
    (!previous.scanned||nodes[previous.scanned-1]===previous.lastSeq);
  if(appendOnly&&previous.found)return true;
  for(let index=appendOnly?previous.scanned:0;index<nodes.length;index++){
    let event;try{event=session.eventAt(nodes[index]);}catch{return true;}
    if(!event)return true;
    const message=event.data?.message??event.data;
    if((message?.content??[]).some(block=>block?.type==='text'&&typeof block.text==='string'&&
      /work_recall|work_state|\[work-evidence history |work-evidence-reference|\[work-evidence ledger receipt\]|\[SW evicted\]/.test(block.text))){
      historicalReferenceCache.set(session,{generation,scanned:nodes.length,lastSeq:nodes.at(-1),found:true});
      return true;
    }
  }
  historicalReferenceCache.set(session,{generation,scanned:nodes.length,lastSeq:nodes.at(-1),found:false});
  return false;
}
export function surfaceReferences(session){
  const generation=session.surface.contentGeneration,previous=surfaceReferenceCache.get(session);
  if(previous&&generation!==undefined&&previous.generation===generation&&previous.seq===session.seq)return previous.result;
  const targets=new Set();let opaque=false;
  for(const seq of session.surface.nodes){
    const event=session.eventAt(seq);
    if(!event){opaque=true;continue;}
    for(const block of event?.data?.message?.content??event?.data?.content??[])if(block.type==='text'){
      const refs=contentReferences(block.text);if(refs.opaque)opaque=true;
      for(const target of refs.targets)targets.add(target);
    }
  }
  const result={targets,opaque};
  if(generation!==undefined)surfaceReferenceCache.set(session,{generation,seq:session.seq,result});
  return result;
}

export function recallResult(agent,{seq,offset=0,maxChars=16000}={}){
  if(!Number.isSafeInteger(seq)||seq<0)throw new Error('recall requires a non-negative event seq');
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('recall offset must be non-negative');
  if(!Number.isSafeInteger(maxChars)||maxChars<256||maxChars>64000)throw new Error('recall maxChars must be between 256 and 64000');
  const event=agent.session.eventAt(seq);
  if(event?.type!=='tool/result')return {status:'unavailable',seq,reason:'The requested event is not an available tool result in this session.'};
  const message=event.data?.message??{},text=resultText(message.content),end=Math.min(text.length,offset+maxChars);
  const nonTextBlocks=(message.content??[]).filter(block=>block.type!=='text').map(block=>block.type);
  return {status:'observed',seq,original:event.surfaceOp?.op!=='replace',historical:true,isError:!!message.isError,offset,totalChars:text.length,
    text:text.slice(offset,end),textComplete:end>=text.length,complete:end>=text.length&&!nonTextBlocks.length,nextOffset:end<text.length?end:null,
    nonTextBlocks,note:'Recorded session output, not a new observation of the current workspace. Non-text blocks are listed but not included in this text response.'};
}

const historySizes=new WeakMap();
export function eventChars(event){
  let chars=0;
  for(const block of event?.data?.message?.content??event?.data?.content??[]){
    if(block.type==='text'||block.type==='reasoning')chars+=String(block.text??'').length;
    else if(block.type==='tool-call')chars+=typeof block.arguments==='string'?block.arguments.length:JSON.stringify(block.arguments??{}).length;
  }
  return chars;
}

export function historyBudget(session,minChars=100000){
  const old=historySizes.get(session),generation=session.surface.contentGeneration;
  if(old?.seq===session.seq&&old.generation===generation)return {chars:old.chars,ready:old.chars>=minChars};
  let chars=0;
  for(const seq of session.surface.nodes){
    chars+=eventChars(session.eventAt(seq));
  }
  historySizes.set(session,{seq:session.seq,generation,chars});
  return {chars,ready:chars>=minChars};
}

export function compactionActive(session){
  for(let seq=session.seq-1;seq>=0;seq--){
    const event=session.eventAt(seq);
    if(event?.type==='compaction/end'||event?.type==='session/end-seed')return false;
    if(event?.type==='compaction/start')return true;
  }
  return false;
}

export function rewriteSpacingReady(session,state,minSteps=8){
  if(!Number.isSafeInteger(state.lastHistoryRewriteSeq))return true;
  let steps=0;
  for(let seq=state.lastHistoryRewriteSeq;seq<session.seq;seq++)if(session.eventAt(seq)?.type==='step/start'&&++steps>=minSteps)return true;
  return false;
}
