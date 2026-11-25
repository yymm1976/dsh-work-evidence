import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

const price=[{provider:'scripted',model:'scripted-model',input:0.15,cacheRead:0.003,output:0.6,currency:'USD'}];
const usage=options=>{const tokens=Math.ceil(JSON.stringify(options.messages).length/3),cached=Math.floor(tokens*.85);
  return {inputTokens:tokens-cached,cacheReadTokens:cached,cacheWriteTokens:0,outputTokens:60,totalTokens:[tokens,60].reduce((sum,n)=>sum+n,0)};};

test('compact surface admits explicit read-only recall on the first request',async()=>{
  for(const request of [
    seq=>'只调用 work_recall，参数 seq='+seq+'。不要修改文件。',
    seq=>'只从历史事件 '+seq+' 取回上次的原始工具输出。不要修改文件。',
  ]){
    let seq;
    const host=await startHost({pluginConfig:{toolSurface:'compact',stepPacing:false},script:(_options,n)=>{
      if(n===1)return [tool('read',{file_path:'reading.md'})];
      if(n===3)return [tool('work_recall',{kind:'output',seq})];
      return [text('Done.')];
    }});
    try{
      const file=path.join(host.cwd,'reading.md');
      await fs.writeFile(file,'Original reading.\n');
      const agent=await host.createAgent();
      await host.send(agent,'只读查看 reading.md，不修改或执行程序。');
      seq=host.events.find(event=>event.type==='tool/result').seq;
      assert.equal(host.requests[0].tools.some(item=>item.name==='work_recall'),false);
      await fs.writeFile(file,'New reading.\n');
      await host.send(agent,request(seq));
      const names=host.requests[2].tools.map(item=>item.name);
      assert.ok(names.includes('work_recall'));
      assert.ok(!names.includes('work_exec'));
      const result=host.events.filter(event=>event.type==='tool/result').at(-1).data.message;
      assert.equal(result.isError,false);
      const evidence=JSON.parse(result.content[0].text);
      assert.ok(evidence.historical);
      assert.match(evidence.text,/Original reading\./u);
      assert.doesNotMatch(evidence.text,/New reading\./u);
    }finally{await host.close();}
  }
});

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

test('unprefixed PowerShell matches preserve the complete result and recover its original text',async()=>{
  const command="Select-String -LiteralPath (Join-Path (Get-Location) 'lookup.txt') -Pattern 'sample' | ForEach-Object { $_.ToString() }";
  const host=await startHost({workspace:{contextProtocol:false,historyHygiene:true,stepPacing:false},
    script:(_options,n)=>n===1?[tool('pwsh',{command,description:'Locate samples'})]:[text('done')]});
  try{
    const lines=Array.from({length:40},(_,index)=>'sample '+index);
    await fs.writeFile(path.join(host.cwd,'lookup.txt'),lines.join('\n'));
    const agent=await host.createAgent();
    await host.send(agent,'Find the lines that contain sample.');
    const result=host.events.find(event=>event.type==='tool/result');
    const canonical=result.data.message.content[0].text;
    const view=host.requests[1].messages.find(message=>message.id===result.data.message.id).content[0].text;
    const [header,...rows]=view.split('\n');
    assert.equal(header,'[Select-String path prefix: '+host.cwd+path.sep+']');
    assert.deepEqual(rows.filter(row=>row.trim()).map(row=>row.trimEnd()),lines.map((line,index)=>`lookup.txt:${index+1}:${line}`));
    assert.equal(rows.map(row=>row.trim()?host.cwd+path.sep+row:row).join('\n'),canonical);
    assert.ok(canonical.length-view.length>=512);
    await host.send(agent,'请给出原始工具输出。');
    const raw=host.requests[2].messages.find(message=>message.id===result.data.message.id);
    assert.equal(raw.content[0].text,canonical);
  }finally{await host.close();}
});

test('a FullName inventory shares its workspace prefix and can show the exact original output',async()=>{
  const command='Get-ChildItem -LiteralPath . -File | Select-Object FullName | Format-Table -AutoSize';
  const host=await startHost({workspace:{contextProtocol:false,historyHygiene:true,stepPacing:false},
    script:(_options,n)=>n===1?[tool('pwsh',{command,description:'List files'})]:[text('done')]});
  try{
    const files=Array.from({length:40},(_,index)=>`sample ${index} é.txt`);
    await Promise.all(files.map(file=>fs.writeFile(path.join(host.cwd,file),'data')));
    const agent=await host.createAgent();
    await host.send(agent,'List the sample files and report their paths.');
    const result=host.events.find(event=>event.type==='tool/result');
    const canonical=result.data.message.content[0].text;
    const view=host.requests[1].messages.find(message=>message.id===result.data.message.id).content[0].text;
    const prefix=host.cwd+path.sep;
    const heading=`[FullName path prefix: ${prefix}]\n`;
    assert.ok(view.startsWith(heading));
    const table=view.slice(heading.length);
    const header=/^(?:\r?\n)*FullName[ \t]*\r?\n-{8}[ \t]*\r?\n/u.exec(table)?.[0];
    assert.ok(header);
    const rows=table.slice(header.length).split('\n');
    assert.deepEqual(rows.filter(row=>row.trim()).map(row=>row.trimEnd()).sort(),files.toSorted());
    assert.equal(header+rows.map(row=>row.trim()?prefix+row:row).join('\n'),canonical);
    assert.ok(canonical.length-view.length>=512);
    await host.send(agent,'请给出原始工具输出。');
    const raw=host.requests[2].messages.find(message=>message.id===result.data.message.id);
    assert.equal(raw.content[0].text,canonical);
  }finally{await host.close();}
});

test('the next request sees an exact grep match beyond the native head preview',async()=>{
  const host=await startHost({workspace:{contextProtocol:false,historyHygiene:true,stepPacing:false},
    script:(_options,n)=>n===1?[tool('grep',{pattern:'winter_sample|spring_sample',path:'.'})]:[text('done')]});
  try{
    const prefix='a'.repeat(2300);
    await fs.writeFile(path.join(host.cwd,'long.txt'),prefix+' winter_sample is beside its actual label');
    await fs.writeFile(path.join(host.cwd,'short.txt'),'spring_sample is a separate complete line');
    const agent=await host.createAgent();
    await host.send(agent,'Find the two samples and report their labels.');
    const result=host.events.find(event=>event.type==='tool/result');
    const canonical=result.data.message.content[0].text;
    assert.match(canonical,/Found 2 matches/u);
    assert.match(canonical,/a{1000}.*\(line truncated\)/u);
    assert.doesNotMatch(canonical,/winter_sample/u);
    const view=host.requests[1].messages.find(message=>message.role==='tool').content[0].text;
    assert.match(view,/Line 1: …a+ winter_sample is beside its actual label \(matched excerpt; line truncated\)/u);
    assert.match(view,/short\.txt\nLine 1: spring_sample is a separate complete line/u);
    assert.ok(view.length+512<canonical.length);
    await host.send(agent,'请给出原始工具输出。');
    const raw=host.requests[2].messages.find(message=>message.id===result.data.message.id);
    assert.equal(raw.content[0].text,canonical);
  }finally{await host.close();}
});

