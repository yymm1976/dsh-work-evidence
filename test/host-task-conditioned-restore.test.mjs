import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

// CoMem's claim is that one history serves different next steps differently:
// the same retained result is worth restoring for the task that needs it and
// worthless for a task that does not. request-working-set decides that in
// needReasons() from the current user message. Both tests below run the exact
// same two setup turns and the same projected set, and vary only the third
// request, so a difference in what comes back can only come from the task.

const price=[{provider:'scripted',model:'scripted-model',input:0.15,cacheRead:0.003,output:0.6,currency:'USD'}];
const usage=o=>{const total=Math.ceil(JSON.stringify(o.messages).length/3),cached=Math.floor(total*.85);
  return {inputTokens:total-cached,cacheReadTokens:cached,cacheWriteTokens:0,outputTokens:60,totalTokens:[total,60].reduce((s,n)=>s+n,0)};};
const big=(tag,count)=>Array.from({length:count},(_,i)=>`${tag} row ${i} `+'q'.repeat(100)).join('\n');

// Turn 1 reads o0..o7. Turn 2 reads p0..p13, which under the small window pushes
// the eight o results out of the retained plan. Turn 3 is the variable.
const plan=[...Array.from({length:8},(_,i)=>[tool('read',{file_path:`o${i}.txt`})]),[text('第一部分完成。')],
  ...Array.from({length:14},(_,i)=>[tool('read',{file_path:`p${i}.txt`})]),[text('第二部分完成。')]];

async function run(thirdRequest){
  const host=await startHost({workspace:{contextProtocol:false,projectionPricing:price,requestProjection:true,projectionRestore:true},
    contextWindow:60000,usage,script:(_o,n)=>plan[n-1]??[text('完成。')]});
  try{
    for(let i=0;i<8;i++)await fs.writeFile(path.join(host.cwd,`o${i}.txt`),big(`o${i}`,120));
    for(let i=0;i<14;i++)await fs.writeFile(path.join(host.cwd,`p${i}.txt`),big(`p${i}`,40));
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 o0.txt 到 o7.txt 并总结');
    await host.send(agent,'现在改为读取 p0.txt 到 p13.txt 并总结');
    const beforeThird=await host.command(agent,'detail');
    const boundary=host.requests.length;
    await host.send(agent,thirdRequest);
    const afterThird=await host.command(agent,'detail');
    return {workingSet:beforeThird.workingSet,
      restored:afterThird.workingSet.restoredObservations,
      restorations:(afterThird.observability?.decisions??[]).filter(decision=>decision.feature==='restoration'),
      thirdBodies:host.requests.slice(boundary).map(requestText)};
  }finally{await host.close();}
}

test('a next task that names a projected source restores exactly that source',async()=>{
  const observed=await run('回到 o0.txt，读取并说明 row 31 的内容');
  assert.ok(observed.workingSet.projectedObservations>0,
    'the o results must be projected before the third turn: '+JSON.stringify(observed.workingSet.skips));
  assert.equal(observed.restored,1,'exactly the named source comes back, not the whole plan');
  const applied=observed.restorations.filter(decision=>decision.status==='applied');
  assert.equal(applied.length,1);
  assert.equal(applied[0].reason,'observable-dependency-returned');
  assert.deepEqual(applied[0].needReasons.map(entry=>entry.reasons),[['user-source-reference']],
    'the recorded signal is the current request naming that source, not age or ordering');
  assert.ok(observed.thirdBodies.some(body=>body.includes('o0 row 31')),
    'the restored body is the text the request asked about');
});

test('the same projected history restores nothing for a task that names no projected source',async()=>{
  const observed=await run('说明 p3.txt 的 row 7 是什么');
  assert.ok(observed.workingSet.projectedObservations>0,
    'identical projected set to the positive case: '+JSON.stringify(observed.workingSet.skips));
  assert.equal(observed.restored,0,'no projected source comes back for a task about another file');
  assert.equal(observed.restorations.length,0);
  assert.ok(!observed.thirdBodies.some(body=>body.includes('o0 row 31')),
    'the unrelated retained body does not reappear in the request');
});
