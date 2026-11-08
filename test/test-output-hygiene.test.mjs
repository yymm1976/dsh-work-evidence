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
  assert.ok(testOutputDigest('.\\gradlew.bat --offline --no-daemon compileTestJava','x'.repeat(9000)));
});
