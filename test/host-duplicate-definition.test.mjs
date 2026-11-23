import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

// 059 and 066 failed the same way: the model fixed the validation layer and never
// located the calculation layer, because nothing told it that the same definition
// exists in two files. The write-after reminder cannot catch that (the second site
// is never written). This notice fires on the search that reveals both sites.

const READ_ONE=[tool('read',{file_path:'one.py'})];

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

const REMINDER='的同名定义';

test('a definition that exists in two files raises one notice naming both sites',async()=>{
  const observed=await run({
    'one.py':'def days_until_birthday(today, birthday):\n    return 1\n',
    'two.py':'def days_until_birthday(today, birthday):\n    return 2\n'
  },async(_o,n)=>{
    if(n===1)return [tool('grep',{pattern:'def days_until_birthday',path:'.'})];
    return [text('完成。')];
  });
  assert.ok(observed.body.includes(REMINDER),'the notice is delivered');
  assert.ok(observed.body.includes('days_until_birthday'),'it names the definition');
  assert.match(observed.body,/的同名定义（(?:one\.py、two\.py|two\.py、one\.py)）/u,'it names both files');
  assert.ok(observed.body.includes('沿用户描述的入口确认实际调用位置'),'it asks which implementation the user reaches');
});

test('a definition in a single file raises no notice',async()=>{
  const observed=await run({
    'one.py':'def days_until_birthday(today, birthday):\n    return 1\n'
  },async(_o,n)=>{
    if(n===1)return [tool('grep',{pattern:'def days_until_birthday',path:'.'})];
    return [text('完成。')];
  });
  assert.ok(!observed.body.includes(REMINDER),'a single implementation is not a risk');
});

test('a broad free-text search raises no notice even when it hits many files',async()=>{
  // Two matches in two files only matter when the query names one definition. A
  // normal search that happens to match a word in several files must not produce
  // this reminder, or every grep would.
  const observed=await run({
    'one.txt':'the word birthday appears here\n',
    'two.txt':'the word birthday appears here too\n'
  },async(_o,n)=>{
    if(n===1)return [tool('grep',{pattern:'birthday appears',path:'.'})];
    return [text('完成。')];
  });
  assert.ok(!observed.body.includes(REMINDER),'a prose search is not a definition query');
});

test('the notice is raised once, not on every matching search',async()=>{
  // The notice is consumed before a request, so a second search has to happen in a
  // later turn. A delivered notice stays in the conversation history, so counting
  // its text across requests would count re-sends of one message; the stateNotices
  // counter is what says how many were actually raised.
  const observed=await run({
    'one.py':'def days_until_birthday(today, birthday):\n    return 1\n',
    'two.py':'def days_until_birthday(today, birthday):\n    return 2\n'
  },async(_o,n)=>{
    if(n===1)return [text('先看看这两个文件的定义。')];
    if(n===2)return [tool('grep',{pattern:'days_until_birthday',path:'.'})];
    if(n===3)return [text('看到了。')];
    if(n===4)return [tool('grep',{pattern:'days_until_birthday',path:'.'})];
    return [text('完成。')];
  });
  assert.equal(observed.detail.metrics.stateNotices,1,'one notice per session, not one per search');
  assert.ok(observed.body.includes(REMINDER),'and it was actually delivered');
});

test('an import and a call are references, not duplicate definitions',async()=>{
  // Two files matching a name is not evidence of two implementations: one may
  // import it and another call it. Claiming "implemented in multiple places" there
  // would mislead and would spend the session's single notice.
  const observed=await run({
    'one.py':'from helpers import calculate_total\n',
    'two.py':'def use_it(rows):\n    return calculate_total(rows)\n',
    'three.py':'def calculate_total(rows):\n    return sum(rows)\n'
  },async(_o,n)=>{
    if(n===1)return [tool('grep',{pattern:'calculate_total',path:'.'})];
    return [text('完成。')];
  });
  assert.ok(!observed.body.includes(REMINDER),
    'one definition plus references is not a duplicate implementation');
  assert.equal(observed.detail.metrics.stateNotices,0);
});

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
  assert.ok(!observed.body.includes('只在'),'a whole-project search already covers other files');
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
  assert.ok(!observed.body.includes('只在'),'no result means no scope advice');
});
