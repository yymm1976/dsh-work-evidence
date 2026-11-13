import test from 'node:test';
import assert from 'node:assert/strict';
import {createExecutionEvidence} from '../execution-evidence.mjs';
import {createTaskFlow} from '../task-flow.mjs';
import {defaults} from '../runtime.mjs';

function fixture(native){
  const log=[],session={id:'probe-facts',log,get seq(){return log.length;},
    append(type,data){log.push({seq:log.length,type,data});}},agent={session};
  const state={id:session.id,root:process.cwd(),dir:process.cwd(),config:{executionTriage:true,probeReplay:true}};
  const runtime={init:async()=>state,get:()=>state,execFor:()=>({}),save:async()=>{}};
  const evidence=createExecutionEvidence({tools:{get:()=>({})},get:()=>null},runtime,()=>native(session),
    {executionDependencies:{capture:async()=>({}),finish:async()=>({})}});
  const plan={question:'Does the native producer report the requested answer?',tool:'bash',arguments:{command:'exact original command'},
    sources:[],cases:[{name:'answer',pointer:'/answer',expectedJson:'42'}]};
  return {evidence,agent,session,plan,execute:(input=plan)=>evidence.execute(agent,input,AbortSignal.timeout(10000))};
}
const completed=()=>({status:'completed',exitCode:0,stdout:{text:'{"answer":42}',truncated:false},stderr:{text:'',truncated:false}});

test('probe completion rejects failure aliases, bounded output and unrecognized native statuses',async()=>{
  const rows=[
    ...['aborted','disabled','not_found','blocked','not-attempted','unavailable','deopt'].map(status=>[{status},'failed']),
    ...['background','promoted'].map(status=>[{status},'pending']),
    ...['stopped','interrupted'].map(status=>[{status},'partial']),
    [{err:'outer failure'},'failed'],[{interrupted:true},'partial'],[{rangeComplete:false},'partial'],
    [{textComplete:false},'partial'],[{scanComplete:false},'partial'],[{budgetTruncated:true},'partial'],
    [{status:'future-unclassified-producer-state'},'unknown']];
  for(const [outer,expected]of rows)for(const outside of [false,true]){
    const value={data:completed()},f=fixture(()=>outside?{...outer,value}:{value:{...outer,...value}});
    const result=await f.execute();
    assert.equal(result.status,expected,JSON.stringify({outer,outside}));
    assert.equal(result.executionCompleted,false);
    assert.equal(result.cases[0].status,'unresolved');
    f.evidence.dispose();
  }
});

test('a failed wrapper retains its live producer and blocks replay until that producer settles',async()=>{
  let calls=0,registered;
  const f=fixture(session=>{
    calls++;
    if(calls===1){
      registered={jobId:'still-running',owner:session.id,kind:'bash',toolCall:{callId:'native-call',rootCallId:'original'}};
      session.append('job/registered',registered);
      return {value:{status:'failed',data:{status:'running',jobId:registered.jobId,exitCode:0}}};
    }
    return {value:completed()};
  });
  f.session.append('tool/call',{callId:'original',name:'work_probe',arguments:f.plan});
  const original=await f.execute();
  assert.equal(original.status,'failed');assert.equal(original.pending,true);assert.equal(original.jobId,'still-running');
  f.session.append('tool/result',{message:{source:{callId:'original'},content:[{type:'text',text:JSON.stringify(original)}]}});
  const blocked=await f.execute({mode:'replay',id:original.id});
  assert.equal(blocked.reason,'probe-replay-pending');assert.equal(blocked.executionOccurred,false);assert.equal(calls,1);
  f.session.append('job/settled',{...registered,status:'failed',cause:'producer',producerReported:true});
  const resumed=await f.execute({mode:'replay',id:original.id});
  assert.equal(resumed.status,'observed');assert.equal(resumed.pending,false);assert.equal(calls,2);
  f.evidence.dispose();
});

test('probe records retain the deepest producer exit, streams and job identity across wrappers',async()=>{
  for(const outerExit of [undefined,0,2])for(const exitCode of [0,7]){
    const f=fixture(()=>({value:{status:'completed',...(outerExit===undefined?{}:{exitCode:outerExit}),
      data:{status:'completed',jobId:'outer-job',data:{...completed(),exitCode,jobId:'producer-job'}}}}));
    const result=await f.execute();
    assert.equal(result.exitCode,exitCode);assert.equal(result.jobId,'producer-job');
    assert.equal(result.stdout.text,'{"answer":42}');
    assert.equal(result.status,exitCode!==0||outerExit===2?'failed':'observed');
    f.evidence.dispose();
  }
});

test('successful stderr warnings and selected user records remain observations',async()=>{
  const warning=fixture(()=>({value:{...completed(),stderr:'ordinary compiler warning'}}));
  assert.equal((await warning.execute()).status,'observed');warning.evidence.dispose();
  const selected=fixture(()=>({value:{status:'observed',sourceComplete:true,format:'json',
    results:[{status:'selected',op:'value',pointer:'/record',value:{status:'failed',error:'user field',complete:false}}]}}));
  const value=await selected.execute({question:'Read the selected record as data.',tool:'read',arguments:{file_path:'record.json'},sources:[],
    cases:[{name:'record status',target:'result',pointer:'/results/0/value/status',expectedJson:'"failed"'}]});
  assert.equal(value.status,'observed');assert.equal(value.cases[0].status,'matched');selected.evidence.dispose();
});

test('live and cold task-flow retain pending producers in failed probe observations',()=>{
  for(const live of [false,true])for(const marker of [{pending:true,background:false},{pending:false,background:true}]){
  const agent={session:{id:'pending-probe-flow',log:[]}},state={root:process.cwd(),config:defaults()};
  const flow=createTaskFlow({}, {get:()=>state,isEnabled:()=>true,activeMode:()=>'default',modeStatus:()=>({})});
  const arguments_={question:'Observe the producer.',tool:'bash',arguments:{command:'check'}};
  const value={status:'failed',...marker,jobId:'active-probe-job',id:'probe-id',
    executionCompleted:false,fileDependencies:{declaredCount:0}};
  agent.session.log.push({seq:0,type:'tool/call',data:{callId:'probe',name:'work_probe',arguments:arguments_}});
  const result={value,content:[{type:'text',text:JSON.stringify(value)}],isError:false};
  if(live)flow.observe({agent,name:'work_probe',callId:'probe',arguments:arguments_},result);
  agent.session.log.push({seq:1,type:'tool/result',data:{message:{source:{callId:'probe'},content:result.content}}});
  const observed=flow.summary(agent);
  assert.ok(observed.pendingJobs.includes('active-probe-job'));
  assert.equal(observed.nativeExecutions.at(-1).status,'failed');
  assert.equal(observed.nativeExecutions.at(-1).pending,true);
  }
});

test('live projection preserves bounded output and keeps an earlier same-command failure unresolved',()=>{
  for(const live of [false,true])for(const marker of [{textComplete:false},{scanComplete:false},{rangeComplete:false},{budgetTruncated:true}]){
    const agent={session:{id:'live-incomplete',log:[]}},state={root:process.cwd(),config:defaults()};
    const flow=createTaskFlow({}, {get:()=>state,isEnabled:()=>true,activeMode:()=>'default',modeStatus:()=>({})});
    for(const [index,value]of [{exitCode:2},{status:'completed',exitCode:0,...marker}].entries()){
      const callId='bounded-'+index,args={command:'same actual check'};
      agent.session.log.push({seq:agent.session.log.length,type:'tool/call',data:{callId,name:'bash',arguments:args}});
      const result={value,content:[{type:'text',text:JSON.stringify(value)}],isError:false};
      if(live)flow.observe({agent,name:'bash',callId,arguments:args},result);
      agent.session.log.push({seq:agent.session.log.length,type:'tool/result',data:{message:{source:{callId},content:result.content}}});
    }
    const result=flow.summary(agent),last=result.nativeExecutions.at(-1);
    assert.equal(last.executionCompleted,false,JSON.stringify({live,marker}));
    assert.equal(last.partial,true,JSON.stringify({live,marker}));
    assert.equal(result.unresolvedErrors.length,1,JSON.stringify({live,marker}));
  }
});
