import test from 'node:test';
import assert from 'node:assert/strict';
import {patchToolExecution,toolModeFor,isBatchToolHost,patchSystemPromptTools} from '../tool-execution.mjs';

test('a batch tool host accepts the legacy single-call shape',async()=>{
  let received;
  const tools={selectExecutor:()=>({}),execute:async input=>{
    received=input;
    return {results:[{callId:input.calls[0].id,result:{isError:false,value:{ok:true}}}],additionalContexts:[],concluded:false};
  }};
  const ctx={tools},agent={turn:3,step:4},signal={aborted:false};
  patchToolExecution(ctx);
  const result=await ctx.tools.execute({name:'work_compute',arguments:{code:'x'},callId:'call-1',rootCallId:'root-1',agent,signal});
  assert.deepEqual(result,{isError:false,value:{ok:true}});
  assert.equal(received.calls.length,1);
  assert.equal(received.calls[0].id,'call-1');
  assert.equal(received.calls[0].name,'work_compute');
  assert.deepEqual(JSON.parse(received.calls[0].arguments),{code:'x'});
  assert.equal(received.signal,signal);
  assert.equal(received.agent,agent);
  assert.equal(received.log,undefined);
});

test('nested internal calls keep their parent and bypass batch dispatch',async()=>{
  let batchCalls=0,preparedInput,completed;
  const pipeline={
    prepare:async input=>{preparedInput=input;return {kind:'dispatch',exec:{id:'exec-1'}};},
    dispatch:async exec=>({kind:'post-result',result:{isError:false,value:{exec}} }),
    complete:async(exec,outcome)=>{completed={exec,outcome};return outcome.result??outcome;}
  };
  const tools={selectExecutor:()=>({pipeline}),execute:async()=>{batchCalls++;return {results:[]};}};
  patchToolExecution({tools});
  const result=await tools.execute({name:'pwsh',arguments:{command:'echo 1'},callId:'call-3',rootCallId:'root-3',parent:'root-3:ptc:1',agent:{}});
  assert.equal(batchCalls,0);
  assert.equal(preparedInput.parent,'root-3:ptc:1');
  assert.deepEqual(preparedInput.arguments,{command:'echo 1'});
  assert.deepEqual(result,{isError:false,value:{exec:{id:'exec-1'}}});
  assert.equal(completed.exec.id,'exec-1');
});

test('an older single-call executor is left unchanged',async()=>{
  let calls=0;
  const tools={execute:async input=>{calls++;return {isError:false,value:{name:input.name}};}};
  const ctx={tools};
  patchToolExecution(ctx);
  const result=await ctx.tools.execute({name:'read',arguments:{file_path:'a.txt'},callId:'call-2'});
  assert.deepEqual(result,{isError:false,value:{name:'read'}});
  assert.equal(calls,1);
});

test('tool mode follows the legacy modeFor method when present',()=>{
  assert.equal(toolModeFor({tools:{modeFor:()=> 'ptc'}},null),'ptc');
  assert.equal(toolModeFor({tools:{modeFor:()=> 'native'}},null),'native');
});

test('tool mode recognizes a selected PTC executor on newer hosts',()=>{
  const agent={},ptc={renderSdk:()=> ''},native={};
  assert.equal(toolModeFor({tools:{selectExecutor:()=>ptc}},agent),'ptc');
  assert.equal(toolModeFor({tools:{selectExecutor:()=>native}},agent),'native');
  assert.equal(toolModeFor({tools:{selectExecutor:()=>{throw Error('unavailable');}}},agent),'native');
});

test('new system prompt hosts receive tool transforms after assembly',async()=>{
  let assembles=0;
  const ctx={tools:{selectExecutor:()=>({})},systemPrompt:{assemble:async()=>({tools:[{name:'run_code'}],sections:[]})}};
  assert.equal(isBatchToolHost(ctx),true);
  patchSystemPromptTools(ctx,(result)=>{result.tools=[...result.tools,{name:'added'}];});
  const before=ctx.systemPrompt.assemble;
  const result=await before({});
  assembles++;
  assert.equal(assembles,1);
  assert.deepEqual(result.tools.map(tool=>tool.name),['run_code','added']);
});

test('older system prompt hosts are not wrapped',async()=>{
  const ctx={tools:{},systemPrompt:{assemble:async()=>({tools:[{name:'run_code'}]})}};
  const before=ctx.systemPrompt.assemble;
  patchSystemPromptTools(ctx,()=>{throw Error('should not run');});
  assert.equal(ctx.systemPrompt.assemble,before);
});
