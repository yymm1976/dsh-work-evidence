import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createQualityReview} from '../quality-review.mjs';

const USAGE={inputTokens:100,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:50,totalTokens:150};
const payloadOf=request=>JSON.parse(request.messages[0].content[0].text);
const gap=(payload,detail)=>({issues:[{kind:'requirement',detail,evidence:[payload.request.seq,payload.answer.seq]}]});

// One session with the review feature enabled: the adapter answers review calls, the scripted
// assistant answers the requests, and the state file lives in a temporary session directory.
async function harness({review=()=>({issues:[]}),finish=()=>'stop',abortOn=0}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'we-quality-review-'));
  const id='quality-review-session',stateFile=path.join(dir,id+'.quality-review.json');
  const hooks=new Map(),dispatched=[],events=[],steered=[];
  let seq=0,control=null;
  const agent={options:{reasoningEffort:'high'},inbox:{nextStep:[],nextTurn:[]},steered,
    session:{id,seq:0,requestHeader:()=>({config:{provider:'p',model:'m'}}),log:events},
    steer(message){steered.push(message);events.push({seq:++seq,type:'user/message',data:{message}});}};
  const state={id,dir,telemetryDir:dir,root:dir,taskSurfaceMode:'full',
    config:{qualityReview:true,finalJsonGuard:true,modelMaxTokens:1200,modelTimeoutMs:20000,modelRoute:null,toolSurface:'compact'},
    metrics:{auxiliaryCalls:0,auxiliaryFailures:0,auxiliaryUnknownCalls:0,auxiliaryJsonRecoveries:0,auxiliaryUsage:{},auxiliaryMs:0},
    problems:[],dirty:false,auxiliarySignals:new WeakSet()};
  const ctx={on(name,fn){if(!hooks.has(name))hooks.set(name,new Set());hooks.get(name).add(fn);return ()=>hooks.get(name).delete(fn);},
    llm:{async *stream(request){
      const call=dispatched.push(request);
      if(call===abortOn){control.abort();throw Object.assign(new Error('The operation was aborted'),{name:'AbortError'});}
      yield {type:'block-end',block:{type:'text',text:JSON.stringify(review(payloadOf(request),call))}};
      yield {type:'usage',usage:USAGE};
      yield {type:'finish',reason:{kind:finish(call)}};
    }}};
  const runtime={get:()=>state,init:async()=>state,sync:()=>state,isEnabled:()=>true,activeMode:()=>'quality',
    modeStatus:()=>({selected:'quality'}),problem:(item,kind,message)=>item.problems.push({kind,message}),effects:{decide(){}}};
  const inspected=()=>({events,
    request:events.findLast(event=>event.type==='user/message'&&event.data?.message?.source?.kind==='user'),
    assistant:events.findLast(event=>event.type==='assistant/message'),issue:null});
  const finalJson={inspect:inspected};
  const taskFlow={reviewState:()=>{const {request,assistant}=inspected();
    return {request:request?{seq:request.seq}:null,assistant:assistant?{seq:assistant.seq}:null,
      mutation:{seq,version:seq},artifacts:[],executions:[],unresolvedErrors:[],pendingJobs:[],todos:[],
      evidenceHighWater:{seq:seq+1}};}};
  const created=createQualityReview(ctx,runtime,taskFlow,finalJson);
  return {agent,state,stateFile,dispatched,steered,review:created,
    request(text){const event={seq:++seq,type:'user/message',
      data:{message:{id:'request-'+seq,role:'user',source:{kind:'user'},content:[{type:'text',text}]}}};
      events.push(event);return event;},
    answer(text){const event={seq:++seq,type:'assistant/message',
      data:{message:{id:'answer-'+seq,role:'assistant',content:[{type:'text',text}]}}};
      events.push(event);return event;},
    run:async()=>{const controller=new AbortController();control=controller;
      for(const handler of hooks.get('agent/turn-stopping'))await handler({agent,turn:1,signal:controller.signal});},
    saved:async()=>JSON.parse(await fs.readFile(stateFile,'utf8')),
    text:()=>fs.readFile(stateFile,'utf8'),
    close:()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3})};
}

test('one explicit retry allowance stops only its own request and keeps later requests reviewable',async()=>{
  const h=await harness({review:(payload,call)=>call===1?gap(payload,'b.txt 未修改'):{issues:[]}});
  try{
    h.request('修改 a.txt 和 b.txt');h.answer('已修改 a.txt。');
    assert.deepEqual(await h.review.retry(h.agent),{status:'ready',reason:'explicit-retry'});
    await h.run();
    const first=h.review.summary(h.agent);
    assert.equal(h.dispatched.length,1);
    assert.equal(first.status,'applied');assert.equal(first.verdict,'gap-reported');
    assert.deepEqual(Object.keys(first.process.pausedRoutes),[]);
    assert.equal(h.steered.length,1);
    h.answer('已补充修改 b.txt。');
    await h.run();
    const second=h.review.summary(h.agent);
    // The single retry call was already spent, so the revised answer is never dispatched again and
    // the stop belongs to that request only: no route pause, no upstream failure claim.
    assert.equal(h.dispatched.length,1);
    assert.equal(second.process.last.reason,'auxiliary-budget-exhausted');
    assert.equal(second.process.last.dispatched,false);
    assert.equal(second.paused,null);
    assert.deepEqual(Object.keys(second.process.pausedRoutes),[]);
    assert.equal(second.verdict,'unavailable','the revised answer shows as not reviewed, never clean');
    h.request('再修改 c.txt');h.answer('已修改 c.txt。');
    await h.run();
    assert.equal(h.dispatched.length,2,'a later user request keeps its own allowance');
    assert.equal(h.review.summary(h.agent).verdict,'no-supported-gap');
  }finally{await h.close();}
});

test('a cancelled review stops only its own request scope',async()=>{
  const h=await harness({abortOn:1,review:()=>({issues:[]})});
  try{
    h.request('读取 a.txt 并总结');h.answer('被打断。');
    await h.run();
    const first=h.review.summary(h.agent);
    assert.equal(first.process.last.reason,'cancelled');
    assert.equal(first.process.last.dispatched,true);
    assert.deepEqual(Object.keys(first.process.pausedRoutes),[]);
    h.answer('已总结。');
    await h.run();
    const second=h.review.summary(h.agent);
    // The cancelled call left unknown consumption, so its own scope is stopped; that is a local
    // stop, not a route failure.
    assert.equal(h.dispatched.length,1);
    assert.equal(second.process.last.reason,'auxiliary-scope-stopped');
    assert.equal(second.process.last.dispatched,false);
    assert.equal(second.paused,null);
    assert.equal(h.state.metrics.auxiliaryCalls,1);
    assert.equal(h.state.metrics.auxiliaryFailures,1,'the cancelled call stays the only recorded call failure');
  }finally{await h.close();}
});

test('host feedback failure preserves the completed model result without pausing later reviews',async()=>{
  const h=await harness({review:(payload,call)=>call===1?gap(payload,'b.txt 未修改'):{issues:[]}});
  try{
    h.agent.steer=()=>{throw new Error('host cannot accept feedback');};
    h.request('修改 a.txt 和 b.txt');h.answer('已修改 a.txt。');await h.run();
    const failed=h.review.summary(h.agent);
    assert.equal(failed.process.last.reason,'review-processing-failed');assert.equal(failed.process.last.dispatched,true);
    assert.deepEqual(failed.process.last.usage,USAGE);assert.equal(failed.paused,null);
    assert.equal(h.state.metrics.auxiliaryFailures,0);
    h.request('继续修改 c.txt');h.answer('已修改 c.txt。');await h.run();
    assert.equal(h.dispatched.length,2);assert.equal(h.review.summary(h.agent).verdict,'no-supported-gap');
  }finally{await h.close();}
});

for(const kind of ['length','max-tokens'])test(`a truncated review is recorded as output-limit (${kind})`,async()=>{
  const h=await harness({finish:()=>kind,review:()=>({issues:[]})});
  try{
    h.request('修改 a.txt');h.answer('已完成。');
    await h.run();
    const summary=h.review.summary(h.agent);
    assert.equal(summary.process.last.reason,'output-limit');
    assert.equal(summary.process.last.finish.kind,kind);
    assert.equal(summary.process.last.dispatched,true);
    assert.ok(summary.paused,'a call that went out and failed still pauses the route');
  }finally{await h.close();}
});

test('a transient state write failure recovers by persisting the newer in-memory record',async()=>{
  const h=await harness({review:()=>({issues:[]})});
  try{
    const first=h.request('修改 a.txt');h.answer('已完成。');
    await h.review.retry(h.agent);
    await h.run();
    assert.equal(h.dispatched.length,1);
    assert.equal(h.review.summary(h.agent).verdict,'no-supported-gap');
    const saved=await h.text();
    await fs.rm(h.stateFile);await fs.mkdir(h.stateFile);
    const second=h.request('再修改 b.txt');h.answer('已完成。');
    await h.run();
    const stuck=h.review.summary(h.agent);
    assert.equal(h.dispatched.length,1,'an unwritable record stops before the call is dispatched');
    assert.ok(stuck.storageError);assert.equal(stuck.readError,null);assert.equal(stuck.status,'unavailable');
    // The record still on disk never saw the second started attempt.
    assert.equal(JSON.parse(saved).attempts,1);
    await fs.rm(h.stateFile,{recursive:true});
    await h.review.retry(h.agent);
    const recovered=await h.saved();
    assert.equal(h.dispatched.length,1,'recovery does not launch a model call');
    // Both counters came from memory: the disk record never held the second started attempt.
    assert.equal(recovered.attempts,2);assert.equal(recovered.clean,1);
    // The retry facts for both requests are kept: the earlier one, and the one this retry recorded.
    assert.equal(recovered.retryRequests[String(first.seq)],true);
    assert.equal(recovered.retryRequests[String(second.seq)],true);
    assert.equal(recovered.storageError,undefined);assert.equal(recovered.readError,undefined);
    assert.equal(h.review.summary(h.agent).storageError,null);
    assert.equal(h.review.summary(h.agent).status,'ready');
  }finally{await h.close();}
});

test('a write failure left behind by an older record is cleared by the first retry',async()=>{
  const h=await harness({review:()=>({issues:[]})});
  try{
    await fs.writeFile(h.stateFile,JSON.stringify({attempts:1,clean:0,notices:0,unavailable:1,last:null,
      pausedRoutes:{},retryRequests:{},storageError:'EPERM: operation not permitted'}),'utf8');
    await h.review.load(h.agent);
    assert.ok(h.review.summary(h.agent).storageError);
    assert.equal(h.review.summary(h.agent).readError,null);
    h.request('修改 a.txt');h.answer('已完成。');
    await h.run();
    assert.equal(h.dispatched.length,0,'a saved failure keeps reviews stopped until the user retries');
    await h.review.retry(h.agent);
    assert.equal(h.review.summary(h.agent).storageError,null);
    assert.equal((await h.saved()).storageError,undefined,'the failure flag is not written back');
    await h.run();
    assert.equal(h.dispatched.length,1,'the retry runs on the allowance it asked for');
    assert.equal(h.review.summary(h.agent).verdict,'no-supported-gap');
  }finally{await h.close();}
});

test('an unreadable state record is only recovered by reading it again',async()=>{
  const h=await harness({review:()=>({issues:[]})});
  try{
    await fs.writeFile(h.stateFile,'{broken','utf8');
    await h.review.load(h.agent);
    const blocked=h.review.summary(h.agent);
    assert.ok(blocked.readError);assert.equal(blocked.storageError,null);assert.equal(blocked.status,'unavailable');
    h.request('修改 a.txt');h.answer('已完成。');
    await h.run();
    assert.equal(h.dispatched.length,0,'an unknown record keeps reviews stopped');
    await assert.rejects(()=>h.review.retry(h.agent),/could not be re-read/u);
    assert.equal(await h.text(),'{broken','an empty record never overwrites the unknown one');
    assert.deepEqual(Object.keys(h.review.summary(h.agent).process.pausedRoutes),[]);
    await fs.writeFile(h.stateFile,JSON.stringify({attempts:7,clean:2,notices:1,unavailable:3,last:null,
      pausedRoutes:{},retryRequests:{'9':true}}),'utf8');
    await h.review.retry(h.agent);
    const recovered=await h.saved();
    // The old record is adopted as it was; only this request's retry fact and the pause clear are added.
    assert.equal(recovered.attempts,7);assert.equal(recovered.clean,2);assert.equal(recovered.unavailable,3);
    assert.equal(recovered.retryRequests['9'],true);assert.equal(recovered.retryRequests['1'],true);
    assert.equal(recovered.storageError,undefined);assert.equal(recovered.readError,undefined);
    const summary=h.review.summary(h.agent);
    assert.equal(summary.readError,null);assert.equal(summary.storageError,null);assert.equal(summary.status,'ready');
    await h.run();
    assert.equal(h.dispatched.length,1,'review resumes once the record is readable again');
  }finally{await h.close();}
});
