import test from 'node:test';
import assert from 'node:assert/strict';
import {patchToolExecution,toolModeFor} from '../tool-execution.mjs';

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
  assert.deepEqual(received.log,{turn:0,step:0});
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
