import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskFlow} from '../task-flow.mjs';
import {defaults} from '../runtime.mjs';
import {normalizeDshEvents} from '../trajectory-audit.mjs';
import {resultHasProblem,resultHasFailure} from '../visible-results.mjs';
import {queryStructuredJson} from '../structured-json-core.mjs';

function flowResult(candidate,live,name='bash'){
  const log=[{seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'user/message',data:{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Run the checks and retain actual failures.'}]}}}];
  const agent={session:{id:'envelope-boundaries',log}},state={config:{...defaults(),qualityReview:true},root:process.cwd()};
  const flow=createTaskFlow({}, {get:()=>state,isEnabled:()=>true,activeMode:()=>'quality'});
  for(const [index,value] of [{exitCode:2,status:'completed'},candidate].entries()){
    const callId='call-'+index;
    log.push({seq:log.length,type:'tool/call',data:{turn:1,step:index+1,callId,name,arguments:{command:'same-check',description:'Run checks'}}});
    const result={value,content:[{type:'text',text:JSON.stringify(value)}],isError:false};
    if(live)flow.observe({agent,name,callId},result);
    log.push({seq:log.length,type:'tool/result',data:{turn:1,step:index+1,message:{role:'tool',source:{callId},content:result.content,isError:false}}});
  }
  return flow.reviewState(agent);
}

test('outer command failures remain failed in replay and compact live records',()=>{
  for(const live of [false,true])for(const outer of [{status:'failed'},{state:'failed'},{job:{status:'failed'}},{success:false},{ok:false}]){
    const result=flowResult({...outer,data:{status:'completed',exitCode:0}},live),last=result.executions.at(-1);
    assert.equal(last.status,'failed',JSON.stringify({live,outer,last}));
    assert.equal(last.executionCompleted,false);
    assert.equal(last.exitCode,0,'the actual producer exit is retained separately');
    assert.equal(result.unresolvedErrors.length,1);
  }
  for(const live of [false,true]){
    const result=flowResult({status:'failed',data:{status:'running',exitCode:0}},live);
    assert.equal(result.executions.at(-1).status,'failed','the failed call remains failed while its nested job is pending');
    assert.equal(result.unresolvedErrors.length,1);
  }
});

test('incomplete command envelopes cannot clear an earlier failed check',()=>{
  for(const live of [false,true])for(const outer of [{completed:false},{executionCompleted:false},{complete:false},{outputPartial:true},{lossy:true},{status:'running'}]){
    const result=flowResult({...outer,data:{status:'completed',exitCode:0}},live),last=result.executions.at(-1);
    assert.equal(last.executionCompleted,false,JSON.stringify({live,outer,last}));
    assert.equal(result.unresolvedErrors.length,1,JSON.stringify({live,outer}));
  }
});

function audited(value){
  const events=[{seq:0,type:'tool/call',data:{callId:'shell',name:'bash',arguments:{command:'check'}}},
    {seq:1,type:'tool/result',data:{message:{role:'tool',source:{callId:'shell'},isError:false,content:[{type:'text',text:JSON.stringify(value)}]}}}];
  return normalizeDshEvents(events).calls[0];
}

test('audit checks the value wrapper and every data layer without replacing the producer exit',()=>{
  for(const status of ['failed','killed','cancelled','error']){
    const row=audited({exitCode:0,value:{data:{status,exitCode:0}}});
    assert.equal(row.outcome,'failed',status);
    assert.equal(row.exitCode,0);
  }
  for(const status of ['running','pending','queued','partial','unknown']){
    const row=audited({exitCode:0,value:{data:{status,exitCode:0}}});
    assert.equal(row.outputIncomplete,true,status);
  }
  const row=audited({exitCode:7,value:{data:{status:'completed',exitCode:0,stdout:{truncated:true}}}});
  assert.equal(row.outcome,'failed');
  assert.equal(row.outputTruncated,true);
  assert.equal(row.exitCode,0);
});

test('selected user records do not become execution failure markers',()=>{
  for(const record of [{completed:false},{executionCompleted:false},{partial:true},{outputPartial:true},{aborted:true},{stopped:'planned'},{status:'running'}]){
    for(const operation of ['value','page'])assert.equal(resultHasProblem({status:'observed',selectors:[{operation,status:'selected',value:operation==='page'?[record]:record}]}),false,JSON.stringify({operation,record}));
    assert.equal(resultHasProblem(record),true,'a root execution marker still signals a problem');
  }
  assert.equal(resultHasProblem({value:{status:'failed'}}),true);
  assert.equal(resultHasProblem({status:'completed',state:'failed'}),true);
  assert.equal(resultHasProblem({status:'completed',job:{status:'running'}}),true);
  assert.equal(resultHasProblem({results:[{value:{error:'actual nested failure'}}]}),true);
  assert.equal(resultHasProblem({complete:false}),true);
});

test('nested value/data producer states and pending kinds agree in live and cold records',()=>{
  for(const live of [false,true]){
    const failed=flowResult({exitCode:0,value:{data:{status:'failed',exitCode:7}}},live);
    assert.equal(failed.executions.at(-1).status,'failed');
    assert.equal(failed.executions.at(-1).exitCode,7);
    const incomplete=flowResult({exitCode:0,value:{data:{status:'completed',completed:false}}},live);
    assert.equal(incomplete.executions.at(-1).executionCompleted,false);
    assert.equal(incomplete.unresolvedErrors.length,1);
    for(const marker of [{kind:'background'},{kind:'promoted'},{job:{kind:'background'}}]){
      const pending=flowResult({...marker,data:{status:'completed',exitCode:0}},live);
      assert.equal(pending.executions.at(-1).status,'pending',JSON.stringify({live,marker}));
      assert.equal(pending.executions.at(-1).executionCompleted,false);
      assert.equal(pending.unresolvedErrors.length,1);
    }
  }
});

test('actual JSON selector values remain user data while bounded views stay incomplete',()=>{
  for(const record of [{exitCode:7},{error:'a field in the document'},{isError:true},{complete:false},{completed:false},{status:'failed'}]){
    for(const op of ['value','page']){
      const query={status:'observed',...queryStructuredJson(JSON.stringify(op==='page'?[record]:record),[{pointer:'',op}])};
      assert.equal(resultHasProblem(query),false,JSON.stringify({op,record}));
      for(const live of [false,true])assert.equal(flowResult(query,live,'structured_json').unresolvedErrors.length,0);
    }
  }
  const query={status:'observed',...queryStructuredJson(JSON.stringify({payload:'x'.repeat(400)}),[{pointer:'/payload',op:'value'}],{maxValueChars:256})};
  assert.equal(query.results[0].complete,false);
  assert.equal(resultHasProblem(query),true,'incomplete output stays protected from projection');
  assert.equal(resultHasFailure(query),false,'the bounded selection is not an execution failure');
  for(const live of [false,true])assert.equal(flowResult(query,live,'structured_json').unresolvedErrors.length,0);
  assert.equal(resultHasFailure({...query,status:'failed'}),true);
});

test('wrapped per-file effects survive a failed operation without certifying its whole scope',()=>{
  const value={value:{status:'partial',effectState:'applied',files:[{file:'applied.txt',effectState:'applied'},{file:'unknown.txt',effectState:'unknown'}]}};
  const events=[{seq:0,type:'tool/call',data:{callId:'edit',name:'verified_exec',arguments:{edits:[{file:'applied.txt',content:'x'}]}}},
    {seq:1,type:'tool/result',data:{message:{role:'tool',source:{callId:'edit'},isError:true,content:[{type:'text',text:JSON.stringify(value)}]}}}];
  const result=normalizeDshEvents(events);
  assert.equal(result.calls[0].outcome,'failed');
  assert.equal(result.calls[0].outputIncomplete,true);
  assert.deepEqual(result.changes.map(({path,status})=>({path,status})),[{path:'applied.txt',status:'applied'},{path:'unknown.txt',status:'unknown'}]);
});
