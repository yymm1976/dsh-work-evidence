import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,load,requestText} from './helpers/host.mjs';

const price=[{provider:'scripted',model:'scripted-model',input:.15,cacheRead:.003,output:.6,currency:'USD'}];
const source=(tag,count)=>Array.from({length:count},(_,line)=>`${tag} row ${line} `+'q'.repeat(100)).join('\n');
const usage=options=>{const tokens=Math.ceil(JSON.stringify(options.messages).length/3),cached=Math.floor(tokens*.85);
  return {inputTokens:tokens-cached,cacheReadTokens:cached,cacheWriteTokens:0,outputTokens:60,totalTokens:tokens+60};};

test('folding, projection, native compaction and disabled-state recall preserve the same source',async()=>{
  const plan=[];
  const host=await startHost({contextWindow:60000,usage,workspace:{
    contextProtocol:true,historyHygiene:true,swLedger:true,swEviction:true,swEvictionSteps:3,
    requestProjection:true,projectionRestore:true,projectionMinChars:16000,projectionPricing:price,
    compressionControl:true,deferPressureCompaction:true,stubSummary:true,
  },script:()=>plan.shift()??[text('当前来源已处理。')]});
  try{
    for(let i=0;i<8;i++)await fs.writeFile(path.join(host.cwd,`o${i}.txt`),source(`o${i}`,120));
    for(let i=0;i<14;i++)await fs.writeFile(path.join(host.cwd,`p${i}.txt`),source(`p${i}`,40));
    const agent=await host.createAgent('max');
    let feature=(await host.command(agent,'feature stubSummary')).features[0];
    assert.ok(feature.reasons.includes('native-compaction-not-attached'));
    plan.push(...Array.from({length:8},(_,i)=>[tool('read',{file_path:`o${i}.txt`})]),[tool('read',{file_path:'o0.txt'})],[text('第一组来源已读取。')]);
    await host.send(agent,'只读取 o0.txt 至 o7.txt，然后再读一次 o0.txt，保留来源供下一阶段使用。');
    const original=host.events.find(event=>event.type==='tool/result'&&event.data.message?.content.some(block=>block.text?.includes('o0 row 31')));
    assert.ok(original);
    plan.push(...Array.from({length:14},(_,i)=>[tool('read',{file_path:`p${i}.txt`})]),[text('第二组来源已读取。')]);
    await host.send(agent,'现在切换到 p0.txt 至 p13.txt，读取并保留来源，不再处理第一组文件。');
    const before=(await host.command(agent,'detail')).detail;
    assert.ok(before.sw.evicted>0||before.workingSet.projectedObservations>0||before.observability.historyHygiene?.charsRemovedAcrossViews>0,
      JSON.stringify({sw:before.sw,projection:before.workingSet}));
    const target=before.workingSet.entries[0];assert.ok(target);
    const restoredMarker=/o\d+ row 31/.exec(JSON.stringify(host.events.find(event=>event.seq===target.seq).data))[0];
    plan.push([text('已恢复旧来源。')]);
    await host.send(agent,`恢复 event:${target.seq} 中的历史正文，不要重新读取文件。`);
    const restored=(await host.command(agent,'detail')).detail.workingSet;
    assert.ok(restored.restoredObservations>0);assert.ok(requestText(host.requests.at(-1)).includes(restoredMarker));
    const basic=await load('dsh-compaction-basic');
    await host.ctx.plugin(basic.default??basic,{thresholdRatio:.7,retainTokens:4000,maxTokens:10000,headroomTokens:4000});
    feature=(await host.command(agent,'feature stubSummary')).features[0];assert.equal(feature.status,'ready');
    await host.ctx.compaction.compactIfNeeded(agent,'pressure',AbortSignal.timeout(30000));
    const pressure=(await host.command(agent,'detail')).detail.compression.nativeHandoff;
    assert.ok(pressure.deferredPressure>0,JSON.stringify(pressure));
    await host.ctx.compaction.compactNow(agent,AbortSignal.timeout(30000));
    const compacted=(await host.command(agent,'detail')).detail.compression.nativeHandoff;
    assert.equal(compacted.committed,1);assert.equal(compacted.stubSummaries,1);
    feature=(await host.command(agent,'feature stubSummary')).features[0];
    assert.equal(feature.effect.status,'applied');assert.equal(feature.effect.applied,1);
    assert.equal(compacted.nativeSummaryCalls,0);assert.equal(host.auxiliaryRequests.length,0);
    await host.command(agent,'off');
    assert.ok(host.ctx.tools.get('work_recall',agent));
    plan.push([tool('work_recall',{kind:'event',seq:original.seq,offset:0,maxChars:64000})],[text('已取回原事件。')]);
    await host.send(agent,`从 event:${original.seq} 取回 o0.txt 的原文，不重新读取文件。`);
    assert.ok(requestText(host.requests.at(-1)).includes('o0 row 31'));
    assert.equal(host.events.filter(event=>event.type==='tool/call'&&event.data.name==='read').length,23);
    assert.equal(host.events.filter(event=>event.type==='tool/result'&&event.data.message?.isError).length,0);
    console.log('combination',JSON.stringify({evicted:before.sw.evicted,projected:before.workingSet.projectedObservations,
      restored:restored.restoredObservations,deferredPressure:pressure.deferredPressure,
      charsOmittedAcrossRequests:before.workingSet.charsOmittedAcrossRequests,stubCommits:compacted.committed,
      nativeSummaryCalls:compacted.nativeSummaryCalls,sourceSeq:original.seq,recallAfterDisable:true}));
  }finally{await host.close();}
});
