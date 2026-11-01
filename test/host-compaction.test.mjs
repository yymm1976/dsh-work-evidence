import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool} from './helpers/host.mjs';

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
