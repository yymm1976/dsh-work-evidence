import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {planContextPrune} from '../context-pruning.mjs';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

// F2-C pruned 49 source-file bodies, then re-read 737,310 characters of the dropped
// middle against 832,846 characters saved. The decision itself is the invariant: a source
// body may only be reduced when a later complete read of the same path supersedes it.

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

test('a source body stays whole in a real request when no later read supersedes it',async()=>{
  const host=await startHost({script:(_o,n)=>n===1?[tool('read',{file_path:'module_a.py'})]:n===2?[tool('read',{file_path:'notes.txt'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'module_a.py'),Array.from({length:400},(_,i)=>`value_${i} = ${i}`).join('\n'));
    await fs.writeFile(path.join(host.cwd,'notes.txt'),'notes\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 module_a.py 与 notes.txt');
    const third=requestText(host.requests.at(-1));
    assert.ok(third.includes('value_200'),'the middle of the only source copy is still visible');
  }finally{await host.close();}
});
