import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

// The remaining notice is about a definition-only search that never left one file.

async function run(files,script,workspace={}){
  const host=await startHost({workspace,script});
  try{
    for(const [name,body] of Object.entries(files))await fs.writeFile(path.join(host.cwd,name),body);
    const agent=await host.createAgent('max');
    await host.send(agent,'找出所有实现并处理');
    for(let n=0;n<3;n++)await host.send(agent,'继续。');
    return {body:host.requests.map(requestText).join('\n'),detail:await host.command(agent,'detail')};
  }finally{await host.close();}
}

test('a single-file definition-only result raises a scope reminder, while existing uses do not',async()=>{
  const definition='def calculate_total(rows):\n    return sum(rows)\n';
  const scopeReminder='中找到 \u0060calculate_total\u0060 的定义';
  for(const use of ['', '\ndef report(rows):\n    return calculate_total(rows)\n']){
    const observed=await run({'totals.py':definition+use},async(_o,n)=>{
      if(n===1)return [tool('grep',{pattern:'calculate_total',path:'totals.py'})];
      return [text('完成。')];
    });
    assert.equal(observed.body.includes(scopeReminder),!use);
    assert.equal(observed.detail.metrics.stateNotices,use?0:1);
  }
});

test('a workspace-wide search raises no scope reminder',async()=>{
  const observed=await run({
    'identity.py':'def normalize_birthday(value):\n    return value\n'
  },async(_o,n)=>{
    if(n===1)return [tool('grep',{pattern:'normalize_birthday',path:'.'})];
    return [text('完成。')];
  });
  assert.ok(!observed.body.includes('中找到'),'a whole-project search already covers other files');
  assert.equal(observed.detail.metrics.stateNotices,0);
});

test('an empty single-file search raises no scope reminder',async()=>{
  // Nothing was found, so there is no in-file result to generalise from; the empty
  // lookup path already has its own notice.
  const observed=await run({
    'identity.py':'def other(value):\n    return value\n'
  },async(_o,n)=>{
    if(n===1)return [tool('grep',{pattern:'normalize_birthday',path:'identity.py'})];
    return [text('完成。')];
  });
  assert.ok(!observed.body.includes('中找到'),'no result means no scope advice');
  assert.equal(observed.detail.metrics.stateNotices,0);
});
