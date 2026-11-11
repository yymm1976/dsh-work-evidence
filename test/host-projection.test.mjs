import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';
import {readRequestAccounting} from '../experiment-consumption.mjs';
import {auditCacheTransitions} from '../trajectory-audit.mjs';

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
    const last=await host.command(agent,'detail'),status=await host.command(agent,'status');
    return {first,second,last,bodies:host.requests.map(requestText),events:host.events,
      sessionId:agent.session.id,observabilityFile:status.observability.persistence.file};
  }finally{await host.close();}
}

test('projection retains sources from the active request and rejects uneconomic historical rewrites',async()=>{
  const observed=await run({requestProjection:true,projectionRestore:true,projectionHorizonSteps:3});
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

test('a projected host request links its plan to matched source results',async()=>{
  const observed=await run({requestProjection:true,projectionRestore:true},60000);
  const accounting=await readRequestAccounting(observed.observabilityFile,observed.events,{sessionId:observed.sessionId});
  const matched=accounting.mainRequestLinks.filter(row=>row.projectionObservation?.status==='matched');
  assert.ok(matched.length>0,JSON.stringify(accounting.mainRequestLinks.map(row=>row.projectionObservation)));
  assert.ok(matched.every(row=>Number.isSafeInteger(row.sourceSeq)&&row.projectionObservation.resultSeqs.length>0));
  const audit=auditCacheTransitions(observed.events,accounting);
  assert.ok(audit.items.some(item=>item.observationKind==='projection-matched'&&item.resultScope==='full-plan'));
  assert.ok(!audit.items.some(item=>item.reasons.includes('restored-result-still-projected')),'restored entries do not invalidate remaining projections');
});

test('restoration preserves distinct tool observations even when their file bytes match',async()=>{
  const plan=[...Array.from({length:8},(_,i)=>[tool('read',{file_path:`o${i}.txt`})]),[text('第一部分完成。')],
    ...Array.from({length:14},(_,i)=>[tool('read',{file_path:`p${i}.txt`})]),[text('第二部分完成。')],
    [tool('read',{file_path:'o0.txt'})],[text('shared row 31 已恢复。')]];
  const host=await startHost({workspace:{contextProtocol:false,requestProjection:true,projectionRestore:true,projectionPricing:price,projectionMinChars:16000},contextWindow:60000,usage,
    script:(_o,n)=>plan[n-1]??[text('完成。')]});
  try{
    const shared=big('shared',120);
    for(let i=0;i<8;i++)await fs.writeFile(path.join(host.cwd,`o${i}.txt`),i<2?shared:big(`o${i}`,120));
    for(let i=0;i<14;i++)await fs.writeFile(path.join(host.cwd,`p${i}.txt`),big(`p${i}`,40));
    const agent=await host.createAgent('max');await host.send(agent,'读取 o0.txt 到 o7.txt 并总结');
    await host.send(agent,'现在改为读取 p0.txt 到 p13.txt 并总结');
    const before=(await host.command(agent,'detail')).detail.workingSet;
    assert.ok(before.projectedObservations>0);
    const o1Call=host.events.find(event=>event.type==='tool/call'&&event.data.name==='read'&&JSON.parse(event.data.arguments).file_path==='o1.txt');
    const o1Result=host.events.find(event=>event.type==='tool/result'&&event.data.message.source.callId===o1Call.data.callId);
    assert.ok(before.entries.some(entry=>entry.seq===o1Result.seq),'the shared historical source must actually be projected');
    await host.send(agent,'读取 o0.txt，并说明 o1.txt 的 row 31；不要重新读取 o1.txt。');
    const last=await host.command(agent,'detail');
    const restored=host.events.find(event=>event.type==='user/message'&&event.data.source?.workingSet?.action==='restore'&&event.data.source.workingSet.seqs.includes(o1Result.seq));
    assert.ok(restored,'the requested historical observation must be recovered rather than aliased to another file with the same bytes');
    const restoredMessage=host.requests.at(-1).messages.find(message=>message.source?.workingSet?.action==='restore'&&message.source.workingSet.seqs.includes(o1Result.seq));
    const restoredText=(restoredMessage?.content??[]).map(block=>block.text??'').join('\n');
    assert.ok(restoredText.includes('o1.txt')&&restoredText.includes('shared row 31'));
    assert.equal(last.detail.workingSet.entries.find(entry=>entry.seq===o1Result.seq)?.restoredAt,restored.seq);
    assert.equal(last.detail.workingSet.restoredObservations,2);
    assert.equal(last.detail.observability.features.restoration.lastReason,'observable-dependency-returned');
    assert.ok(last.detail.observability.features.restoration.applied>0);
    assert.equal(host.events.filter(event=>event.type==='tool/call'&&event.data.name==='read'&&JSON.parse(event.data.arguments).file_path==='o1.txt').length,1);
  }finally{await host.close();}
});

test('projection and its restoration switch must both be enabled',async()=>{
  for(const workspace of [{requestProjection:false,projectionRestore:true},{requestProjection:true,projectionRestore:false}]){
    const observed=await run(workspace,60000);
    assert.equal(observed.last.detail.workingSet.projectedObservations,0);
    assert.equal(observed.last.detail.workingSet.restoredObservations,0);
  }
});

test('a full-output request bypasses active pointers without a source restoration signal',async()=>{
  const plan=[...Array.from({length:8},(_,i)=>[tool('read',{file_path:`o${i}.txt`})]),[text('第一部分完成。')],
    ...Array.from({length:14},(_,i)=>[tool('read',{file_path:`p${i}.txt`})]),[text('第二部分完成。')]];
  const host=await startHost({workspace:{contextProtocol:false,requestProjection:true,projectionRestore:true,projectionPricing:price,projectionMinChars:16000},contextWindow:60000,usage,
    script:(_o,n)=>plan[n-1]??[text('完成。')]});
  try{
    for(let i=0;i<8;i++)await fs.writeFile(path.join(host.cwd,`o${i}.txt`),big(`o${i}`,120));
    for(let i=0;i<14;i++)await fs.writeFile(path.join(host.cwd,`p${i}.txt`),big(`p${i}`,40));
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 o0.txt 到 o7.txt 并总结');
    await host.send(agent,'现在改为读取 p0.txt 到 p13.txt 并总结');
    const before=(await host.command(agent,'detail')).detail.workingSet;
    assert.ok(before.entries.length>0,'this regression requires an actual active projection');
    const originals=before.entries.map(entry=>host.events.find(event=>event.seq===entry.seq).data.message);
    await host.send(agent,'请保留完整输出。');
    for(const original of originals){
      const assembled=host.requests.at(-1).messages.find(message=>message.id===original.id);
      assert.deepEqual(assembled?.content,original.content,'the assembled request must carry the canonical tool body');
    }
    await host.send(agent,'继续下一部分。');
    assert.ok(originals.some(original=>{
      const assembled=host.requests.at(-1).messages.find(message=>message.id===original.id);
      return assembled&&JSON.stringify(assembled.content)!==JSON.stringify(original.content);
    }),'a later ordinary request resumes the existing projection');
  }finally{await host.close();}
});
