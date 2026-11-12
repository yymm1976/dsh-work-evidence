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
    if(input?.parent!==undefined){
      const nested=await executeNested(ctx,input);
      if(nested!==undefined)return nested;
    }
    const callId=input.callId??input.rootCallId??randomUUID();
    const block={id:callId,name:input.name,arguments:typeof input.arguments==='string'?input.arguments:JSON.stringify(input.arguments??{})};
    const batch=await original({calls:[block],signal:input.signal,agent:input.agent,
      ...(input.toolSet!==undefined?{toolSet:input.toolSet}:{}),
      ...(input.maxParallelToolCalls!==undefined?{maxParallelToolCalls:input.maxParallelToolCalls}:{})});
    const result=batch.results?.[0]?.result;
    if(!result)throw new Error('Tool execution returned no result');
    return result;
  };
  patched.add(tools);
}

/**
 * A PTC host rejects model-direct calls to native tools and admits only nested
 * children. The batch API drops the nesting marker, so internal plugin calls
 * with `parent` run through the selected executor's pipeline instead.
 */
async function executeNested(ctx,input){
  const tools=ctx?.tools,pipeline=tools.selectExecutor(input.agent)?.pipeline;
  if(typeof pipeline?.prepare!=='function'||typeof pipeline?.dispatch!=='function'||typeof pipeline?.complete!=='function')return undefined;
  const callId=input.callId??input.rootCallId??randomUUID();
  let args=input.arguments??{};
  if(typeof args==='string'){try{args=args?JSON.parse(args):{};}catch{}}
  const prepared=await pipeline.prepare({callId,name:input.name,arguments:args,agent:input.agent,parent:input.parent,signal:input.signal,
    ...(input.toolSet!==undefined?{toolSet:input.toolSet}:{})});
  if(prepared.kind==='dispatch')return pipeline.complete(prepared.exec,await pipeline.dispatch(prepared.exec));
  return pipeline.complete(prepared.exec,prepared);
}

/** New system-prompt hosts add tool schemas after the assemble waterfall. */
export function patchSystemPromptTools(ctx,transform){
  const service=ctx?.systemPrompt;
  if(!isBatchToolHost(ctx)||!service||typeof service.assemble!=='function')return;
  // Cordis returns a fresh traceable proxy per property access; patch the
  // underlying service so every caller sees the same wrapper and transform list.
  const target=service[Symbol.for('cordis.original')]??service;
  let transforms=toolTransforms.get(target);
  if(!transforms){
    transforms=[];toolTransforms.set(target,transforms);
    const original=target.assemble.bind(target);
    target.assemble=async context=>{
      const result=await original(context);
      if(Array.isArray(result?.tools))for(const apply of transforms)apply(result,context);
      return result;
    };
  }
  ctx.effect(()=>{
    transforms.push(transform);
    // The shared assembly wrapper survives reloads, but each plugin's closure
    // must leave before its Cordis services become inactive.
    return ()=>{
      const index=transforms.indexOf(transform);
      if(index>=0)transforms.splice(index,1);
    };
  });
}
