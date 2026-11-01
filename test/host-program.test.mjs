import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';
async function run(programHistory,cacheRead){
  const host=await startHost({workspace:{programHistory,contextProtocol:false,projectionPricing:[{provider:'scripted',model:'scripted-model',input:0.15,cacheRead,output:0.6,currency:'USD'}]},
    toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node',{}],['dsh-agent-tool-presentation',{mode:'ptc'}]],
    usage:o=>{const input=Math.ceil(JSON.stringify(o.messages).length/3);return {inputTokens:input,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:40,totalTokens:[input,40].reduce((s,n)=>s+n,0)};},
    script:(_o,n)=>n<=8?[tool('run_code',{code:`const value=await tools.read({file_path:'a.txt'});\n/* ${'read-only historical program '.repeat(80)} */\nreturn value;`,description:'read source'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'hello\n');const agent=await host.createAgent('max');await host.send(agent,'读取源码');
    const sizes=host.requests.map(requestText).map(s=>s.length);
    return {status:await host.command(agent,'detail'),body:host.requests.map(requestText).join('\n'),total:sizes.reduce((s,n)=>s+n,0)};
  }finally{await host.close();}
}
test('programHistory adopts economical historical programs and keeps original calls recoverable',async()=>{
  const on=await run(true,.15),off=await run(false,.15);
  assert.ok(on.status.historyHygiene.programViews>0);
  assert.equal(off.status.historyHygiene.programViews,0);
  assert.ok(on.body.includes('Historical completed program'));
  assert.ok(on.body.includes('kind:"call"')||on.body.includes('kind:\\"call\\"'));
  assert.ok(on.total<off.total);
  console.log('measurement',JSON.stringify({feature:'programHistory',onChars:on.total,offChars:off.total,views:on.status.historyHygiene.programViews,pricing:'synthetic equal input and cache prices'}));
});
test('programHistory records a refusal for candidates whose cache refill exceeds forecast savings',async()=>{
  const observed=await run(true,.003);
  assert.ok(observed.status.detail.observability.features.programHistory.reasons['predicted-cache-cost-insufficient']>0);
});
