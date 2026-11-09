import test from 'node:test';
import assert from 'node:assert/strict';
import {testOutputDigest} from '../history-hygiene.mjs';

test('test output digest keeps failure identity and stays bounded',()=>{
  const lines=[];
  for(let index=0;index<120;index++)lines.push(`FAILED tests/test_case.py::test_${index} - AssertionError: expected ${index} but got ${index+1}`);
  lines.push('120 failed, 40 passed, 3 warnings in 4.21s');
  while(lines.join('\n').length<9000)lines.push('    at tests/test_case.py:'+(lines.length+10)+': assert value == expected');
  const text=lines.join('\n');
  const digest=testOutputDigest('python -m pytest -q tests/test_case.py',text,{seq:77});
  assert.ok(digest);
  assert.ok(digest.text.includes('FAILED tests/test_case.py::test_0'));
  assert.ok(digest.text.includes('120 failed'));
  assert.ok(digest.text.includes('work_recall'));
  assert.ok(digest.text.includes('seq=77'));
  assert.ok(digest.text.length<=4000,`${digest.text.length}`);
  assert.equal(digest.originalChars,text.length);
  assert.equal(testOutputDigest('python -m pytest','short output'),null);
  assert.equal(testOutputDigest('git status','x'.repeat(9000)),null);
  assert.equal(testOutputDigest('node --test suite.mjs','x'.repeat(9000),{truncated:true}),null);
  assert.equal(testOutputDigest('python -m pytest -q',text.slice(0,7000)+'\n[output truncated; full output: C:\\Temp\\spill.log]'),null);
  assert.equal(testOutputDigest('python -m pytest -q','x'.repeat(9000)),null);
  assert.equal(testOutputDigest('python -m pytest -q',text,{seq:null}),null);
  assert.ok(testOutputDigest('gradlew.bat --offline --no-daemon compileTestJava','x'.repeat(9000)+'\n10 failed',{seq:1}));
});

test('environment and focus filtering keep assertions actionable',()=>{
  const text=[
    'FAILED tests/test_cli.py::test_run - FileNotFoundError: WinError 2',
    'FAILED tests/test_main.py::test_get_key_not_found - AssertionError: expected x',
    '16 failed, 175 passed, 48 skipped, 28 warnings in 1.93s',
    ''
  ].join('\n')+'x'.repeat(4200);
  const digest=testOutputDigest('python -m pytest -q',text,{seq:104,focus:['src/dotenv/main.py','tests/','test/']});
  assert.ok(digest);
  const failingLine=digest.text.split(/\n/u).find(line=>line.startsWith('failing:'))||'';
  assert.ok(failingLine.includes('tests/test_main.py'));
  assert.ok(!failingLine.includes('tests/test_cli.py'));
  assert.ok(digest.text.includes('environment-like failures omitted'));
});

test('actionable assertion after eight environment failures is shown',()=>{
  const lines=[];
  for(let i=0;i<8;i++)lines.push('FAILED tests/test_cli.py::test_run_'+i+' - FileNotFoundError: WinError 2');
  lines.push('FAILED tests/test_main.py::test_get_key_not_found - AssertionError: expected x');
  lines.push('20 failed, 175 passed, 48 skipped, 28 warnings in 1.93s');
  lines.push('');
  const text=lines.join('\n')+'x'.repeat(4200);
  const digest=testOutputDigest('python -m pytest -q',text,{seq:107,focus:['tests/'],filterEnvironment:true});
  assert.ok(digest);
  const failingLine=digest.text.split(/\n/u).find(line=>line.startsWith('failing:'))||'';
  assert.ok(failingLine.includes('tests/test_main.py'));
  assert.ok(!failingLine.includes('test_cli.py'));
});

test('environment-only output is not projected',()=>{
  const lines=[];
  for(let i=0;i<8;i++)lines.push('FAILED tests/test_cli.py::test_run_'+i+' - FileNotFoundError: WinError 2');
  lines.push('8 failed, 175 passed, 48 skipped, 1 warning in 1.93s');
  const text=lines.join('\n')+'x'.repeat(4200);
  assert.equal(testOutputDigest('python -m pytest -q',text,{seq:108,focus:['tests/']}),null);
});

test('Node test receipts are disabled',()=>{
  assert.equal(testOutputDigest('node --test suite.mjs','x'.repeat(9000)+'\n10 failed',{seq:109}),null);
});

test('truncated receipt keeps the locator',()=>{
  const text='x'.repeat(9000)+'\nFAILED tests/test_main.py::test_x - AssertionError: y\n16 failed, 175 passed\n';
  const digest=testOutputDigest('python -m pytest -q',text,{seq:110});
  assert.ok(digest.text.length<=4000);
  assert.ok(digest.text.endsWith('work_recall kind=output seq=110.'));
});
