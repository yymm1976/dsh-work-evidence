import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {startHost,text,tool} from './helpers/host.mjs';
import {OPS_ROOT} from './helpers/paths.mjs';
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

for(const toolMode of ['native','ptc'])test(`quality review retains successful OPS source changes (${toolMode})`,async t=>{
  const root=OPS_ROOT;
  const [file,discovery,ptc]=await Promise.all(['file','discovery','ptc'].map(name=>import(pathToFileURL(root+'/'+name+'/index.js').href)));
  const marker='OPS_MIDDLE_REQUIREMENT_BRANCH',body='/*\n'+'source heading\n'.repeat(250)+'*/\nexport const '+marker+' = true;\n/*\n'+'source tail\n'.repeat(250)+'original-ending\n*/\n';
  let payload,revision;
  const invoke=(name,args)=>toolMode==='native'?tool(name,args):tool('run_code',{code:'console.log(JSON.stringify(await tools.'+name+'('+JSON.stringify(args)+')));'});
  const host=await startHost({workspace:{qualityReview:true},toolMode,extraMounts:[...(toolMode==='ptc'?[['dsh-ptc-runtime-node']]:[]),
    [file,{promptPolicy:false,required:true}],[discovery,{alwaysLoaded:['stat','write_file','edit_file','inspect_local_file'],required:true}],
    ...(toolMode==='ptc'?[[ptc,{alwaysLoaded:['stat','write_file','edit_file','read_files'],required:true}]]:[])],script:(options,n)=>{
      if(n===1)return [invoke('ops_write_file',{path:'core.mjs',content:body,expectedRevision:'absent'})];
      if(n===2){const output=options.messages.findLast(message=>message.role==='tool').content.map(block=>block.text??'').join('');
        const result=toolMode==='ptc'?JSON.parse(output):null;revision=result?(result.data??result).revision:/\brevision=([a-f0-9]{64})\b/u.exec(output)?.[1];
        return [invoke('ops_write_file',{path:'core.mjs',expectedRevision:revision,content:'PREVIEWED_SOURCE_ONLY',dryRun:true})];}
      if(n===3)return [invoke('ops_edit_file',{path:'core.mjs',expectedRevision:revision,edits:[{oldText:'missing-source-text',newText:'FAILED_SOURCE_ONLY'}]})];
      if(n===4)return [invoke('ops_edit_file',{path:'core.mjs',expectedRevision:revision,edits:[{oldText:'original-ending',newText:'final-ending'}]})];
      if(n===5)return [toolMode==='ptc'?invoke('ops_read_files',{files:[{path:'core.mjs',offset:245,limit:20}]}):invoke('ops_inspect_local_file',{path:'core.mjs',offset:245,limit:20})];
      return [text('源码已写入并修正末尾。')];
    },auxiliary:options=>{payload=JSON.parse(options.messages[0].content[0].text);return [text('{"issues":[]}')];}});
  try{
    const agent=await host.createAgent('ultra');
    // OPS publishes scoped tool definitions asynchronously; wait for the PTC SDK too.
    let ready=false;
    for(let attempt=0;attempt<50&&!ready;attempt++){
      if(host.ctx.tools.get('ops_write_file',agent)){
        if(toolMode!=='ptc')ready=true;
        else{
          const assembly=await host.ctx.systemPrompt.assemble({agent,scope:agent});
          ready=(assembly.sections?.find(section=>section.name==='tools:sdk')?.text??'').includes('ops_write_file');
        }
      }
      if(!ready)await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(!ready)return t.skip('The optional dsh-ops file component publishes no write tools on this host.');
    await host.send(agent,'写入 core.mjs，再准确修正末尾，保留中间的需求分支。');
    assert.ok(payload,JSON.stringify({end:host.events.findLast(event=>event.type==='turn/end')?.data.reason,
      results:host.events.filter(event=>event.type==='tool/result').map(event=>event.data.message.content.map(block=>block.text??'').join('').slice(0,500))}));
    assert.ok(payload.observed.artifacts.some(item=>item.tool==='ops_edit_file'));
    const changes=payload.evidence.filter(item=>item.data.includes('successful-historical-change'));
    assert.ok(changes.some(item=>item.data.includes(marker)),'The OPS inserted source must reach review even after a later small edit.');
    assert.ok(changes.some(item=>item.data.includes('final-ending')));
    assert.ok(changes.every(item=>!item.data.includes('PREVIEWED_SOURCE_ONLY')&&!item.data.includes('FAILED_SOURCE_ONLY')));
    const sourceRead=host.events.findLast(event=>toolMode==='ptc'?event.type==='tool/ptc-dispatch'&&event.data.name==='ops_read_files':event.type==='tool/result');
    const read=payload.evidence.find(item=>item.seq===sourceRead.seq);
    assert.ok(read?.data.includes(marker),'A successful OPS read receives the same source excerpt allowance as a native read: '+JSON.stringify({
      seq:sourceRead.seq,evidenceChars:read?.data.length,head:read?.data.slice(0,300),tail:read?.data.slice(-300),
      originalChars:JSON.stringify(sourceRead.data).length,originalContainsMarker:JSON.stringify(sourceRead.data).includes(marker)}));
  }finally{await host.close();}
});
