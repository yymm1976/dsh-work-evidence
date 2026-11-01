import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

const price=[{provider:'scripted',model:'scripted-model',input:0.15,cacheRead:0.003,output:0.6,currency:'USD'}];
const usage=o=>{const total=Math.ceil(JSON.stringify(o.messages).length/3),cached=Math.floor(total*.85);
  return {inputTokens:total-cached,cacheReadTokens:cached,cacheWriteTokens:0,outputTokens:60,totalTokens:[total,60].reduce((s,n)=>s+n,0)};};
const big=(tag,count)=>Array.from({length:count},(_,i)=>`${tag} row ${i} `+'q'.repeat(100)).join('\n');
async function run(workspace,contextWindow=200000){
  const plan=[...Array.from({length:8},(_,i)=>[tool('read',{file_path:`o${i}.txt`})]),[text('第一部分完成。')],
    ...Array.from({length:14},(_,i)=>[tool('read',{file_path:`p${i}.txt`})]),[text('第二部分完成。')],
    [tool('read',{file_path:'o0.txt'})],[text('第三部分完成。')]];
  const host=await startHost({workspace:{contextProtocol:false,projectionPricing:price,projectionMinChars:16000,...workspace},contextWindow,usage,
    script:(_o,n)=>plan[n-1]??[text('完成。')]});
  try{
    for(let i=0;i<8;i++)await fs.writeFile(path.join(host.cwd,`o${i}.txt`),big(`o${i}`,120));
    for(let i=0;i<14;i++)await fs.writeFile(path.join(host.cwd,`p${i}.txt`),big(`p${i}`,40));
    const agent=await host.createAgent('max');await host.send(agent,'读取 o0.txt 到 o7.txt 并总结');
    const first=await host.command(agent,'detail');
    await host.send(agent,'现在改为读取 p0.txt 到 p13.txt 并总结');
    const second=await host.command(agent,'detail');
    await host.send(agent,'回到 o0.txt，读取并说明 row 31 的内容');
    return {first,second,last:await host.command(agent,'detail'),bodies:host.requests.map(requestText),events:host.events};
  }finally{await host.close();}
}

test('projection retains sources from the active request and rejects uneconomic historical rewrites',async()=>{
  const observed=await run({requestProjection:true,projectionRestore:true});
  assert.equal(observed.first.detail.workingSet.projectedObservations,0);
  assert.ok(observed.first.detail.workingSet.candidateAssessment.rejected['current-task-source']>0);
  assert.equal(observed.second.detail.workingSet.projectedObservations,0);
  assert.ok(observed.second.detail.workingSet.skips['predicted-cache-cost-insufficient']>0);
});

test('projection adopts under capacity pressure and restores an old source dependency',async()=>{
  const observed=await run({requestProjection:true,projectionRestore:true},60000);
  assert.ok(observed.second.detail.workingSet.projectedObservations>0);
  assert.ok(observed.last.detail.workingSet.restoredObservations>0);
  assert.ok(observed.bodies.at(-1).includes('o0 row 31'));
  console.log('measurement',JSON.stringify({feature:'requestProjection',projected:observed.second.detail.workingSet.projectedObservations,restored:observed.last.detail.workingSet.restoredObservations,charsOmittedAcrossRequests:observed.second.detail.workingSet.charsOmittedAcrossRequests}));
});

test('projection and its restoration switch must both be enabled',async()=>{
  for(const workspace of [{requestProjection:false,projectionRestore:true},{requestProjection:true,projectionRestore:false}]){
    const observed=await run(workspace,60000);
    assert.equal(observed.last.detail.workingSet.projectedObservations,0);
    assert.equal(observed.last.detail.workingSet.restoredObservations,0);
  }
});
