import test from 'node:test';
import assert from 'node:assert/strict';
import {startHost,text,tool} from './helpers/host.mjs';

for(const toolMode of ['native','ptc'])test(`quality review retains implementation reads after modification (${toolMode})`,async()=>{
  const marker='IMPORTANT_MIDDLE_REQUIREMENT_BRANCH',body='header\n'.repeat(300)+marker+'\n'+'tail\n'.repeat(300);
  let payload=null;
  const invoke=(name,args)=>toolMode==='native'?tool(name,args):tool('run_code',{code:`return await tools.${name}(${JSON.stringify(args)});`});
  const host=await startHost({toolMode,extraMounts:toolMode==='ptc'?[['dsh-ptc-runtime-node',{}],['dsh-agent-tool-presentation',{mode:'ptc'}]]:[],
    script:(_o,n)=>n===1?[invoke('write',{file_path:'a.txt',content:body})]:
    n===2?[invoke('read',{file_path:'a.txt'})]:[text('a.txt 已写入并读取。')],
    auxiliary:options=>{payload=JSON.parse(options.messages[0].content[0].text);return [text('{"issues":[]}')];}});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'写入 a.txt 后读取并说明实际内容。');
    assert.ok(payload);
    assert.ok(payload.observed.artifacts.length,JSON.stringify({observed:payload.observed,
      errors:host.events.filter(e=>e.type==='tool/result'&&e.data.message.isError).map(e=>e.data.message.content)}));
    const reads=payload.evidence.filter(e=>e.type==='tool/ptc-dispatch'&&e.data.includes(marker));
    assert.ok(reads.length||payload.evidence.some(e=>e.type==='tool/result'&&e.data.includes(marker)),
      'The implementation middle must reach the review: '+JSON.stringify(payload.evidence.map(e=>({seq:e.seq,type:e.type,chars:e.data.length,head:e.data.slice(0,200)}))));
    assert.ok(JSON.stringify(payload).length<60000,'review evidence stays bounded');
  }finally{await host.close();}
});

test('quality review does not promote a source read superseded by a later write',async()=>{
  const marker='SUPERSEDED_SOURCE_MIDDLE',body='header\n'.repeat(300)+marker+'\n'+'tail\n'.repeat(300);
  let payload=null;
  const host=await startHost({script:(_o,n)=>n===1?[tool('write',{file_path:'a.txt',content:body})]:
    n===2?[tool('read',{file_path:'a.txt'})]:n===3?[tool('write',{file_path:'a.txt',content:'replacement\n'})]:[text('a.txt 已替换。')],
    auxiliary:options=>{payload=JSON.parse(options.messages[0].content[0].text);return [text('{"issues":[]}')];}});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'读取第一版后写入第二版，并说明实际状态。');
    assert.ok(payload);assert.equal(payload.evidence.some(e=>e.data.includes(marker)),false,
      'A superseded read must not receive the expanded source budget');
  }finally{await host.close();}
});
