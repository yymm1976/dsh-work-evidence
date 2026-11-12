import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

const price=[{provider:'scripted',model:'scripted-model',input:0.15,cacheRead:0.003,output:0.6,currency:'USD'}];
const usage=options=>{const tokens=Math.ceil(JSON.stringify(options.messages).length/3),cached=Math.floor(tokens*.85);
  return {inputTokens:tokens-cached,cacheReadTokens:cached,cacheWriteTokens:0,outputTokens:60,totalTokens:[tokens,60].reduce((sum,n)=>sum+n,0)};};
async function commandHistory(workspace,contextWindow=60000){
  const host=await startHost({workspace:{contextProtocol:false,swLedger:false,swEviction:false,projectionPricing:price,...workspace},contextWindow,usage,
    script:(_o,n)=>n<=14?[tool('pwsh',{command:n%2?"1..400 | % { 'same output line ' + $_ + ' ' + ('w'*60) }":
      "1..300 | % { 'unique line ' + $_ + ' ' + ('v'*60) }",description:'list'})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'读取已有输出后总结');
    const status=await host.command(agent,'detail'),sizes=host.requests.map(o=>requestText(o).length);
    return {status,sizes,events:host.events,body:host.requests.map(requestText).join('\n'),
      total:sizes.reduce((a,b)=>a+b,0)};
  }finally{await host.close();}
}

test('historyHygiene reduces old successful command output only when enabled',async()=>{
  const off=await commandHistory({historyHygiene:false}),on=await commandHistory({});
  console.log('measurement',JSON.stringify({feature:'historyHygiene',onChars:on.total,offChars:off.total}));
  assert.ok(on.total<off.total*.7,`${on.total} / ${off.total}`);
  assert.ok(on.body.includes('work_recall'),'removed text remains addressable');
  assert.equal(on.events.filter(e=>e.type==='compaction/summary').length,0,'request views need no summary request');
  assert.equal(off.status.observability.features.historyOutput?.applied??0,0);
  assert.ok(on.status.observability.features.historyOutput?.applied>0);
});

test('SW evicts exact duplicate outputs under context pressure and respects its switches and age',async()=>{
  const off=await commandHistory({swLedger:true,swEviction:false});
  const on=await commandHistory({swLedger:true,swEviction:true});
  const old=await commandHistory({swLedger:true,swEviction:true,swEvictionSteps:50});
  const noLedger=await commandHistory({swLedger:false,swEviction:true});
  assert.equal(off.status.sw.evicted,0);assert.ok(on.status.sw.evicted>0);
  assert.ok(on.total<off.total,`${on.total} / ${off.total}`);
  assert.equal(old.status.sw.evicted,0,'outputs younger than the configured age stay visible');
  assert.equal(noLedger.status.sw.observations,0);assert.equal(noLedger.status.sw.evicted,0);
  assert.ok(on.status.sw.charsSaved>4096);
  console.log('measurement',JSON.stringify({feature:'swEviction',onChars:on.total,offChars:off.total,evictions:on.status.sw.evicted,charsSaved:on.status.sw.charsSaved}));
});

test('a full-output request prevents a queued persistent history replacement',async()=>{
  for(const requested of [false,true]){
    const host=await startHost({workspace:{contextProtocol:true,historyHygiene:false,swLedger:false,swEviction:false},
      script:(_o,n)=>n===1?[tool('read',{file_path:'big.txt'})]:n===2?[tool('read',{file_path:'small.txt'})]:[text('done')]});
    try{
      await fs.writeFile(path.join(host.cwd,'big.txt'),Array.from({length:400},(_,i)=>'line '+i+' '+('q'.repeat(90))).join('\n'));
      await fs.writeFile(path.join(host.cwd,'small.txt'),'small');
      const agent=await host.createAgent();await host.send(agent,(requested?'Keep full output. ':'')+'Read big.txt and small.txt and summarize.');
      const replacements=host.events.filter(event=>event.type==='tool/result'&&event.surfaceOp?.op==='replace');
      assert.equal(replacements.length,requested?0:1,'ordinary requests must still prune; full-output requests must preserve the body');
    }finally{await host.close();}
  }
});

