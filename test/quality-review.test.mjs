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
async function harness({review=()=>({issues:[]}),finish=()=>'stop',abortOn=0,usage=USAGE,executions=[],pendingJobs=[],artifacts=[]}={}){
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
      yield {type:'usage',usage};
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
      mutation:{seq,version:seq},artifacts,executions,unresolvedErrors:[],pendingJobs,todos:[],
      evidenceHighWater:{seq:seq+1}};}};
  const created=createQualityReview(ctx,runtime,taskFlow,finalJson);
  return {agent,state,stateFile,dispatched,steered,review:created,
    event(type,data){const event={seq:++seq,type,data};events.push(event);return event;},
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

test('successful partial OPS read pages retain source excerpts without claiming complete files',async()=>{
  const marker='PARTIAL_PAGE_SOURCE_MARKER',source='head '.repeat(600)+marker+' tail'.repeat(600);
  const page={status:'partial',data:{failed:0,complete:false,items:[{failed:0,complete:false,items:[{path:'core.mjs',line:250,text:source}]}]},
    coverage:{isComplete:false},continuation:'remaining-page'};
  for(const variant of ['page','failed','item-failed','error','dry-run','tool-error']){
    let payload;const artifacts=[],h=await harness({artifacts,review:value=>{payload=value;return {issues:[]};}});
    try{
      h.request('审阅 core.mjs 的已修改源码。');
      h.event('tool/call',{callId:'write',name:'write',arguments:{file_path:'core.mjs',content:'initial source'}});
      const written=h.event('tool/result',{message:{role:'tool',source:{callId:'write'},isError:false,content:[{type:'text',text:'Created file'}]}});
      artifacts.push({seq:written.seq,path:'core.mjs',tool:'write',effectState:'applied'});
      const value=structuredClone(page);
      if(variant==='failed')value.data.failed=1;
      if(variant==='item-failed')value.data.items[0].failed=1;
      if(variant==='error')value.error={message:'Read failed'};
      const original=JSON.stringify(value),read=h.event('tool/ptc-dispatch',{subCallId:'read',rootCallId:'outer',name:'ops_read_files',
        arguments:{files:[{path:'core.mjs',offset:245,limit:20}],...(variant==='dry-run'?{dryRun:true}:{})},
        isError:variant==='tool-error',content:[{type:'text',text:original}]});
      h.answer('已审阅提供的源码摘录。');await h.run();
      const excerpt=payload.evidence.find(item=>item.seq===read.seq);
      assert.equal(excerpt.data.includes(marker),variant==='page',variant);
      if(variant==='page'){
        assert.deepEqual(excerpt.sourceFiles,['core.mjs']);
        assert.ok(excerpt.data.includes('"complete":false'));assert.ok(excerpt.data.includes('remaining-page'));
      }else assert.equal(excerpt.sourceFiles,undefined,variant);
      assert.equal(read.data.content[0].text,original,'The recorded read and its incomplete-page metadata remain unchanged.');
    }finally{await h.close();}
  }
});

test('quality review links producer completion to the exact nested call without upgrading task or file validity',async()=>{
  const executions=[];let payload;
  const h=await harness({executions,review:value=>{payload=value;return {issues:[]};}});
  try{
    h.request('运行检查并说明实际结果。');
    const label='NATIVE_JOB_LABEL_NOT_NEEDED_IN_REVIEW'.repeat(100);
    const job={jobId:'job-1',owner:'quality-review-session',kind:'pwsh',label,toolCall:{callId:'root:ptc:1',rootCallId:'root'}};
    const registered=h.event('job/registered',job);
    const settled=h.event('job/settled',{...job,status:'completed',cause:'producer',producerReported:true,detail:'exit code: 0'});
    const result=h.event('tool/ptc-dispatch',{...job.toolCall,subCallId:job.toolCall.callId,name:'pwsh',arguments:{command:'check'},content:[{type:'text',text:'OK'}],isError:false});
    executions.push({seq:result.seq,tool:'pwsh',status:'partial',exitCode:null,executionCompleted:false,evidenceValidity:'unknown'});
    h.answer('检查输出 OK，进程以 0 退出。');await h.run();
    const execution=payload.observed.executions[0];assert.equal(execution.status,'partial');assert.equal(execution.evidenceValidity,'unknown');
    assert.equal(execution.completionObservation.exitCode,0);assert.equal(execution.completionObservation.seq,settled.seq);
    assert.equal(execution.completionObservation.registrationSeq,registered.seq);
    assert.ok(payload.evidence.some(item=>item.seq===settled.seq));
    assert.ok(payload.evidence.some(item=>item.seq===registered.seq));
    const registration=payload.evidence.find(item=>item.seq===registered.seq),completion=payload.evidence.find(item=>item.seq===settled.seq);
    assert.deepEqual(JSON.parse(registration.data),{executionSeq:result.seq,jobId:job.jobId});
    assert.deepEqual(JSON.parse(completion.data),{executionSeq:result.seq,jobId:job.jobId,status:'completed',exitCode:0});
    assert.equal(registration.projection,'verified-process-facts');assert.equal(completion.projection,'verified-process-facts');
    assert.equal(execution.completionObservation.callId,job.toolCall.callId);
    assert.equal(execution.completionObservation.rootCallId,job.toolCall.rootCallId);
    assert.ok(!JSON.stringify(payload).includes('NATIVE_JOB_LABEL_NOT_NEEDED_IN_REVIEW'));
    assert.equal(h.agent.session.log.find(event=>event.seq===registered.seq).data.label,label,'Original job data remains unchanged.');
  }finally{await h.close();}
});

test('a cached completion cannot survive contradictory or later source evidence at review time',async()=>{
  const executions=[];let payload;
  const h=await harness({executions,review:value=>{payload=value;return {issues:[]};}});
  try{
    h.request('说明实际结果。');
    const job={jobId:'cached-job',owner:'quality-review-session',kind:'pwsh',toolCall:{callId:'root:ptc:1',rootCallId:'root'}};
    const registration=h.event('job/registered',job);
    const value={...job,status:'completed',cause:'producer',producerReported:true,detail:'exit code: 0'};
    const settlement=h.event('job/settled',value);
    const result=h.event('tool/ptc-dispatch',{...job.toolCall,subCallId:job.toolCall.callId,name:'pwsh',arguments:{command:'check'},content:[{type:'text',text:'OK'}],isError:false});
    executions.push({seq:result.seq,tool:'pwsh',status:'partial',completionObservation:{seq:settlement.seq,registrationSeq:registration.seq,
      jobId:job.jobId,exitCode:0,processCompleted:true}});
    h.event('job/settled',{...value,detail:'exit code: 1'});
    h.answer('命令已经结束。');await h.run();
    assert.equal(payload.observed.executions[0].completionObservation,undefined);
    assert.ok(!payload.evidence.some(item=>item.projection==='verified-process-facts'));
  }finally{await h.close();}
});

test('pending jobs retain their original registration data rather than using a completed-process projection',async()=>{
  let payload;
  const h=await harness({pendingJobs:['live-job'],review:value=>{payload=value;return {issues:[]};}});
  try{
    h.request('说明任务当前状态。');
    const job={jobId:'live-job',owner:'quality-review-session',kind:'pwsh',label:'A job still waiting on output',toolCall:{callId:'live',rootCallId:'live'}};
    const registered=h.event('job/registered',job);
    h.answer('后台任务仍在等待。');await h.run();
    const evidence=payload.evidence.find(item=>item.seq===registered.seq);
    assert.deepEqual(JSON.parse(evidence.data),job);assert.equal(evidence.projection,undefined);
    assert.deepEqual(payload.observed.pendingJobs,['live-job']);
  }finally{await h.close();}
});

test('a report contradiction requires an exact answer claim and an exact supplied counterexample quote',async()=>{
  const h=await harness({review:payload=>{
    const source=payload.evidence.find(item=>item.data.includes('async def generate():'));
    return {issues:[{kind:'unsupported-success',detail:'An async generator does not run its body at construction.',
      claim:'构造时同步抛出 ValueError',counterEvidence:{seq:source.seq,quote:'async def generate():'},evidence:[payload.answer.seq,source.seq]}]};}});
  try{
    h.request('说明这个生成器何时校验参数。');
    h.event('tool/call',{turn:1,step:1,callId:'read-code',name:'read',arguments:{file_path:'generate.py'}});
    h.event('tool/result',{turn:1,step:1,message:{role:'tool',source:{callId:'read-code'},content:[{type:'text',text:'async def generate():\n    raise ValueError()\n    yield 1'}],isError:false}});
    h.answer('构造时同步抛出 ValueError。');await h.run();
    assert.equal(h.steered.length,1);assert.equal((await h.saved()).last.status,'applied');
  }finally{await h.close();}
});

test('absent observations, invented claims and quotes outside the cited event cannot support a report contradiction',async()=>{
  for(const variation of ['missing-quotes','invented-claim','invented-quote','wrong-event','uncited-event']){
    const h=await harness({review:payload=>{
      const source=payload.evidence.find(item=>item.data.includes('recorded value is 1'));
      const issue={kind:'unsupported-success',detail:'The claim contradicts a recorded value.',claim:'结果为 0',
        counterEvidence:{seq:source.seq,quote:'recorded value is 1'},evidence:[payload.answer.seq,source.seq]};
      if(variation==='missing-quotes'){delete issue.claim;delete issue.counterEvidence;issue.detail='No execution evidence was supplied.';}
      if(variation==='invented-claim')issue.claim='从未出现的声明';
      if(variation==='invented-quote')issue.counterEvidence.quote='no execution records supplied';
      if(variation==='wrong-event'){issue.counterEvidence.seq=payload.request.seq;issue.evidence.push(payload.request.seq);}
      if(variation==='uncited-event')issue.evidence=[payload.answer.seq,payload.evidence.find(item=>item.seq!==source.seq).seq];
      return {issues:[issue]};}});
    try{
      h.request('说明实际结果。');
      h.event('tool/call',{turn:1,step:1,callId:'read-value',name:'read',arguments:{file_path:'value.txt'}});
      h.event('tool/result',{turn:1,step:1,message:{role:'tool',source:{callId:'read-value'},content:[{type:'text',text:'recorded value is 1'}],isError:false}});
      h.answer('结果为 0。');await h.run();
      assert.equal(h.steered.length,0,variation);assert.equal((await h.saved()).last.reason,'invalid-review-result',variation);
    }finally{await h.close();}
  }
});

test('ambiguous, unrelated and non-producer job settlements cannot prove an execution result',async()=>{
  for(const variation of ['different-call','different-owner','not-producer','conflict','duplicate','later']){
    const executions=[];let payload;
    const h=await harness({executions,review:value=>{payload=value;return {issues:[]};}});
    try{
      h.request('运行检查。');
      const job={jobId:'job-1',owner:'quality-review-session',kind:'pwsh',toolCall:{callId:'root:ptc:1',rootCallId:'root'}};
      h.event('job/registered',job);
      const settled={...job,status:'completed',cause:'producer',producerReported:true,detail:'exit code: 0'};
      if(variation==='different-call')settled.toolCall={callId:'another',rootCallId:'root'};
      if(variation==='different-owner')settled.owner='another-session';
      if(variation==='not-producer')settled.producerReported=false;
      if(variation==='conflict')settled.status='failed';
      if(variation!=='later')h.event('job/settled',settled);
      if(variation==='duplicate')h.event('job/settled',settled);
      const result=h.event('tool/ptc-dispatch',{...job.toolCall,subCallId:job.toolCall.callId,name:'pwsh',arguments:{command:'check'},content:[{type:'text',text:'OK'}],isError:false});
      executions.push({seq:result.seq,tool:'pwsh',status:'partial',exitCode:null,executionCompleted:false});
      h.answer('检查输出 OK。');if(variation==='later')h.event('job/settled',settled);
      await h.run();assert.ok(payload);assert.equal(payload.observed.executions[0].completionObservation,undefined,variation);
    }finally{await h.close();}
  }
});

test('native completed status with nonzero exit is retained as process completion without proving success',async()=>{
  const executions=[];let payload;
  const h=await harness({executions,review:value=>{payload=value;const item=value.observed.executions[0];
    return {issues:[{kind:'execution-failure',detail:'命令以 1 退出，最终答复仍称检查通过。',evidence:[value.answer.seq,item.seq,item.completionObservation.seq]}]};}});
  try{
    h.request('说明命令实际退出结果。');
    const job={jobId:'job-nonzero',owner:'quality-review-session',kind:'pwsh',toolCall:{callId:'root:ptc:1',rootCallId:'root'}};
    h.event('job/registered',job);
    h.event('job/settled',{...job,status:'completed',cause:'producer',producerReported:true,detail:'exit code: 1'});
    const result=h.event('tool/ptc-dispatch',{...job.toolCall,subCallId:job.toolCall.callId,name:'pwsh',arguments:{command:'check'},content:[{type:'text',text:'check did not pass'}],isError:false});
    executions.push({seq:result.seq,tool:'pwsh',status:'partial',exitCode:null,executionCompleted:false,evidenceValidity:'unknown'});
    h.answer('检查已经通过。');await h.run();
    const execution=payload.observed.executions[0];assert.equal(execution.completionObservation.status,'completed');
    assert.equal(execution.completionObservation.exitCode,1);assert.equal(execution.status,'partial');
    assert.equal(execution.evidenceValidity,'unknown');assert.equal(execution.exitCode,null);
    assert.equal(h.steered.length,1);assert.equal((await h.saved()).last.status,'applied');
  }finally{await h.close();}
});

test('execution failure based on completion facts requires both exact events and an observed nonzero exit',async()=>{
  for(const variation of ['missing-completion','only-completion','zero-exit']){
    const executions=[],h=await harness({executions,review:payload=>{
      const item=payload.observed.executions[0],refs=[payload.answer.seq];
      if(variation!=='only-completion')refs.push(item.seq);
      if(variation!=='missing-completion')refs.push(item.completionObservation.seq);
      return {issues:[{kind:'execution-failure',detail:'The command did not pass.',evidence:refs}]};}});
    try{
      h.request('说明命令结果。');
      const job={jobId:'job-scope',owner:'quality-review-session',kind:'pwsh',toolCall:{callId:'root:ptc:1',rootCallId:'root'}};
      h.event('job/registered',job);
      h.event('job/settled',{...job,status:'completed',cause:'producer',producerReported:true,detail:'exit code: '+(variation==='zero-exit'?0:1)});
      const result=h.event('tool/ptc-dispatch',{...job.toolCall,subCallId:job.toolCall.callId,name:'pwsh',arguments:{command:'check'},content:[{type:'text',text:'result'}],isError:false});
      executions.push({seq:result.seq,tool:'pwsh',status:'partial',exitCode:null,executionCompleted:false});
      h.answer('命令已经结束。');await h.run();
      assert.equal(h.steered.length,0,variation);assert.equal((await h.saved()).last.reason,'invalid-review-result',variation);
    }finally{await h.close();}
  }
});

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

test('a failed review preserves raw zero counters separately from unknown consumption',async()=>{
  const zero={inputTokens:0,outputTokens:0,totalTokens:0},h=await harness({finish:()=>'error',usage:zero});
  try{
    h.request('修改 a.txt 并说明结果');h.answer('已完成。');await h.run();
    const summary=h.review.summary(h.agent);
    assert.equal(summary.verdict,'unavailable');assert.equal(summary.process.last.usage,null);
    assert.deepEqual(summary.process.last.reportedUsage,zero);assert.equal(h.state.metrics.auxiliaryUnknownCalls,1);
    const saved=await h.saved();assert.equal(saved.last.usage,null);assert.deepEqual(saved.last.reportedUsage,zero);
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
