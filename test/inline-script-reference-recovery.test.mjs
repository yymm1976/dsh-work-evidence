import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveInlineScript,inlineScriptEventRef} from '../inline-exec.mjs';
import {recallCall} from '../history-hygiene.mjs';

const user=seq=>({seq,type:'user/message',data:{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'继续修改本项目'}]}}});
const call=(seq,id,args,name='work_exec')=>({seq,type:'tool/ptc-dispatch',data:{subCallId:id,name,arguments:args}});

test('short event references reconstruct only the exact work_exec call and retain canonical recovery identities',()=>{
  const session={log:[user(1),call(4,'long-original',{runtime:'node',code:'console.log(42);'}),
    call(5,'long-edited',{scriptRef:'event:4',edits:[{before:'42',after:'63'}]}),call(6,'read-call',{file_path:'x'},'read')]};
  assert.equal(inlineScriptEventRef(session,'long-original'),'event:4');
  const script=resolveInlineScript({scriptRef:'event:5',edits:[{before:'63',after:'84'}]},session);
  assert.equal(script.code,'console.log(84);');assert.deepEqual(script.sourceCallIds,['long-edited','long-original']);
  assert.throws(()=>resolveInlineScript({scriptRef:'event:6'},session),/does not identify/);
  assert.throws(()=>resolveInlineScript({scriptRef:'event:4',runtime:'python'},session),/runtime must match/);
  assert.throws(()=>resolveInlineScript({scriptRef:'event:4'},{log:[]}),/does not identify/);
  assert.throws(()=>resolveInlineScript({scriptRef:'event:4',edits:[{before:'absent',after:'x'}]},session),/match exactly once/);
});

test('script references retain the recorded interpreter until an explicit PATH runtime replaces it',()=>{
  const args={runtime:'node',code:'console.log(42);'},executable='C:/recorded/node.exe';
  const session={log:[user(1),call(4,'original',args),
    {seq:5,type:'tool/ptc-dispatch',data:{subCallId:'original',name:'work_exec',arguments:args,
      content:[{type:'text',text:JSON.stringify({scriptRef:'original',scriptRuntime:'node',scriptChars:args.code.length,scriptExecutable:executable})}]}}]};
  assert.equal(resolveInlineScript({scriptRef:'original'},session).executable,executable);
  assert.equal(resolveInlineScript({scriptRef:'event:4'},session).executable,executable);
  assert.equal(resolveInlineScript({scriptRef:'original',executable:'node'},session).executable,'node');
});

test('the exact short-ref call-start event returns original arguments without inventing an execution outcome',()=>{
  const args={runtime:'python',code:'print("原文")'};
  for(const type of ['tool/ptc-dispatch-start','tool/code-dispatch-start']){
    const event={seq:12,type,data:{name:'work_exec',subCallId:'original',arguments:args}},agent={session:{eventAt:seq=>seq===12?event:null}};
    const result=recallCall(agent,{seq:12,maxChars:256});
    assert.equal(result.status,'observed');assert.deepEqual(JSON.parse(result.text),args);
    assert.equal(result.executionOutcome,'not-observed-from-call-start');assert.equal(result.complete,true);
    assert.equal(recallCall(agent,{seq:13}).status,'unavailable');
  }
});

test('a rejected exact script edit reports its index, count and bounded source without applying a guessed replacement',()=>{
  const code='header\nexpected = "Y=9\\nA=dupe\\nZ=z"\nfooter';
  const session={log:[user(1),call(4,'original',{runtime:'python',code})]};
  assert.throws(()=>resolveInlineScript({scriptRef:'event:4',edits:[{before:'Y=9\nA=dupe\nZ=z',after:'Y=10'}]},session),error=>{
    assert.equal(error.code,'WORK_EXEC_SCRIPT_EDIT_MISMATCH');
    assert.equal(error.editMismatch.scriptRef,'event:4');assert.equal(error.editMismatch.editIndex,0);
    assert.equal(error.editMismatch.occurrences,0);assert.equal(error.editMismatch.executionOccurred,false);
    assert.equal(error.editMismatch.windows[0].line,2);
    assert.equal(error.editMismatch.windows[0].lines[1].text,'expected = "Y=9\\nA=dupe\\nZ=z"');
    assert.ok(error.message.includes('unique-first-line-anchor'));assert.ok(error.message.includes('Y=9\\\\n'));
    return true;
  });
  assert.equal(resolveInlineScript({scriptRef:'event:4'},session).code,code);
  assert.throws(()=>resolveInlineScript({scriptRef:'event:4',edits:[{before:'missing',after:'x'}]},session),error=>{
    assert.equal(error.editMismatch.occurrences,0);assert.deepEqual(error.editMismatch.windows,[]);return true;
  });
  const repeated={log:[user(1),call(4,'original',{runtime:'node',code:'aaa\nother'})]};
  assert.throws(()=>resolveInlineScript({scriptRef:'event:4',edits:[{before:'aa',after:'x'}]},repeated),error=>{
    assert.equal(error.editMismatch.occurrences,2);assert.equal(error.editMismatch.windows.length,2);return true;
  });
});

test('a later rejected edit identifies proposed text after earlier edits and leaves the recorded version intact',()=>{
  const code='original\nbody\nend',session={log:[user(1),call(4,'original',{runtime:'node',code})]};
  assert.throws(()=>resolveInlineScript({scriptRef:'event:4',edits:[{before:'original',after:'created\\ntext'},
    {before:'created\ntext',after:'replacement'}]},session),error=>{
    assert.equal(error.editMismatch.editIndex,1);assert.equal(error.editMismatch.precedingEditsAppliedToCandidate,1);
    assert.equal(error.editMismatch.windows[0].lines[0].text,'created\\ntext');
    assert.match(error.editMismatch.scope,/Candidate script text/u);return true;
  });
  assert.equal(resolveInlineScript({scriptRef:'event:4'},session).code,code);
  const large={log:[user(1),call(4,'original',{runtime:'python',code:'Y=9'+('\\nrecord').repeat(5000)})]};
  assert.throws(()=>resolveInlineScript({scriptRef:'event:4',edits:[{before:'Y=9\nrecord',after:'x'}]},large),error=>{
    assert.ok(JSON.stringify(error.editMismatch).length<=3000);assert.equal(error.editMismatch.windows[0].lines[0].textTruncated,true);return true;
  });
});

test('both observed start and result event addresses resolve to the same canonical script call',()=>{
  const args={runtime:'python',code:'print(42)'},id='the-original-call';
  const session={log:[user(1),{seq:65,type:'tool/ptc-dispatch-start',data:{name:'work_exec',subCallId:id,arguments:args}},
    {seq:68,type:'tool/ptc-dispatch',data:{name:'work_exec',subCallId:id,arguments:args,content:[]}}]};
  for(const scriptRef of ['event:65','event:68']){
    const script=resolveInlineScript({scriptRef,edits:[{before:'42',after:'63'}]},session);
    assert.equal(script.code,'print(63)');assert.deepEqual(script.sourceCallIds,[id]);
  }
  assert.throws(()=>resolveInlineScript({scriptRef:'event:67'},session),/does not identify/);
});

test('a missing ref names reconstructable versions from this request without selecting or executing one',()=>{
  const session={log:[user(1),call(2,'old-task',{runtime:'node',code:'console.log("old");'}),user(3),
    call(4,'node-original',{runtime:'node',code:'console.log(42);'}),
    call(5,'node-edited',{scriptRef:'node-original',edits:[{before:'42',after:'63'}]}),
    call(6,'python-original',{runtime:'python',code:'print(42)'}),
    call(7,'broken-edit',{scriptRef:'node-original',edits:[{before:'absent',after:'x'}]}),
    call(8,'not-a-script',{code:'console.log(99);'},'run_code')]};
  assert.throws(()=>resolveInlineScript({scriptRef:'unknown',runtime:'node'},session),error=>{
    assert.equal(error.code,'WORK_EXEC_SCRIPT_REF_NOT_FOUND');
    assert.deepEqual(error.availableScripts.map(item=>item.scriptRef),['node-edited','node-original']);
    assert.equal(error.availableScripts[0].scriptChars,'console.log(63);'.length);
    assert.match(error.message,/historical code, not execution success/);
    assert.ok(!error.message.includes('old-task'));
    return true;
  });
  assert.equal(resolveInlineScript({scriptRef:'node-edited'},session).code,'console.log(63);');
  assert.throws(()=>resolveInlineScript({scriptRef:'unknown',runtime:'node',edits:[{before:'63',after:'84'}]},session),error=>{
    assert.deepEqual(error.availableScripts.map(item=>item.scriptRef),['node-edited'],'the submitted edit excludes other complete versions');return true;
  });
  assert.throws(()=>resolveInlineScript({scriptRef:'broken-edit'},session),/match exactly once/);
});

test('reference suggestions are bounded and omit unreconstructable chains and other requests',()=>{
  const log=[user(1),...Array.from({length:6},(_,index)=>call(index+2,'ref-'+index,{runtime:'node',code:'console.log('+index+');'})),
    call(8,'cycle',{scriptRef:'cycle'}),call(9,'missing-ancestor',{scriptRef:'unknown'}),call(10,'retained',{mode:'retained',runtime:'node',code:'42'})];
  assert.throws(()=>resolveInlineScript({scriptRef:'missing'},{log}),error=>{
    assert.deepEqual(error.availableScripts.map(item=>item.scriptRef),['ref-5','ref-4','ref-3']);return true;
  });
  log.push(user(11));
  assert.throws(()=>resolveInlineScript({scriptRef:'missing'},{log}),error=>{assert.deepEqual(error.availableScripts,[]);return true;});
});
