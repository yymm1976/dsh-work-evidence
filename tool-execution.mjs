import {randomUUID} from 'node:crypto';

const patched=new WeakSet();

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
