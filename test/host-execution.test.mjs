import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {startHost,text,tool} from './helpers/host.mjs';
const PYTHON='C:/Users/杨铭/Documents/DSH Desktop/runtime/python312/python.exe';
const lastValue=o=>JSON.parse(o.messages.at(-1).content.map(b=>b.text??'').join(''));
const outputs=host=>host.events.filter(e=>e.type==='tool/result').map(e=>{const body=e.data.message.content.map(b=>b.text??'').join('');try{return JSON.parse(body);}catch{return {text:body,isError:e.data.message.isError};}});
test('work_exec reuses an exact script version and rejects an ambiguous replacement',async()=>{
  let initial;
  const host=await startHost({script:(o,n)=>{
    if(n===1)return [tool('work_exec',{runtime:'node',code:'console.log(21*2);'})];
    if(n===2){initial=lastValue(o).scriptRef;return [tool('work_exec',{scriptRef:initial,edits:[{before:'21*2',after:'21*3'}]})];}
    if(n===3)return [tool('work_exec',{scriptRef:initial,edits:[{before:'missing-token',after:'1'}]})];
    return [text('完成。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行程序，修改计算，再演示不存在的替换');
    const [first,second,third]=outputs(host);
    assert.equal(first.exitCode,0);assert.match(first.stdout.text,/42/);
    assert.equal(second.scriptReused,true);assert.match(second.stdout.text,/63/);
    assert.ok(third.isError||/match|替换|missing|exactly/i.test(third.text??''));
  }finally{await host.close();}
});
test('work_exec retains missing-runtime input for one explicit corrected invocation',async()=>{
  const host=await startHost({script:(o,n)=>n===1?[tool('work_exec',{code:'console.log(7);'})]:n===2?
    [tool('work_exec',{runtime:'node',scriptRef:lastValue(o).scriptRef})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行已有程序');
    const [first,second]=outputs(host);assert.equal(first.executionOccurred,false);assert.ok(first.scriptRef);
    assert.equal(second.exitCode,0);assert.match(second.stdout.text,/7/);
  }finally{await host.close();}
});
test('work_exec runs the selected installed Python interpreter and preserves nonzero exit status',{skip:!existsSync(PYTHON)},async()=>{
  const host=await startHost({script:(_o,n)=>n===1?[tool('work_exec',{runtime:'python',executable:PYTHON,code:'print(42)'})]:n===2?
    [tool('work_exec',{runtime:'python',executable:PYTHON,code:'raise ValueError("expected failure")'})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行两段程序');
    const [good,bad]=outputs(host);assert.equal(good.exitCode,0);assert.match(good.stdout.text,/42/);
    assert.notEqual(bad.exitCode,0);assert.match(bad.stderr.text,/expected failure/);
  }finally{await host.close();}
});

test('retained computation blocks direct filesystem writes as well as omitting write tools',async()=>{
  const host=await startHost({workspace:{toolSurface:'full'},script:(_o,n)=>n===1?[tool('work_compute',{
    code:"const fsx=await import('node:fs/promises'); await fsx.writeFile('compute-write.txt','probe'); 'write-completed'"})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'核对计算环境的写入限制');
    const [result]=outputs(host);assert.equal(result.status,'failed');assert.equal(result.sandbox.denied,true);
    assert.equal(await fs.stat(path.join(host.cwd,'compute-write.txt')).then(()=>true,()=>false),false);
  }finally{await host.close();}
});
