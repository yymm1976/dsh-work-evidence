import test from 'node:test';
import assert from 'node:assert/strict';
import {dependencyExecutionComplete} from '../execution-dependencies.mjs';

test('dependency completion checks status, state, and nested job status independently',()=>{
  for(const status of ['failed','running','pending']){
    for(const detail of [{state:status},{job:{status}},{status:'completed',state:status},{state:'completed',job:{status}}])
      assert.equal(dependencyExecutionComplete({exitCode:0,...detail}),false,JSON.stringify(detail));
  }
});

test('legacy zero exit and completed job observations remain complete',()=>{
  assert.equal(dependencyExecutionComplete({exitCode:0}),true);
  assert.equal(dependencyExecutionComplete({job:{status:'completed'}}),true);
  assert.equal(dependencyExecutionComplete({status:'completed',state:'completed',job:{status:'completed'},exitCode:0}),true);
});

test('an inner zero exit cannot erase explicit failures or incomplete flags in any outer data layer',()=>{
  for(const marker of [{status:'failed'},{state:'pending'},{job:{status:'running'}},{success:false},{ok:false},{exitCode:2},
    {completed:false},{complete:false},{executionCompleted:false},{partial:true},{outputPartial:true},{truncated:true},{lossy:true},
    {signal:'SIGTERM'},{stopped:true},{kind:'background',job:{kind:'foreground'}},{kind:'foreground',job:{kind:'background'}}]){
    for(const wrapped of [false,true]){
      const raw={...marker,data:{status:'completed',exitCode:0}},result={value:wrapped?{status:'completed',data:raw}:raw};
      assert.equal(dependencyExecutionComplete(result),false,JSON.stringify({marker,wrapped}));
    }
  }
});

test('every declared status in a data chain must be completed before completion can be certified',()=>{
  for(const status of ['incomplete','success','succeeded','not-a-terminal-status',''])for(const field of ['status','state','job']){
    const marker=field==='job'?{job:{status}}:{[field]:status};
    for(const data of [marker,{status:'completed',exitCode:0,data:marker}]){
      assert.equal(dependencyExecutionComplete({value:{status:'completed',exitCode:0,data:{status:'completed',exitCode:0,data}}}),false);
    }
  }
  assert.equal(dependencyExecutionComplete({value:{status:'completed',data:{status:'completed',exitCode:0,data:{status:'completed'}}}}),true);
});
