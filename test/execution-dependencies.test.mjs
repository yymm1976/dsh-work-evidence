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
