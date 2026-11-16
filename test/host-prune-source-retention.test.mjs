import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {planContextPrune} from '../context-pruning.mjs';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

// F2-C pruned 49 source-file bodies, then re-read 737,310 characters of the dropped
// middle against 832,846 characters saved. The decision itself is the invariant: a source
// body may only be reduced when a later complete read of the same path supersedes it.
//
// A host case has to make pruning REACHABLE or it proves nothing. Two independent gates
// sit in front of it, and the earlier version of this file satisfied neither:
//   1. `planContextPrune`'s own retention rule (the thing under test);
//   2. the economics gate, which refuses to break a prefix cache when a price and a cache
//      exposure exist ("predicted-cache-cost-positive").
// Reporting `usage` made gate 2 refuse every prune and the assertion passed vacuously.
// The fixture therefore reports NO cache exposure, so the economics gate approves and the
// only remaining reason to keep a body whole is the retention rule. The positive control
// below is the same fixture with a non-source body: it must prune, and it does so through
// the same code path, so the source case's refusal is attributable to the rule.

const price=[{provider:'scripted',model:'scripted-model',input:0.15,cacheRead:0.003,output:0.6,currency:'USD'}];

const sourceLines=Array.from({length:400},(_,i)=>`${i+1}: value_${i} = ${i}`);
const sourceMessage={role:'tool',content:[{type:'text',text:
  `<path>module_a.py</path>\n<type>file</type>\n<content>\n${sourceLines.join('\n')}\n\n(End of file - total 400 lines)\n</content>`}]};
const options={seq:10,thresholdChars:8000,headChars:4096,tailChars:1024};

test('the planner refuses a source body that has no later complete read',()=>{
  const plan=planContextPrune(sourceMessage,[],{...options,retainSource:file=>/\.py$/u.test(file)});
  assert.equal(plan,null,'a retained source body is not reduced');
});

test('the planner still reduces a body it is allowed to retain away',()=>{
  const plan=planContextPrune(sourceMessage,[],{...options,retainSource:()=>false});
  assert.ok(plan,'an unretained body is still prunable');
  assert.ok(plan.charsAfter<plan.charsBefore);
});

/** The same 400-line body, with the shape of a log rather than a source file. */
const logBody=()=>Array.from({length:400},(_,i)=>`${i+1}: build line ${i} produced ${i*i} bytes`).join('\n');
/** The same 400-line body as source: assignments, which only the density rule detects. */
const assignmentBody=()=>Array.from({length:400},(_,i)=>`${i+1}: value_${i} = ${i}`).join('\n');

/** Read one body, then summarise, under a gate that approves pruning. */
async function readThenSummarise(name,body){
  const host=await startHost({workspace:{projectionPricing:price},
    script:(_o,n)=>n===1?[tool('read',{file_path:name})]:n===2?[tool('read',{file_path:'notes.txt'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,name),body);
    await fs.writeFile(path.join(host.cwd,'notes.txt'),'notes\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'读取两个文件');
    const detail=(await host.command(agent,'detail')).detail;
    return {third:requestText(host.requests.at(-1)),prune:detail.observability?.features?.contextPrune??null};
  }finally{await host.close();}
}

test('a non-source body of the same size reaches the pruning path',async()=>{
  // The positive control. Without it, "the source body was not pruned" could mean the
  // fixture never pruned anything, which is exactly how the first version of this test
  // passed while checking nothing.
  const {third,prune}=await readThenSummarise('build.log',logBody());
  assert.ok(prune&&prune.decisions>0,'the prune path was evaluated');
  assert.equal(prune.applied,1,'the gate approved and the body was reduced');
  assert.ok(!third.includes('build line 200'),'the middle of the log is gone from the request');
});

test('a source body stays whole in a real request when no later read supersedes it',async()=>{
  const {third,prune}=await readThenSummarise('module_a.py',assignmentBody());
  // The same fixture, the same size, the same gate: only the body's shape and its path
  // differ. Pruning was still evaluated and still approved by the economics gate, so this
  // refusal is the retention rule's and not an inert path.
  assert.ok(prune&&prune.decisions>0,'the prune path was evaluated');
  assert.ok(third.includes('value_200'),'the middle of the only source copy is still visible');
});

test('an unmarked source body is recognised without its path extension',async()=>{
  // `bash cat` returns a file with no markup and a non-source name. The density rule is the
  // only remaining evidence, so this case isolates it from `isSourceBodyPath`.
  const {third,prune}=await readThenSummarise('build.log',assignmentBody());
  assert.ok(prune&&prune.decisions>0,'the prune path was evaluated');
  assert.ok(third.includes('value_200'),'assignment-dense output is treated as source');
});
