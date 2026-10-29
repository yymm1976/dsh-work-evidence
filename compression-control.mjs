import {argsOf} from './runtime.mjs';
import {eventChars,resultText} from './visible-results.mjs';

function canonical(value){
  return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
    ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
}
function numericRanges(raw){
  const args=argsOf(raw),wrapped=args.arguments?argsOf(args.arguments):args;
  let content=wrapped.content??(wrapped.summary!==undefined?[wrapped]:null);
  if(typeof content==='string'){try{content=JSON.parse(content);}catch{return null;}}
  if(!Array.isArray(content)||!content.length)return null;
  const ranges=[];
  for(const item of content){
    const start=item?.startSeq??item?.startId,end=item?.endSeq??item?.endId;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||typeof item?.summary!=='string')return null;
    ranges.push({start,end,summary:item.summary});
  }
  return ranges;
}
function surfaceChars(session){return session.surface.nodes.reduce((sum,seq)=>sum+eventChars(session.eventAt(seq)),0);}

/** Cooperates at the existing compress tool; it never manufactures summaries. */
export function createCompressionControl(ctx,runtime,economics){
  const states=new Map();
  const get=agent=>{
    let state=states.get(agent.session.id);
    if(!state){state={attempts:[],transactions:[],blocked:0,emergencyPasses:0,errors:0,pressureFailure:false};states.set(agent.session.id,state);}
    return state;
  };
  function reject(state,reason,details){
    state.blocked++;
    const message='Work Evidence deferred this compression: '+reason+'. The requested history was retained. '+details;
    return {isError:true,error:{code:'CONTEXT_COMPRESSION_NO_PROGRESS',message},content:[{type:'text',text:message}]};
  }
  ctx.on('tools/execute',async(exec,next)=>{
    if(exec.name!=='compress'||!exec.agent||!runtime.isEnabled(exec.agent)||!runtime.get(exec.agent).config.compressionControl)return next();
    const agent=exec.agent,session=agent.session,state=get(agent),generation=session.surface.contentGeneration,
      signature=canonical(exec.arguments),ranges=numericRanges(exec.arguments),pressure=economics.pressure(agent),emergency=pressure.emergency||state.pressureFailure,
      turn=runtime.get(agent).turn,step=runtime.get(agent).step;
    if(!emergency){
      if(state.attempts.some(item=>item.signature===signature&&item.generationAfter===generation&&item.turn===turn&&
        (!item.protectionDependent||item.step===step)&&item.progress===false&&!item.failed))
        return reject(state,'the identical proposal left the same surface unchanged','Combine a useful larger interval or change the summary; do not repeat the identical operation.');
      if(ranges){
        const proposals=ranges.map(range=>{
          const seqs=session.surface.nodes.filter(seq=>seq>=range.start&&seq<=range.end);
          return {...range,seqs,chars:seqs.reduce((sum,seq)=>sum+eventChars(session.eventAt(seq)),0)};
        });
        if(proposals.every(range=>range.seqs.length&&range.summary.length>=range.chars))
          return reject(state,'every supplied summary is at least as large as its live source interval','No smaller request can result from these summaries. Critical context pressure bypasses this guard.');
      }
    }else state.emergencyPasses++;
    let costDecision=null;
    if(ranges){
      const covered=new Set(ranges.flatMap(range=>session.surface.nodes.filter(seq=>seq>=range.start&&seq<=range.end)));
      const savedChars=[...covered].reduce((sum,seq)=>sum+eventChars(session.eventAt(seq)),0)-ranges.reduce((sum,range)=>sum+range.summary.length,0);
      if(savedChars>0)costDecision=economics.remember(agent,economics.assess(agent,{savedChars,changedSeq:Math.min(...covered),emergency}),'external-compression-advice');
    }
    const before=surfaceChars(session),startSeq=session.seq;let result,failed=false;
    try{result=await next();failed=!!result?.isError;return result;}
    catch(error){failed=true;state.errors++;throw error;}
    finally{
      const after=surfaceChars(session),transactions=state.transactions.filter(item=>item.summarySeq>=startSeq);
      state.attempts.push({signature,generationBefore:generation,generationAfter:session.surface.contentGeneration,
        beforeChars:before,afterChars:after,progress:after<before,failed,emergency,turn,step,
        protectionDependent:/protected|guarded|active user|live carrier/i.test(String(result?.value?.text??result?.text??resultText(result?.content))),
        ranges:ranges?.map(({start,end})=>({start,end}))??null,transactionSeqs:transactions.map(item=>item.summarySeq),costDecision});
      if(state.attempts.length>12)state.attempts.shift();
      runtime.get(agent).dirty=true;
    }
  },{prepend:true});
  ctx.on('session/event',(session,event)=>{
    const agent=ctx.agents.get(session.id);if(!agent)return;
    const state=get(agent),data=event.data??{};
    if(event.type==='compaction/summary'){
      const seqs=data.shadowedSeqs??[],before=seqs.reduce((sum,seq)=>sum+eventChars(session.eventAt(seq)),0),after=resultText(data.summary).length;
      state.transactions.push({compactionId:data.compactionId,summarySeq:event.seq,range:data.shadowedRange??null,
        sourceChars:before,summaryChars:after,progress:after<before,sourceEvents:seqs.length,provider:data.provider??null,model:data.model??null,
        outcome:'pending'});
      if(state.transactions.length>24)state.transactions.shift();
    }
    if(event.type==='compaction/end'){
      for(const item of state.transactions)if(item.compactionId===data.compactionId)item.outcome=data.error?'failed':'committed';
    }
    if(event.type==='assistant/message'&&event.data?.usage)state.pressureFailure=false;
  });
  ctx.on('agent/request-error',async(payload,next)=>{
    if(payload.agent&&/CONTEXT_WINDOW_EXCEEDED|context.*(?:overflow|limit|length)/i.test(String(payload.failure?.code??payload.failure?.message??'')))get(payload.agent).pressureFailure=true;
    return next();
  });
  return {metrics(agent){
    const state=get(agent);let compressAvailable=false;try{compressAvailable=!!ctx.tools.get('compress',agent);}catch{}
    return {enabled:runtime.isEnabled(agent)&&runtime.get(agent).config.compressionControl,compressAvailable,
      control:'optional-external-compress-cooperation; core-folding-and-request-projection-are-independent',
      attempts:state.attempts.length,blocked:state.blocked,emergencyPasses:state.emergencyPasses,errors:state.errors,
      recentAttempts:state.attempts.slice(-4).map(({signature,...item})=>item),recentTransactions:state.transactions.slice(-6),
      note:'Counts describe external compress cooperation. Work Evidence core folding and request projection use native history and do not require an external compression plugin.'};
    },dispose(){states.clear();}};
}
