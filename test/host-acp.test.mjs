import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {startHost,text,tool} from './helpers/host.mjs';
const ENTRY='C:/Users/杨铭/Documents/DSH Desktop/home/profiles/web/node_modules/billion-context-dsh/dist/index.js';
test('installed ACP compresses a real host range alongside Work Evidence and recovers its source',{skip:!existsSync(ENTRY)},async()=>{
  const acp=await import(pathToFileURL(ENTRY).href);
  let host;
  host=await startHost({workspace:{contextProtocol:false,historyHygiene:false,ledgerReceipt:false},
    extraMounts:[[acp.default,{settingsEnabled:false,autoNudge:false,autoCommand:false,modelContextLimit:200000}]],
    script:(_o,n)=>{
      if(n<=8)return [tool('read',{file_path:n===1?'big.txt':'small.txt'})];
      if(n===9){const start=host.events.find(e=>e.type==='assistant/message').seq,end=host.events.find(e=>e.type==='tool/result').seq;
        return [tool('compress',{content:[{startSeq:start,endSeq:end,summary:'Read big.txt successfully. The original source contains numbered rows; the next step reads small.txt. Preserve the original rows behind this checkpoint for later recovery.'}]})];}
      if(n===10)return [tool('decompress',{blockId:'b1'})];
      if(n===11)return [tool('decompress',{blockId:'b1',offset:1})];
      if(n===12)return [tool('acp_status',{})];
      return [text('完成。')];
    }});
  try{
    await fs.writeFile(path.join(host.cwd,'big.txt'),Array.from({length:300},(_,i)=>`ORIGINAL_ROW_${i} `+'x'.repeat(70)).join('\n'));
    await fs.writeFile(path.join(host.cwd,'small.txt'),'small\n');
    const agent=await host.createAgent('max');await host.send(agent,'读取文件，压缩已读范围，然后取回');
    const results=host.events.filter(e=>e.type==='tool/result').map(e=>({error:e.data.message.isError,text:e.data.message.content.map(b=>b.text??'').join('')}));
    assert.ok(host.events.some(e=>e.type==='compaction/summary'),'the ACP checkpoint commits through the actual host');
    assert.ok(results.slice(-3).some(e=>e.text.includes('ORIGINAL_ROW_31')),'decompress recovers original text');
    assert.equal(host.auxiliaryRequests.length,0,'ACP uses the submitted summary without another model call');
    assert.equal(host.events.findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
  }finally{await host.close();}
});
