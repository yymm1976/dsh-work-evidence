import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText,lastUserText} from './helpers/host.mjs';

const NOTICE='[work-evidence] 上一条答复包含阶段摘要';

test('completion notice continues a turn that stopped at an actionable stage summary', async()=>{
  const host=await startHost({workspace:{completionNotice:true},script:(_o,n)=>n===1?[text('已完成第一部分。\n\n## 阶段摘要\n- 已改 a.txt\n下一步：修改 b.txt')]:[text('全部完成。')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'修改 a.txt 和 b.txt');
    assert.equal(host.requests.length,2,'the notice must trigger exactly one continuation request');
    assert.ok(lastUserText(host.requests[1]).includes(NOTICE));
  }finally{await host.close();}
});

test('completion notice stays silent when the next step is none or the user asked to pause', async()=>{
  for(const [request,answer] of [
    ['修改 a.txt','## 阶段摘要\n已完成。\n下一步：无'],
    ['先只汇报，不要继续','## 阶段摘要\n已检查。\n下一步：修改 b.txt'],
  ]){
    const host=await startHost({script:()=>[text(answer)]});
    try{
      const agent=await host.createAgent('max');
      await host.send(agent,request);
      assert.equal(host.requests.length,1,request);
    }finally{await host.close();}
  }
});

test('completion notice is opt-in and adds no request by default', async()=>{
  const host=await startHost({script:()=>[text('## 阶段摘要\n下一步：修改 b.txt')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'修改 a.txt 和 b.txt');
    assert.equal(host.requests.length,1);
  }finally{await host.close();}
});

test('completion notice can be switched off explicitly after opt-in', async()=>{
  const host=await startHost({workspace:{completionNotice:false},script:()=>[text('## 阶段摘要\n下一步：修改 b.txt')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'修改 a.txt 和 b.txt');
    assert.equal(host.requests.length,1);
  }finally{await host.close();}
});

test('final JSON guard asks once for a syntax repair and accepts the repaired answer', async()=>{
  const host=await startHost({script:(_o,n)=>n===1?[text('```json\n{"count": 3,}\n```')]:[text('```json\n{"count":3}\n```')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'统计行数，最终只返回 JSON 代码块。');
    assert.equal(host.requests.length,2);
    assert.ok(lastUserText(host.requests[1]).includes('无法严格解析'));
  }finally{await host.close();}
});

test('quality review runs only under Ultra, steers on a gap and re-reviews the revised answer', async()=>{
  let reviews=0;
  const auxiliary=options=>{
    reviews++;
    const payload=JSON.parse(options.messages.at(-1).content.map(block=>block.text).join(''));
    const issues=reviews===1?[{kind:'requirement',detail:'b.txt 未修改',evidence:[payload.request.seq,payload.answer.seq]}]:[];
    return [text(JSON.stringify({issues}))];
  };
  const host=await startHost({workspace:{qualityReview:true},auxiliary,script:(_o,n)=>[text(n===1?'已修改 a.txt 和 b.txt。':'已补充说明。')]});
  try{
    const max=await host.createAgent('max');
    await host.send(max,'修改 a.txt 和 b.txt');
    assert.equal(reviews,0,'aggressive mode must not run the quality review');
    const ultra=await host.createAgent('ultra');
    await host.send(ultra,'修改 a.txt 和 b.txt');
    assert.equal(reviews,2,'original answer and revised answer are each reviewed once');
    assert.ok(lastUserText(host.requests.at(-1)).includes('最终答复可能遗漏'));
    const requestsBefore=host.requests.length;
    await host.send(ultra,'再修改 c.txt');
    assert.equal(reviews,3,'a later request in the same session is still reviewed');
    assert.equal(host.requests.length,requestsBefore+1);
  }finally{await host.close();}
});

for(const [efforts,choice,expected]of [
  [['low','high','max'],'auto','low'],[['max'],'auto','max'],[['low','high','max'],'inherit','max'],
  [['low','high','max'],'high','high'],[['max'],'low',null],
])test(`review effort ${choice} uses declared ${efforts.join('/')} without changing the main request`,async()=>{
  const host=await startHost({efforts,workspace:{qualityReview:true,qualityReviewEffort:choice},
    script:()=>[text('当前交付已完成。')],auxiliary:()=>[text('{"issues":[]}')]});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'修改 a.txt 并报告交付内容。');
    assert.ok(host.requests.every(request=>request.reasoningEffort==='max'));
    const detail=(await host.command(agent,'detail')).detail.qualityReview;
    assert.equal(detail.effort.configured,choice);
    if(expected){
      assert.equal(host.auxiliaryRequests.length,1);assert.equal(host.auxiliaryRequests[0].reasoningEffort,expected);
      assert.equal(detail.effort.last.selected,choice==='inherit'?'ultra':expected);assert.equal(detail.verdict,'no-supported-gap');
      const feature=(await host.command(agent,'feature qualityReviewEffort')).features[0];
      assert.equal(feature.effect.status,'applied');assert.equal(feature.effect.lastReason,'review-options-selected');
    }else{
      assert.equal(host.auxiliaryRequests.length,0);assert.equal(detail.status,'unavailable');
      assert.equal(detail.process.last.reason,'review-effort-not-declared');assert.equal(detail.process.last.dispatched,false);
      assert.equal(detail.paused,null);
      const feature=(await host.command(agent,'feature qualityReview')).features[0];
      assert.equal(feature.status,'blocked');assert.ok(feature.reasons.includes('review-effort-not-declared'));
      const effort=(await host.command(agent,'feature qualityReviewEffort')).features[0];
      assert.equal(effort.effect.status,'not-applied');assert.equal(effort.effect.unavailable,1);
      assert.equal(effort.effect.lastReason,'review-effort-not-declared');
    }
  }finally{await host.close();}
});

test('a write after a read marks the old observation stale without prompting a reread', async()=>{
  const host=await startHost({script:(_o,n)=>n===1?[tool('read',{file_path:'a.txt'})]:n===2?[tool('write',{file_path:'a.txt',content:'new\n'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'old\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'把 a.txt 改为 new');
    assert.equal(host.requests.length,3);
    assert.ok(!host.requests.some(request=>requestText(request).includes('工程状态已失效')),'successful own writes do not create a reread requirement');
    const status=await host.command(agent,'detail');
    assert.equal(status.detail.state.observations[0].stale,true);
    assert.equal(status.detail.state.mutations.length,1);
    assert.equal(await fs.readFile(path.join(host.cwd,'a.txt'),'utf8'),'new\n');
  }finally{await host.close();}
});

test('a large read result is pruned in later requests and stays recoverable', async()=>{
  const big=Array.from({length:400},(_,i)=>`line ${String(i).padStart(4,'0')} `+'x'.repeat(90)).join('\n');
  const host=await startHost({script:(_o,n)=>n===1?[tool('read',{file_path:'big.txt'})]:n===2?[tool('read',{file_path:'small.txt'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'big.txt'),big);
    await fs.writeFile(path.join(host.cwd,'small.txt'),'small\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 big.txt 和 small.txt 后总结');
    const [, second, third]=host.requests.map(requestText);
    const status=await host.command(agent,'detail');
    assert.equal(status.metrics.contextProtocolPrunedResults,1);
    assert.ok(third.length<second.length/2,'the next request carries a much shorter history');
    assert.ok(third.includes('line 0000')&&third.includes('line 0399'),'head and tail of the result stay visible');
    assert.ok(!third.includes('line 0200'),'the middle is removed from the request');
    assert.match(third,/seq \d+|work_recall/u,'the pruned body names a recovery address');
  }finally{await host.close();}
});

test('a completed turn with writes but no work_report leaves a continuation note', async()=>{
  const host=await startHost({script:(_o,n)=>n===1?[tool('write',{file_path:'a.txt',content:'1\n'})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'写 a.txt');
    await new Promise(resolve=>setTimeout(resolve,300));
    const dir=path.join(host.cwd,'.dsh','work-evidence');
    const notes=(await fs.readdir(dir)).filter(name=>name.endsWith('-interrupted.md'));
    assert.equal(notes.length,1);
  }finally{await host.close();}
});

test('work_recall returns the exact original text that pruning removed', async()=>{
  const big=Array.from({length:400},(_,i)=>`line ${String(i).padStart(4,'0')} `+'x'.repeat(90)).join('\n');
  let recalled=null,locator=null;
  const host=await startHost({script:(options,n)=>{
    if(n===1)return [tool('read',{file_path:'big.txt'})];
    if(n===2)return [tool('read',{file_path:'small.txt'})];
    if(n===3){
      const body=requestText(options);
      const match=/work_recall\(\{seq:(\d+),offset:(\d+)\}\)/u.exec(body);
      locator=match?{seq:Number(match[1]),offset:Number(match[2])}:null;
      return locator?[tool('work_recall',{...locator,kind:'output'})]:[text('没有取回地址。')];
    }
    if(n===4){recalled=options.messages.at(-1);return [text('完成。')];}
    return [text('完成。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'big.txt'),big);
    await fs.writeFile(path.join(host.cwd,'small.txt'),'small\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 big.txt 和 small.txt 后总结');
    assert.ok(locator,'the shortened history names a work_recall address');
    const value=JSON.parse(recalled.content.map(block=>block.text??'').join(''));
    assert.equal(value.status,'observed');
    const body=JSON.stringify(value);
    const omittedStart=big.indexOf('line 0040');
    assert.ok(body.includes('line 0041'),'recall starts inside the omitted middle');
    assert.ok(omittedStart>0);
  }finally{await host.close();}
});

test('work_status keeps a disabled session disabled until a user command enables it', async()=>{
  const host=await startHost({script:(_o,n)=>n===1?[tool('work_status',{config:{noSuchSetting:true}})]:n===2?[tool('work_status',{session_enabled:true})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');
    await host.command(agent,'off');
    assert.equal((await host.command(agent,'status')).effective,false);
    await host.send(agent,'检查插件状态');
    const results=host.events.filter(event=>event.type==='tool/result').map(event=>event.data.message.content.map(block=>block.text??'').join(''));
    assert.match(results[0],/Unknown work-evidence setting|error/iu);
    assert.equal((await host.command(agent,'status')).effective,false);
    await host.command(agent,'on');
    assert.equal((await host.command(agent,'status')).effective,true);
  }finally{await host.close();}
});

// A small window forces native compaction after a few large reads.
const compactionHost=(stubSummary,summaries)=>startHost({
  contextWindow:30000,
  workspace:{stubSummary},
  extraMounts:[['dsh-compaction-basic',{thresholdRatio:0.5,retainTokens:2000,maxTokens:4000,headroomTokens:4000}]],
  usage:options=>{
    const chars=JSON.stringify(options.messages).length;
    return {inputTokens:Math.ceil(chars/3),outputTokens:50,cacheReadTokens:0,totalTokens:Math.ceil(chars/3)+50};
  },
  auxiliary:options=>{summaries.push(options);return [text('摘要：已读取 f0 至 f3。')];},
  script:(_o,n)=>n<=4?[tool('read',{file_path:`f${n-1}.txt`})]:[text('完成。')],
});

for(const stubSummary of [false,true]){
  test(`native compaction ${stubSummary?'uses the deterministic stub':'extends the host summary'} and keeps continuation sources`, async()=>{
    const summaries=[];
    const host=await compactionHost(stubSummary,summaries);
    try{
      for(let i=0;i<4;i++)await fs.writeFile(path.join(host.cwd,`f${i}.txt`),Array.from({length:150},(_,j)=>`f${i} ${j} `+'y'.repeat(60)).join('\n'));
      const agent=await host.createAgent('max');
      await host.send(agent,'依次读取 f0.txt 到 f3.txt，保留文件名 f0.txt 的原话');
      const summary=host.events.find(event=>event.type==='compaction/summary');
      assert.ok(summary,'compaction ran');
      const body=JSON.stringify(summary.data.summary);
      assert.ok(body.includes('[Work Evidence continuation sources]'));
      assert.ok(body.includes('保留文件名 f0.txt 的原话'),'the original user request is kept verbatim');
      if(stubSummary)assert.equal(summaries.length,0,'stub mode makes no summary model call');
      else assert.ok(summaries.length>=1,'native mode calls the summarizer');
      const status=await host.command(agent,'detail');
      assert.equal(status.detail.compression.nativeHandoff.committed>=1,true);
    }finally{await host.close();}
  });
}

// Repeated full reads of one file: P0 receipts (default on) must replace later
// duplicate bodies with references, and that must lower total prompt size.
async function repeatedReads(workspace){
  let promptTokens=0;
  const host=await startHost({workspace,
    usage:options=>{const tokens=Math.ceil(JSON.stringify(options.messages).length/3),read=Math.floor(tokens*0.9);promptTokens+=tokens;
      return {inputTokens:tokens-read,outputTokens:40,cacheReadTokens:read,totalTokens:tokens+40};},
    script:(_o,n)=>n<=12?[tool('read',{file_path:n%2?'same.txt':`other${n}.txt`})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'same.txt'),Array.from({length:300},(_,j)=>`row ${j} `+'z'.repeat(110)).join('\n'));
    for(let i=0;i<=12;i++)await fs.writeFile(path.join(host.cwd,`other${i}.txt`),Array.from({length:60},(_,j)=>`o${i} ${j} `+'w'.repeat(80)).join('\n'));
    const agent=await host.createAgent('max');
    await host.send(agent,'反复读取文件后总结');
    const status=await host.command(agent,'detail');
    return {promptTokens,receipts:status.detail.observability.features.receipt?.applied??0};
  }finally{await host.close();}
}

test('ledger receipts replace repeated read bodies and cut prompt size', async()=>{
  const on=await repeatedReads({contextProtocol:false});
  const off=await repeatedReads({contextProtocol:false,ledgerReceipt:false});
  assert.ok(on.receipts>=4,'later duplicate reads are replaced');
  assert.equal(off.receipts,0);
  assert.ok(on.promptTokens<off.promptTokens*0.7,`prompt tokens ${on.promptTokens} vs ${off.promptTokens}`);
});

test('compaction omits continuation sources that cannot fit and still commits the host summary', async()=>{
  const summaries=[];
  const longRequest='请依次读取 f0.txt 到 f13.txt 并总结。约束：'+'保留每个文件的原始行号与内容摘要，不要修改任何文件。'.repeat(60);
  const host=await startHost({
    contextWindow:30000,
    // A large retained tail leaves small spans whose sources outweigh them.
    extraMounts:[['dsh-compaction-basic',{thresholdRatio:0.5,retainTokens:12500,maxTokens:4000,headroomTokens:4000}]],
    usage:options=>{const tokens=Math.ceil(JSON.stringify(options.messages).length/3);return {inputTokens:tokens,outputTokens:50,cacheReadTokens:0,totalTokens:tokens+50};},
    auxiliary:options=>{summaries.push(options);return [text('## 摘要\n'+'- 已读取文件并记录行号与内容。\n'.repeat(60))];},
    script:(_o,n)=>n<=14?[tool('read',{file_path:`f${n-1}.txt`})]:[text('完成。')],
  });
  try{
    for(let i=0;i<14;i++)await fs.writeFile(path.join(host.cwd,`f${i}.txt`),Array.from({length:60},(_,j)=>`f${i} ${j} `+'y'.repeat(60)).join('\n'));
    const agent=await host.createAgent('max');
    await host.send(agent,longRequest);
    const handoff=(await host.command(agent,'detail')).detail.compression.nativeHandoff;
    assert.ok((handoff.sourcesOmitted??0)>=1,'oversized sources are left out instead of failing the commit');
    assert.equal(summaries.length,handoff.nativeSummaryCalls);
    const ends=host.events.filter(event=>event.type==='compaction/end');
    assert.ok(ends.length>=1);
    assert.ok(ends.filter(event=>!event.data.error).length>=ends.length-(handoff.skippedSmallSpans??0),'every summary call that was paid for commits');
    assert.equal(host.events.findLast(event=>event.type==='turn/end')?.data?.reason?.kind,'completed');
  }finally{await host.close();}
});
