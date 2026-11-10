import test from 'node:test';
import assert from 'node:assert/strict';
import {testOutputDigest,toolOutputDigest} from '../history-hygiene.mjs';

test('failing non-TAP check output stays canonical',()=>{
  const lines=[];
  for(let index=0;index<120;index++)lines.push(`FAILED tests/test_case.py::test_${index} - AssertionError: expected ${index} but got ${index+1}`);
  lines.push('120 failed, 40 passed, 3 warnings in 4.21s');
  while(lines.join('\n').length<9000)lines.push('    at tests/test_case.py:'+(lines.length+10)+': assert value == expected');
  const text=lines.join('\n');
  // pytest/gradle/maven failure output has no structured causes; keep the full diagnostic body.
  assert.equal(testOutputDigest('python -m pytest -q tests/test_case.py',text,{seq:77}),null);
  assert.equal(testOutputDigest('python -m pytest','short output'),null);
  assert.equal(testOutputDigest('git status','x'.repeat(9000)),null);
  assert.equal(testOutputDigest('python -m pytest -q',text,{seq:78,truncated:true}),null);
  assert.equal(testOutputDigest('python -m pytest -q',text.slice(0,7000)+'\n[output truncated; full output: C:\\Temp\\spill.log]',{seq:79}),null);
  assert.equal(testOutputDigest('python -m pytest -q','x'.repeat(9000),{seq:80}),null);
  assert.equal(testOutputDigest('python -m pytest -q',text,{seq:null}),null);
  assert.equal(testOutputDigest('git status',text,{seq:81}),null);
  const gradle=testOutputDigest('gradlew.bat --offline --no-daemon compileTestJava','x'.repeat(9000)+'\n10 failed',{seq:1});
  assert.ok(gradle);
  assert.ok(gradle.text.includes('causes:'));
  assert.ok(gradle.text.length<=4000);
});

test('passing pytest output is projected with a locator',()=>{
  const text='175 passed, 48 skipped, 28 warnings in 1.93s\n'+'    at tests/test_case.py:10: assert value == expected\n'.repeat(200);
  const digest=testOutputDigest('python -m pytest -q',text,{seq:90});
  assert.ok(digest);
  assert.ok(digest.text.includes('work_recall kind=output seq=90'));
  assert.ok(digest.text.length<=4000,`${digest.text.length}`);
  const zero='175 passed, 0 failed in 1.93s\n'+'x'.repeat(4200);
  assert.ok(testOutputDigest('python -m pytest -q',zero,{seq:91}),'a zero failure count is not a failure');
});

test('failing non-TAP output is not projected regardless of focus',()=>{
  const text=[
    'FAILED tests/test_cli.py::test_run - FileNotFoundError: WinError 2',
    'FAILED tests/test_main.py::test_get_key_not_found - AssertionError: expected x',
    '16 failed, 175 passed, 48 skipped, 28 warnings in 1.93s',
    ''
  ].join('\n')+'x'.repeat(4200);
  assert.equal(testOutputDigest('python -m pytest -q',text,{seq:104,focus:['src/dotenv/main.py','tests/','test/']}),null);
  assert.equal(testOutputDigest('python -m pytest -q',text,{seq:107,focus:['tests/'],filterEnvironment:true}),null);
});

test('environment-only output is not projected',()=>{
  const lines=[];
  for(let i=0;i<8;i++)lines.push('FAILED tests/test_cli.py::test_run_'+i+' - FileNotFoundError: WinError 2');
  lines.push('8 failed, 175 passed, 48 skipped, 1 warning in 1.93s');
  const text=lines.join('\n')+'x'.repeat(4200);
  assert.equal(testOutputDigest('python -m pytest -q',text,{seq:108,focus:['tests/']}),null);
});

test('Node TAP receipts require an exact summary and preserve failure identity',()=>{
  const tap=['TAP version 13','not ok 2 - test/api.picomatch.js','  ---','# ReferenceError: describe is not defined','  ...','1..38','# tests 38','# suites 0','# pass 2','# fail 36','# cancelled 0','# skipped 0','# todo 0'].join('\n')+'x'.repeat(4200);
  const digest=testOutputDigest('node --test',tap,{seq:109});
  assert.ok(digest);
  assert.ok(digest.text.includes('result: 2 passed, 36 failed of 38'));
  assert.ok(digest.text.includes('not ok 2 - test/api.picomatch.js'));
  assert.ok(digest.text.includes('causes: ReferenceError: describe is not defined'),'a receipt must keep the first distinct error causes');
  assert.ok(digest.text.includes('work_recall kind=output seq=109'));
  assert.ok(digest.text.length<=4000);
  assert.equal(digest.originalChars,tap.length);
  assert.equal(testOutputDigest('node --test','x'.repeat(9000)+'\n10 failed',{seq:110}),null);
  assert.equal(testOutputDigest('node --test',tap.replace('# fail 36\n',''),{seq:111}),null);
  assert.equal(testOutputDigest('node --test',tap,{seq:112,truncated:true}),null);
  assert.equal(testOutputDigest('node --test',tap.slice(0,7000)+'\n[output truncated; full output: C:\\Temp\\spill.log]',{seq:113}),null);
  assert.equal(testOutputDigest('node --test',tap,{seq:null}),null);
  assert.equal(testOutputDigest('node --test','short',{seq:114}),null);
  assert.equal(testOutputDigest('git status',tap,{seq:115}),null);
});

test('passing truncated receipt keeps the locator',()=>{
  const text='175 passed, 48 skipped in 4.21s\n'+'x'.repeat(9000);
  const digest=testOutputDigest('python -m pytest -q',text,{seq:110});
  assert.ok(digest);
  assert.ok(digest.text.length<=4000);
  assert.ok(digest.text.endsWith('work_recall kind=output seq=110.'));
});

test('TAP receipts keep the cause regardless of diagnostic field order',()=>{
  const build=(fields)=>['TAP version 13','not ok 1 - t','  ---',...fields,'  ...','1..1','# tests 1','# pass 0','# fail 1','# cancelled 0','# skipped 0','# todo 0'].join('\n')+'x'.repeat(4200);
  const errorFirst=build(['  error: |-','    AssertionError [ERR_ASSERTION]: expected true','  name: \'AssertionError\'']);
  const nameFirst=build(['  name: \'ReferenceError\'','  error: |-','    describe is not defined']);
  assert.ok(testOutputDigest('node --test',errorFirst,{seq:201}).text.includes('causes: AssertionError'));
  assert.ok(testOutputDigest('node --test',nameFirst,{seq:202}).text.includes('causes: ReferenceError: describe is not defined'));
});

test('generic tool output digest bounds noisy shell/search output',()=>{
  const text='head line\n'+'grep match line '.repeat(1000)+'\nERROR: build failed\n'+'tail line\n';
  const digest=toolOutputDigest('grep',text,{seq:301});
  assert.ok(digest);
  assert.ok(digest.text.includes('errors:'));
  assert.ok(digest.text.includes('ERROR: build failed'));
  assert.ok(digest.text.includes('work_recall kind=output seq=301'));
  assert.ok(digest.text.length<=5000);
  assert.equal(digest.originalChars,text.length);
  assert.equal(toolOutputDigest('read',text,{seq:302}),null);
  assert.equal(toolOutputDigest('grep','short',{seq:303}),null);
  assert.equal(toolOutputDigest('grep',text,{seq:null}),null);
  assert.equal(toolOutputDigest('pwsh',text,{seq:304,command:'python -m pytest -q'}),null,'check commands stay with testOutputDigest');
  assert.equal(toolOutputDigest('pwsh',text,{seq:305,command:'.\\gradlew.bat test'}),null,'gradle checks stay with testOutputDigest');
  assert.equal(toolOutputDigest('pwsh',text+'\n[truncated]',{seq:306,command:'echo done'}),null,'truncated bodies keep the canonical output');
  assert.equal(toolOutputDigest('pwsh',text+'\n[output truncated; full output: C:\\Temp\\spill.log]',{seq:307,command:'echo done'}),null,'spilled bodies keep the canonical output');
});
