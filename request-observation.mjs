import {canonicalUsage,requestKindOf} from './context-economics.mjs';

const fields=['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','reasoningTokens','totalTokens'];
export function measureText(value){
  const text=typeof value==='string'?value:JSON.stringify(value);
  return {stringUnits:text?.length||0,utf8Bytes:Buffer.byteLength(text||''),tokens:null,tokenMethod:'unavailable'};
}
function modelText(options){
  return {system:options.system,tools:options.tools,messages:options.messages.map(message=>({role:message.role,
    content:(message.content||[]).map(block=>block.type==='tool-call'?{type:'tool-call',name:block.name,arguments:block.arguments}:block)}))};
}

/** Observe the assembled model request, without storing prompts or changing its prefix. */
export function observeRequests(ctx,runtime){
  ctx.on('llm/stream',async function*(options,next){
    const agent=options.sessionId?ctx.agents.get(options.sessionId):null;
    if(!agent||!runtime.isEnabled(agent)){yield* next();return;}
    await runtime.init(agent,options.signal);await runtime.effects?.load(agent);
    const config=runtime.get(agent).config;
    if(!config.requestAccounting&&!config.requestProjection&&!config.compressionControl){yield* next();return;}
    const s=runtime.sync(agent),started=performance.now();
    const requestKind=requestKindOf({purpose:options.purpose,auxiliary:s.auxiliarySignals.has(options.signal)}),auxiliary=requestKind==='auxiliary',main=requestKind==='main';
    const effectRecord=runtime.effects?.begin(agent,options,{auxiliary,requestKind});
    if(effectRecord)await runtime.effects?.start?.(agent,effectRecord);
    const record={ordinal:main?++s.metrics.contextRequests:null,at:new Date().toISOString(),sourceSeq:agent.session.seq,preset:s.selectedPreset||null,mode:runtime.modeStatus(agent),requestKind,auxiliary,purpose:options.purpose??(auxiliary?'work-evidence-auxiliary':null),
      provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort??null,maxTokens:options.maxTokens??null,
      parameterScope:'assembled-llm-options; provider transport mapping not observed',
      generation:Number.isSafeInteger(agent.session.surface?.contentGeneration)?agent.session.surface.contentGeneration:null,
      messageCount:options.messages.length,toolMessages:options.messages.filter(message=>message.role==='tool').length,
      toolDefinitions:options.tools?.length||0,requestText:measureText({messages:options.messages,tools:options.tools,system:options.system}),
      requestTextScope:'assembled-envelope-including-message-metadata',modelText:measureText(modelText(options)),
      modelTextScope:'assembled text, reasoning, tool-call arguments and media descriptors after projection plus schemas; excludes source metadata; provider transport projection unobserved',
      finishReason:null,failureCode:null,usage:null,elapsedMs:null,settled:false};
    if(config.requestAccounting){s.requestObservations.push(record);if(s.requestObservations.length>24)s.requestObservations.shift();}
    if(main){s.metrics.contextRequestChars+=record.requestText.stringUnits;s.metrics.contextModelTextChars+=record.modelText.stringUnits;}s.dirty=true;
    try{
      for await(const chunk of next()){
        if(chunk.type==='usage'){
          record.usage??={};for(const field of fields){const value=chunk.usage?.[field];if(value!==null&&value!==undefined)record.usage[field]=value;}
          if(effectRecord)effectRecord.usageChunks++;
        }
        if(chunk.type==='finish'){record.finishReason=chunk.reason?.kind||null;record.failureCode=chunk.reason?.failure?.code||null;record.settled=true;}
        yield chunk;
      }
    }catch(error){record.failureCode=error.code||error.name||'STREAM_FAILED';throw error;}
    finally{
      record.elapsedMs=Math.round(performance.now()-started);record.aborted=!!options.signal?.aborted;s.dirty=true;
      const canonical=canonicalUsage(record.usage);record.usage=canonical.usage;record.usageSources=canonical.sources;
      record.usageConsistent=canonical.consistent;record.usageComplete=canonical.complete;
      runtime.contextControl?.requestFinished(agent,options,record);
      if(effectRecord){Object.assign(effectRecord,{usage:record.usage,usageSources:record.usageSources,usageConsistent:record.usageConsistent,usageComplete:record.usageComplete,
        settled:record.settled,finishReason:record.finishReason,failureCode:record.failureCode,elapsedMs:record.elapsedMs,aborted:record.aborted});runtime.effects.finish(agent,effectRecord);}
      if(main)runtime.noteProjectionDispatch?.(agent,options,effectRecord);
    }
  });
}
