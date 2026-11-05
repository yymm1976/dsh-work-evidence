import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,lastUserText} from './helpers/host.mjs';

const notices=host=>host.events.filter(event=>event.type==='user/message'&&
  ['work-evidence-final-json','work-evidence-completion','work-evidence-quality-review'].includes(event.data?.source?.kind));
const stage='\n\n## 阶段摘要\n已写入第一部分。\n下一步：写入 b.txt';

test('JSON repair precedes authorized continuation and only the completed delivery is reviewed',async()=>{
  const payloads=[];
  const host=await startHost({workspace:{qualityReview:true,completionNotice:true,finalJsonGuard:true},
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
    assert.equal(payloads.length,1,'The intermediate stage does not consume a paid review.');
    assert.match(payloads[0].answer.text,/"b.txt"/);
    assert.ok(payloads[0].observed.artifacts.some(item=>item.path.endsWith('b.txt')));
    const status=await host.command(agent,'detail');assert.equal(status.qualityReview.status,'clean');
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
