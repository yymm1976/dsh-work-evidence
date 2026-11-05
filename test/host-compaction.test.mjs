import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

// Without request pruning, the effective request still reaches native pressure.
async function run(workspace,{manual=false}={}){
  const summaries=[];
  const host=await startHost({workspace,contextWindow:40000,
    extraMounts:[['dsh-compaction-basic',{thresholdRatio:0.3,retainTokens:4000,maxTokens:30000,headroomTokens:4000}]],
    usage:options=>{const tokens=Math.ceil(JSON.stringify(options.messages).length/3);return {inputTokens:tokens,outputTokens:50,cacheReadTokens:0,totalTokens:tokens+50};},
    auxiliary:options=>{summaries.push(options);return [text('## 摘要\n- 已读取前面的文件。')];},
    script:(_o,n)=>n<=30?[tool('read',{file_path:`f${n-1}.txt`})]:[text('完成。')]});
  try{
    for(let i=0;i<30;i++)await fs.writeFile(path.join(host.cwd,`f${i}.txt`),Array.from({length:40},(_,j)=>`f${i} ${j} `+'y'.repeat(60)).join('\n'));
    const agent=await host.createAgent('max');
    await host.send(agent,'依次读取 f0.txt 到 f29.txt 并总结');
    const handoff=(await host.command(agent,'detail')).detail.compression.nativeHandoff;
    const beforeManual=summaries.length;
    if(manual)await host.ctx.compaction.compactNow(agent,AbortSignal.timeout(30000));
    return {handoff,summaries,beforeManual,starts:host.events.filter(e=>e.type==='compaction/start').length,
      completed:host.events.findLast(e=>e.type==='turn/end')?.data?.reason?.kind};
  }finally{await host.close();}
}

test('pressure deferral retains native pressure when the effective request is not reduced', async()=>{
  const off=await run({contextProtocol:false});
  const on=await run({contextProtocol:false,deferPressureCompaction:true});
  assert.equal(off.completed,'completed');
  assert.equal(on.completed,'completed');
  assert.ok(off.starts>=2,`host compacts early without deferral (${off.starts})`);
  assert.equal(on.handoff.deferredPressure??0,0,'an unshortened request must not defer pressure');
  assert.equal(on.starts,off.starts,'both runs preserve the native pressure decisions');
  assert.ok(on.summaries.every(o=>o.maxTokens===30000),'native summaries retain the configured output reservation');
  assert.ok(off.summaries.some(o=>o.maxTokens===30000),'without deferral the host reservation is unchanged');
  assert.equal(off.handoff.deferredPressure??0,0);
});

test('pressure deferral does not cap a manual summary after the pressure operation has ended',async()=>{
  const observed=await run({contextProtocol:false,deferPressureCompaction:true},{manual:true});
  assert.equal(observed.summaries.length,observed.beforeManual+1);
  assert.equal(observed.summaries.at(-1).maxTokens,30000);
});

test('native stub compaction commits without a summary call and its source remains recoverable',async()=>{
  let sourceSeq;
  const marker='EXACT_SOURCE_MIDDLE_817';
  const host=await startHost({workspace:{stubSummary:true,contextProtocol:false,historyHygiene:false},
    extraMounts:[['dsh-compaction-basic',{thresholdRatio:.9,retainTokens:4000,maxTokens:10000,headroomTokens:4000}]],
    script:(_options,n)=>n<=10?[tool('read',{file_path:`source${n-1}.txt`})]:n===12?
      [tool('work_recall',{kind:'event',seq:sourceSeq,offset:0,maxChars:64000})]:[text(n===13?marker:'已读取来源。')]});
  try{
    for(let i=0;i<10;i++)await fs.writeFile(path.join(host.cwd,`source${i}.txt`),Array.from({length:90},(_,j)=>
      `source${i} line ${j}: `+(i===0&&j===50?marker:'x'.repeat(90))).join('\n'));
    const agent=await host.createAgent('max');await host.send(agent,'依次读取 source0.txt 到 source9.txt，稍后继续使用原文。');
    sourceSeq=host.events.find(event=>event.type==='tool/result'&&event.data.message?.content.some(block=>block.text?.includes(marker))).seq;
    await host.ctx.compaction.compactNow(agent,AbortSignal.timeout(30000));
    const detail=(await host.command(agent,'detail')).detail.compression.nativeHandoff;
    assert.equal(detail.stubSummaries,1);assert.equal(detail.committed,1);assert.equal(detail.nativeSummaryCalls,0);
    assert.equal(host.auxiliaryRequests.length,0);
    await host.command(agent,'off');
    assert.ok(host.ctx.tools.get('work_recall',agent),'the existing checkpoint must retain its recall entry while the plugin is off');
    await host.send(agent,'按原事件取回 source0.txt 第 50 行的精确标记，不重新读取文件。');
    assert.ok(requestText(host.requests.at(-1)).includes(marker));
    assert.equal(host.events.filter(event=>event.type==='tool/call'&&event.data.name==='read').length,10);
    assert.ok(host.events.some(event=>event.type==='tool/call'&&event.data.name==='work_recall'));
  }finally{await host.close();}
});

test('native summarization stays usable when enabled stub compaction lacks the recall tool',async()=>{
  const host=await startHost({workspace:{stubSummary:true,contextProtocol:false,historyHygiene:false},
    extraMounts:[['dsh-compaction-basic',{thresholdRatio:.9,retainTokens:4000,maxTokens:10000,headroomTokens:4000}]],
    auxiliary:()=>[text('已读完 source0.txt 至 source9.txt；后续继续处理当前要求。')],
    script:(_options,n)=>n<=10?[tool('read',{file_path:`source${n-1}.txt`})]:[text('已读取来源。')]});
  let release;
  try{
    for(let i=0;i<10;i++)await fs.writeFile(path.join(host.cwd,`source${i}.txt`),(`source${i} `+'x'.repeat(100)+'\n').repeat(90));
    const agent=await host.createAgent('max');await host.send(agent,'依次读取 source0.txt 到 source9.txt，稍后继续。');
    release=agent.ctx.tools.restrict({deny:['work_recall']});
    const feature=(await host.command(agent,'feature stubSummary')).features[0];
    assert.equal(feature.status,'blocked');assert.ok(feature.reasons.includes('historical-recall-not-exposed'));
    await host.ctx.compaction.compactNow(agent,AbortSignal.timeout(30000));
    const detail=(await host.command(agent,'detail')).detail.compression.nativeHandoff;
    assert.equal(detail.stubSummaries,0);assert.equal(detail.committed,1);assert.equal(detail.nativeSummaryCalls,1);
    assert.equal(detail.last.stubSkippedReason,'historical-recall-not-exposed');assert.equal(host.auxiliaryRequests.length,1);
  }finally{release?.();await host.close();}
});
