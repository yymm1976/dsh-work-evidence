import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool} from './helpers/host.mjs';
async function run({confidence=.9,winner='b',execute=false,estimated_run_ms=120000,invalidEvidence=false}={}){
  let cwd;
  const host=await startHost({workspace:{toolSurface:'full'},auxiliary:()=>[text(JSON.stringify({winner,confidence,evidence:[{path:path.join(cwd,'data.txt'),quote:invalidEvidence?'invented quote':'prefer b'}],limitations:[]}))],
    script:(_o,n)=>n===1?[tool('candidate_select',{task:'选择已有实现',data_report:'prefer b',evidence_paths:['data.txt'],execute,estimated_run_ms,
      candidates:[{id:'a',file_path:'a.js',command:'echo selected-a'},{id:'b',file_path:'b.js',command:'echo selected-b'}]})]:[text('完成。')]});
  cwd=host.cwd;
  try{
    await fs.writeFile(path.join(cwd,'a.js'),'a\n');await fs.writeFile(path.join(cwd,'b.js'),'b\n');await fs.writeFile(path.join(cwd,'data.txt'),'prefer b\n');
    const agent=await host.createAgent('max');await host.send(agent,'比较已有候选，按开关执行');
    const event=host.events.filter(e=>e.type==='tool/result').at(-1);
    return {value:JSON.parse(event.data.message.content.map(b=>b.text??'').join('')),status:await host.command(agent,'detail'),aux:host.auxiliaryRequests};
  }finally{await host.close();}
}
test('candidate_select abstains on low confidence, invented evidence and cheap operations',async()=>{
  assert.equal((await run({confidence:.6})).value.reason,'insufficient-prediction-confidence');
  assert.equal((await run({invalidEvidence:true})).value.reason,'prediction-unavailable');
  const cheap=await run({estimated_run_ms:1});assert.equal(cheap.value.reason,'candidate-runtime-too-short');assert.equal(cheap.aux.length,0);
});
test('candidate_select predicts without execution and executes only on explicit execute',async()=>{
  const predicted=await run(),executed=await run({execute:true});
  assert.equal(predicted.value.selected,'b');assert.equal(predicted.value.execution,null);
  assert.equal(predicted.status.metrics.candidateRuns,0);
  assert.equal(executed.value.selected,'b');assert.equal(executed.value.execution.isError,false);
  assert.equal(executed.status.metrics.candidateRuns,1);
});

test('semantic index aliases are saved only after grounded model approval',async()=>{
  for(const faithful of [true,false]){
    const host=await startHost({workspace:{toolSurface:'full'},auxiliary:()=>[text(JSON.stringify({faithful,specific:true,separated:true}))],
      script:(_o,n)=>n===1?[tool('evidence_index',{mode:'learn',query:'doubling operation',file:'math.js',quote:'return x*2',semantic:true})]:[text('完成。')]});
    try{
      await fs.writeFile(path.join(host.cwd,'math.js'),'export const twice=x=>{return x*2};\n');
      const agent=await host.createAgent('max');await host.send(agent,'记录源码别名');
      const receipt=JSON.parse(host.events.find(e=>e.type==='tool/result').data.message.content.map(b=>b.text??'').join(''));
      assert.equal(receipt.saved,faithful);assert.equal(host.auxiliaryRequests.length,1);
    }finally{await host.close();}
  }
});

test('selfIndex offers a verified alternate source after repeated empty scoped searches',async()=>{
  for(const selfIndex of [true,false]){
    const host=await startHost({workspace:{toolSurface:'full',selfIndex},script:(_o,n)=>n===1?
      [tool('evidence_index',{mode:'learn',query:'twice',file:'math.js',quote:'twice'})]:n<=3?
      [tool('grep',{path:'other',pattern:'twice'})]:[text('完成。')]});
    try{
      await fs.writeFile(path.join(host.cwd,'math.js'),'export const twice=x=>x*2;\n');
      await fs.mkdir(path.join(host.cwd,'other'));await fs.writeFile(path.join(host.cwd,'other','a.txt'),'hello\n');
      const agent=await host.createAgent('max');await host.send(agent,'查找函数定义');
      const body=JSON.stringify(host.requests.map(o=>o.messages));
      assert.equal(body.includes('已核对当前源码的检索入口'),selfIndex);
    }finally{await host.close();}
  }
});

test('ptc_patterns extracts observed repeated chains without executing a generated candidate',async()=>{
  const host=await startHost({workspace:{toolSurface:'full'},toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node',{}],['dsh-agent-tool-presentation',{mode:'ptc'}]],
    script:(_o,n)=>n<=3?[tool('run_code',{code:"const a=await tools.read({file_path:'a.txt'}); const b=await tools.grep({path:'.',pattern:'hello'}); return {a,b};",description:'read and search'})]:
      n===4?[tool('run_code',{code:"return await tools.ptc_patterns({scope:'session',minSupport:1,minToolCalls:2});",description:'inspect observed chains'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'hello\n');const agent=await host.createAgent('max');await host.send(agent,'检查读取与搜索链');
    const report=JSON.parse(await fs.readFile(path.join(host.cwd,'.dsh','work-evidence','ptc-patterns.json'),'utf8'));
    assert.ok(report.sessions[0].liveSession);assert.ok(report.candidateCount>0);
    assert.ok(report.candidates.every(c=>c.executionEligible===false));
    assert.equal((await host.command(agent,'detail')).metrics.ptcFastpathRuns,0);
  }finally{await host.close();}
});
