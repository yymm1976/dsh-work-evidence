import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';
async function stateRun(workspace,external=false){
  let cwd;
  const host=await startHost({workspace,script:async(_o,n)=>{
    if(n===1)return [tool('read',{file_path:'a.txt'})];
    if(n===2){
      if(external){await fs.writeFile(path.join(cwd,'a.txt'),'changed\nline2\n');return [tool('read',{file_path:'a.txt',offset:1,limit:1})];}
      return [tool('write',{file_path:'a.txt',content:'changed\n'})];
    }
    return [text('完成。')];
  }});
  cwd=host.cwd;
  try{
    await fs.writeFile(path.join(cwd,'a.txt'),'original\nline2\n');
    const agent=await host.createAgent('max');await host.send(agent,'读取后处理 a.txt');
    return {status:await host.command(agent,'detail'),body:host.requests.map(requestText).join('\n'),events:host.events};
  }finally{await host.close();}
}
test('stateLedger records reads and invalidation while its disabled form records neither',async()=>{
  const on=await stateRun({}),off=await stateRun({stateLedger:false});
  assert.ok(on.status.detail.state.observations.some(x=>x.stale));
  assert.equal(on.status.detail.state.mutations.length,1);
  assert.equal(off.status.detail.state.observations.length,0);assert.equal(off.status.detail.state.mutations.length,0);
});
test('stateInform controls legacy invalidation notices when ledgerUnresolved is disabled',async()=>{
  for(const stateInform of [true,false]){
    const observed=await stateRun({stateInform,ledgerUnresolved:false});
    assert.equal(observed.body.includes('工程状态已失效'),stateInform);
  }
});
test('requestAccounting can be disabled without disabling the task',async()=>{
  const on=await stateRun({}),off=await stateRun({requestAccounting:false});
  assert.equal(on.status.requestObservations.length,3);
  assert.equal(off.status.requestObservations.length,0);
  assert.ok(off.status.contextEconomics.mainHistory.length>0,'compression economics still observes usage');
  assert.equal(off.events.findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
});

test('ledgerUnresolved describes repeated empty searches and suppresses the legacy duplicate notice',async()=>{
  for(const ledgerUnresolved of [true,false]){
    const host=await startHost({workspace:{ledgerUnresolved,selfIndex:false},script:(_o,n)=>n<=2?
      [tool('grep',{path:'.',pattern:'definitely_missing_abc'})]:[text('完成。')]});
    try{
      await fs.writeFile(path.join(host.cwd,'a.txt'),'hello\n');
      const agent=await host.createAgent('max');await host.send(agent,'查找符号');
      const body=host.requests.map(requestText).join('\n');
      assert.equal(body.includes('[work-evidence ledger state]'),ledgerUnresolved);
      assert.equal(body.includes('已观察的局部检索事实'),!ledgerUnresolved);
    }finally{await host.close();}
  }
});
