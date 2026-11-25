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
  const ctx={llm:{stream(request){
    if(control.streamThrows)throw new Error('native stream was not created');
    dispatched.push(request);
    return (async function*(){
      yield {type:'block-end',block:{type:'text',text:control.answer}};
      if(control.usage!==null)yield {type:'usage',usage:control.usage};
      yield {type:'finish',reason:{kind:control.finishKind}};
    })();
  }}};
  const state={id,dir,telemetryDir:dir,config:{modelMaxTokens:1200,modelTimeoutMs:20000,modelRoute:null},
    metrics:{auxiliaryCalls:0,auxiliaryFailures:0,auxiliaryUnknownCalls:0,auxiliaryUsage:{},auxiliaryMs:0},
    problems:[],dirty:true,auxiliarySignals:new WeakSet()};
  const runtime={get:()=>state,effects,problem:(item,kind,message)=>item.problems.push({kind,message}),modeStatus:()=>({selected:'aggressive'})};
  const agent={session:{id,seq:0,requestHeader:()=>({config:{provider:'p',model:'m'}})}};
  const run=(scope,budgetCalls=2,task=null)=>modelJson(ctx,runtime,agent,new AbortController().signal,'system',{payload:1},
    {route:{provider:'p',model:'m'},tokenLimit:32000,budgetScope:scope,budgetCalls,
      ...(task?{taskBudgetScope:task.scope,taskTokenLimit:task.tokenLimit,taskCallLimit:task.calls}:{})});
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

test('a stream creation failure before dispatch hands the reservation back',async()=>{
  const {state,dispatched,control,run,budget,close}=await start();
  try{
    control.streamThrows=true;
    await assert.rejects(()=>run('pre-dispatch'),error=>error.auxiliaryDispatched===false&&
      error.auxiliaryDispatchState==='not-dispatched');
    assert.equal(dispatched.length,0);
    assert.equal(state.metrics.auxiliaryFailures,1);
    assert.equal(state.metrics.auxiliaryUnknownCalls,0);
    assert.deepEqual((await budget()).scopes['pre-dispatch'],{calls:0,tokens:0,failed:false});
    control.streamThrows=false;
    assert.equal((await run('pre-dispatch')).value.ok,true);
  }finally{await close();}
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

test('a shared task budget spans scopes and stops before dispatch',async()=>{
  const {dispatched,run,budget,close}=await start();
  try{
    const task={scope:'bounded-patch:req-1',tokenLimit:32000,calls:2};
    assert.equal((await run('bounded-patch:req-1:1',1,task)).value.ok,true);
    assert.equal((await run('bounded-patch:req-1:2',1,task)).value.ok,true);
    await assert.rejects(()=>run('bounded-patch:req-1:3',1,task),error=>
      error.auxiliaryCode==='auxiliary-budget-exhausted'&&error.auxiliaryDispatched===false&&
      /Auxiliary task budget exhausted/.test(error.message));
    assert.equal(dispatched.length,2,'the third scope never reaches the provider');
    const record=await budget();
    assert.deepEqual(record.tasks['bounded-patch:req-1'],{calls:2,tokens:300,failed:false});
  }finally{await close();}
});

test('known-usage failures settle the task budget while unknown usage stops it',async()=>{
  const known=await start({finishKind:'length'});
  try{
    const task={scope:'known-task',tokenLimit:32000,calls:4};
    await assert.rejects(()=>known.run('known-task:a',1,task),/did not finish/);
    known.control.finishKind='stop';
    assert.equal((await known.run('known-task:b',1,task)).value.ok,true,
      'a known-usage failure consumes the shared budget but does not stop later scopes');
    const record=await known.budget();
    assert.equal(record.tasks['known-task'].failed,false);
    assert.equal(record.tasks['known-task'].calls,2);
  }finally{await known.close();}

  const unknown=await start();
  try{
    const task={scope:'unknown-task',tokenLimit:32000,calls:4};
    unknown.control.usage=null;
    assert.equal((await unknown.run('unknown-task:a',1,task)).value.ok,true);
    await assert.rejects(()=>unknown.run('unknown-task:b',1,task),error=>
      error.auxiliaryCode==='auxiliary-task-stopped'&&error.auxiliaryDispatched===false);
    assert.equal(unknown.dispatched.length,1);
    assert.equal((await unknown.budget()).tasks['unknown-task'].failed,true);
  }finally{await unknown.close();}
});

test('task consumption survives a new observer process',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'we-aux-task-'));
  const state={
    id:'session-aux-task',dir,telemetryDir:dir,
    config:{modelMaxTokens:1200,modelTimeoutMs:20000,modelRoute:null},
    metrics:{auxiliaryCalls:0,auxiliaryFailures:0,auxiliaryUnknownCalls:0,auxiliaryUsage:{},auxiliaryMs:0},
    problems:[],dirty:true,auxiliarySignals:new WeakSet(),
  };
  const dispatched=[];
  const ctx={llm:{async *stream(request){
    dispatched.push(request);
    yield {type:'block-end',block:{type:'text',text:'{"ok":true}'}};
    yield {type:'usage',usage:OBSERVED};
    yield {type:'finish',reason:{kind:'stop'}};
  }}};
  const runtime={get:()=>state,effects:null,problem:()=>{},modeStatus:()=>({selected:'aggressive'})};
  const agent={session:{id:state.id,seq:0,requestHeader:()=>({config:{provider:'p',model:'m'}})}};
  const task={scope:'restart-task',tokenLimit:32000,calls:1};
  try{
    await modelJson(ctx,runtime,agent,new AbortController().signal,'s',{x:1},
      {route:{provider:'p',model:'m'},budgetScope:'restart-task:a',budgetCalls:1,...taskTaskOptions(task)});
    delete state.auxiliaryBudget;
    await assert.rejects(()=>modelJson(ctx,runtime,agent,new AbortController().signal,'s',{x:2},
      {route:{provider:'p',model:'m'},budgetScope:'restart-task:b',budgetCalls:1,...taskTaskOptions(task)}),error=>
      error.auxiliaryCode==='auxiliary-budget-exhausted'&&error.auxiliaryDispatched===false);
    assert.equal(dispatched.length,1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('more than 32 live scopes are retained and an old scope is not reset',async()=>{
  const {run,budget,close}=await start();
  try{
    for(let index=0;index<40;index++)assert.equal((await run('scope-'+index,2)).value.ok,true);
    const first=await budget();
    assert.equal(Object.keys(first.scopes).length,40);
    assert.equal(first.scopes['scope-0'].calls,1);
    assert.equal((await run('scope-0',2)).value.ok,true);
    const second=await budget();
    assert.equal(second.scopes['scope-0'].calls,2,'a reused scope keeps its prior consumption');
  }finally{await close();}
});

test('concurrent reservations cannot spend one allowance twice',async()=>{
  const h=await start();
  try{
    const results=await Promise.allSettled([
      h.run('concurrent-scope',1),
      h.run('concurrent-scope',1),
      h.run('concurrent-scope',1),
    ]);
    assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
    assert.equal(results.filter(item=>item.status==='rejected'&&
      item.reason?.auxiliaryCode==='auxiliary-budget-exhausted').length,2);
    assert.equal(h.dispatched.length,1);
    assert.deepEqual((await h.budget()).scopes['concurrent-scope'],{calls:1,tokens:150,failed:false});
  }finally{await h.close();}
});

test('two admitted task calls settle independently and retain both actual usages',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'we-aux-two-calls-'));
  const id='session-two-calls',file=path.join(dir,id+'.auxiliary-budget.json');
  const state={id,dir,telemetryDir:dir,config:{modelMaxTokens:1200,modelTimeoutMs:20000,modelRoute:null},
    metrics:{auxiliaryCalls:0,auxiliaryFailures:0,auxiliaryUnknownCalls:0,auxiliaryUsage:{},auxiliaryMs:0},
    problems:[],dirty:true,auxiliarySignals:new WeakSet()};
  const dispatched=[],releases=[];
  const ctx={llm:{stream(request){
    const index=dispatched.length;dispatched.push(request);
    return (async function*(){
      yield {type:'block-end',block:{type:'text',text:'{"ok":true}'}};
      await new Promise(resolve=>{releases[index]=resolve;});
      yield {type:'usage',usage:OBSERVED};
      yield {type:'finish',reason:{kind:'stop'}};
    })();
  }}};
  const runtime={get:()=>state,effects:null,problem:()=>{},modeStatus:()=>({selected:'aggressive'})};
  const agent={session:{id,seq:0,requestHeader:()=>({config:{provider:'p',model:'m'}})}};
  const task={taskBudgetScope:'two-call',taskTokenLimit:32000,taskCallLimit:2};
  const run=scope=>modelJson(ctx,runtime,agent,new AbortController().signal,'system',{scope},
    {route:{provider:'p',model:'m'},tokenLimit:32000,budgetScope:scope,budgetCalls:1,...task});
  const budget=async()=>JSON.parse(await fs.readFile(file,'utf8'));
  const waitFor=async predicate=>{for(let index=0;index<100;index++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('timed out waiting for dispatched calls');};
  try{
    const first=run('two:a'),second=run('two:b');
    await waitFor(()=>dispatched.length===2);
    await assert.rejects(()=>run('two:c'),error=>error.auxiliaryCode==='auxiliary-budget-exhausted'&&error.auxiliaryDispatched===false);
    releases[0]();
    await first;
    const afterFirst=await budget();
    assert.equal(afterFirst.tasks['two-call'].calls,2,'the second reservation remains visible while in flight');
    assert.ok(afterFirst.tasks['two-call'].tokens>=OBSERVED.totalTokens+1200);
    releases[1]();
    await second;
    const afterSecond=await budget();
    assert.equal(afterSecond.tasks['two-call'].tokens,OBSERVED.totalTokens*2);
    assert.deepEqual(afterSecond.scopes['two:a'],{calls:1,tokens:150,failed:false});
    assert.deepEqual(afterSecond.scopes['two:b'],{calls:1,tokens:150,failed:false});
  }finally{await fs.rm(dir,{recursive:true,force:true,maxRetries:3});}
});

test('a stale lock owned by a live process is not removed',async()=>{
  const h=await start();
  const lock=h.file+'.lock';
  try{
    await fs.writeFile(lock,JSON.stringify({pid:process.pid,token:'still-owned',at:new Date().toISOString()}),'utf8');
    const old=new Date(Date.now()-120_000);
    await fs.utimes(lock,old,old);
    await assert.rejects(()=>h.run('stale-lock'),error=>
      error.auxiliaryCode==='auxiliary-budget-unavailable'&&/active process/u.test(error.message));
    assert.equal(JSON.parse(await fs.readFile(lock,'utf8')).token,'still-owned');
    assert.equal(h.dispatched.length,0);
  }finally{
    await fs.rm(lock,{force:true}).catch(()=>{});
    await h.close();
  }
});

test('a failed unknown-usage settlement remains enforceable on the next reservation',async()=>{
  const h=await start();
  const originalWrite=fs.writeFile;
  let tempWrites=0,failSettlement=true;
  fs.writeFile=async(file,...args)=>{
    if(failSettlement&&String(file).includes('.auxiliary-budget.json.')&&String(file).endsWith('.tmp')&&++tempWrites===2)
      throw Object.assign(new Error('injected settlement write failure'),{code:'EIO'});
    return originalWrite(file,...args);
  };
  try{
    h.control.usage=null;
    assert.equal((await h.run('settlement-failure')).value.ok,true);
    failSettlement=false;
    await assert.rejects(()=>h.run('settlement-failure'),error=>
      error.auxiliaryCode==='auxiliary-scope-stopped'&&error.auxiliaryDispatched===false);
    assert.equal(h.dispatched.length,1,'the unresolved reservation stops the next dispatch');
    const record=await h.budget();
    assert.equal(record.scopes['settlement-failure'].failed,true);
    assert.deepEqual(record.meta.reservations,{});
  }finally{
    fs.writeFile=originalWrite;
    await h.close();
  }
});

const taskTaskOptions=task=>({taskBudgetScope:task.scope,taskTokenLimit:task.tokenLimit,taskCallLimit:task.calls});
