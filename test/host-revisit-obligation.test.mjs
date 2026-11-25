import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

// Elapsed steps after a write do not establish a need to read again. Preserve
// actual invalidation notices and ordinary read/write records without a timer.

const filler=[tool('glob',{pattern:'*.txt'})];
const write=[tool('write',{file_path:'a.txt',content:'changed\n'})];
const reread=[tool('read',{file_path:'a.txt'})];
const done=[text('完成。')];
const REMINDER='改动后未复核';

// Answers are keyed by main-request number, so a test can decide what a turn does
// after seeing how the previous one ended. The write is followed by `done` because
// the request after a tool call belongs to the same turn: without it the turn
// would keep looping and read the file back itself.
async function withHost(body){
  const answers=new Map();
  const host=await startHost({script:async(_options,n)=>answers.get(n)??done});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'original\nline2\n');
    const agent=await host.createAgent('max');
    return await body({answers,
      command:action=>host.command(agent,action),send:message=>host.send(agent,message),
      body:()=>host.requests.map(requestText).join('\n')});
  }finally{await host.close();}
}
const writeAtFour=answers=>{
  for(let n=1;n<4;n++)answers.set(n,filler);
  answers.set(4,write);answers.set(5,done);
};

test('elapsed steps after a write keep the stale-search notice without a reread reminder',async()=>{
  await withHost(async({answers,send,body,command})=>{
    writeAtFour(answers);
    await send('处理 a.txt');
    await send('继续。');
    await send('继续。');
    await send('继续。');
    const detail=(await command('detail')).detail.state;
    assert.equal(detail.counts.mutations,1,'the write is recorded');
    assert.equal(detail.counts.stateNotices,1,'the search invalidation is still delivered once');
    assert.ok(detail.searches.some(search=>search.stale),'the search invalidation stays recorded');
    assert.match(body(),/工程状态已失效/u,'the model still receives the search invalidation');
    assert.ok(!body().includes(REMINDER),'elapsed steps do not create a reminder');
    assert.deepEqual(detail.revisitObligations,[],'legacy status exposes no manufactured obligation');
  });
});

test('an explicit read after a write remains available and recorded',async()=>{
  await withHost(async({answers,send,body,command})=>{
    writeAtFour(answers);
    answers.set(6,reread);
    await send('处理 a.txt');
    await send('继续。');
    await send('继续。');
    assert.ok(!body().includes(REMINDER));
    assert.match(body(),/(?:^|\n)\s*1(?:[:|]|\t)\s*changed(?:\r?\n|$)/u,
      'the requested source line still reaches the model');
    assert.ok((await command('detail')).detail.state.observations.some(item=>item.path==='a.txt'),
      'reading after a write is still recorded');
  });
});

test('a read during a disabled interval never produces a reminder that the file was not reread',async()=>{
  await withHost(async({answers,send,body,command})=>{
    writeAtFour(answers);
    answers.set(6,reread);
    await send('处理 a.txt');
    await command('off');
    await send('继续。');
    await command('on');
    await send('继续。');
    await send('继续。');
    await send('继续。');
    const bodyText=body();
    assert.ok(!bodyText.includes(REMINDER),
      'no reminder may claim a.txt was not reread: '+JSON.stringify(bodyText.slice(-600)));
    assert.equal((await command('detail')).state.counts.mutations,0,
      'disabling reset the ledger the write was recorded in');
  });
});

test('an empty read window does not create a timed reread requirement',async()=>{
  await withHost(async({answers,send,body,command})=>{
    writeAtFour(answers);
    answers.set(6,[tool('read',{file_path:'a.txt',offset:900,limit:50})]);
    await send('处理 a.txt');
    await send('继续。');
    await send('继续。');
    await send('继续。');
    assert.ok(!body().includes(REMINDER));
    assert.equal((await command('detail')).state.counts.mutations,1,
      'the write record survives an empty read window');
  });
});
