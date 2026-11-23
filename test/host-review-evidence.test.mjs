import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {startHost,text,tool} from './helpers/host.mjs';

import {scopeReviewSources} from '../quality-review.mjs';

for(const toolMode of ['native','ptc'])test(`quality review retains implementation reads after modification (${toolMode})`,async()=>{
  const marker='IMPORTANT_MIDDLE_REQUIREMENT_BRANCH',body='header\n'.repeat(300)+marker+'\n'+'tail\n'.repeat(300);
  let payload=null;
  const invoke=(name,args)=>toolMode==='native'?tool(name,args):tool('run_code',{code:`return await tools.${name}(${JSON.stringify(args)});`});
  const host=await startHost({workspace:{qualityReview:true},toolMode,extraMounts:toolMode==='ptc'?[['dsh-ptc-runtime-node',{}],['dsh-agent-tool-presentation',{mode:'ptc'}]]:[],
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

for(const toolMode of ['native','ptc'])test(`quality review keeps a complete inserted source before later small edits (${toolMode})`,async()=>{
  const marker='NEW_FUNCTION_MIDDLE_REQUIREMENT',body='header\n'.repeat(400)+marker+'\n'+'tail\n'.repeat(400)+'original-ending\n';
  let payload=null;
  const invoke=(name,args)=>toolMode==='native'?tool(name,args):tool('run_code',{code:`return await tools.${name}(${JSON.stringify(args)});`});
  const host=await startHost({workspace:{qualityReview:true},toolMode,extraMounts:toolMode==='ptc'?[['dsh-ptc-runtime-node',{}],['dsh-agent-tool-presentation',{mode:'ptc'}]]:[],
    script:(_options,n)=>n===1?[invoke('write',{file_path:'a.txt',content:body})]:n===2?
      [invoke('edit',{file_path:'a.txt',old_string:'original-ending',new_string:'final-ending'})]:[text('已写入并修正 a.txt。')],
    auxiliary:options=>{payload=JSON.parse(options.messages[0].content[0].text);return [text('{"issues":[]}')];}});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'写入 a.txt，再准确修改末尾文字。');
    assert.ok(payload);const changes=payload.evidence.filter(item=>item.data.includes('successful-historical-change'));
    const inserted=changes.find(item=>item.data.includes(marker)),edited=changes.find(item=>item.data.includes('final-ending'));
    assert.ok(inserted);assert.ok(edited);
    assert.ok(inserted.seq<edited.seq);assert.equal(JSON.parse(inserted.data).arguments.content,body);
    assert.deepEqual(payload.evidence.map(item=>item.seq),payload.evidence.map(item=>item.seq).toSorted((a,b)=>a-b));
    assert.equal(host.events.filter(event=>event.type==='tool/call'&&event.data.name==='read').length,0);
  }finally{await host.close();}
});

for(const toolMode of ['native','ptc'])test(`quality review retains a completed inline program's scope (${toolMode})`,async()=>{
  const code='const observed = [1, 2].map(x => x * 2);\nif (observed[1] !== 4) throw new Error("unexpected result");\nconsole.log("passed");';
  let payload;
  const args={runtime:'node',code};
  const run=toolMode==='native'?tool('work_exec',args):tool('run_code',{
    code:`const r=await tools.work_exec(${JSON.stringify(args)}); console.log(r.stdout.text);`});
  const host=await startHost({workspace:{qualityReview:true},toolMode,
    extraMounts:toolMode==='ptc'?[['dsh-ptc-runtime-node',{}],['dsh-agent-tool-presentation',{mode:'ptc'}]]:[],
    script:(_options,n)=>n===1?[run]:[text('程序核对了所有项目行为。')],
    auxiliary:options=>{payload=JSON.parse(options.messages[0].content[0].text);return [text('{"issues":[]}')];}});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'运行程序并说明它实际核对了什么。');
    assert.ok(payload);
    const execution=payload.observed.executions.find(item=>item.tool==='work_exec'&&item.executionCompleted);
    assert.ok(execution);
    const row=payload.evidence.find(item=>item.seq===execution.seq);
    assert.ok(row?.data.includes(code),'the recorded result keeps the exact program that produced it');
    assert.ok(row?.data.includes('passed'),'the native result is also available');
    assert.equal(payload.evidence.filter(item=>item.data.includes(code)).length,1);
  }finally{await host.close();}
});

test('quality review does not promote a source read superseded by a later write',async()=>{
  const marker='SUPERSEDED_SOURCE_MIDDLE',body='header\n'.repeat(300)+marker+'\n'+'tail\n'.repeat(300);
  let payload=null;
  const host=await startHost({workspace:{qualityReview:true},script:(_o,n)=>n===1?[tool('write',{file_path:'a.txt',content:body})]:
    n===2?[tool('read',{file_path:'a.txt'})]:n===3?[tool('write',{file_path:'a.txt',content:'replacement\n'})]:[text('a.txt 已替换。')],
    auxiliary:options=>{payload=JSON.parse(options.messages[0].content[0].text);return [text('{"issues":[]}')];}});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'读取第一版后写入第二版，并说明实际状态。');
    assert.ok(payload);assert.equal(payload.evidence.some(e=>e.data.includes(marker)),false,
      'A superseded read must not receive the expanded source budget');
    assert.equal(payload.evidence.some(e=>e.type==='tool/result'&&e.data.includes('header\\n')),false,
      'An old read cannot leak back through the recent-event fallback');
  }finally{await host.close();}
});

test('quality review retains checks edited after the implementation without changing their default scope',async()=>{
  const marker='RELATIONSHIP_CHECK_ONLY_IN_CHECK_SCRIPT';
  let payload;
  const host=await startHost({workspace:{qualityReview:true},script:(_o,n)=>{
    if(n===1)return [tool('write',{file_path:'lib/core.mjs',content:'// retained implementation context\n'.repeat(1000)+'export const result = { re: /a/ };\n'})];
    if(n===2)return [tool('write',{file_path:'test/check-core.mjs',content:'export const initialCheck = true;\n'})];
    if(n===3)return [tool('edit',{file_path:'test/check-core.mjs',old_string:'initialCheck',new_string:marker})];
    return [text('实现和检查均已更新。')];
  },auxiliary:options=>{payload=JSON.parse(options.messages[0].content[0].text);return [text('{"issues":[]}')];}});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'实现公开结果，再补充检查。');
    assert.ok(payload);assert.ok(payload.evidence.some(item=>item.data.includes(marker)));
  }finally{await host.close();}
});

test('focused review still selects business source while retaining the associated check',()=>{
  const payload={observed:{mutation:{seq:3},artifacts:[
    {seq:1,path:'lib/core.mjs',effectState:'applied'},
    {seq:2,path:'test/api.core.js',effectState:'applied'},
    {seq:3,path:'test/api.core.js',effectState:'applied'}],executions:[],unresolvedErrors:[],pendingJobEvents:[]},evidence:[
    {seq:1,type:'tool/ptc-dispatch',data:'implementation\n'.repeat(1500)},
    {seq:2,type:'tool/ptc-dispatch',data:'initial checks\n'.repeat(900)},
    {seq:3,type:'tool/ptc-dispatch',data:'assert.strictEqual(result.re.source, expected.source)'}]};
  const result=scopeReviewSources(payload,process.cwd(),'auto');
  assert.equal(result.sourceReview.mode,'focused');
  assert.deepEqual(result.sourceReview.files,['lib/core.mjs']);
  assert.deepEqual(result.sourceReview.omittedFiles,[]);
  assert.ok(result.evidence.some(item=>item.seq===3&&item.data.includes('result.re.source')));
});

test('focused review retains a later check identified by a successful source read',()=>{
  const payload={observed:{mutation:{seq:3},artifacts:[
    {seq:1,path:'lib/core.mjs',effectState:'applied'},
    {seq:2,path:'test/api.core.js',effectState:'applied'}],executions:[],unresolvedErrors:[],pendingJobEvents:[]},evidence:[
    {seq:1,type:'tool/result',data:'implementation\n'.repeat(1500)},
    {seq:2,type:'tool/result',sourceFiles:['test/api.core.js'],data:'assert.strictEqual(result.match(input), expected.match(input))'}]};
  const result=scopeReviewSources(payload,process.cwd(),'auto');
  assert.ok(result.evidence.some(item=>item.seq===2));
});

test('a stored Tool-text verified edit for a check file is retained by focused scope',()=>{
  const call='Tool: verified_exec\nArguments: '+JSON.stringify({edits:[{file:'test/api.core.js',content:'CHECK_MARKER'}]});
  const payload={observed:{mutation:{seq:3},artifacts:[
    {seq:1,path:'lib/core.mjs',effectState:'applied'},
    {seq:2,path:'test/api.core.js',effectState:'applied'}],executions:[],unresolvedErrors:[],pendingJobEvents:[]},evidence:[
    {seq:1,type:'tool/result',data:'implementation\n'.repeat(2000)},
    {seq:2,type:'tool/result',data:call}]};
  const result=scopeReviewSources(payload,process.cwd(),'auto');
  assert.equal(result.sourceReview.mode,'focused');
  assert.ok(result.evidence.some(item=>item.seq===2),'the check edit is associated through its stored arguments');
});

test('review retains every bounded artifact and focused scope counts retained uncertain files',()=>{
  const artifacts=Array.from({length:9},(_,index)=>({seq:index+1,path:`src/file-${index}.mjs`,
    effectState:index===0?'unknown':'applied'}));
  const result=scopeReviewSources({observed:{mutation:{seq:9},artifacts,executions:[],unresolvedErrors:[],pendingJobEvents:[]},
    evidence:artifacts.map(item=>({seq:item.seq,type:'tool/result',data:'x'.repeat(5000)}))},process.cwd(),'auto');
  assert.equal(result.observed.artifacts.length,2);
  assert.equal(result.observed.artifacts.some(item=>item.effectState==='unknown'),true);
  assert.equal(result.sourceReview.mode,'focused');
  assert.equal(result.observed.artifacts.some(item=>item.effectState==='unknown'),true);
  assert.equal(result.sourceReview.omittedFiles.includes('src/file-0.mjs'),false);
});

// REMOVED: the two `quality review retains successful OPS source changes` cases
// drove review through ops_write_file / ops_edit_file / ops_read_files. Those
// tools were part of the dsh-ops adapter surface, and the OPS-only observation,
// pagination and source-excerpt branches they exercised were deleted with the
// adapters (see OPS-ADAPTERS-OPT-IN.md). The equivalent behaviour is still covered on the
// native path by the earlier cases in this file plus test/quality-review.test.mjs
// and test/native-cas.test.mjs; do not re-add an OPS-only variant.
