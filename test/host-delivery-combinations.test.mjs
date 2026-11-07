import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,lastUserText} from './helpers/host.mjs';
import {requestPausesContinuation} from '../completion-notice.mjs';

const notices=host=>host.events.filter(event=>event.type==='user/message'&&
  ['work-evidence-final-json','work-evidence-completion','work-evidence-quality-review'].includes(event.data?.source?.kind));
const stage='\n\n## 阶段摘要\n已写入第一部分。\n下一步：写入 b.txt';

test('JSON repair precedes authorized continuation and only the completed delivery is reviewed',async()=>{
  const payloads=[];
  const host=await startHost({workspace:{qualityReview:true,completionNotice:true,finalJsonGuard:true,qualityReviewEffort:'inherit',qualityReviewScope:'full'},
    script:(options,n)=>{
      if(n===1)return [tool('write',{file_path:'a.txt',content:'first\n'})];
      if(n===2)return [text('```json\n{"written":["a.txt"],}\n```'+stage)];
      if(n===3){assert.match(lastUserText(options),/无法严格解析/);return [text('```json\n{"written":["a.txt"]}\n```'+stage)];}
      if(n===4){assert.match(lastUserText(options),/上一条答复包含阶段摘要/);return [tool('write',{file_path:'b.txt',content:'second\n'})];}
      return [text('```json\n{"written":["a.txt","b.txt"]}\n```\n\n## 阶段摘要\n全部完成。\n下一步：无')];
    },auxiliary:options=>{payloads.push(JSON.parse(options.messages[0].content[0].text));return [text('{"issues":[]}')];}});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'不要停止，无需确认。写入 a.txt 和 b.txt，最终提供 JSON 代码块和阶段摘要。');
    assert.equal(host.events.findLast(event=>event.type==='turn/end')?.data.reason.kind,'completed');
    assert.equal(await fs.readFile(path.join(host.cwd,'a.txt'),'utf8'),'first\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'b.txt'),'utf8'),'second\n');
    assert.deepEqual(notices(host).map(event=>event.data.source.kind),['work-evidence-final-json','work-evidence-completion']);
    const completion=(await host.command(agent,'feature completionNotice')).features[0];
    assert.equal(completion.effect.status,'applied');assert.equal(completion.effect.applied,1);
    assert.equal(payloads.length,1,'The intermediate stage does not consume a paid review.');
    assert.match(payloads[0].answer.text,/"b.txt"/);
    assert.ok(payloads[0].observed.artifacts.some(item=>item.path.endsWith('b.txt')));
    const status=await host.command(agent,'detail');assert.equal(status.qualityReview.status,'clean');
    const review=(await host.command(agent,'feature qualityReview')).features[0];
    assert.equal(review.effect.status,'applied');assert.equal(review.effect.lastReason,'review-completed-no-supported-gap');
    const effort=(await host.command(agent,'feature qualityReviewEffort')).features[0];
    assert.equal(effort.status,'ready');assert.equal(effort.effect.status,'applied');
    assert.equal(effort.effect.lastReason,'review-options-selected');
    const scope=(await host.command(agent,'feature qualityReviewScope')).features[0];
    assert.equal(scope.status,'ready');assert.equal(scope.effect.status,'applied');
    assert.equal(scope.effect.lastReason,'review-options-selected');
    assert.equal(status.finalJson?.unresolvedSyntax??null,null);
    console.log('delivery',JSON.stringify({syntaxNotices:1,continuationNotices:1,reviewCalls:payloads.length,
      writes:2,completed:true}));
  }finally{await host.close();}
});

test('an explicit request to pause and report receives no delivery review or continuation',async()=>{
  for(const request of ['先只汇报当前进展，不要继续修改 a.txt 或 b.txt。','先只汇报当前进展，不要继续。']){
  const host=await startHost({workspace:{qualityReview:true,completionNotice:true,finalJsonGuard:true},
    script:()=>[text('## 阶段摘要\n目前只完成 a.txt。\n下一步：修改 b.txt')],
    auxiliary:()=>[text('{"issues":[]}')]});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,request);
    assert.equal(host.requests.length,1);assert.equal(host.auxiliaryRequests.length,0,'Paused project work does not consume a delivery review.');
    assert.equal(notices(host).length,0);
    if(!request.includes('修改')){
      const feature=await host.command(agent,'feature qualityReview');assert.equal(feature.features[0].status,'waiting');
      assert.ok(feature.features[0].reasons.includes('current-request-report-only'));
    }
  }finally{await host.close();}
  }
});

test('a plan-only request does not resume to implement the proposed next step',async()=>{
  const host=await startHost({workspace:{qualityReview:false,completionNotice:true},script:()=>[text('## 阶段摘要\n计划已列出。\n下一步：修改 b.txt')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'只制定计划，不要实施或修改文件。');
    assert.equal(host.requests.length,1);
    assert.equal(notices(host).length,0);
  }finally{await host.close();}
});

test('a stage-summary example in a fenced code block does not resume the task',async()=>{
  for(const fence of ['```','~~~']){
    const host=await startHost({workspace:{qualityReview:false,completionNotice:true},script:()=>
      [text('下面是模板：\n'+fence+'markdown\n## 阶段摘要\n下一步：修改 b.txt\n'+fence)]});
    try{
      const agent=await host.createAgent('max');
      await host.send(agent,'展示一个 Markdown 阶段摘要模板。');
      assert.equal(host.requests.length,1);
      assert.equal(notices(host).length,0);
    }finally{await host.close();}
  }
});

test('a real stage summary does not use a next step inside a code example',async()=>{
  const host=await startHost({workspace:{qualityReview:false,completionNotice:true},script:()=>
    [text('## 阶段摘要\n已展示模板。\n```markdown\n下一步：修改 b.txt\n```')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'展示一个 Markdown 模板。');
    assert.equal(host.requests.length,1);
    assert.equal(notices(host).length,0);
  }finally{await host.close();}
});

test('a real stage summary after a fenced example can still continue',async()=>{
  const host=await startHost({workspace:{qualityReview:false,completionNotice:true},script:(_options,number)=>
    [text(number===1?'```markdown\n## 阶段摘要\n下一步：示例\n```\n## 阶段摘要\n下一步：修改 b.txt':'## 阶段摘要\n已完成。\n下一步：无')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'修改 a.txt 和 b.txt。');
    assert.equal(host.requests.length,2);
    assert.deepEqual(notices(host).map(event=>event.data.source.kind),['work-evidence-completion']);
  }finally{await host.close();}
});

test('plan-only detection preserves explicit authorization to continue',()=>{
  assert.equal(requestPausesContinuation('只制定计划，然后不要实施。'),true);
  assert.equal(requestPausesContinuation('只制定计划，然后不实施。'),true);
  assert.equal(requestPausesContinuation('只制定计划，经用户确认后再实施。'),true);
  assert.equal(requestPausesContinuation('只制定计划，然后询问我是否实施。'),true);
  assert.equal(requestPausesContinuation('只制定计划，然后实施。'),false);
  assert.equal(requestPausesContinuation('只制定计划，然后无需确认直接实施。'),false);
  assert.equal(requestPausesContinuation('不只制定计划，还要开发。'),false);
  assert.equal(requestPausesContinuation('读取“只制定计划”的原文并完成任务。'),false);
});

test('plan words used as nouns stay eligible for continuation',()=>{
  for(const request of[
    '只按计划修改 a.txt','仅参考方案','只按计划执行','仅需方案，随后实施','按方案实施',
    '只按计划实施：修改 a.txt','按这份方案实施','只实现方案 B','仅方案B','只需要方案B的实现',
    '只参考计划里的顺序执行','仅按给出的计划开发','计划已经确认，继续实施','只按方案修改，无需再确认',
    '仅计划中的规则需要实现，不要改动其他','只需要计划里的三条改动全部实现','仅方案中的 extglob 部分需要落地',
    '只要计划批准就立即实施','仅方案中的内容需要落地','参考方案后修改 b.txt','不要把这次答复当作计划，继续实施',
    '给出计划后无需确认直接开发','不用等我批准，直接实施','不要等用户确认后再修改文件','不用等我确认后再修改，直接按计划实施',
    '计划：下一步修改 a.txt','先给方案并按方案修改文件','不要只给计划，直接做。','只要方案，马上实施',
    '先写代码，核对确认后执行','跑一遍测试，确认无误后再交付','我确认过了，继续实施','不需要用户确认，直接实施'
  ])assert.equal(requestPausesContinuation(request),false,request);
});

test('plan-only and confirmation-gate requests pause continuation',()=>{
  for(const request of[
    '只制定计划，不要实施或修改文件','只给一份计划，不要改代码','只需要一个方案，等我确认后再执行',
    '只制定方案','仅制定计划','制定计划并经用户确认后执行','先出计划，我确认后你再实施',
    '仅方案确认后实施','只写方案，不动代码','仅出一版计划给我','只需要一份计划，其他都别动',
    '用户确认后我再让你实施，现在先给方案','未经我确认不得实施','等我确认后再实施','仅计划文档待我确认',
    '写个计划，等我确认后再继续。','写个计划，等我确认后再改代码。','写个计划，确认后执行。','写个计划，获批后执行。',
    '待授权后提交','获批后发布','先备份，确认后回滚'
  ])assert.equal(requestPausesContinuation(request),true,request);
});

test('a request to plan and then implement can continue after its stage summary',async()=>{
  const host=await startHost({workspace:{qualityReview:false,completionNotice:true},script:(_options,number)=>
    [text(number===1?'## 阶段摘要\n计划已列出。\n下一步：修改 b.txt':'## 阶段摘要\n工作完成。\n下一步：无')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'先制定计划，然后实施并修改文件。');
    assert.equal(host.requests.length,2);
    assert.deepEqual(notices(host).map(event=>event.data.source.kind),['work-evidence-completion']);
  }finally{await host.close();}
});

test('a paused report can repair its explicitly requested JSON without resuming project work',async()=>{
  const host=await startHost({workspace:{qualityReview:true,completionNotice:true,finalJsonGuard:true},script:(_options,n)=>
    [text(n===1?'```json\n{"stage":"paused",}\n```':'```json\n{"stage":"paused"}\n```')]});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'先只汇报当前进展，不要继续。最终提供 JSON 代码块。');
    assert.equal(host.requests.length,2);assert.equal(host.auxiliaryRequests.length,0);
    assert.deepEqual(notices(host).map(event=>event.data.source.kind),['work-evidence-final-json']);
    assert.equal(host.events.filter(event=>event.type==='tool/call').length,0);
  }finally{await host.close();}
});

test('literal result repair runs before review and reuses the one native command result',async()=>{
  const fields={exitCode:0,stdout:'actual\r\n',stderr:''};let payload;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],
    workspace:{qualityReview:true,completionNotice:true,finalJsonGuard:true,finalJsonResultGuard:true},script:(options,n)=>{
      if(n===1)return [tool('run_code',{code:'const r=await tools.pwsh({command:\'[Console]::Out.Write("actual`r`n")\',description:"Return requested output"});return {exitCode:r.exitCode,stdout:r.stdout.text,stderr:r.stderr.text};'})];
      if(n===2)return [text(JSON.stringify({...fields,stdout:'actual'}))];
      assert.match(lastUserText(options),/末尾换行/);return [text(JSON.stringify(fields))];
    },auxiliary:options=>{payload=JSON.parse(options.messages[0].content[0].text);return [text('{"issues":[]}')];}});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'最终只返回 JSON：{"exitCode":整数,"stdout":"完整实际输出","stderr":"完整实际错误输出"}。');
    assert.equal(host.requests.length,3);assert.equal(host.auxiliaryRequests.length,1);
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='pwsh').length,1);
    assert.deepEqual(JSON.parse(payload.answer.text),fields);
    assert.deepEqual(notices(host).map(event=>event.data.source.kind),['work-evidence-final-json']);
  }finally{await host.close();}
});

test('disabling the plugin during format repair releases native tools and all automatic handlers',async()=>{
  const host=await startHost({workspace:{qualityReview:true,completionNotice:true,finalJsonGuard:true},script:async(_options,n)=>{
    if(n===1)return [text('```json\n{"stage":"first",}\n```'+stage)];
    if(n===2){await host.command(agent,'off');return [tool('write',{file_path:'native.txt',content:'native result\n'})];}
    return [text('```json\n{"stage":"native",}\n```'+stage)];
  }});let agent;
  try{
    agent=await host.createAgent('ultra');await host.send(agent,'写入 native.txt，最终提供 JSON 代码块和阶段摘要。');
    assert.equal(await fs.readFile(path.join(host.cwd,'native.txt'),'utf8'),'native result\n');
    assert.equal(host.requests.length,3);assert.equal(host.auxiliaryRequests.length,0);
    assert.deepEqual(notices(host).map(event=>event.data.source.kind),['work-evidence-final-json']);
    assert.equal((await host.command(agent,'status')).effective,false);
  }finally{await host.close();}
});

test('independent review and continuation switches preserve the selected behavior',async()=>{
  for(const qualityReview of [false,true]){
    const host=await startHost({workspace:{qualityReview,completionNotice:false},script:()=>[text('## 阶段摘要\n下一步：写入 b.txt')],
      auxiliary:()=>[text('{"issues":[]}')]});
    try{
      const agent=await host.createAgent('ultra');await host.send(agent,'写入 a.txt 和 b.txt。');
      assert.equal(host.requests.length,1);assert.equal(host.auxiliaryRequests.length,qualityReview?1:0);
      assert.equal(notices(host).length,0);
    }finally{await host.close();}
  }
});

test('quoted file content does not become a request to stop continuation or review',async()=>{
  const host=await startHost({workspace:{qualityReview:true,completionNotice:true},script:(_options,n)=>{
    if(n===1)return [tool('write',{file_path:'a.txt',content:'暂停'})];
    if(n===2)return [text('## 阶段摘要\na.txt 已写入。\n下一步：写入 b.txt，内容为“暂停”')];
    if(n===3)return [tool('write',{file_path:'b.txt',content:'暂停'})];
    return [text('## 阶段摘要\n两份文件已写入。\n下一步：无')];
  },auxiliary:()=>[text('{"issues":[]}')]});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'写入 a.txt，内容为“暂停”；再写入 b.txt，内容为“暂停”。最终给阶段摘要。');
    assert.equal(await fs.readFile(path.join(host.cwd,'a.txt'),'utf8'),'暂停');
    assert.equal(await fs.readFile(path.join(host.cwd,'b.txt'),'utf8'),'暂停');
    assert.equal(host.auxiliaryRequests.length,1);
    assert.deepEqual(notices(host).map(event=>event.data.source.kind),['work-evidence-completion']);
  }finally{await host.close();}
});
