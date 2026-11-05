import {isAgentLoopRequest,markAgentLoopRequest} from '@deepseek-ai/dsh-llm';

/** Translate readable pi-ai metadata only; original reasoning blocks stay exact. */
export function nativeReasoningReplayView(options){
  if(!/(?:^|\/)deepseek-/iu.test(options.model??'')||!options.tools?.length||!Array.isArray(options.messages))return {options,translatedMessages:0};
  let translatedMessages=0;
  const messages=options.messages.map(message=>{
    const source=message?.source,replay=source?.replayState,response=replay?.response;
    if(message?.role!=='assistant'||source?.provider!==options.provider||source?.model!==options.model||
      response?.kind!=='pi-ai'||response.version!==2||response.api!=='openai-completions'||response.provider!==options.provider||response.model!==options.model||
      !Array.isArray(message.content)||!Array.isArray(replay.blocks)||replay.blocks.length!==message.content.length||
      replay.blocks.some((block,index)=>!block||!message.content[index]||block.type!==message.content[index].type||block.thoughtSignature!==undefined||block.redacted===true))return message;
    const indices=message.content.flatMap((block,index)=>block.type==='reasoning'?[index]:[]);
    if(indices.length!==1)return message;
    const index=indices[0],block=message.content[index],metadata=replay.blocks[index];
    if(typeof block.text!=='string'||typeof metadata.thinkingSignature!=='string'||metadata.thinkingSignature==='reasoning_content')return message;
    let details;try{details=JSON.parse(metadata.thinkingSignature);}catch{return message;}
    if(!Array.isArray(details)||!details.length||details.some(part=>!part||part.type!=='reasoning.text'||typeof part.text!=='string'||
      Object.keys(part).some(key=>!['type','text','index'].includes(key))||part.index!==undefined&&(!Number.isSafeInteger(part.index)||part.index<0))||
      details.map(part=>part.text).join('')!==block.text)return message;
    const blocks=replay.blocks.map((entry,at)=>at===index?{...entry,thinkingSignature:'reasoning_content'}:entry);
    translatedMessages++;
    return {...message,source:{...source,replayState:{...replay,blocks}}};
  });
  if(!translatedMessages)return {options,translatedMessages};
  const projected={...options,messages};
  if(isAgentLoopRequest(options))markAgentLoopRequest(projected);
  return {options:Object.isFrozen(options)?Object.freeze(projected):projected,translatedMessages};
}

export function nativeReasoningReplayRequest(ctx,runtime,options){
  const agent=options.sessionId?ctx.agents.get(options.sessionId):null;
  if(!agent||!runtime.isEnabled(agent)||!runtime.get(agent).config.nativeReasoningReplay)return options;
  const view=nativeReasoningReplayView(options);
  if(view.translatedMessages){
    const state=runtime.get(agent),observed=state.reasoningReplay??={requests:0,translatedMessages:0};
    observed.requests++;observed.translatedMessages+=view.translatedMessages;state.dirty=true;
    runtime.effects?.decide(agent,'nativeReasoningReplay','applied','readable-deepseek-replay-field',{messages:view.translatedMessages});
  }
  return view.options;
}
