import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,reasoning} from './helpers/host.mjs';

const sentence='I considered the alternate implementation and rejected it because it duplicates the current parser. The existing parser remains authoritative; the next action reads the source before changing the method. ';
async function scenario(workspace,efforts=['off','low','high','max']){
  const source=sentence.repeat(100),short=sentence.repeat(6);
  const host=await startHost({workspace:{reasoningHistory:true,...workspace},efforts,
    usage:o=>({inputTokens:1000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:o.system?100:6000,totalTokens:o.system?1100:7000}),
    auxiliary:()=>[text(JSON.stringify({text:short}))],
    script:(_o,n)=>n===1?[reasoning(source),tool('read',{file_path:'a.txt'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'a\n');const agent=await host.createAgent('max');await host.send(agent,'读取 a.txt');
    return {status:await host.command(agent,'detail'),requests:host.requests,aux:host.auxiliaryRequests,
      original:host.events.find(e=>e.type==='assistant/message').data.message.content.find(b=>b.type==='reasoning')?.text,source,short};
  }finally{await host.close();}
}

test('reasoningHistory avoids unsupported off effort and missing route pricing',async()=>{
  const unsupported=await scenario({},['low','high','max']);assert.equal(unsupported.aux.length,0);
  const unpriced=await scenario({});assert.equal(unpriced.aux.length,0);
  assert.equal(unpriced.original,unpriced.source);
});

test('reasoningHistory adopts a profitable replay view and leaves the original event unchanged',async()=>{
  const observed=await scenario({projectionPricing:[{provider:'scripted',model:'scripted-model',input:1,cacheRead:1,output:0.01,currency:'USD'}]});
  assert.ok(observed.aux.length>0);
  assert.equal(observed.aux[0].reasoningEffort,'off');
  assert.equal(observed.original,observed.source);
  const replay=observed.requests[1].messages.flatMap(m=>m.content??[]).find(b=>b.type==='reasoning');
  assert.equal(replay.text,observed.short);
});

test('reasoningHistory switch prevents auxiliary calls even on a profitable route',async()=>{
  const observed=await scenario({reasoningHistory:false,projectionPricing:[{provider:'scripted',model:'scripted-model',input:1,cacheRead:1,output:0.01,currency:'USD'}]});
  assert.equal(observed.aux.length,0);
});
