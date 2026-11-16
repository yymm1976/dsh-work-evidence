import test from 'node:test';
import assert from 'node:assert/strict';
import {testOutputDigest,toolOutputDigest} from '../history-hygiene.mjs';
import {looksLikeSourceBody} from '../context-pruning.mjs';

// Every place a tool body can be reduced to a receipt is an entry point of one invariant: a
// source body's middle must stay visible. The projection was the first entry point found
// (F2-C's 88.5% re-read), and each later round found the next one — the generic tool digest,
// then the nested-read branch, then the test receipt. A guard that lives only in the caller
// is the pattern that produced those rounds, because the next caller is written by someone
// who never saw this file.
//
// These cases therefore pin the PRODUCERS, not a projection. A producer that returns null for
// source is a fact every caller inherits; a projection-level assertion passes whether or not
// the rule exists, which is how the previous version of this file passed on pre-fix code.

const sourceBody=()=>['import os','','class Widget:','    def render(self):','        return os.path.basename(__file__)','',
  ...Array.from({length:400},(_,i)=>`    value_${i} = ${i}`)].join('\n');

// A passing `node --test` run that also printed the file it was testing. The TAP totals are
// real, so the test-receipt branch finds everything it needs; the body is source, so it must
// still refuse. This is the exact shape the round-40 finding described.
const tapWithSource=()=>'<path>src/widget.py</path>\n<type>file</type>\n<content>\n'
  +sourceBody()+'\n(End of file - total 406 lines)\n</content>\n\n# tests 5\n# pass 5\n# fail 0\n';

test('the test receipt refuses a source body printed beside passing totals',()=>{
  const text=tapWithSource();
  assert.equal(looksLikeSourceBody(text),true,'the fixture is source-shaped');
  assert.equal(testOutputDigest('node --test',text,{seq:7}),null,'a passing run does not summarise a source body');
});

test('the test receipt still summarises a real check log',()=>{
  // The control: the same command and the same shape without source content must still
  // produce a receipt, or the guard above would be indistinguishable from a dead branch.
  const log=['# tests 5','# pass 5','# fail 0',...Array.from({length:400},(_,i)=>`build step ${i} completed in ${i}ms`)].join('\n');
  const digest=testOutputDigest('node --test',log,{seq:8});
  assert.ok(digest,'a log with totals is summarised');
  assert.ok(digest.text.includes('5 passed'));
});

test('the generic tool receipt refuses a source body printed by a shell command',()=>{
  const text=sourceBody();
  assert.equal(looksLikeSourceBody(text),true,'the fixture is source-shaped');
  assert.equal(toolOutputDigest('pwsh',text,{seq:9,command:'cat src/widget.py'}),null,'source is never digested');
});

test('the generic tool receipt still summarises a diagnostic log',()=>{
  const log=Array.from({length:900},(_,i)=>`build step ${i} completed in ${i}ms`).join('\n')+'\nERROR: one step failed\n';
  assert.equal(looksLikeSourceBody(log),false,'a log is not source-shaped');
  assert.ok(toolOutputDigest('pwsh',log,{seq:10,command:'run-build'}),'a log can still become a receipt');
});
