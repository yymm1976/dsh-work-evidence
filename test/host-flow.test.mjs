import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

async function scenario(workspace,request,steps,{setup,extraMounts=[],usage}={}){
  const host=await startHost({workspace,extraMounts,usage,script:(_o,n)=>steps[n-1]??[text('完成。')]});
  try{
    if(setup)await setup(host.cwd);
    const agent=await host.createAgent('max');await host.send(agent,request);
    return {body:host.requests.map(requestText).join('\n'),requests:host.requests,
      events:host.events,status:await host.command(agent,'detail')};
  }finally{await host.close();}
}
const resultTexts=run=>run.events.filter(e=>e.type==='tool/result').map(e=>e.data.message.content.map(b=>b.text??'').join(''));

test('executionTriage identifies repeated failures and repeated successful calls only when enabled',async()=>{
  const bad=tool('pwsh',{command:"node -e \"throw new Error('boom 42')\"",description:'run'});
  const good=tool('pwsh',{command:'echo same-output',description:'echo'});
  for(const executionTriage of [true,false]){
    const failed=await scenario({executionTriage},'运行程序并处理错误',[[bad],[bad],[bad]]);
    assert.equal(failed.body.includes('提取到的失败摘要相同'),executionTriage);
    assert.equal(failed.body.includes('相同摘要不证明根因或外部输入相同'),executionTriage);
    const repeated=await scenario({executionTriage},'检查输出',[[good],[good],[good]]);
    assert.equal(repeated.body.includes('返回了相同的完整短输出'),executionTriage);
  }
});

test('executionTriage warns only about a source-linked correction that is reused without a scoped file change',async()=>{
  const claim='src/a.txt 保存了最终值。';
  const report=()=>tool('work_report',{status:'partial',summary:'记录一个待核对判断。',observed:[],unverified:[claim],remaining:['核对实际文件。'],
    claims:[{claim,status:'inferred',support:'尚无直接验证。'}]});
  for(const executionTriage of [true,false]){
    let correctionRequests=0;
    const host=await startHost({workspace:{executionTriage,stepPacing:false,completionNotice:false,toolSurface:'full'},
      script:(options,n)=>{
        if(requestText(options).includes('纠正：')){correctionRequests++;return correctionRequests===1?[report()]:[text('已保留纠正。')];}
        return n===1?[report()]:[text('完成。')];
      }});
    try{
      const agent=await host.createAgent('max');
      await host.send(agent,'记录这个关键判断。');
      assert.ok(!host.requests.some(request=>requestText(request).includes('旧判断已标记为 challenged')));
      await host.send(agent,'纠正：'+claim+'错了，请不要继续沿用。');
      const reminder=host.events.find(event=>event.type==='user/message'&&event.data?.source?.taskFlow?.kind==='diagnostic'&&
        event.data.content.some(block=>block.text?.includes('旧判断已标记为 challenged')));
      assert.equal(!!reminder,executionTriage);
      assert.equal(host.requests.some(request=>requestText(request).includes('旧判断已标记为 challenged')),executionTriage);
      const status=await host.command(agent,'detail');
      assert.equal(status.detail.taskFlow.judgmentChallenges.length,executionTriage?1:0);
      if(executionTriage){
        assert.equal(status.detail.taskFlow.judgmentChallenges[0].status,'challenged');
        assert.equal(status.detail.observability.features.failureAdvice.applied>0,true);
        const correction=host.events.find(event=>event.type==='user/message'&&event.data?.content?.[0]?.text?.startsWith('纠正：'));
        assert.equal(reminder.data.content[0].text.includes('事件'+correction.seq),true);
        const links=reminder.data.source.taskFlow.judgment;
        assert.equal(links.status,'challenged');assert.equal(links.correctionSeq,correction.seq);
        assert.ok(links.reusedSeq>correction.seq);assert.equal(links.source,'work_report');
        const reportCall=host.events.find(event=>event.type==='tool/call'&&event.data.name==='work_report');
        const reportResult=host.events.find(event=>event.type==='tool/result'&&event.data.message.source.callId===reportCall.data.callId);
        assert.equal(links.reportSeq,reportResult.seq);
      }
    }finally{await host.close();}
  }
});

test('a bare assistant repetition carries the correction into the next request without blocking the following tool',async()=>{
  const claim='旧解析接口总是会返回数组。';
  const report=claims=>tool('work_report',{status:'partial',summary:'记录判断。',observed:[],unverified:[],remaining:[],claims});
  let correctionRequests=0;
  const host=await startHost({workspace:{stepPacing:false,completionNotice:false,toolSurface:'full'},script:(options,n)=>{
    if(requestText(options).includes('纠正：')){
      correctionRequests++;
      return correctionRequests===1?[text(claim),report([{claim:'另一个判断仍待核对。',status:'inferred'}])]:[text('完成。')];
    }
    return n===1?[report([{claim,status:'inferred'}])]:[text('完成。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'登记判断。');
    await host.send(agent,'纠正：'+claim+'错了。');
    const reminder=host.events.find(event=>event.type==='user/message'&&event.data?.source?.taskFlow?.judgment?.source==='assistant-text');
    assert.ok(reminder);assert.ok(reminder.data.source.taskFlow.judgment.reusedSeq>0);
    assert.equal(host.events.filter(event=>event.type==='tool/call'&&event.data.name==='work_report').length,2);
    assert.ok(host.requests.some(request=>requestText(request).includes('旧判断已标记为 challenged')));
  }finally{await host.close();}
});

test('a scoped file change and ambiguous or indirect corrections leave judgment applicability unknown or unobserved',async()=>{
  const claim='src/a.txt 保存了最终值。',second='src/b.txt 保存了另一个最终值。';
  for(const variation of ['file-change','opaque-boundary','ambiguous','indirect']){
    const marker=variation==='ambiguous'?'之前的两个判断':variation==='indirect'?'另一个模块':'纠正：';
    const uncertain=['file-change','opaque-boundary'].includes(variation);
    let correctionRequests=0;
    const host=await startHost({workspace:{stepPacing:false,completionNotice:false,toolSurface:'full'},script:(options,n)=>{
      if(requestText(options).includes(marker)){
        correctionRequests++;
        if(variation==='file-change'&&correctionRequests===1)return [tool('write',{file_path:'src/a.txt',content:'updated\n'})];
        if(variation==='opaque-boundary'&&correctionRequests===1)return [tool('pwsh',{command:'echo read-only-output',description:'observe external state'})];
        if(correctionRequests===(uncertain?2:1))return [tool('work_report',{status:'partial',summary:'再次登记。',observed:[],unverified:[],remaining:[],
          claims:[{claim,status:'observed'}]})];
        return [text(claim)];
      }
      if(n===1)return [tool('work_report',{status:'partial',summary:'登记两个来源范围。',observed:[],unverified:[],remaining:['继续核对。'],
        claims:[{claim,status:'inferred'},{claim:second,status:'inferred'}]})];
      return [text('完成。')];
    }});
    try{
      const agent=await host.createAgent('max');await host.send(agent,'登记判断。');
      const correction=variation==='ambiguous'?'之前的两个判断都错了：'+claim+'；'+second:
        variation==='indirect'?'另一个模块有问题，请继续核对。':'纠正：'+claim+'错了。';
      await host.send(agent,correction);
      assert.ok(!host.requests.some(request=>requestText(request).includes('旧判断已标记为 challenged')),variation);
      const status=await host.command(agent,'detail');
      if(uncertain){
        if(variation==='file-change')assert.ok(status.detail.taskFlow.mutationVersion>0,'the file effect must be observed before invalidating the judgment');
        assert.equal(status.detail.taskFlow.judgmentChallenges[0].status,'unknown');
      }else assert.equal(status.detail.taskFlow.judgmentChallenges.length,0);
    }finally{await host.close();}
  }
});

test('stepPacing controls actual output-usage guidance',async()=>{
  const steps=Array.from({length:4},()=>[tool('pwsh',{command:'echo ok',description:'observe'})]);
  const usage=()=>({inputTokens:1000,outputTokens:6500,cacheReadTokens:0,totalTokens:7500});
  const on=await scenario({},'修改项目并观察结果',steps,{usage}),off=await scenario({stepPacing:false},'修改项目并观察结果',steps,{usage});
  assert.ok(on.status.detail.observability.features.stageJudgment.applied>0);
  assert.equal(off.status.detail.observability.features.stageJudgment?.applied??0,0);
  assert.ok(on.status.detail.observability.features.stepPacing.applied>0);
  assert.equal(off.status.detail.observability.features.stepPacing.applied,0);
  assert.ok(!off.body.includes('本次使用激进优化'));
  assert.ok(on.body.includes('上一响应较长'));
  assert.ok(!off.body.includes('上一响应较长'));
});

test('retainedCompute keeps bindings, clears them after writes and respects its switch',async()=>{
  const steps=[[tool('work_compute',{code:'globalThis.k=41; const v=1; v'})],
    [tool('work_compute',{code:'k+1'})],[tool('write',{file_path:'b.txt',content:'x'})],
    [tool('work_compute',{code:'typeof k'})]];
  const on=await scenario({toolSurface:'full'},'计算并写文件',steps);
  const result=resultTexts(on).filter(s=>s.startsWith('{')).map(s=>JSON.parse(s));
  assert.equal(result[0].value,1);assert.equal(result[1].value,42);
  assert.equal(result[2].value,'undefined');assert.equal(result[2].resetReason,'observed-workspace-change');
  const off=await scenario({toolSurface:'full',retainedCompute:false},'计算并写文件',steps);
  for(const value of resultTexts(off).filter(s=>s.startsWith('{')).map(s=>JSON.parse(s)))assert.equal(value.executionOccurred,false);
});

test('stageWorkingSet disables explicit stage declarations without claiming a stage',async()=>{
  for(const stageWorkingSet of [true,false]){
    const run=await scenario({stageWorkingSet,toolSurface:'full'},'记录当前阶段',[[tool('work_state',{mode:'stage',phase:'investigate',focus:['a.txt']})]]);
    const value=JSON.parse(resultTexts(run)[0]);
    if(stageWorkingSet)assert.notEqual(value.status,'disabled');else assert.equal(value.feature,'stageWorkingSet');
  }
});

test('the real native line cap produces a scoped JSON recovery hint only when enabled',async()=>{
  const input=JSON.stringify(Array.from({length:480},(_,id)=>({id,amount:100+id,archived:id%5===0})));
  for(const config of [{executionTriage:true},{executionTriage:false},{enabled:false}]){
    const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],
      workspace:{stepPacing:false,qualityReview:false,completionNotice:false,...config},script:(_options,n)=>n===1?
        [tool('run_code',{code:'const r=await tools.read({file_path:"orders.json"});const txt=r.lines.map(l=>l.text).join("\\n");return JSON.parse(txt);',description:'Read and parse the supplied orders'})]:[text('已保留读取失败。')]});
    try{
      await fs.writeFile(path.join(host.cwd,'orders.json'),input);
      const agent=await host.createAgent();await host.send(agent,'读取 orders.json 并解析；保护输入文件。');
      assert.equal(host.requests.length,2);
      const reads=host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read');
      assert.equal(reads.length,1,'no automatic reread');
      assert.ok(reads[0].data.content.some(block=>block.text?.includes('(line truncated to 2000 chars)')));
      assert.ok(host.events.some(event=>event.type==='tool/result'&&event.data.message?.isError&&event.data.message.content.some(block=>block.text?.includes('at JSON.parse'))));
      const notices=host.events.filter(event=>event.type==='user/message'&&event.data?.source?.taskFlow?.key?.includes('native-read-clipped-json'));
      const expected=config.executionTriage===true;
      assert.equal(requestText(host.requests[1]).includes('扩大 limit 或取回同一历史事件不能补回'),expected);
      assert.equal(notices.length,expected?1:0);
      assert.equal(await fs.readFile(path.join(host.cwd,'orders.json'),'utf8'),input);
    }finally{await host.close();}
  }
});
