import test from 'node:test';
import assert from 'node:assert/strict';
import {startHost,text,tool} from './helpers/host.mjs';
test('native shell can omit its UI description without mutating frozen parsed arguments',async()=>{
  const host=await startHost({script:(_o,n)=>n===1?[tool('pwsh',{command:"Write-Output 'description-compatible'"})]:[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'执行已授权短命令，读取实际输出。');
    const results=host.events.filter(e=>e.type==='tool/result');
    assert.ok(results.length);assert.ok(results.every(e=>!e.data.message.isError),JSON.stringify(results));
    assert.ok(results.some(e=>e.data.message.content.some(b=>b.text?.includes('description-compatible'))));
    const call=host.events.find(e=>e.type==='tool/call'&&e.data.name==='pwsh');
    const args=typeof call.data.arguments==='string'?JSON.parse(call.data.arguments):call.data.arguments;
    assert.equal(args.command,"Write-Output 'description-compatible'");
  }finally{await host.close();}
});
