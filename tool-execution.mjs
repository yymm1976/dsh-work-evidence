import {randomUUID} from 'node:crypto';

const patched=new WeakSet(),toolTransforms=new WeakMap();

export const isBatchToolHost=ctx=>typeof ctx?.tools?.selectExecutor==='function';

/** New DSH hosts replace modeFor with a selected executor; older hosts keep the direct method. */
export function toolModeFor(ctx,agent){
  const tools=ctx?.tools;
  if(typeof tools?.modeFor==='function')return tools.modeFor(agent);
  if(typeof tools?.selectExecutor!=='function')return 'native';
  try{
    const executor=tools.selectExecutor(agent);
    return executor&&(typeof executor.renderSdk==='function'||executor.ptcTransport!==undefined)?'ptc':'native';
  }catch{return 'native';}
}

/** New DSH hosts expose a batch executor; older hosts accept one execution object. */
export function patchToolExecution(ctx){
  const tools=ctx?.tools;
  if(!tools||patched.has(tools)||typeof tools.selectExecutor!=='function')return;
  const original=tools.execute.bind(tools);
  tools.execute=async input=>{
    if(Array.isArray(input?.calls))return original(input);
    const callId=input.callId??input.rootCallId??randomUUID();
    const block={id:callId,name:input.name,arguments:typeof input.arguments==='string'?input.arguments:JSON.stringify(input.arguments??{})};
    const batch=await original({calls:[block],signal:input.signal,agent:input.agent,
      ...(input.toolSet!==undefined?{toolSet:input.toolSet}:{}),
      ...(input.maxParallelToolCalls!==undefined?{maxParallelToolCalls:input.maxParallelToolCalls}:{}),
      log:{turn:0,step:0}});
    const result=batch.results?.[0]?.result;
    if(!result)throw new Error('Tool execution returned no result');
    return result;
  };
  patched.add(tools);
}

/** New system-prompt hosts add tool schemas after the assemble waterfall. */
export function patchSystemPromptTools(ctx,transform){
  const service=ctx?.systemPrompt;
  if(!isBatchToolHost(ctx)||!service||typeof service.assemble!=='function')return;
  let transforms=toolTransforms.get(service);
  if(!transforms){
    transforms=[];toolTransforms.set(service,transforms);
    const original=service.assemble.bind(service);
    service.assemble=async context=>{
      const result=await original(context);
      if(Array.isArray(result?.tools))for(const apply of transforms)apply(result,context);
      return result;
    };
  }
  transforms.push(transform);
}
