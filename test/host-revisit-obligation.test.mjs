import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

// A write that is never read back is the pattern behind the lost 屎山 cases: the
// model fixed one of two sites and moved on. recordMutation therefore arms a
// revisit obligation and consumeStateNotice emits one reminder naming the file.
// These tests cover both directions, plus the case where the reread happens while
// the plugin is disabled: observe() returns early then, so the ledger never sees
// that read, and a reminder afterwards would claim something untrue.

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

test('a written file that is never read back gets one reminder that names it',async()=>{
  await withHost(async({answers,send,body,command})=>{
    writeAtFour(answers);
    await send('处理 a.txt');
    await send('继续。');
    await send('继续。');
    await send('继续。');
    const detail=(await command('detail')).state;
    assert.equal(detail.counts.mutations,1,'the write is recorded');
    // Count EMISSIONS, not occurrences in the transcript. `body()` joins every captured
    // request, and a notice injected at step k is carried in the history of every later
    // request, so one delivery appears several times and a transcript count would fail for
    // a plugin that behaves correctly.
    //
    // TWO notices are emitted here, and both are correct:
    //   step 4 — the write staled the three glob observations, so the "工程状态已失效"
    //            notice reports what it invalidated;
    //   step 7 — the revisit obligation for a.txt is overdue, so the "改动后未复核" reminder
    //            fires naming the file.
    // The test's title is about the SECOND one. Asserting a total of 1 conflated the two and
    // would have forced the stale-state notice to be suppressed to pass, which is a
    // capability loss, not a fix.
    assert.equal(detail.counts.stateNotices,2,'the stale-state notice and the revisit reminder are emitted');
    // The whole transcript contains a.txt in the user request and in the write arguments,
    // so a bare includes() would pass even if the reminder omitted the file. Anchor on the
    // reminder text itself.
    const text=body();
    const reminders=[...text.matchAll(new RegExp(REMINDER,'gu'))];
    assert.equal(reminders.length,1,'the revisit reminder appears exactly once in the transcript');
    const from=reminders[0].index;
    const clause=text.slice(from,from+240);
    assert.match(clause,/a\.txt/u,'the reminder itself names the changed file');
  });
});

test('a written file that is read back before the reminder gets no reminder',async()=>{
  await withHost(async({answers,send,body})=>{
    writeAtFour(answers);
    answers.set(6,reread);
    await send('处理 a.txt');
    await send('继续。');
    await send('继续。');
    assert.ok(!body().includes(REMINDER),'the reread discharges the obligation before any reminder');
  });
});

test('a read during a disabled interval never produces a reminder that the file was not reread',async()=>{
  await withHost(async({answers,send,body,command})=>{
    writeAtFour(answers);
    answers.set(6,reread);
    await send('处理 a.txt');
    // Request 6 is the read, and it happens while the plugin is disabled. The
    // plugin cannot observe it, so after re-enabling it must not report the file
    // as still unread: the obligation went with the ledger that disabling reset.
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

test('a read past the end of the file does not discharge the obligation',async()=>{
  // A read with an offset past the end completes successfully with no lines. That
  // delivers no source, so it cannot confirm anything about the change; discharging
  // here would let the reminder disappear without the file having been checked.
  await withHost(async({answers,send,body})=>{
    writeAtFour(answers);
    answers.set(6,[tool('read',{file_path:'a.txt',offset:900,limit:50})]);
    await send('处理 a.txt');
    await send('继续。');
    await send('继续。');
    await send('继续。');
    assert.ok(body().includes(REMINDER),
      'an out-of-range read leaves the obligation standing');
  });
});
