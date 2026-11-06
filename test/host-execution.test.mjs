import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {startHost,text,tool} from './helpers/host.mjs';
const PYTHON='C:/Users/杨铭/Documents/DSH Desktop/runtime/python312/python.exe';
const lastValue=o=>JSON.parse(o.messages.findLast(message=>message.role==='tool').content.map(b=>b.text??'').join(''));
const outputs=host=>host.events.filter(e=>e.type==='tool/result').map(e=>{const body=e.data.message.content.map(b=>b.text??'').join('');try{return JSON.parse(body);}catch{return {text:body,isError:e.data.message.isError};}});
test('work_exec reuses an exact script version and rejects an ambiguous replacement',async()=>{
  let initial;
  const host=await startHost({script:(o,n)=>{
    if(n===1)return [tool('work_exec',{runtime:'node',code:'console.log(21*2);'})];
    if(n===2){initial=lastValue(o).scriptRef;return [tool('work_exec',{scriptRef:initial,edits:[{before:'21*2',after:'21*3'}]})];}
    if(n===3)return [tool('work_exec',{scriptRef:initial,edits:[{before:'missing-token',after:'1'}]})];
    return [text('完成。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行程序，修改计算，再演示不存在的替换');
    const [first,second,third]=outputs(host);
    assert.equal(first.exitCode,0);assert.match(first.stdout.text,/42/);
    assert.equal(second.scriptReused,true);assert.match(second.stdout.text,/63/);
    assert.ok(third.isError||/match|替换|missing|exactly/i.test(third.text??''));
  }finally{await host.close();}
});

test('native PTC revisions use short exact event refs and release only their own failed program lineage',async()=>{
  let firstRef;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'console.log(JSON.stringify(await tools.work_exec({runtime:"node",code:"throw Error(\\\"first failure\\\");"})));',description:'Execute the original failed program'})];
    if(n===2){firstRef=lastValue(options).scriptEventRef;assert.match(firstRef,/^event:\d+$/u);
      const resultEvent=host.events.findLast(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='work_exec');
      return [tool('run_code',{code:'console.log(JSON.stringify(await tools.work_exec('+JSON.stringify({scriptRef:'event:'+resultEvent.seq,edits:[{before:'throw Error("first failure");',after:'console.log(42);'}]})+')));',description:'Revise the exact recorded result event version'})];}
    if(n===3)return [tool('run_code',{code:'console.log(JSON.stringify(await tools.work_recall('+JSON.stringify({kind:'call',seq:Number(firstRef.slice(6))})+')));',description:'Read the exact original arguments at the short address'})];
    assert.equal(lastValue(options).status,'observed');assert.equal(JSON.parse(lastValue(options).text).code,'throw Error("first failure");');
    return [text('已沿用准确事件版本返回 42。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行已有程序，修复错误后继续。');
    const values=outputs(host);assert.equal(values[0].exitCode,1);assert.equal(values[1].exitCode,0);assert.equal(values[1].stdout.text.trim(),'42');
    assert.equal(values[2].executionOutcome,'not-observed-from-call-start');
    assert.deepEqual(values[1].scriptSourceRefs,[values[0].scriptRef]);assert.notEqual(values[1].scriptEventRef,firstRef);
    const status=await host.command(agent,'detail');assert.deepEqual(status.taskFlow.unresolvedErrors,[]);
    assert.equal(status.taskFlow.nativeExecutions.at(-1).scriptEventRef,values[1].scriptEventRef);
  }finally{await host.close();}
});

test('a native rejected edit carries its source context and only an explicit corrected request executes',async()=>{
  let originalRef;
  const invoke=args=>tool('run_code',{code:'return await tools.work_exec('+JSON.stringify(args)+');',description:'Continue the exact program version'});
  const code='const value = "A=1\\nB=2"; console.log(value);';
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [invoke({runtime:'node',code})];
    if(n===2){originalRef=lastValue(options).scriptEventRef;return [invoke({scriptRef:originalRef,edits:[{before:'A=1\nB=2',after:'A=3\nB=2'}]})];}
    if(n===3){
      const error=options.messages.findLast(message=>message.role==='tool').content.map(block=>block.text??'').join('');
      assert.match(error,/"editIndex":0/u);assert.match(error,/"occurrences":0/u);
      assert.ok(error.includes('A=1\\\\nB=2'));
      return [invoke({scriptRef:originalRef,edits:[{before:'A=1\\nB=2',after:'A=3\\nB=2'}]})];
    }
    return [text('已按准确原文显式修改程序。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'沿用程序版本，定位不匹配项后按原文修改。');
    const values=outputs(host);assert.equal(values.length,3);
    assert.equal(values[0].stdout.text.trim(),'A=1\nB=2');assert.equal(values[1].isError,true);
    assert.equal(values[2].stdout.text.trim(),'A=3\nB=2');assert.equal(values[2].scriptReused,true);
    assert.match(values[1].text,/"executionOccurred":false/u);
  }finally{await host.close();}
});

test('a changed program that reports failure offers its new address for the next explicit revision',async()=>{
  let firstRef,secondRef;
  const invoke=args=>tool('run_code',{code:'console.log(JSON.stringify(await tools.work_exec('+JSON.stringify(args)+')));',description:'Continue the selected recorded program'});
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [invoke({runtime:'node',code:'throw Error("first program error");'})];
    if(n===2){firstRef=lastValue(options).scriptEventRef;return [invoke({scriptRef:firstRef,edits:[{before:'throw Error("first program error");',after:'console.log("FAIL: remaining expectation");'}]})];}
    if(n===3){
      secondRef=lastValue(options).scriptEventRef;assert.notEqual(secondRef,firstRef);
      const notice=options.messages.find(message=>message.source?.taskFlow?.kind==='scriptVersion');
      assert.ok(notice.content.map(block=>block.text??'').join('').includes(JSON.stringify(secondRef)));
      assert.equal(lastValue(options).reportedChecks.status,'reported-failed');
      return [invoke({scriptRef:secondRef,edits:[{before:'FAIL: remaining expectation',after:'PASS: corrected expectation'}]})];
    }
    return [text('已明确沿用第二版继续，未重新引入第一版的异常。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'修改并执行现有程序，继续时明确沿用刚返回的版本。');
    const values=outputs(host);assert.equal(values[0].exitCode,1);assert.equal(values[1].exitCode,0);
    assert.equal(values[1].reportedChecks.status,'reported-failed');assert.equal(values[2].exitCode,0);
    assert.match(values[2].stdout.text,/PASS: corrected expectation/u);assert.equal(values[2].stderr.text,'');
    assert.deepEqual(values[2].scriptSourceRefs,[values[1].scriptRef,values[0].scriptRef]);
    const calls=host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='work_exec');
    assert.equal(calls[2].data.arguments.scriptRef,secondRef);assert.equal(calls[2].data.arguments.code,undefined);
    assert.ok(host.events.some(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='work_exec'&&event.data.content.some(block=>block.text?.includes('first program error'))));
  }finally{await host.close();}
});

test('normal pacing delivers large program recovery before its competing stage notice',async()=>{
  let recovery;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:(options,n)=>{
    if(n<=2)return [tool('run_code',{code:'console.log(JSON.stringify(await tools.read({file_path:"observed.txt"})));',description:'Read the requested source'})];
    if(n===3)return [tool('run_code',{code:'const value=String.raw`first``second`;'+(' '.repeat(1200)),description:'Reproduce the failed program before native dispatch'})];
    recovery=options.messages.find(message=>message.source?.taskFlow?.kind==='diagnostic'&&message.content.some(block=>block.text?.includes('尚未观察到内部工具分发')));
    assert.ok(recovery,'the first request after the failure receives the concrete recovery');
    const failure=host.events.findLast(event=>event.type==='tool/result'&&event.data.message.isError);
    assert.ok(!host.events.some(event=>event.seq>failure.seq&&event.type==='user/message'&&(event.data.message??event.data).source?.taskFlow?.kind==='judgment'));
    return [text('程序在内部工具分发前失败，保留原错误。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'observed.txt'),'current source');
    const agent=await host.createAgent('max');await host.send(agent,'读取现有文件并运行程序，报告真实错误。');
    assert.equal(host.requests.length,4);assert.ok(recovery);
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read').length,2);
    const status=await host.command(agent,'detail');assert.ok(status.taskFlow.unresolvedErrors.some(error=>error.tool==='run_code'));
  }finally{await host.close();}
});
test('native PTC missing-ref errors expose an exact recorded version and dispatch no guessed program',async()=>{
  let firstRef,launches=0;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'console.log(JSON.stringify(await tools.work_exec({runtime:"node",code:"console.log(42);"})));',description:'Record the initial complete program'})];
    if(n===2){firstRef=lastValue(options).scriptRef;return [tool('run_code',{code:'return await tools.work_exec({scriptRef:"missing-native-ref",edits:[{before:"42",after:"63"}]});',description:'Use an invalid recorded program reference'})];}
    if(n===3){
      const body=options.messages.findLast(message=>message.role==='tool').content.map(block=>block.text??'').join('\n');
      const match=/^Available recorded script versions[^\n]*: (\[[^\n]+\])$/mu.exec(body);
      assert.ok(match,'the native PTC failure includes the recovery addresses');
      const versions=JSON.parse(match[1]);assert.equal(versions[0].scriptRef,firstRef);
      return [tool('run_code',{code:'console.log(JSON.stringify(await tools.work_exec('+JSON.stringify({scriptRef:versions[0].scriptRef,edits:[{before:'42',after:'63'}]})+')));',description:'Apply an explicit edit to the recorded version'})];
    }
    return [text('已按准确版本完成增量执行。')];
  }});
  host.ctx.on('tools/pre-execute',(exec,next)=>{if(exec.name==='pwsh')launches++;return next();});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'修改并运行 Node 程序；引用失败时沿用准确的已有程序。');
    const nativeCalls=host.events.filter(event=>event.type==='tool/ptc-dispatch');
    assert.equal(launches,2,'the rejected reference launches no extra native process');
    const executions=nativeCalls.filter(event=>event.data.name==='work_exec');assert.equal(executions.length,3);
    assert.equal(executions[1].data.isError,true);
    const last=JSON.parse(executions[2].data.content.map(block=>block.text??'').join(''));
    assert.equal(last.exitCode,0);assert.equal(last.scriptReused,true);assert.match(last.stdout.text,/63/);
    assert.ok(!Object.hasOwn(executions[2].data.arguments,'code'),'the complete program is not resent');
  }finally{await host.close();}
});

test('work_exec retains missing-runtime input for one explicit corrected invocation',async()=>{
  const host=await startHost({script:(o,n)=>n===1?[tool('work_exec',{code:'console.log(7);'})]:n===2?
    [tool('work_exec',{runtime:'node',scriptRef:lastValue(o).scriptRef})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行已有程序');
    const [first,second]=outputs(host);assert.equal(first.executionOccurred,false);assert.ok(first.scriptRef);
    assert.equal(second.exitCode,0);assert.match(second.stdout.text,/7/);
  }finally{await host.close();}
});

test('work_exec rejects a missing explicit interpreter without starting PowerShell and retains its program',async()=>{
  const host=await startHost({script:(o,n)=>n===1?
    [tool('work_exec',{runtime:'node',executable:'C:/definitely-missing-work-evidence/node.exe',code:'console.log(42);'})]:
    n===2?[tool('work_exec',{scriptRef:lastValue(o).scriptRef,executable:'node'})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'按返回的程序引用修正解释器路径');
    const [failed,recovered]=outputs(host);
    assert.equal(failed.status,'failed');assert.equal(failed.isError,true);assert.equal(failed.executionOccurred,false);
    assert.equal(failed.error.code,'WORK_EXEC_EXECUTABLE_NOT_FOUND');assert.ok(failed.scriptRef);assert.equal(failed.scriptChars,'console.log(42);'.length);
    assert.equal(recovered.exitCode,0);assert.match(recovered.stdout.text,/42/);assert.equal(recovered.scriptReused,true);
    assert.equal(host.events.filter(event=>event.type==='tool/result').length,2,'the rejected call and the explicit correction both settle');
  }finally{await host.close();}
});

test('work_exec missing-interpreter retries inherit the path until an explicit PATH runtime replaces it',async()=>{
  const missing='C:/definitely-missing-work-evidence/node.exe';
  const host=await startHost({script:(o,n)=>n===1?
    [tool('work_exec',{runtime:'node',executable:missing,code:'console.log(42);'})]:
    n<=3?[tool('work_exec',{scriptRef:lastValue(o).scriptRef})]:
    n===4?[tool('work_exec',{runtime:'node',scriptRef:lastValue(o).scriptRef,executable:'node'})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'按返回的程序引用修正解释器路径');
    const results=outputs(host);assert.equal(results.length,4);
    for(const failed of results.slice(0,3)){
      assert.equal(failed.status,'failed');assert.equal(failed.executionOccurred,false);
      assert.equal(failed.error.code,'WORK_EXEC_EXECUTABLE_NOT_FOUND');assert.equal(failed.scriptExecutable,missing);
      assert.match(failed.retry,/explicitly set executable/);assert.doesNotMatch(failed.retry,/omit executable to use the runtime on PATH/);
    }
    const recovered=results[3];assert.equal(recovered.exitCode,0);assert.match(recovered.stdout.text,/42/);
    assert.equal(recovered.scriptReused,true);assert.equal(recovered.scriptExecutable,'node');
    assert.equal(host.events.filter(event=>event.type==='tool/result').length,4);
  }finally{await host.close();}
});

test('work_exec leaves PATH names and directories that cannot execute to native handling',async()=>{
  const host=await startHost({script:(_o,n)=>n===1?
    [tool('work_exec',{runtime:'node',executable:'node',code:'console.log(7);'})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'使用 PATH 中的解释器');
    assert.match(outputs(host)[0].stdout.text,/7/);
  }finally{await host.close();}
});

test('an identity script edit still reruns against changed inputs without claiming a new code edit',async()=>{
  let originalRef;
  const program='import fs from "node:fs";console.log(fs.readFileSync("value.txt","utf8"));';
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'await tools.write({file_path:"value.txt",content:"1"});console.log(JSON.stringify(await tools.work_exec('+JSON.stringify({runtime:'node',code:program})+')));',description:'Run the first program against its input'})];
    if(n===2){originalRef=lastValue(options).scriptRef;return [tool('run_code',{code:'await tools.write({file_path:"value.txt",content:"2"});console.log(JSON.stringify(await tools.work_exec('+JSON.stringify({scriptRef:originalRef,edits:[{before:'console.log',after:'console.log'}]})+')));',description:'Rerun the unchanged program against updated input'})];}
    assert.ok(!options.messages.some(message=>message.source?.taskFlow?.key?.includes('edited-script-version')));
    return [text('输入已改变，原程序再次执行后返回 2。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'先运行程序，再修改输入并沿用原程序执行。');
    const values=outputs(host);assert.equal(values[0].stdout.text.trim(),'1');assert.equal(values[1].stdout.text.trim(),'2');
    assert.equal(values[1].scriptEditsSubmitted,1);assert.equal(values[1].scriptEditCount,0);assert.equal(values[1].scriptReused,true);
    const status=await host.command(agent,'detail'),execution=status.taskFlow.nativeExecutions.at(-1);
    assert.equal(execution.scriptEditsSubmitted,1);assert.equal(execution.scriptEditCount,0);
    assert.equal(status.observability.features.inlineScriptReuse.applied,1,'the exact program reference was still reused');
    assert.equal(status.taskFlow.scriptReuseNotices,0,'unchanged code adds no edited-version hint');
  }finally{await host.close();}
});
test('default ESM require failures provide an exact same-script CommonJS retry',async()=>{
  const host=await startHost({script:(o,n)=>n===1?[tool('work_exec',{runtime:'node',code:'const assert=require("node:assert/strict"); assert.equal(6*7,42); console.log("ok");'})]:n===2?
    [tool('work_exec',lastValue(o).recovery.arguments)]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行程序，按实际格式错误修正并沿用原文');
    const [failed,recovered]=outputs(host);
    assert.equal(failed.exitCode,1);
    assert.equal(failed.recovery.reason,'commonjs-program-with-default-esm');
    assert.equal(failed.recovery.arguments.scriptRef,failed.scriptEventRef);
    assert.equal(recovered.exitCode,0);assert.match(recovered.stdout.text,/ok/);
    assert.equal(recovered.scriptReused,true);
    assert.ok(!recovered.recovery);
    const status=await host.command(agent,'detail'),feature=status.observability.features.inlineExec;
    assert.equal(feature.failed,1);assert.equal(feature.applied,1);
    assert.equal(feature.reasons['native-execution-failed'],1);
  }finally{await host.close();}
});
test('work_exec runs the selected installed Python interpreter and preserves nonzero exit status',{skip:!existsSync(PYTHON)},async()=>{
  const host=await startHost({script:(_o,n)=>n===1?[tool('work_exec',{runtime:'python',executable:PYTHON,code:'print(42)'})]:n===2?
    [tool('work_exec',{runtime:'python',executable:PYTHON,code:'raise ValueError("expected failure")'})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行两段程序');
    const [good,bad]=outputs(host);assert.equal(good.exitCode,0);assert.match(good.stdout.text,/42/);
    assert.notEqual(bad.exitCode,0);assert.match(bad.stderr.text,/expected failure/);
    const status=await host.command(agent,'detail');
    assert.equal(status.observability.features.inlineExec.failed,1);
    assert.equal(status.observability.features.inlineExec.applied,1);
  }finally{await host.close();}
});

test('reported check failures stay consistent in the tool result, task state, feature record and next model context',async()=>{
  let context;
  const code='console.log("LOAD-FAIL example.js Missing optional dependency");console.log("legacy suites: 2074 passed, 2 failed");';
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false},
    script:(options,n)=>{
      if(n===1)return [tool('run_code',{code:'const r=await tools.work_exec('+JSON.stringify({runtime:'node',code})+');console.log(r.exitCode);',description:'Execute the requested checks'})];
      context=options.messages.find(message=>message.source?.taskFlow?.key?.includes('reported-execution-failure'));
      assert.ok(context,'the report survives a caller that prints only the process exit code');
      const receipt=context.content.map(block=>block.text??'').join('');
      assert.match(receipt,/"passed":2074/);assert.match(receipt,/"failed":2/);
      return [text('原程序报告 2074 项通过、2 项失败。')];
    }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行已有检查并报告实际输出。');
    assert.ok(context);
    const dispatch=host.events.find(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='work_exec');
    const value=JSON.parse(dispatch.data.content.map(block=>block.text??'').join(''));
    assert.equal(value.exitCode,0);assert.equal(value.isError,false);
    assert.equal(value.fileDependencies.executionCompleted,true,'the process finished even though its report contains failures');
    assert.equal(value.reportedChecks.summary.failed,2);
    const status=await host.command(agent,'detail');
    assert.equal(status.taskFlow.nativeExecutions[0].status,'failed');
    assert.equal(status.taskFlow.nativeExecutions[0].failureSource,'reported-checks');
    assert.equal(status.observability.features.inlineExec.failed,1);
    assert.equal(status.observability.features.inlineExec.applied??0,0);
  }finally{await host.close();}
});

test('compact PASS and FAIL reports retain the exact counts even without individual failure lines',async()=>{
  const host=await startHost({script:(_options,n)=>n===1?[tool('work_exec',{runtime:'node',code:'console.log("PASS 54 FAIL 3");'})]:[text('已记录 54 项通过、3 项失败。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行程序并保留原报告。');
    const result=outputs(host)[0];assert.equal(result.exitCode,0);assert.equal(result.reportedChecks.summary.passed,54);assert.equal(result.reportedChecks.summary.failed,3);
    const status=await host.command(agent,'detail');assert.equal(status.taskFlow.nativeExecutions[0].failureSource,'reported-checks');
    assert.equal(status.observability.features.inlineExec.failed,1);
  }finally{await host.close();}
});

test('a completed program string-list failure reaches the PTC caller that only prints exitCode',async()=>{
  const stdout="PASS leading blank lines kept | correct\nFAIL blank lines + untouched entry | wrong quoting\nFAIL crlf replaced+appended | wrong newline\nFAILURES: ['blank lines + untouched entry', 'crlf replaced+appended']";
  let receipt;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'const r=await tools.work_exec('+JSON.stringify({runtime:'node',code:'console.log('+JSON.stringify(stdout)+');'})+');console.log(r.exitCode);',description:'Execute the string-list report'})];
    const message=options.messages.find(item=>item.source?.taskFlow?.key?.includes('reported-execution-failure'));
    receipt=JSON.parse(message.content.map(block=>block.text??'').join('').split('\n').slice(1).join('\n'));
    return [text('原报告有 2 项失败，总数和通过数未提供。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'执行程序并报告原始结果。');
    assert.equal(receipt.processExitCode,0);assert.equal(receipt.summary.failed,2);
    assert.equal(receipt.summary.passed,undefined);assert.equal(receipt.summary.total,undefined);
    assert.equal(receipt.failureEntries.length,2);
    const dispatch=host.events.find(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='work_exec');
    const raw=JSON.parse(dispatch.data.content.map(block=>block.text??'').join(''));
    assert.equal(raw.stdout.text.replaceAll('\r\n','\n').trim(),stdout);
    assert.equal(raw.exitCode,0);assert.equal(raw.isError,false);
    const status=await host.command(agent,'detail');
    assert.equal(status.taskFlow.nativeExecutions[0].failureSource,'reported-checks');
    assert.equal(status.observability.features.inlineExec.failed,1);
  }finally{await host.close();}
});

test('a named ratio report reaches the next PTC request without changing its zero exit code',async()=>{
  const stdout='PASS source\nFAIL encoding fixture -> ValueError: wrong input\nPASS order\nTOTAL 2/3';let report;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'const value=await tools.work_exec('+JSON.stringify({runtime:'node',code:'console.log('+JSON.stringify(stdout)+');'})+');console.log(value.exitCode);',description:'Execute the native named report'})];
    const receipt=options.messages.find(message=>message.source?.taskFlow?.key?.includes('reported-execution-failure'));
    report=JSON.parse(receipt.content.map(block=>block.text??'').join('').split('\n').slice(1).join('\n'));
    return [text('原程序退出码为 0，报告为 2 项通过、1 项失败。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'执行程序并报告真实结果。');
    assert.equal(report.summary.total,3);assert.equal(report.summary.passed,2);assert.equal(report.summary.failed,1);assert.equal(report.processExitCode,0);
    assert.equal(report.failureEntries[0],'FAIL encoding fixture -> ValueError: wrong input');
    const dispatch=host.events.find(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='work_exec');
    const result=JSON.parse(dispatch.data.content.map(block=>block.text??'').join(''));
    assert.equal(result.exitCode,0);assert.equal(result.stdout.text.replaceAll('\r\n','\n').trim(),stdout);
    const status=await host.command(agent,'detail');assert.equal(status.taskFlow.nativeExecutions[0].failureSource,'reported-checks');
  }finally{await host.close();}
});

test('native shell labeled totals reach the model with exact failure names',async()=>{
  let receipt;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'const result=await tools.pwsh({command:\'Write-Output "checks: 46, failures: 1"; Write-Output "FAIL legacy content: wrong newline"\',description:"Print the original report form"});console.log(result.exitCode);',description:'Execute the native report'})];
    const message=options.messages.find(item=>item.source?.taskFlow?.key?.includes('reported-execution-failure'));
    receipt=JSON.parse(message.content.map(block=>block.text??'').join('').split('\n').slice(1).join('\n'));
    return [text('原报告为 46 项、45 项通过、1 项失败。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行原生程序并保留报告。');
    assert.equal(receipt.summary.total,46);assert.equal(receipt.summary.passed,45);assert.equal(receipt.summary.failed,1);
    assert.deepEqual(receipt.failureEntries,['FAIL legacy content: wrong newline']);assert.equal(receipt.processExitCode,0);
    const status=await host.command(agent,'detail');assert.equal(status.taskFlow.nativeExecutions[0].failureSource,'reported-checks');
  }finally{await host.close();}
});

test('real Python unittest stderr reaches a caller that prints only the process exit code',{skip:!existsSync(PYTHON)},async()=>{
  let receipt;
  const code='import unittest\nclass Example(unittest.TestCase):\n def test_pass(self): self.assertEqual(2, 2)\n def test_fail(self): self.assertEqual(2, 3)\n def test_error(self): raise KeyError("missing")\nunittest.main()\n';
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'const r=await tools.work_exec('+JSON.stringify({runtime:'python',executable:PYTHON,code})+');console.log(r.exitCode);',description:'Run the original unittest report'})];
    const message=options.messages.find(item=>item.source?.taskFlow?.key?.includes('reported-execution-failure'));
    receipt=JSON.parse(message.content.map(block=>block.text??'').join('').split('\n').slice(1).join('\n'));
    return [text('原报告为 3 项、1 项通过、2 项失败。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'执行 Python 程序并保留原始报告。');
    assert.equal(receipt.sourceStream,'stderr');assert.equal(receipt.processExitCode,1);
    assert.deepEqual([receipt.summary.total,receipt.summary.passed,receipt.summary.failed,receipt.summary.errors],[3,1,2,1]);
    assert.equal(receipt.failureEntries.length,2);
    const status=await host.command(agent,'detail');assert.equal(status.taskFlow.nativeExecutions[0].failureSource,'reported-checks');
    assert.equal(status.observability.features.inlineExec.failed,1);
  }finally{await host.close();}
});

test('native job list can return a running process without adding a query error',async()=>{
  let jobId;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-tool-jobs',{completionDelivery:'quiet'}],['dsh-ptc-runtime-node']],
    pluginConfig:{aggressiveMode:true,stepPacing:false},script:(options,n)=>{
      if(n===1)return [tool('run_code',{code:'console.log(JSON.stringify(await tools.pwsh({command:"Start-Sleep -Seconds 30",run_in_background:true})));',description:'Start a controlled background process'})];
      if(n===2){jobId=lastValue(options).jobId;return [tool('run_code',{code:'console.log(JSON.stringify(await tools.job_list({})));',description:'Read the native background registry'})];}
      if(n===3){assert.ok(lastValue(options).some(job=>job.id===jobId&&job.status==='running'));return [tool('run_code',{
        code:'console.log(JSON.stringify(await tools.job_kill('+JSON.stringify({job_id:jobId,reason:'Controlled registry observation finished'})+')));',description:'End the controlled process'})];}
      return [text('已读取后台任务并结束本次观察程序。')];
    }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'读取后台任务的实际状态。');
    const status=await host.command(agent,'detail');
    assert.ok(!status.taskFlow.unresolvedErrors.some(error=>error.tool==='job_list'));
    assert.ok(host.events.some(event=>event.type==='job/settled'&&event.data.jobId===jobId&&event.data.status==='killed'));
    assert.ok(status.taskFlow.unresolvedErrors.some(error=>error.tool==='job_output'),'the stopped process remains distinct from the successful registry read');
  }finally{await host.close();}
});

test('retained computation blocks direct filesystem writes as well as omitting write tools',async()=>{
  const host=await startHost({workspace:{toolSurface:'full'},script:(_o,n)=>n===1?[tool('work_compute',{
    code:"const fsx=await import('node:fs/promises'); await fsx.writeFile('compute-write.txt','probe'); 'write-completed'"})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'核对计算环境的写入限制');
    const [result]=outputs(host);assert.equal(result.status,'failed');assert.equal(result.sandbox.denied,true);
    assert.equal(await fs.stat(path.join(host.cwd,'compute-write.txt')).then(()=>true,()=>false),false);
  }finally{await host.close();}
});

test('a user-named missing interpreter is not replaced by PATH in the retry hint', async () => {
  const missing = 'C:/definitely-missing-work-evidence/node.exe';
  const host = await startHost({script: (options, n) => n === 1
    ? [tool('work_exec', {runtime: 'node', executable: missing, code: 'console.log(1);'})]
    : [text('完成。')]});
  try {
    const agent = await host.createAgent('max');
    await host.send(agent, '使用 ' + missing + ' 运行程序。');
    const [failed] = outputs(host);
    assert.equal(failed.error.code, 'WORK_EXEC_EXECUTABLE_NOT_FOUND');
    assert.match(failed.retry, /names a specific interpreter path/);
    assert.doesNotMatch(failed.retry, /explicitly set executable/);
  } finally {
    await host.close();
  }
});

test('a mixed interpreter declaration keeps the required path instead of falling back to PATH', async () => {
  const missing = 'C:/definitely-missing-work-evidence/node.exe';
  const host = await startHost({script: (options, n) => n === 1
    ? [tool('work_exec', {runtime: 'node', executable: missing, code: 'console.log(1);'})]
    : [text('完成。')]});
  try {
    const agent = await host.createAgent('max');
    await host.send(agent, '不要使用 C:/definitely-missing-work-evidence/old/node.exe；使用 ' + missing + ' 运行程序。');
    const [failed] = outputs(host);
    assert.equal(failed.error.code, 'WORK_EXEC_EXECUTABLE_NOT_FOUND');
    assert.match(failed.retry, /names a specific interpreter path/);
    assert.doesNotMatch(failed.retry, /explicitly set executable/);
  } finally {
    await host.close();
  }
});
