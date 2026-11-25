import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,reasoning,requestText} from './helpers/host.mjs';

const BODY=Array.from({length:80},(_,index)=>`line ${index+1}: the quick brown fox jumps over the lazy dog.`).join('\n')+'\n';
const messageOf=event=>event?.data?.message??event?.data;
const textOf=message=>(message?.content??[]).filter(block=>block?.type==='text').map(block=>block.text??'').join('\n');

async function stateInvalidation(workspace,firstCall={tool:'grep',arguments:{path:'.',pattern:'needle'}}){
  const host=await startHost({workspace,script:async(_options,index)=>{
    if(index===1)return [tool(firstCall.tool,firstCall.arguments)];
    if(index===2)return [tool('write',{file_path:'a.txt',content:'changed\n'})];
    return [text('完成。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'needle one\nline2\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'查找 needle 后更新 a.txt');
    return {agent,host,detail:await host.command(agent,'detail'),body:host.requests.map(requestText).join('\n')};
  }finally{await host.close();}
}

test('a stale search reaches the model under the default ledger combination',async()=>{
  const observed=await stateInvalidation({});
  assert.ok(observed.detail.detail.state.searches.some(search=>search.stale),'the write must mark the recorded search stale');
  assert.ok(observed.body.includes('旧搜索命中')||observed.body.includes('stale search'),
    'the default combination must not silently drop a recorded search invalidation');
  assert.ok(observed.body.includes('0 个旧源码观察和'),
    'keeping a stale search notice must drop the authored-write observation count, not report it as a reread requirement');
  const notice=observed.body.slice(observed.body.indexOf('工程状态已失效'));
  assert.ok(notice.includes('只有后续判断依赖这些搜索事实时'),
    'search invalidation only asks for a new search when a later decision needs those facts');
  assert.ok(!notice.includes('按当前文件核对三类断言'),
    'stale search hits do not establish a need for a source and caller review');
});

test('the legacy notice still reports invalidation when the ledger card is disabled',async()=>{
  const observed=await stateInvalidation({ledgerUnresolved:false});
  assert.ok(observed.body.includes('工程状态已失效'));
});

test('an authored write without a stale search clears the notice and asks for no reread',async()=>{
  const observed=await stateInvalidation({},{tool:'read',arguments:{file_path:'a.txt'}});
  assert.ok(!observed.body.includes('工程状态已失效'),
    'a write that only invalidates its own earlier read must not leave a state notice behind');
  assert.ok(!observed.body.includes('changed at its source'),
    'a known-write invalidation must not be reported as an unresolved reread requirement');
});

test('a write invalidates only searches whose filters could include the written file',async()=>{
  const host=await startHost({script:async(_options,index)=>{
    if(index===1)return [
      tool('glob',{pattern:'**/*.md'}),
      tool('glob',{pattern:'**/{checks,specs}/**/*'}),
      tool('grep',{pattern:'needle',include:'*.md'}),
    ];
    if(index===2)return [tool('write',{file_path:'worker.py',content:'needle changed\n'})];
    if(index===3)return [
      tool('glob',{pattern:'**/*.py'}),
      tool('grep',{pattern:'needle',path:'worker.py',include:'*.md'}),
    ];
    if(index===4)return [tool('write',{file_path:'worker.py',content:'changed\n'})];
    return [text('完成。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'worker.py'),'needle\n');
    await fs.writeFile(path.join(host.cwd,'guide.md'),'needle\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'查找 needle 后更新 worker.py');
    const state=(await host.command(agent,'detail')).detail.state;
    const stale=state.searches.filter(search=>search.stale).map(search=>[search.tool,search.pattern,search.scope]);
    assert.deepEqual(stale.sort(),[['glob','**/*.py','.'],['grep','needle','worker.py']]);
    assert.equal(state.searches.length,5);
    assert.equal(state.counts.stateNotices,1);
    assert.doesNotMatch(requestText(host.requests[2]),/工程状态已失效/u);
    assert.match(requestText(host.requests[4]),/2 个旧搜索命中/u);
  }finally{await host.close();}
});

test('stageWorkingSet is enabled by default but reports no reachable consumer instead of ready',async()=>{
  const host=await startHost({script:async()=>[text('完成。')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 a.txt 并报告');
    let feature=(await host.command(agent,'feature stageWorkingSet')).features[0];
    assert.equal(feature.configured,true);
    assert.notEqual(feature.status,'ready','projection is off, work_state is hidden and executionTriage records executions');
    assert.ok(feature.reasons.includes('inactive-without-reachable-consumer'));
    await host.command(agent,'feature stageWorkingSet off');
    feature=(await host.command(agent,'feature stageWorkingSet')).features[0];
    assert.equal(feature.configured,false);
    assert.equal(feature.status,'off');
  }finally{await host.close();}
});

test('stageWorkingSet stays ready when a consumer is reachable',async()=>{
  for(const workspace of [
    {stageWorkingSet:true,toolSurface:'full'},
    {stageWorkingSet:true,executionTriage:false},
    {stageWorkingSet:true,requestProjection:true,projectionRestore:true},
  ]){
    const host=await startHost({workspace,script:async()=>[text('完成。')]});
    try{
      const agent=await host.createAgent('max');
      await host.send(agent,'读取 a.txt 并报告');
      const feature=(await host.command(agent,'feature stageWorkingSet')).features[0];
      assert.ok(!feature.reasons.includes('inactive-without-reachable-consumer'),JSON.stringify(workspace));
    }finally{await host.close();}
  }
});

test('the ledger omits recall pointers for private reasoning and visible assistant text',async()=>{
  const conclusion='采用方案B继续实现该功能并保留旧入口';
  const host=await startHost({script:async(_options,index)=>index===1?
    [reasoning('结论：'+conclusion),tool('read',{file_path:'a.txt'})]:index===2?
      [text('结论：已有文件正文可供下一步使用'),tool('read',{file_path:'a.txt'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'original\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 a.txt 并决定实现方案');
    const cards=host.events.filter(event=>event.type==='user/message'&&
      String(messageOf(event)?.source?.kind??'')==='work-evidence-ledger');
    const card=cards.map(event=>textOf(messageOf(event))).find(value=>value.includes('work_recall')||value.includes(conclusion));
    assert.equal(card,undefined);
  }finally{await host.close();}
});

test('ledgerReceipt follows evidenceViews instead of shortening behind a blocked view',async()=>{
  async function twice(workspace){
    const host=await startHost({workspace,script:async(_options,index)=>index<=2?
      [tool('read',{file_path:'a.txt'})]:[text('完成。')]});
    try{
      await fs.writeFile(path.join(host.cwd,'a.txt'),BODY);
      const agent=await host.createAgent('max');
      await host.send(agent,'读取 a.txt 两次并报告');
      return host.events.filter(event=>event.type==='tool/result').map(event=>textOf(messageOf(event)));
    }finally{await host.close();}
  }
  const enabled=await twice({});
  assert.ok(enabled.some(value=>value.includes('[work-evidence ledger receipt]')),'the default path shortens an unchanged repeat read');
  const disabled=await twice({evidenceViews:false});
  assert.ok(!disabled.some(value=>value.includes('[work-evidence ledger receipt]')),
    'disabling evidenceViews must not leave receipts active while the panel calls the reference view blocked');
  assert.equal(disabled.filter(value=>value.includes('the quick brown fox')).length,2);
});

test('an explicit reference view cannot bypass disabled evidenceViews receipts',async()=>{
  const host=await startHost({workspace:{toolSurface:'full',evidenceViews:false},script:async(_options,index)=>index<=2?
    [tool('project_evidence',{mode:'read',files:[{path:'a.txt'}],responseView:'reference-if-visible'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),BODY);
    const agent=await host.createAgent('max');
    await host.send(agent,'按参考视图读取 a.txt 两次');
    const results=host.events.filter(event=>event.type==='tool/result').map(event=>textOf(messageOf(event)));
    assert.ok(!results.some(value=>value.includes('[work-evidence ledger receipt]')),
      'an explicit reference-if-visible request must not shorten a body while evidenceViews is blocked');
    assert.equal(results.filter(value=>value.includes('the quick brown fox')).length,2,
      'both explicit reads must return the requested full body');
  }finally{await host.close();}
});

test('a truncated batch read is never receipted as a visible complete window',async()=>{
  const body=Array.from({length:60},(_,index)=>'batch row '+index+' '+('z'.repeat(100))).join('\n')+'\n';
  const host=await startHost({workspace:{toolSurface:'full'},script:async(_options,index)=>index===1?
    [tool('project_evidence',{files:[{path:'a.txt'},{path:'b.txt'}],maxChars:2000})]:
    index===2?[tool('read',{file_path:'a.txt'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),body);
    await fs.writeFile(path.join(host.cwd,'b.txt'),body);
    const agent=await host.createAgent('max');
    await host.send(agent,'批量读取两个文件，然后重新读取 a.txt');
    const results=host.events.filter(event=>event.type==='tool/result').map(event=>textOf(messageOf(event)));
    const second=results.at(-1);
    assert.ok(!second.includes('[work-evidence ledger receipt]'),'a budget-truncated batch body is not a complete visible receipt');
    assert.ok(second.includes('batch row 59'),'the subsequent read delivers the requested body');
  }finally{await host.close();}
});

test('an incomplete evidence body stays re-readable instead of receiving a receipt',async()=>{
  const host=await startHost({workspace:{toolSurface:'full'},script:async(_options,index)=>index===1?
    [tool('project_evidence',{files:[{path:'a.txt'}]})]:
    index===2?[tool('read',{file_path:'a.txt'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'short\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 a.txt，再重新读取同一文件。');
    const results=host.events.filter(event=>event.type==='tool/result').map(event=>textOf(messageOf(event)));
    const secondEvidence=results.at(-2),secondRead=results.at(-1);
    assert.match(secondEvidence,/rangeComplete/u);
    assert.ok(!secondRead.includes('[work-evidence ledger receipt]'));
    assert.match(secondRead,/short/u);
  }finally{await host.close();}
});

test('a budget-truncated single source is never receipted as a visible complete window',async()=>{
  const body=Array.from({length:80},(_,index)=>'single row '+index+' '+('z'.repeat(100))).join('\n')+'\n';
  const host=await startHost({workspace:{toolSurface:'full'},script:async(_options,index)=>index===1?
    [tool('project_evidence',{mode:'read',files:[{path:'a.txt'}],maxChars:2000})]:
    [text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),body);
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 a.txt。');
    const result=host.events.filter(event=>event.type==='tool/result').map(event=>textOf(messageOf(event))).at(-1);
    assert.match(result,/single row 0/u);
    assert.ok(!result.includes('[work-evidence ledger receipt]'),'an incomplete source remains body-bearing and is never replaced by a receipt');
  }finally{await host.close();}
});

test('a new user request clears the prior source continuation',async()=>{
  const host=await startHost({workspace:{toolSurface:'full'},script:(_options,index)=>index===1
    ?[tool('project_evidence',{mode:'read',files:[{path:'a.txt'},{path:'b.txt'}],maxChars:2000})]
    :[text('完成。')]});
  const continuations=()=>host.events.filter(event=>event.type==='user/message'&&
    messageOf(event)?.source?.taskFlow?.key?.includes('"source-followup"'));
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'a');
    await fs.writeFile(path.join(host.cwd,'b.txt'),BODY);
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 a.txt 和 b.txt，再修复 b.txt。');
    assert.equal(continuations().length,1);
    await host.send(agent,'修改 c.txt。');
    assert.equal(continuations().length,1,'the second request did not repeat the old continuation');
  }finally{await host.close();}
});
