import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskFlow} from '../task-flow.mjs';
import {defaults} from '../runtime.mjs';

function reviewResult(value,{body=typeof value==='string'?value:JSON.stringify(value),live=false,isError=false}={}){
  const log=[{seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'user/message',data:{message:{id:'request',role:'user',source:{kind:'user'},content:[{type:'text',text:'运行检查并说明结果'}]}}},
    {seq:2,type:'tool/call',data:{turn:1,step:1,callId:'shell',name:'pwsh',arguments:{command:'run-checks',description:'checks'}}}];
  const agent={session:{id:'execution-facts',log,seq:4}},state={config:defaults(),root:process.cwd()};
  const flow=createTaskFlow({}, {get:()=>state,isEnabled:()=>true,activeMode:()=> 'quality'});
  if(live)flow.observe({agent,name:'pwsh',callId:'shell'},{value,content:[{type:'text',text:body}],isError});
  log.push({seq:3,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',source:{callId:'shell'},content:[{type:'text',text:body}],isError}}});
  return flow.reviewState(agent);
}

test('zero failed count is not confused with the total count before FAILED',()=>{
  for(const stdout of ['TOTAL 36 FAILED 0','checks: 25 passed: 25 failed: 0','36 tests, 0 failed','FAILED 0']){
    for(const live of [false,true]){
      const result=reviewResult({exitCode:0,stdout:{text:stdout},stderr:{text:'parser warning: preserved invalid record'}},{live});
      assert.equal(result.executions[0].status,'observed',stdout);
      assert.equal(result.executions[0].executionCompleted,true);
      assert.equal(result.unresolvedErrors.length,0);
    }
  }
});

test('reported nonzero failures remain failures even when the process exits zero',()=>{
  for(const stdout of ['TOTAL 36 FAILED 2','checks: 25 passed: 24 failed: 1','36 tests, 2 failed','FAILED 2','FAIL: wrong preserved line']){
    for(const live of [false,true]){
      const result=reviewResult({exitCode:0,stdout:{text:stdout},stderr:{text:''}},{live});
      assert.equal(result.executions[0].status,'failed',stdout);
      assert.equal(result.executions[0].failureSource,'reported-checks');
      assert.equal(result.unresolvedErrors.length,1);
    }
  }
});

test('legacy plain output stays incomplete without being reported as a failed process',()=>{
  for(const live of [false,true]){
    const result=reviewResult(null,{body:'checks: 25 passed: 25 failed: 0',live});
    assert.equal(result.executions[0].status,'partial');
    assert.equal(result.executions[0].executionCompleted,false);
    assert.equal(result.unresolvedErrors.length,0);
    const failed=reviewResult(null,{body:'checks: 25 passed: 24 failed: 1',live});
    assert.equal(failed.executions[0].status,'failed');
    assert.equal(failed.executions[0].failureSource,'reported-checks');
  }
});

test('explicit failures, incomplete output and stopped processes retain their limits',()=>{
  for(const live of [false,true]){
    for(const value of [{exitCode:1},{exitCode:0,error:'failed'},{exitCode:0,aborted:true},{exitCode:0,timedOut:true},{exitCode:0,signal:'SIGTERM'},{exitCode:0,status:'killed'}]){
      const result=reviewResult(value,{live});
      assert.equal(result.executions[0].status,'failed',JSON.stringify(value));
      assert.equal(result.unresolvedErrors.length,1);
    }
    for(const value of [{exitCode:0,truncated:true},{exitCode:0,complete:false},{exitCode:0,status:'unknown'}]){
      assert.equal(reviewResult(value,{live}).executions[0].executionCompleted,false);
    }
    assert.equal(reviewResult(null,{body:'Error: command failed',live,isError:true}).executions[0].status,'failed');
  }
});
