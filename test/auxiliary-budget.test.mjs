import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {modelJson} from '../model.mjs';

const OBSERVED={inputTokens:100,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:50,totalTokens:150};
const SMALL={inputTokens:20,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:5,totalTokens:25};

async function start({usage=OBSERVED,finishKind='stop',answer='{"ok":true}',effects=null}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'we-aux-budget-'));
  const id='session-aux';
  const file=path.join(dir,id+'.auxiliary-budget.json');
  const dispatched=[],control={usage,finishKind,answer};
  const ctx={llm:{async *stream(request){
    dispatched.push(request);
    yield {type:'block-end',block:{type:'text',text:control.answer}};
    if(control.usage!==null)yield {type:'usage',usage:control.usage};
    yield {type:'finish',reason:{kind:control.finishKind}};
  }}};
  const state={id,dir,telemetryDir:dir,config:{modelMaxTokens:1200,modelTimeoutMs:20000,modelRoute:null},
    metrics:{auxiliaryCalls:0,auxiliaryFailures:0,auxiliaryUnknownCalls:0,auxiliaryUsage:{},auxiliaryMs:0},
    problems:[],dirty:true,auxiliarySignals:new WeakSet()};
  const runtime={get:()=>state,effects,problem:(item,kind,message)=>item.problems.push({kind,message}),modeStatus:()=>({selected:'aggressive'})};
  const agent={session:{id,seq:0,requestHeader:()=>({config:{provider:'p',model:'m'}})}};
  const run=(scope,budgetCalls=2)=>modelJson(ctx,runtime,agent,new AbortController().signal,'system',{payload:1},
    {route:{provider:'p',model:'m'},tokenLimit:32000,budgetScope:scope,budgetCalls});
  const budget=async()=>JSON.parse(await fs.readFile(file,'utf8'));
  const close=async()=>{await fs.rm(dir,{recursive:true,force:true,maxRetries:3});};
  return {state,dispatched,control,run,budget,file,close};
}

test('scoped reviews keep their own allowance and never consume the unscoped budget',async()=>{
  const {state,dispatched,run,budget,close}=await start({effects:{snapshot:()=>{throw new Error('unscoped budget must not read observed auxiliary counts');}}});
  try{
    assert.equal((await run('quality-review:10')).value.ok,true);
    assert.equal((await run('quality-review:10')).value.ok,true);
    // A spent allowance stops the call before dispatch, so it is not an upstream call failure.
    await assert.rejects(()=>run('quality-review:10'),error=>error.auxiliaryCode==='auxiliary-budget-exhausted'&&
      error.auxiliaryDispatched===false&&/Auxiliary budget exhausted for quality-review:10 \(2 calls \/ 32000 tokens\)/.test(error.message));
    assert.equal(state.metrics.auxiliaryCalls,2);
    // The reviews took two calls of their own; the unscoped allowance is still whole.
    assert.equal((await run(null)).value.ok,true);
    assert.equal((await run(null)).value.ok,true);
    await assert.rejects(()=>run(null),error=>error.auxiliaryCode==='auxiliary-budget-exhausted'&&error.auxiliaryDispatched===false&&
      /Auxiliary budget exhausted for calls without a budget scope \(2 calls \/ 32000 tokens\)/.test(error.message));
    assert.equal(state.metrics.auxiliaryCalls,4);
    assert.equal(dispatched.length,4);
    const record=await budget();
    assert.deepEqual(record.scopes['quality-review:10'],{calls:2,tokens:300,failed:false});
    assert.deepEqual(record.general,{calls:2,tokens:300,failed:false});
    assert.equal(record.calls,undefined);assert.equal(record.tokens,undefined);assert.equal(record.failed,undefined);
    // A record that never mixed the counts must not gain invented legacy facts.
    assert.equal(record.legacyMixedCounters,undefined);
  }finally{await close();}
});

test('an auxiliary failure stops only the budget that failed',async()=>{
  const {state,control,run,budget,close}=await start({finishKind:'length'});
  try{
    await assert.rejects(()=>run('quality-review:11'),/Auxiliary call did not finish: length/);
    assert.equal(state.metrics.auxiliaryFailures,1);
    control.finishKind='stop';
    assert.equal((await run(null)).value.ok,true);
    await assert.rejects(()=>run('quality-review:11'),error=>error.auxiliaryCode==='auxiliary-scope-stopped'&&error.auxiliaryDispatched===false&&
      /Auxiliary calls for quality-review:11 stopped after a prior failure/.test(error.message));
    const afterReviewFailure=await budget();
    assert.equal(afterReviewFailure.scopes['quality-review:11'].failed,true);
    assert.equal(afterReviewFailure.general.failed,false);
    // An unscoped failure stops unscoped calls only; another scope stays available.
    control.finishKind='length';
    await assert.rejects(()=>run(null),/Auxiliary call did not finish: length/);
    control.finishKind='stop';
    await assert.rejects(()=>run(null),error=>error.auxiliaryCode==='auxiliary-scope-stopped'&&error.auxiliaryDispatched===false&&
      /Auxiliary calls without a budget scope stopped after a prior failure/.test(error.message));
    assert.equal((await run('quality-review:12')).value.ok,true);
    assert.equal((await budget()).general.failed,true);
  }finally{await close();}
});

test('unknown consumption is retained inside its own budget',async()=>{
  const {state,control,run,budget,close}=await start();
  try{
    control.usage=null;
    assert.equal((await run(null)).value.ok,true);
    assert.equal(state.metrics.auxiliaryUnknownCalls,1);
    assert.deepEqual(state.problems.map(problem=>problem.kind),['auxiliary-usage-unavailable']);
    assert.match(state.problems[0].message,/without a budget scope/);
    await assert.rejects(()=>run(null),/Auxiliary calls without a budget scope stopped after a prior failure/);
    const record=await budget();
    assert.equal(record.general.failed,true);
    assert.ok(record.general.tokens>0);
    // A scope that reports its own usage is untouched by that unknown consumption.
    control.usage=SMALL;
    assert.equal((await run('quality-review:12')).value.ok,true);
    assert.deepEqual((await budget()).scopes['quality-review:12'],{calls:1,tokens:25,failed:false});
    assert.equal((await budget()).general.failed,true);
    control.usage=null;
    assert.equal((await run('quality-review:12')).value.ok,true);
    assert.match(state.problems.at(-1).message,/for quality-review:12/);
    assert.equal((await budget()).scopes['quality-review:12'].failed,true);
  }finally{await close();}
});

test('zero adapter counters on a failed response retain unknown consumption and its reservation',async()=>{
  const zero={inputTokens:0,outputTokens:0,totalTokens:0};
  const h=await start({usage:zero,finishKind:'error',answer:''});
  try{
    await assert.rejects(()=>h.run('quality-review:failed-zero'),error=>{
      assert.equal(error.auxiliaryUsage,null);assert.deepEqual(error.auxiliaryReportedUsage,zero);
      return error.auxiliaryDispatched===true&&error.auxiliaryFinish.kind==='error';
    });
    assert.equal(h.state.metrics.auxiliaryUnknownCalls,1);
    const entry=(await h.budget()).scopes['quality-review:failed-zero'];assert.ok(entry.tokens>0);assert.equal(entry.failed,true);
    await assert.rejects(()=>h.run('quality-review:failed-zero'),/stopped after a prior failure/);
    h.control.usage=SMALL;h.control.finishKind='stop';h.control.answer='{"ok":true}';
    assert.equal((await h.run('quality-review:later')).usage.totalTokens,25);
    assert.deepEqual((await h.budget()).scopes['quality-review:later'],{calls:1,tokens:25,failed:false});
  }finally{await h.close();}
});

test('positive complete usage remains accounted after a failed response',async()=>{
  const h=await start({usage:SMALL,finishKind:'error',answer:''});
  try{
    await assert.rejects(()=>h.run('quality-review:known-failure'),error=>{
      assert.deepEqual(error.auxiliaryUsage,SMALL);assert.equal(error.auxiliaryReportedUsage,null);return true;
    });
    assert.equal(h.state.metrics.auxiliaryUnknownCalls,0);
    assert.deepEqual((await h.budget()).scopes['quality-review:known-failure'],{calls:1,tokens:25,failed:true});
  }finally{await h.close();}
});

test('invalid adapter values cannot be turned into omitted zero cache usage in a budget',async()=>{
  const host=await start({usage:{inputTokens:100,cacheReadTokens:-1,outputTokens:50,totalTokens:150}});
  try{
    const result=await host.run('quality-review:invalid');
    assert.equal(result.usage.cacheReadTokens,-1);
    assert.equal(host.state.metrics.auxiliaryUnknownCalls,1);
    assert.equal((await host.budget()).scopes['quality-review:invalid'].failed,true);
    await assert.rejects(()=>host.run('quality-review:invalid'),/stopped after a prior failure/);
    host.control.usage=SMALL;assert.equal((await host.run(null)).value.ok,true);
  }finally{await host.close();}
});

test('a legacy mixed count is neither reused as unscoped consumption nor fabricated',async()=>{
  const {run,budget,close,file}=await start();
  try{
    await fs.writeFile(file,JSON.stringify({calls:9,tokens:200000,failed:true,
      scopes:{'quality-review:9':{calls:1,tokens:150,failed:true}}}),{flag:'wx'});
    // The old top-level total counted every auxiliary call and cannot say how many were
    // unscoped, so the unscoped budget starts from zero instead of reinterpreting it, while
    // a recorded scope keeps its own allowance and failure.
    await assert.rejects(()=>run('quality-review:9'),/Auxiliary calls for quality-review:9 stopped after a prior failure/);
    assert.equal((await run(null)).value.ok,true);
    assert.equal((await run(null)).value.ok,true);
    const record=await budget();
    assert.deepEqual(record.general,{calls:2,tokens:300,failed:false});
    assert.deepEqual(record.scopes['quality-review:9'],{calls:1,tokens:150,failed:true});
    assert.equal(record.calls,undefined);assert.equal(record.tokens,undefined);assert.equal(record.failed,undefined);
    // Later writes keep the old mixed totals exactly as they were recorded, and they are never
    // read back as consumption: the unscoped allowance counted only the two calls made now.
    assert.equal(record.legacyMixedCounters.calls,9);
    assert.equal(record.legacyMixedCounters.tokens,200000);
    assert.equal(record.legacyMixedCounters.failed,true);
    assert.match(record.legacyMixedCounters.note,/not reconstructable/u);
  }finally{await close();}
});

test('an explicit single-call scope keeps its own bounded retry',async()=>{
  const {dispatched,run,close}=await start();
  try{
    assert.equal((await run('quality-review:13:explicit-retry',1)).value.ok,true);
    await assert.rejects(()=>run('quality-review:13:explicit-retry',1),error=>error.auxiliaryCode==='auxiliary-budget-exhausted'&&
      error.auxiliaryDispatched===false&&
      /Auxiliary budget exhausted for quality-review:13:explicit-retry \(1 calls \/ 32000 tokens\)/.test(error.message));
    assert.equal(dispatched.length,1);
  }finally{await close();}
});

test('a budget that cannot be read or saved stops before dispatch and hands the call back',async()=>{
  const missing=await start();
  try{
    missing.state.telemetryDir=null;
    await assert.rejects(()=>missing.run('quality-review:14'),error=>error.auxiliaryCode==='auxiliary-budget-unavailable'&&
      error.auxiliaryDispatched===false&&/persistent session storage/.test(error.message));
    assert.equal(missing.dispatched.length,0);
  }finally{await missing.close();}
  const unsavable=await start();
  try{
    // A file where the storage directory should be makes the reserve write fail. Nothing was
    // dispatched, so the allowance is handed back instead of being silently spent.
    const blocker=path.join(path.dirname(unsavable.file),'budget-blocker');
    await fs.writeFile(blocker,'not a directory','utf8');
    unsavable.state.telemetryDir=path.join(blocker,'telemetry');
    await assert.rejects(()=>unsavable.run(null),error=>error.auxiliaryCode==='auxiliary-budget-unavailable'&&
      error.auxiliaryDispatched===false&&/could not be saved/.test(error.message));
    assert.equal(unsavable.dispatched.length,0);
    assert.deepEqual(unsavable.state.auxiliaryBudget.general,{calls:0,tokens:0,failed:false});
  }finally{await unsavable.close();}
});

test('a malformed budget record is rejected before any dispatch',async()=>{
  for(const record of [
    null,
    [],
    5,
    'broken',
    {general:{calls:-1,tokens:0,failed:false},scopes:{}},
    {general:{calls:0,tokens:0,failed:'false'},scopes:{}},
    {general:{calls:0,tokens:0,failed:false},scopes:{'':{calls:0,tokens:0,failed:false}}},
    {general:{calls:0,tokens:0,failed:false},scopes:[]},
    {calls:1,tokens:1,failed:false,scopes:'broken'},
  ]){
    const {dispatched,run,close,file}=await start();
    try{
      await fs.writeFile(file,JSON.stringify(record),{flag:'wx'});
      await assert.rejects(()=>run(null),error=>error.auxiliaryCode==='auxiliary-budget-invalid'&&error.auxiliaryDispatched===false&&
        /Invalid auxiliary budget record/.test(error.message));
      assert.equal(dispatched.length,0);
    }finally{await close();}
  }
});

test('budget record text that is not JSON is identified as an invalid record',async()=>{
  const {dispatched,run,close,file}=await start();
  try{
    await fs.writeFile(file,'{stopped mid-write','utf8');
    await assert.rejects(()=>run(null),error=>error.auxiliaryCode==='auxiliary-budget-invalid'&&error.auxiliaryDispatched===false&&
      /not readable JSON/.test(error.message));
    assert.equal(dispatched.length,0);
  }finally{await close();}
});
