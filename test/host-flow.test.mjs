import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

async function scenario(workspace,request,steps,{setup,extraMounts=[]}={}){
  const host=await startHost({workspace,extraMounts,script:(_o,n)=>steps[n-1]??[text('完成。')]});
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
    assert.equal(failed.body.includes('执行连续因同一错误中断'),executionTriage);
    const repeated=await scenario({executionTriage},'检查输出',[[good],[good],[good]]);
    assert.equal(repeated.body.includes('返回了相同的完整短输出'),executionTriage);
  }
});

test('executionAdvice suggests native execution after reading concrete input sources',async()=>{
  for(const executionAdvice of [true,false]){
    const run=await scenario({executionAdvice},'m.js 的函数对输入 21 返回什么结果？',[[tool('read',{file_path:'m.js'})]],
      {setup:cwd=>fs.writeFile(path.join(cwd,'m.js'),'module.exports=x=>x*2;\n')});
    assert.equal(run.body.includes('当前具体问题可以优先考虑已有代码的原生执行'),executionAdvice);
  }
});

test('finishAdvice uses completed todos and an observed post-write execution',async()=>{
  const steps=[[tool('todo_write',{todos:[{content:'写 a.txt',status:'completed'}]})],
    [tool('write',{file_path:'a.txt',content:'1\n'})],[tool('pwsh',{command:'Get-Content a.txt',description:'check'})]];
  for(const finishAdvice of [true,false]){
    const run=await scenario({finishAdvice},'写 a.txt 并检查',steps,{extraMounts:[['dsh-tool-todo',{allowParallelInProgress:true}]]});
    assert.equal(run.body.includes('已有计划全部标为完成'),finishAdvice);
  }
});

test('stepPacing can disable automatic progress guidance',async()=>{
  const steps=Array.from({length:4},()=>[tool('pwsh',{command:'echo ok',description:'observe'})]);
  const on=await scenario({},'观察结果',steps),off=await scenario({stepPacing:false},'观察结果',steps);
  assert.ok(on.status.detail.observability.features.stepPacing.applied>0);
  assert.equal(off.status.detail.observability.features.stepPacing.applied,0);
  assert.ok(!off.body.includes('本次使用激进优化'));
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
