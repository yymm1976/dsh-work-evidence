import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {startHost,text,tool,requestText} from './helpers/host.mjs';
import {ACP_ENTRY} from './helpers/paths.mjs';

const acpFile=ACP_ENTRY;
const source=(tag,count)=>Array.from({length:count},(_,line)=>`${tag} row ${line} `+'q'.repeat(100)).join('\n');
const read=file=>tool('run_code',{code:'console.log(JSON.stringify(await tools.read('+JSON.stringify({file_path:file})+')));',description:'Read the required source'});

for(const ledgerReceipt of [true,false])test('native PTC, '+(ledgerReceipt?'source receipts':'SW folding')+' and installed ACP retain exact source through compression and disable',async()=>{
  const acp=await import(pathToFileURL(acpFile).href),plan=[];
  const host=await startHost({toolMode:'ptc',contextWindow:60000,
    usage:options=>{const inputTokens=Math.ceil(JSON.stringify(options.messages).length/3),outputTokens=60;return {inputTokens,outputTokens,cacheReadTokens:0,totalTokens:inputTokens+outputTokens};},
    workspace:{toolSurface:'full',stepPacing:false,ledgerReceipt,swLedger:true,swEviction:true,swEvictionSteps:3,structuredCalls:true},
    extraMounts:[['dsh-ptc-runtime-node'],[acp.default,{settingsEnabled:false,preset:'balanced',autoTools:true,autoCommand:true,autoNudge:true,maxOverflowRetries:1,modelContextLimit:60000}]],
    script:()=>plan.shift()??[text('本阶段来源已保留。')]});
  try{
    for(let i=0;i<8;i++)await fs.writeFile(path.join(host.cwd,`o${i}.txt`),source(`o${i}`,120));
    for(let i=0;i<14;i++)await fs.writeFile(path.join(host.cwd,`p${i}.txt`),source(`p${i}`,40));
    const agent=await host.createAgent('max');
    plan.push(...Array.from({length:8},(_,i)=>[read(`o${i}.txt`)]),[read('o0.txt')],[text('第一组来源已读取。')]);
    await host.send(agent,'读取 o0.txt 至 o7.txt，再读一次 o0.txt，保留准确来源供下一阶段使用。');
    const root=host.events.find(event=>event.type==='tool/result'&&event.data.message?.content.some(block=>block.text?.includes('o0 row 31')));
    const firstCall=host.events.find(event=>event.type==='assistant/message');assert.ok(root);assert.ok(firstCall);
    plan.push(...Array.from({length:14},(_,i)=>[read(`p${i}.txt`)]),[text('第二组来源已读取。')]);
    await host.send(agent,'现在读取 p0.txt 至 p13.txt，先保留原事件来源，不再修改第一组文件。');
    const before=(await host.command(agent,'detail')).detail;
    if(ledgerReceipt)assert.ok(before.sw.skips['reference-result']>0,'the prior source receipt already removes the duplicate body');
    else assert.ok(before.sw.evicted>0,JSON.stringify({sw:before.sw,hygiene:before.observability.historyHygiene}));
    const liveRoot=agent.session.surface.nodes.map(seq=>agent.session.eventAt(seq)).find(event=>event.type==='tool/result'&&event.data.message?.source?.callId===root.data.message.source.callId);
    assert.ok(liveRoot,'compression uses the current surface result, including a later SW replacement');
    plan.push([tool('run_code',{calls:[{name:'compress',arguments:{content:[{startSeq:firstCall.seq,endSeq:liveRoot.seq,summary:'已通过原生 PTC 读取工作区 o0.txt，文件共 120 行，每行记录来源标签、行序号和 q 正文。原事件包含准确行正文，后续需要逐字内容时须按原事件取回；此摘要仅记录读取动作，不代替原文。'}]}}],description:'Compress the complete earlier source interval'})],[text('已处理指定区间。')]);
    await host.send(agent,'压缩第一份 o0.txt 的完整调用区间，保留之后的事件。');
    assert.ok(host.events.some(event=>event.type==='compaction/summary'),JSON.stringify({end:host.events.findLast(event=>event.type==='turn/end')?.data.reason,
      results:host.events.filter(event=>event.type==='tool/result').slice(-1).map(event=>event.data.message.content),
      compactions:host.events.filter(event=>event.type.startsWith('compaction/')).map(event=>({type:event.type,data:event.data}))}));
    await host.command(agent,'off');assert.ok(host.ctx.tools.get('work_recall',agent));
    plan.push([tool('run_code',{code:'console.log(JSON.stringify(await tools.work_recall('+JSON.stringify({kind:'event',seq:root.seq,offset:0,maxChars:64000})+')));',description:'Recover the original source event without another file read'})],[text('已取回原始正文。')]);
    await host.send(agent,`从 event:${root.seq} 取回 o0.txt 原文，保持 Work Evidence 关闭，不重新读取文件。`);
    assert.ok(requestText(host.requests.at(-1)).includes('o0 row 31'));
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read').length,23);
    assert.equal(host.auxiliaryRequests.length,0);
    assert.equal(host.events.filter(event=>event.type==='tool/result'&&event.data.message?.isError).length,0,
      JSON.stringify(host.events.filter(event=>event.type==='tool/result'&&event.data.message?.isError).map(event=>event.data.message.content)));
    console.log('acpCombination',JSON.stringify({nativePtc:true,ledgerReceipt,swEvicted:before.sw.evicted,receiptAlreadyReduced:before.sw.skips['reference-result']??0,acpCheckpoint:true,auxiliaryModelCalls:0,sourceSeq:root.seq,liveCompressionEnd:liveRoot.seq,recallAfterDisable:true,nativeReads:23}));
  }finally{await host.close();}
});
