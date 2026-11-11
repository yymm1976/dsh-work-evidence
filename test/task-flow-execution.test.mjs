import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskFlow,taskFlowGuidance} from '../task-flow.mjs';
import {defaults} from '../runtime.mjs';
import {reportedCheckFailure,reportedExecutionChecks} from '../recovery.mjs';

function reviewResult(value,{body=typeof value==='string'?value:JSON.stringify(value),live=false,isError=false}={}){
  const log=[{seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'user/message',data:{message:{id:'request',role:'user',source:{kind:'user'},content:[{type:'text',text:'运行检查并说明结果'}]}}},
    {seq:2,type:'tool/call',data:{turn:1,step:1,callId:'shell',name:'pwsh',arguments:{command:'run-checks',description:'checks'}}}];
  const agent={session:{id:'execution-facts',log,seq:4}},state={config:{...defaults(),qualityReview:true},root:process.cwd()};
  const flow=createTaskFlow({}, {get:()=>state,isEnabled:()=>true,activeMode:()=> 'quality'});
  if(live)flow.observe({agent,name:'pwsh',callId:'shell'},{value,content:[{type:'text',text:body}],isError});
  log.push({seq:3,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',source:{callId:'shell'},content:[{type:'text',text:body}],isError}}});
  return flow.reviewState(agent);
}

test('zero failed count is not confused with the total count before FAILED',()=>{
  for(const stdout of ['TOTAL 36 FAILED 0','checks: 25 passed: 25 failed: 0','36 tests, 0 failed','FAILED 0',
    'legacy suites: 2074 passed, 0 failed','Example output: legacy suites: 2074 passed, 2 failed','PASS 54 FAIL 0','Example output: PASS 54 FAIL 3']){
    for(const live of [false,true]){
      const result=reviewResult({exitCode:0,stdout:{text:stdout},stderr:{text:'parser warning: preserved invalid record'}},{live});
      assert.equal(result.executions[0].status,'observed',stdout);
      assert.equal(result.executions[0].executionCompleted,true);
      assert.equal(result.unresolvedErrors.length,0);
    }
  }
});

test('reported nonzero failures remain failures even when the process exits zero',()=>{
  for(const stdout of ['TOTAL 36 FAILED 2','checks: 25 passed: 24 failed: 1','36 tests, 2 failed','FAILED 2','FAIL: wrong preserved line',
    'legacy suites: 2074 passed, 2 failed','PASS 54 FAIL 3',"LOAD-FAIL braces.js Cannot find module 'fill-range'"]){
    for(const live of [false,true]){
      const result=reviewResult({exitCode:0,stdout:{text:stdout},stderr:{text:''}},{live});
      assert.equal(result.executions[0].status,'failed',stdout);
      assert.equal(result.executions[0].failureSource,'reported-checks');
      assert.equal(result.unresolvedErrors.length,1);
    }
  }
});

test('labeled total and failure reports retain arithmetic counts and only anchored failed entries',()=>{
  const failure=reportedCheckFailure('checks: 41, failures: 2\r\nFAIL same export formatting as set_key: wrong newline\r\nFAIL single pass output: wrong fixture\r\n');
  assert.deepEqual(failure.summary,{passed:39,failed:2,total:41,source:'reported-text',text:'checks: 41, failures: 2'});
  assert.deepEqual(failure.failureEntries,['FAIL same export formatting as set_key: wrong newline','FAIL single pass output: wrong fixture']);
  for(const text of ['checks: 46, failures: 0','Example output: checks: 46, failures: 1','FAIL example: ordinary prose'])assert.equal(reportedCheckFailure(text),null,text);
  assert.equal(reportedCheckFailure('checks: 2, failures: 3').summary,null,'inconsistent totals do not invent a passed count');
  assert.equal(reportedCheckFailure('checks: 9007199254740992, failures: 1').summary,null,'unsafe totals stay unknown');
});

test('unittest reports on stderr preserve test totals, failures and errors without reading exception counts',()=>{
  const stderr='FAIL: test_wrong_value (checks.Example.test_wrong_value)\nAssertionError: 2 != 3\nERROR: test_missing_value (checks.Example.test_missing_value)\nKeyError: missing\nRan 5 tests in 0.004s\n\nFAILED (failures=1, errors=1, skipped=1)\n';
  const report=reportedExecutionChecks({exitCode:1,stdout:{text:''},stderr:{text:stderr}});
  assert.equal(report.sourceStream,'stderr');assert.equal(report.processExitCode,1);
  assert.deepEqual([report.summary.total,report.summary.passed,report.summary.failed,report.summary.failures,report.summary.errors,report.summary.skipped],[5,2,2,1,1,1]);
  assert.deepEqual(report.failureEntries,['FAIL: test_wrong_value (checks.Example.test_wrong_value)','ERROR: test_missing_value (checks.Example.test_missing_value)']);
  assert.equal(reportedExecutionChecks({exitCode:0,stdout:'',stderr:'warning: FAIL: an ordinary diagnostic'}),null);
  assert.equal(reportedExecutionChecks({exitCode:1,stdout:'',stderr:{text:stderr,truncated:true}}),null);
  for(const suffix of ['FAILED (failures=6)','FAILED (failures=1, failures=1)','FAILED (failures=1, unknown=1)'])
    assert.equal(reportedExecutionChecks({exitCode:1,stdout:'',stderr:'Ran 5 tests in 0.004s\n'+suffix}),null,suffix);
  for(const live of [false,true])assert.equal(reviewResult({exitCode:1,stdout:'',stderr},{live}).executions[0].failureSource,'reported-checks');
});

test('string-list failure reports preserve named failures and leave absent totals unknown',()=>{
  const stdout="PASS leading blank lines kept | correct\r\nFAIL blank lines + untouched entry | wrong quoting\r\nFAIL crlf replaced+appended | wrong newline\r\nFAILURES: ['blank lines + untouched entry', 'crlf replaced+appended']\r\n";
  const report=reportedExecutionChecks({exitCode:0,stdout:{text:stdout},stderr:{text:''}});
  assert.equal(report.processExitCode,0);assert.equal(report.summary.failed,2);
  assert.equal(report.summary.source,'reported-list');assert.equal(report.summary.passed,undefined);assert.equal(report.summary.total,undefined);
  assert.deepEqual(report.failureEntries,['FAIL blank lines + untouched entry | wrong quoting','FAIL crlf replaced+appended | wrong newline']);
  for(const live of [false,true])assert.equal(reviewResult({exitCode:0,stdout,stderr:''},{live}).executions[0].failureSource,'reported-checks');
  const escaped=String.raw`FAILURES: ['quoted \'key\', comma', "second \"name\"",]`;
  assert.equal(reportedCheckFailure(escaped).summary.failed,2,'commas and escaped quotes inside names are not extra entries');
  for(const value of ["FAILURES: []","FAILURES: none","Example output: FAILURES: ['example']",
    "FAIL example: ordinary prose","FAILURES: [get_failures()]","FAILURES: ['unclosed'","FAILURES: ['one', 2]"])
    assert.equal(reportedCheckFailure(value),null,value);
  assert.equal(reportedExecutionChecks({exitCode:0,stdout:{text:stdout,truncated:true},stderr:''}),null);
});

test('named verdicts and a terminal ratio must agree before exact counts are reported',()=>{
  const text='PASS preserved source\r\nFAIL wrong fixture -> AssertionError: mismatch\r\nPASS encoding\r\nTOTAL 2/3\r\n';
  const report=reportedExecutionChecks({exitCode:0,stdout:{text},stderr:{text:''}});
  assert.deepEqual(report.summary,{passed:2,failed:1,total:3,source:'reported-named-ratio',text:'TOTAL 2/3'});
  assert.deepEqual(report.failureEntries,['FAIL wrong fixture -> AssertionError: mismatch']);
  assert.equal(report.processExitCode,0);
  for(const live of [false,true])assert.equal(reviewResult({exitCode:0,stdout:text,stderr:''},{live}).executions[0].failureSource,'reported-checks');
  for(const value of ['TOTAL 2/3','PASS source\nFAIL fixture\nTOTAL 1/3','PASS source\nFAIL fixture\nTOTAL 0/2',
    'PASS source\nFAIL fixture\nTOTAL 9007199254740992/9007199254740993',
    'PASS source\nFAIL fixture\nTOTAL 1/2\nThis is an example',
    'PASS source\nPASS fixture\nTOTAL 2/2','Example: TOTAL 1/2'])
    assert.equal(reportedCheckFailure(value),null,value);
  assert.equal(reportedExecutionChecks({exitCode:0,stdout:{text,truncated:true},stderr:''}),null);
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

function nativeRecovery(){
  const log=[],add=(type,data)=>{const event={seq:log.length,type,data};log.push(event);return event;};
  add('turn/start',{turn:1});add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'完成当前修改并说明结果。'}]}});
  const agent={session:{id:'native-recovery',log}},state={config:defaults({qualityReview:true}),root:process.cwd()};
  const flow=createTaskFlow({}, {get:()=>state,isEnabled:()=>true,activeMode:()=>'quality'});
  function command(command,code,{nested=false,body=code?'[exit code: '+code+']':'command output',workdir,variation=null}={}){
    const id='native-'+log.length,inner=nested?id+':ptc:1':id,args={command,...(workdir?{workdir}:{})};
    add('tool/call',{callId:id,name:nested?'run_code':'pwsh',arguments:nested?{code:'return await tools.pwsh({command:"check"});'}:args});
    if(nested)add('tool/ptc-dispatch-start',{rootCallId:id,subCallId:inner,name:'pwsh',arguments:args});
    const job={jobId:'job-'+id,owner:'native-recovery',kind:'pwsh',toolCall:{callId:inner,rootCallId:id}};
    add('job/registered',job);
    const end={...job,status:'completed',cause:'producer',producerReported:true,detail:'exit code: '+code};
    if(variation==='wrong-owner')end.owner='unrelated-session';
    if(variation!=='later')add('job/settled',end);
    if(variation==='duplicate')add('job/settled',end);
    const result=nested?add('tool/ptc-dispatch',{rootCallId:id,subCallId:inner,name:'pwsh',arguments:args,content:[{type:'text',text:body}],isError:false}):
      add('tool/result',{message:{role:'tool',source:{callId:id},content:[{type:'text',text:body}],isError:false}});
    if(nested)add('tool/result',{message:{role:'tool',source:{callId:id},content:[{type:'text',text:body}],isError:false}});
    if(variation==='later')add('job/settled',end);
    return result;
  }
  return {add,command,review:()=>flow.reviewState(agent)};
}

test('cold native completion clears only the matching earlier nonzero process error while output and file validity remain unknown',()=>{
  for(const nested of [false,true]){
    const h=nativeRecovery(),failed=h.command('run-checks',1,{nested}),success=h.command('run-checks',0,{nested});
    const result=h.review(),last=result.executions.at(-1);
    assert.equal(result.unresolvedErrors.length,0);
    assert.ok(result.executions.some(item=>item.seq===failed.seq&&item.status==='failed'),'the historical failure remains recorded');
    assert.equal(last.seq,success.seq);assert.equal(last.exitCode,0);assert.equal(last.completionObservation.exitCode,0);
    assert.equal(last.status,'partial');assert.equal(last.executionCompleted,false);assert.equal(last.evidenceValidity,'unknown');
  }
});

test('cold completion cannot resolve another command, working directory, user request or zero-exit failed check',()=>{
  for(const variation of ['command','directory','request','failed-check']){
    const h=nativeRecovery(),first=h.command('run-checks',variation==='failed-check'?0:1,
      {body:variation==='failed-check'?'TOTAL 2 FAILED 1':'[exit code: 1]',workdir:variation==='directory'?'one':undefined});
    if(variation==='request')h.add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'另一项任务。'}]}});
    h.command(variation==='command'?'other-checks':'run-checks',0,{workdir:variation==='directory'?'two':undefined});
    assert.ok(h.review().unresolvedErrors.some(item=>item.seq===first.seq),variation);
  }
});

test('unrelated, ambiguous or later completion and explicitly partial results preserve a native failure',()=>{
  for(const variation of ['wrong-owner','duplicate','later','partial','truncated','reported-failure']){
    const h=nativeRecovery(),first=h.command('run-checks',1);
    const body=variation==='partial'?JSON.stringify({nativeStructured:false,partial:true}):
      variation==='truncated'?JSON.stringify({nativeStructured:false,stdout:{text:'ok',truncated:true}}):
      variation==='reported-failure'?'TOTAL 2 FAILED 1':'command output';
    h.command('run-checks',0,{variation,body});
    const result=h.review();
    if(variation==='reported-failure')assert.equal(result.executions.at(-1).failureSource,'reported-checks');
    else assert.ok(result.unresolvedErrors.some(item=>item.seq===first.seq),variation);
    assert.equal(result.unresolvedErrors.length,1,variation);
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

function timeline(config={},availableTools=[],mode='aggressive'){
  const log=[],agent={session:{id:'flow-timeline',log,seq:0}},runtimeState={config:{...defaults(),...config},root:process.cwd(),taskSurfaceMode:'writable'};
  const flow=createTaskFlow({tools:{get:name=>availableTools.includes(name)?{}:null}}, {get:()=>runtimeState,isEnabled:()=>runtimeState.config.enabled!==false,activeMode:()=>mode,modeStatus:()=>({selected:mode})});
  const add=(type,data)=>{const event={seq:log.length,type,data};log.push(event);agent.session.seq=event.seq;return event;};
  const user=()=>add('user/message',{message:{id:'request-'+log.length,role:'user',source:{kind:'user'},content:[{type:'text',text:'修改项目并运行检查'}]}});
  add('turn/start',{turn:1});user();
  let step=0;
  const command=(name,args,value,{live=true,isError=false,innerIsError=isError,nested=false,program='return await tools.pwsh({command:"checks"});',output=value}={})=>{
    add('step/start',{step:++step});const id='call-'+log.length;
    if(nested){
      add('assistant/message',{message:{role:'assistant',content:[{type:'tool-call',id,name:'run_code',arguments:{code:program}}]}});
      add('tool/call',{callId:id,name:'run_code',arguments:{code:program}});
      add('tool/ptc-dispatch-start',{rootCallId:id,subCallId:id+'-inner',name,arguments:args});
      if(live)flow.observe({agent,name,arguments:args,callId:id+'-inner'},{value,content:[{type:'text',text:JSON.stringify(value)}],isError:innerIsError});
      add('tool/ptc-dispatch',{rootCallId:id,subCallId:id+'-inner',name,arguments:args,content:[{type:'text',text:JSON.stringify(value)}],isError:innerIsError});
      add('tool/result',{message:{role:'tool',source:{callId:id},content:[{type:'text',text:typeof output==='string'?output:JSON.stringify(output)}],isError}});
    }else{
      add('tool/call',{callId:id,name,arguments:args});
      if(live)flow.observe({agent,name,arguments:args,callId:id},{value,content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}],isError});
      add('tool/result',{message:{role:'tool',source:{callId:id},content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}],isError}});
    }
    flow.sync(agent);
  };
  const notices=()=>flow.beforeStep(agent);
  const keep=messages=>messages.forEach(message=>add('user/message',{message}));
  return {flow,agent,add,user,command,notices,keep,runtimeState};
}

test('job registry queries keep the call outcome separate from states in the returned list',()=>{
  for(const live of [true,false])for(const nested of [true,false]){
    const t=timeline({stepPacing:false});
    const jobs=['running','stopping','completed','failed','killed'].map((status,index)=>({id:'job-'+index,kind:'pwsh',status,label:'Error: historical process output',startedAt:1}));
    t.command('job_list',{},jobs,{live,nested});
    assert.deepEqual(t.flow.summary(t.agent).unresolvedErrors,[],'job status does not turn a successful list call into a failure');
    t.add('job/settled',{jobId:'job-3',status:'failed'});
    assert.equal(t.flow.summary(t.agent).unresolvedErrors.length,1,'the actual failed process remains recorded');
    t.command('job_list',{},jobs,{live,nested});
    assert.equal(t.flow.summary(t.agent).unresolvedErrors.length,1,'reading the list does not clear the failed process');
    t.command('job_list',{},null,{live,nested,isError:true,output:'Error: registry unavailable'});
    assert.ok(t.flow.summary(t.agent).unresolvedErrors.some(error=>error.tool==='job_list'),'native list failure is retained');
  }
});

test('a same-command retry with completed false cannot resolve a recorded process failure',()=>{
  for(const live of [true,false])for(const nested of [true,false]){
    const t=timeline({stepPacing:false,qualityReview:true},[],'quality'),args={command:'run-checks'};
    t.command('pwsh',args,{exitCode:1,stdout:'failed',stderr:''},{live,nested});
    t.command('pwsh',args,{exitCode:0,completed:false,stdout:'still incomplete',stderr:''},{live,nested});
    const result=t.flow.reviewState(t.agent);
    assert.equal(result.unresolvedErrors.length,1,JSON.stringify({live,nested}));
    assert.equal(result.executions.at(-1).executionCompleted,false);
    t.command('pwsh',args,{exitCode:0,completed:true,stdout:'finished',stderr:''},{live,nested});
    assert.equal(t.flow.reviewState(t.agent).unresolvedErrors.length,0,'an actual complete retry can resolve the failure');
  }
});

test('implicit PTC file writes separate execution comparisons without claiming an observed mutation',()=>{
  for(const live of [true,false]){
    const t=timeline({stepPacing:false}),args={command:'node checks.mjs'},result={exitCode:0,stdout:'passed',stderr:''};
    t.command('pwsh',args,result,{live,nested:true});
    t.command('run_code',{code:'const fs = require("node:fs"); fs.writeFileSync("main.js", "changed"); return "patched";'},'patched',{live});
    t.command('pwsh',args,result,{live,nested:true});
    assert.ok(!t.notices().some(m=>m.source.taskFlow.kind==='reuse'));
    const summary=t.flow.summary(t.agent);
    assert.equal(summary.lastMutationSeq,-1);
    assert.equal(summary.nativeExecutions[1].programEpoch,3,'assistant and tool/call events count one program');
    t.command('pwsh',args,result,{live});
    assert.equal(t.notices().some(m=>m.source.taskFlow.kind==='reuse'),live,'only live complete short outputs support an equality comparison');
  }
});

test('an incomplete scriptRef retry preserves the referenced failed execution',()=>{
  for(const live of [true,false])for(const nested of [true,false]){
    const t=timeline({stepPacing:false,qualityReview:true},[],'quality');
    t.command('work_exec',{runtime:'node',code:'throw new Error("failed")'}, {exitCode:1,stderr:'Error: failed',stdout:''},{live,nested});
    const first=t.flow.reviewState(t.agent).unresolvedErrors[0];assert.ok(first);
    t.command('work_exec',{scriptRef:'failed-version'}, {exitCode:0,completed:false,stdout:'pending',stderr:'',scriptSourceRefs:[first.callId]},{live,nested});
    assert.equal(t.flow.reviewState(t.agent).unresolvedErrors.length,1,JSON.stringify({live,nested}));
    t.command('work_exec',{scriptRef:'failed-version'}, {exitCode:0,completed:true,stdout:'complete',stderr:'',scriptSourceRefs:[first.callId]},{live,nested});
    assert.equal(t.flow.reviewState(t.agent).unresolvedErrors.length,0);
  }
});

test('large PTC failure advice distinguishes worker exits, parse errors, cancellation and execution failures',()=>{
  for(const live of [true,false])for(const [error,expected,unexpected]of [
    ['worker-exit: kernel helper did not answer','执行工作进程故障','按实际解析错误修正程序'],
    ['SyntaxError: Unexpected token','按实际解析错误修正程序','执行工作进程故障'],
    ['Request cancelled','程序已取消','只修改实际失败部分'],
    ['Permission denied','先依据原错误定位失败原因','按实际解析错误修正程序'],
  ]){
    const t=timeline({stepPacing:false});
    t.command('run_code',{code:'x'.repeat(1200)},error,{live,isError:true});
    const advice=t.notices().find(m=>m.source.taskFlow.kind==='diagnostic');
    assert.ok(advice,error+' live='+live);
    assert.ok(advice.content[0].text.includes(expected),advice.content[0].text);
    assert.ok(!advice.content[0].text.includes(unexpected));
    assert.ok(!advice.content[0].text.includes('字符未实际执行'));
  }
});

test('non-aggressive stage advice occurs once per phase and blocker state, including after replay',()=>{
  const t=timeline({executionTriage:false},[],'default'),result={exitCode:0,stdout:'ok',stderr:''};
  const judgments=[];
  for(let i=0;i<12;i++){
    t.command('pwsh',{command:'echo '+i},result);
    const notices=t.notices();judgments.push(...notices.filter(m=>m.source.taskFlow.kind==='judgment'));t.keep(notices);
  }
  assert.equal(judgments.length,1);
  const replay=timeline({executionTriage:false},[],'default');
  replay.agent.session.log.splice(0,Infinity,...t.agent.session.log);replay.agent.session.seq=t.agent.session.seq;
  assert.ok(!replay.notices().some(m=>m.source.taskFlow.kind==='judgment'));
  t.command('pwsh',{command:'failing'}, {exitCode:1,stderr:'Error: actual blocker'});
  assert.ok(t.notices().some(m=>m.source.taskFlow.kind==='judgment'));
  t.user();
  for(let i=0;i<3;i++)t.command('pwsh',{command:'next '+i},result);
  assert.ok(t.notices().some(m=>m.source.taskFlow.kind==='judgment'),'new user request gets its own opportunity');
});

test('equal failure summaries do not claim that different commands have the same root cause',()=>{
  const t=timeline({stepPacing:false}),failure={exitCode:1,stderr:'AssertionError: wrong value'};
  t.command('pwsh',{command:'node first.js'},failure);
  t.command('pwsh',{command:'node second.js'},failure);
  const notice=t.notices().find(item=>item.source.taskFlow.kind==='diagnostic');
  assert.ok(notice.content[0].text.includes('记录到的调用参数：不同'));
  assert.ok(notice.content[0].text.includes('相同摘要不证明根因或外部输入相同'));
  assert.ok(!notice.content[0].text.includes('因同一错误中断'));
});

test('pending stage prose cannot hide the next request recovery for a large failed PTC program',()=>{
  for(const live of [true,false]){
    const t=timeline();
    for(let i=0;i<3;i++)t.command('read',{file_path:'source-'+i+'.js'},
      {path:'source-'+i+'.js',offset:1,lines:[{number:1,text:'export const value='+i+';'}],totalLines:1},{live});
    t.command('run_code',{code:'const text=String.raw`value`;'+(' '.repeat(1200))},
      'Error: code run failed (exception): TypeError: String.raw(...) is not a function',{live,isError:true});
    const notices=t.notices();
    assert.equal(notices[0]?.source.taskFlow.kind,'diagnostic');
    assert.ok(notices[0].content[0].text.includes('尚未观察到内部工具分发'));
    assert.ok(!notices.some(message=>message.source.taskFlow.kind==='judgment'));
    assert.equal(t.flow.summary(t.agent).unresolvedErrors[0].tool,'run_code');
    t.keep(notices);
    t.command('run_code',{code:'console.log("corrected program");'},'corrected program',{live});
    assert.ok(t.notices().some(message=>message.source.taskFlow.kind==='judgment'),'stage prose stays available after the concrete recovery opportunity');
  }
});

test('successful replacement PTC programs supersede wrapper errors without resolving failed inner operations',()=>{
  for(const live of [true,false]){
    const t=timeline({stepPacing:false});
    t.command('run_code',{code:'x'.repeat(1200)},'ReferenceError: require is not defined',{live,isError:true});
    assert.equal(t.flow.summary(t.agent).unresolvedErrors.length,1);
    t.command('run_code',{code:'console.log("recovered program");'},'recovered program',{live});
    assert.equal(t.flow.summary(t.agent).unresolvedErrors.length,0);
    assert.ok(!t.notices().some(m=>m.source.taskFlow.kind==='diagnostic'));
    t.command('pwsh',{command:'real failed operation'}, {exitCode:1,stdout:'',stderr:'Error: actual task failure'},{live,nested:true});
    t.command('run_code',{code:'console.log("unrelated program");'},'unrelated program',{live});
    assert.equal(t.flow.summary(t.agent).unresolvedErrors.length,1);
    assert.equal(t.flow.summary(t.agent).unresolvedErrors[0].tool,'pwsh');
    assert.equal(t.agent.session.log.filter(event=>event.type==='tool/result'&&event.data.message.isError).length,1,'original program failure remains in canonical history');
  }
});

test('long-script reuse only selects a PATH runtime for a missing interpreter',()=>{
  for(const variation of ['missing','ordinary','required','named','negate-path','mixed','mixed-en','old-unavailable','reject-path-cn','switch','switch-en','or-path','separate','lowercase-path']){
    const missing=variation!=='ordinary',t=timeline({stepPacing:false});
    if(variation==='required')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'使用现有 C:\\required\\node.exe 执行程序'}];
    if(variation==='named')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'使用 C:\\named\\node.exe 执行程序'}];
    if(variation==='negate-path')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'不要使用 C:\\named\\node.exe，改用 PATH 中的 node'}];
    if(variation==='mixed')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'不要使用 C:\\old\\node.exe；使用 C:\\named\\node.exe 执行程序'}];
    if(variation==='mixed-en')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'Do not use C:\\old\\node.exe; use C:\\named\\node.exe'}];
    if(variation==='old-unavailable')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'The old Node is unavailable; use C:\\named\\node.exe'}];
    if(variation==='reject-path-cn')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'不要使用 PATH 中的 node，使用 C:\\named\\node.exe 执行程序'}];
    if(variation==='switch')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'不要切换到 PATH，使用 C:\\named\\node.exe 执行程序'}];
    if(variation==='switch-en')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'Do not switch to PATH; use C:\\named\\node.exe'}];
    if(variation==='or-path')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'Use C:\\named\\node.exe or PATH if it is missing'}];
    if(variation==='separate')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'Use C:\\named\\node.exe; do not switch to node14 but switch to PATH if it is missing'}];
    if(variation==='lowercase-path')t.agent.session.log.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'Use the path C:\\named\\node.exe to run this'}];
    t.command('work_exec',{runtime:'node',code:'x'.repeat(2400)},{status:'failed',isError:true,executionOccurred:false,
      error:{code:missing?'WORK_EXEC_EXECUTABLE_NOT_FOUND':'WORK_EXEC_SCRIPT_FAILED',message:'failed'},
      scriptRef:'failed-script',scriptEventRef:'event:12',scriptRuntime:'node',scriptChars:2400},{isError:true});
    assert.equal(t.flow.handoff(t.agent).executions.at(-1).errorCode,missing?'WORK_EXEC_EXECUTABLE_NOT_FOUND':'WORK_EXEC_SCRIPT_FAILED');
    const notice=t.notices().find(message=>message.source.taskFlow.kind==='scriptReuse');
    assert.ok(notice);const text=notice.content[0].text;
    const fallback=['missing','or-path','separate','negate-path'].includes(variation);
    assert.equal(text.includes('"executable":"node"'),fallback);
    assert.equal(text.includes('避免继续继承不存在的解释器路径'),fallback);
    assert.equal(text.includes('保留该缺失路径为阻塞项'),['required','named','mixed','mixed-en','old-unavailable','reject-path-cn','switch','switch-en','lowercase-path'].includes(variation));
    assert.ok(text.includes('"scriptRef":"event:12"'));
  }
});

test('format recovery stays visible when a PTC program only prints the native error',()=>{
  const t=timeline({stepPacing:false});
  t.command('work_exec',{runtime:'node',code:'const fs=require("node:fs");'},
    {exitCode:1,stdout:'',stderr:'ReferenceError: require is not defined in ES module scope',scriptRef:'failed-script',scriptRuntime:'node',scriptChars:27,
      recovery:{reason:'commonjs-program-with-default-esm',tool:'work_exec',arguments:{scriptRef:'failed-script',format:'commonjs'}}},{nested:true});
  const message=t.notices().find(m=>m.source.taskFlow.kind==='diagnostic');
  assert.ok(message.content[0].text.includes('"scriptRef":"failed-script","format":"commonjs"'));
  assert.ok(!t.notices().some(m=>m.source.taskFlow.kind==='diagnostic'),'the same failure only adds one recovery notice');
});

test('a completed failed revision exposes its exact new version without claiming execution success',()=>{
  for(const live of [false,true])for(const exitCode of [0,1]){
    const t=timeline({stepPacing:false});
    t.command('work_exec',{scriptRef:'original-version',edits:[{before:'wrong',after:'right'}]},
      {exitCode,stdout:exitCode===0?'FAIL: wrong expectation':'',stderr:exitCode===1?'TypeError: remaining issue':'',
        scriptRef:'revised-version',scriptEventRef:'event:42',scriptChars:100,scriptRuntime:'node',scriptEditCount:1,scriptSourceRefs:['original-version']},{live,nested:true});
    const notice=t.notices().find(message=>message.source.taskFlow.kind==='scriptVersion');
    assert.ok(notice.content[0].text.includes('"event:42"'));
    assert.ok(!notice.content[0].text.includes('成功执行'));
    assert.equal(t.flow.summary(t.agent).nativeExecutions.at(-1).status,'failed');
    assert.equal(t.flow.summary(t.agent).unresolvedErrors.length,1);
    assert.ok(!t.notices().some(message=>message.source.taskFlow.kind==='scriptVersion'),'the same request keeps its existing one-notice limit');
  }
  for(const boundary of [{exitCode:null,kind:'promoted',jobId:'still-running'},{exitCode:0,truncated:true},{exitCode:0,complete:false}]){
    const t=timeline({stepPacing:false});
    t.command('work_exec',{scriptRef:'original-version'},
      {...boundary,stdout:'',stderr:'',scriptRef:'partial-revision',scriptEventRef:'event:42',scriptChars:100,scriptRuntime:'node',scriptEditCount:1,scriptSourceRefs:['original-version']},{nested:true});
    assert.ok(!t.notices().some(message=>message.source.taskFlow.kind==='scriptVersion'));
  }
});

test('a long task gets one convergence reminder without claiming successful observations made no progress',()=>{
  const t=timeline({executionTriage:false}),reminders=[];
  for(let i=0;i<28;i++){
    t.add('assistant/message',{usage:{outputTokens:5000},message:{role:'assistant',content:[]}});
    t.command('pwsh',{command:'observe '+i},{exitCode:0,stdout:'new fact '+i,stderr:''});
    const messages=t.notices();t.keep(messages);
    reminders.push(...messages.filter(m=>m.source.taskFlow.key.includes('finalize-reminder')));
  }
  assert.equal(reminders.length,1);
  assert.ok(reminders[0].content[0].text.includes('完成全部明确要求'));
  assert.ok(!reminders[0].content[0].text.includes('没有带来新的覆盖或进展'));
});

test('script execution advice includes conditional host discovery and remains optional',()=>{
  const t=timeline({stepPacing:false},['pwsh','work_exec']);
  t.command('write',{file_path:'main.js',content:'export const n=42;'},{});
  const message=t.notices().find(m=>m.source.taskFlow.kind==='inlineExec');
  assert.ok(message.content[0].text.includes('宿主已声明的 capabilities.search'));
  assert.ok(message.content[0].text.includes('已有结果足够时不因本提示新增执行'));
  assert.ok(!t.notices().some(m=>m.source.taskFlow.kind==='inlineExec'));
});

test('a running job with an exception in partial output gets one status reminder and stays pending',()=>{
  const t=timeline({stepPacing:false});
  t.command('work_exec',{runtime:'python',code:'start_connection_then_assert()'},
    {kind:'promoted',jobId:'job-failed-thread',output:'[stderr]\nTraceback (most recent call last):\nAssertionError: wrong expected value',scriptRef:'saved-program',scriptRuntime:'python'});
  const messages=t.notices();
  assert.ok(messages.some(m=>m.content[0].text.includes('job-failed-thread')&&m.content[0].text.includes('AssertionError')));
  assert.equal(t.flow.summary(t.agent).nativeExecutions[0].status,'pending');
  assert.deepEqual(t.flow.summary(t.agent).pendingJobs,['job-failed-thread']);
  assert.ok(!t.notices().some(m=>m.source.taskFlow.key.includes('background-diagnostic')));
  t.add('job/settled',{jobId:'job-failed-thread',status:'killed'});
  assert.ok(!t.notices().some(m=>m.source.taskFlow.key.includes('background-diagnostic')));
  const healthy=timeline({stepPacing:false});
  healthy.command('work_exec',{runtime:'node',code:'start_server()'},{kind:'promoted',jobId:'healthy-server',output:'Listening on localhost'});
  assert.ok(!healthy.notices().some(m=>m.source.taskFlow.key.includes('background-diagnostic')));
  const timeout=timeline({stepPacing:false});
  timeout.command('work_exec',{runtime:'python',code:'wait_for_event()'},
    {kind:'promoted',jobId:'job-timeout',output:'[stderr]\nTraceback (most recent call last):\n  File "<stdin>", line 7\nTimeoutError\r\n',scriptRef:'timeout-program',scriptRuntime:'python'});
  assert.ok(timeout.notices().some(m=>m.content[0].text.includes('TimeoutError')&&m.content[0].text.includes('job-timeout')));
});

test('caught external assertion errors remain output diagnostics rather than failed PTC wrappers',()=>{
  for(const live of [true,false]){
    const t=timeline({stepPacing:false}),code='const cp=await import("node:child_process"); try { cp.execFileSync("node",["checks.js"]); } catch(e) { console.log(e.stderr.toString()); }';
    const output='earlier observation\n'.repeat(120)+'node:assert:152\n  throw new AssertionError(obj);\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\nfalse !== true\n    at [eval]:21:8';
    t.command('run_code',{code},output,{live});
    t.command('run_code',{code:'console.log("read actual input");'},'actual input',{live});
    t.command('run_code',{code},output,{live});
    const messages=t.notices();
    assert.ok(messages.some(m=>m.content[0].text.includes('外部程序输出均包含错误诊断')));
    assert.equal(t.flow.summary(t.agent).unresolvedErrors.length,0);
    assert.ok(!t.notices().some(m=>m.source.taskFlow.key.includes('program-output-diagnostic')));
    t.command('run_code',{code},output,{live});
    assert.ok(!t.notices().some(m=>m.source.taskFlow.key.includes('program-output-diagnostic')),'one reminder per failure and source location');
    const read=timeline({stepPacing:false});
    read.command('run_code',{code:'console.log(fs.readFileSync("old-output.txt","utf8"));'},output,{live});
    read.command('run_code',{code:'console.log(fs.readFileSync("old-output.txt","utf8"));'},output,{live});
    assert.equal(read.flow.summary(read.agent).programOutputDiagnostics.length,0,'reading an old diagnostic is not a new external execution');
    const returned=timeline({stepPacing:false});
    returned.command('run_code',{code:'return {exitCode:1,stderr:"TypeError: application result"};'},
      {exitCode:1,stderr:'TypeError: application result',error:{message:'application-level failure'}},{live});
    assert.equal(returned.flow.summary(returned.agent).unresolvedErrors.length,0,'a returned application object does not change the wrapper outcome');
  }
});

test('native read shape advice needs a matching live read and a visible field-access symptom',()=>{
  const value={path:'a.txt',offset:1,totalLines:1,lines:[{number:1,text:'private body'}]};
  for(const [actual,program,output,want]of [
    [value,'const r=await tools.read({file_path:"a.txt"});console.log(r.content);','=== a.txt ===\nundefined',true],
    [value,'const r=await tools.read({file_path:"a.txt"});console.log("=== a.txt ===\\n"+(r?.text??""));','=== a.txt ===\n',true],
    [{...value,lines:[{number:1,text:''}]},'const r=await tools.read({file_path:"a.txt"});console.log(r?.text??"");','',false],
    [value,'const r=await tools.read({file_path:"a.txt"});console.log(r.lines.map(l=>l.text).join("\\n"));','private body',false],
    [value,'const r=await tools.read({file_path:"a.txt"});console.log(r.content);','chosen output',false],
    ['legacy text','const r=await tools.read({file_path:"a.txt"});console.log(r.content);','undefined',false],
  ]){
    const t=timeline({stepPacing:false});
    t.command('read',{file_path:'a.txt'},actual,{nested:true,program,output});
    const messages=t.notices(),advice=messages.find(m=>m.source.taskFlow.key.includes('native-read-result'));
    assert.equal(!!advice,want);
    assert.equal(t.flow.summary(t.agent).unresolvedErrors.length,0,'field diagnosis does not change the wrapper outcome');
    if(want){
      assert.ok(advice.content[0].text.includes('r.lines.map'));
      assert.ok(!advice.content[0].text.includes('private body'),'the diagnostic does not disclose file text');
      assert.ok(!t.notices().some(m=>m.source.taskFlow.key.includes('native-read-result')));
      t.keep(messages);
      const replay=timeline({stepPacing:false});replay.agent.session.log.splice(0,Infinity,...t.agent.session.log);
      assert.ok(!replay.notices().some(m=>m.source.taskFlow.key.includes('native-read-result')));
    }
  }
});

const clippedJsonProgram='const r=await tools.read({file_path:"orders.json"});const txt=r.lines.map(l=>l.text).join("\\n");return JSON.parse(txt);';
const clippedJsonError='Error: code run failed (exception): SyntaxError: Unterminated string in JSON at position 2034 (line 1 column 2035)\n    at JSON.parse (<anonymous>)';
const clippedJsonRead={path:'orders.json',offset:1,totalLines:1,lines:[{number:1,text:'["'+('private-data'.repeat(182)).slice(0,1998)+'... (line truncated to 2000 chars)'}]};

test('a matching clipped native read gets one JSON recovery hint without copying its body or retrying',()=>{
  const t=timeline({stepPacing:false});
  t.command('read',{file_path:'orders.json'},clippedJsonRead,{nested:true,program:clippedJsonProgram,output:clippedJsonError,isError:true,innerIsError:false});
  const count=t.agent.session.log.length,messages=t.notices(),advice=messages.find(m=>m.source.taskFlow.key.includes('native-read-clipped-json'));
  assert.ok(advice);
  assert.ok(advice.content[0].text.includes('扩大 limit 或取回同一历史事件不能补回'));
  assert.ok(advice.content[0].text.includes('宿主权限'));
  assert.ok(!advice.content[0].text.includes('private-data'));
  assert.equal(t.agent.session.log.length,count,'the notice performs no retry or file access');
  assert.ok(t.flow.summary(t.agent).unresolvedErrors.some(item=>item.tool==='run_code'),'the actual failed wrapper stays failed');
  assert.ok(!t.notices().some(m=>m.source.taskFlow.key.includes('native-read-clipped-json')));
  t.keep(messages);
  const replay=timeline({stepPacing:false});replay.agent.session.log.splice(0,Infinity,...t.agent.session.log);
  assert.ok(!replay.notices().some(m=>m.source.taskFlow.key.includes('native-read-clipped-json')));
});

test('JSON recovery rejects untruncated data, unrelated errors, denied reads, other roots and disabled settings',()=>{
  for(const options of [
    {value:{...clippedJsonRead,lines:[{number:1,text:'{"broken":'}]}},
    {value:{...clippedJsonRead,path:'../outside.json'}},
    {program:'const r=await tools.read({file_path:"orders.json"});return JSON.parse("{");'},
    {output:'Error: code run failed (exception): TypeError: something else'},
    {isError:false}, {innerIsError:true}, {live:false},
    {config:{executionTriage:false}}, {config:{enabled:false}},
  ]){
    const {value=clippedJsonRead,config={},...commandOptions}=options,t=timeline({stepPacing:false,...config});
    t.command('read',{file_path:'orders.json'},value,{nested:true,program:clippedJsonProgram,output:clippedJsonError,isError:true,innerIsError:false,...commandOptions});
    assert.ok(!t.notices().some(m=>m.source.taskFlow.key.includes('native-read-clipped-json')),JSON.stringify(options));
  }
  const t=timeline({stepPacing:false});
  t.command('read',{file_path:'orders.json'},clippedJsonRead,{nested:true,program:'return await tools.read({file_path:"orders.json"});'});
  t.command('run_code',{code:clippedJsonProgram},clippedJsonError,{isError:true});
  assert.ok(!t.notices().some(m=>m.source.taskFlow.key.includes('native-read-clipped-json')),'a different root call cannot supply truncation evidence');
});

test('the next user request and successful program clear a prior clipped-read issue',()=>{
  for(const action of ['request','success','triage-off','plugin-off']){
    const t=timeline({stepPacing:false});
    t.command('read',{file_path:'orders.json'},clippedJsonRead,{nested:true,program:clippedJsonProgram,output:clippedJsonError,isError:true,innerIsError:false});
    if(action==='request')t.user();
    if(action==='success')t.command('run_code',{code:'return 3;'},3);
    if(action==='triage-off')t.runtimeState.config.executionTriage=false;
    if(action==='plugin-off')t.runtimeState.config.enabled=false;
    assert.ok(!t.notices().some(m=>m.source.taskFlow.key.includes('native-read-clipped-json')),action);
  }
});

test('aggressive guidance does not ban network access unconditionally',()=>{
  const body=taskFlowGuidance('aggressive');
  assert.doesNotMatch(body,/禁止访问网络/u,'experiment isolation must not be the default product rule');
  assert.match(body,/需要联网的操作沿用用户已有授权；超出授权范围时再确认/u);
  assert.match(body,/用户明确要求移植上游修复或恢复发布版实现时，按该要求使用指定来源/u);
  assert.match(body,/不得使用用户禁止的外部实现/u);
});

test('correct failing reproductions must be fixed, not deleted',()=>{
  const body=taskFlowGuidance('aggressive');
  assert.match(body,/若复现有效但仍失败，必须继续修复实现并重跑该复现/u);
  assert.match(body,/不得删除有效复现/u);
  assert.match(body,/仅在确认测试无法修正时才删除它/u);
  assert.match(body,/后续出现新的测试自身错误时，仍按实际证据修正，不限制修正次数/u);
  assert.doesNotMatch(body,/最多修正测试(?:预期)?一次/u);
  assert.match(body,/复现通过后，用文件工具删除临时测试/u);
  assert.match(body,/既有测试断言仅在用户明确要求或指定行为确需调整时修改/u);
  assert.match(body,/不得改动无关断言/u);
  assert.doesNotMatch(body,/第二次仍失败则删除临时测试/u);
});
