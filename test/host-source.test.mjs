import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {startHost,text,tool} from './helpers/host.mjs';
import {OPS_ROOT,pythonExecutableAvailable} from './helpers/paths.mjs';

// OPS is a profile package, not part of the desktop runtime; skip when it is absent.
const opsRoot=OPS_ROOT;
const hasOps=existsSync(opsRoot+'/file/index.js');
const PYTHON=process.env.DSH_TEST_FASTEDIT_PYTHON||path.resolve(import.meta.dirname,'..','.fastedit-venv','Scripts','python.exe');

async function opsMounts(){
  const file=await import(pathToFileURL(opsRoot+'/file/index.js').href);
  const discovery=await import(pathToFileURL(opsRoot+'/discovery/index.js').href);
  return [[file,{promptPolicy:false,required:true}],[discovery,{enabled:true,alwaysLoaded:['stat','edit_file','write_file'],required:true}]];
}
const resultsOf=host=>host.events.filter(e=>e.type==='tool/result').map(e=>JSON.parse(e.data.message.content.map(b=>b.text??'').join('')));

async function run(steps,files,workspace={}){
  const host=await startHost({workspace:{toolSurface:'full',...workspace},extraMounts:await opsMounts(),script:(_o,n)=>steps[n-1]??[text('完成。')]});
  try{
    for(const [name,body] of Object.entries(files))await fs.writeFile(path.join(host.cwd,name),body);
    const agent=await host.createAgent('max');
    await host.send(agent,'按要求修改文件');
    const read=name=>fs.readFile(path.join(host.cwd,name),'utf8');
    return {results:resultsOf(host),read:Object.fromEntries(await Promise.all(Object.keys(files).map(async name=>[name,await read(name)])))};
  }finally{await host.close();}
}

test('verified_exec previews, applies through OPS revisions and deopts on a stale text', {skip:!hasOps}, async()=>{
  const edit={file:'a.txt',mode:'replace_exact',old_text:'hello',new_text:'world'};
  const {results,read}=await run([
    [tool('verified_exec',{summary:'预览',apply:false,edits:[edit]})],
    [tool('verified_exec',{summary:'应用',apply:true,edits:[edit]})],
    [tool('verified_exec',{summary:'旧文本已不存在',apply:true,edits:[edit]})],
    [tool('verified_exec',{summary:'新建',apply:true,edits:[{file:'b.txt',mode:'create',content:'new\n'}]})],
  ],{'a.txt':'hello\n'});
  assert.equal(results[0].status,'previewed');
  assert.equal(results[1].status,'applied');
  assert.equal(results[1].files[0].changed,1);
  assert.equal(read['a.txt'],'world\n');
  assert.notEqual(results[2].status,'applied','a missing old_text must not report success');
  assert.equal(results[3].status,'applied');
});

test('verified_exec keeps replacement text literal and addresses every edit in the original source', {skip:!hasOps}, async()=>{
  const literal="literal $$ $& $` $' second";
  const edits=[{file:'a.txt',mode:'replace_exact',old_text:'first',new_text:literal},
    {file:'a.txt',mode:'replace_exact',old_text:'second',new_text:'changed'}];
  const {results,read}=await run([
    [tool('verified_exec',{summary:'Preview the requested literal edits',apply:false,edits})],
    [tool('verified_exec',{summary:'Apply the requested literal edits',apply:true,edits})],
  ],{'a.txt':'first second\n'});
  assert.equal(results[0].status,'previewed');assert.equal(results[1].status,'applied');
  assert.equal(read['a.txt'],literal+' changed\n');
});

test('fastedit_java finds, reads and replaces one method through the native pwsh bridge', {skip:!hasOps||!pythonExecutableAvailable(PYTHON)}, async()=>{
  const java='public class Calc {\n  public int add(int a, int b) {\n    return a + b;\n  }\n\n  public int sub(int a, int b) {\n    return a - b;\n  }\n}\n';
  const replacement='public int add(int a, int b) {\n    return b + a;\n  }';
  const {results,read}=await run([
    [tool('fastedit_java',{file:'Calc.java',operation:'find_entity',symbol:'Calc.add'})],
    [tool('fastedit_java',{file:'Calc.java',operation:'read_entity',symbol:'Calc.add'})],
    [tool('fastedit_java',{file:'Calc.java',operation:'replace_symbol',symbol:'Calc.add',snippet:replacement})],
    [tool('fastedit_java',{file:'Calc.java',operation:'replace_symbol',symbol:'Calc.add',snippet:replacement,apply:true})],
    [tool('fastedit_java',{file:'Calc.java',operation:'read_entity',symbol:'Calc.missing'})],
  ],{'Calc.java':java},{fastEditPython:PYTHON});
  assert.equal(results[0].status,'found');
  assert.equal(results[0].matches[0].line_start,2);
  assert.equal(results[1].status,'read');
  assert.match(results[1].text,/return a \+ b;/);
  assert.notEqual(results[2].status,'applied','a preview leaves the file unchanged');
  assert.equal(results[3].status,'applied');
  assert.match(read['Calc.java'],/return b \+ a;/);
  assert.match(read['Calc.java'],/return a - b;/,'the other method is untouched');
  assert.equal(results[4].status,'deopt');
});

test('fastEditEnabled disables fastedit_java and restores it in the same host session', {skip:!hasOps||!pythonExecutableAvailable(PYTHON)}, async()=>{
  const java='public class Calc {\n  public int add(int a, int b) {\n    return a + b;\n  }\n}\n';
  const host=await startHost({workspace:{toolSurface:'full',fastEditEnabled:false,fastEditPython:PYTHON},extraMounts:await opsMounts(),
    script:(_o,n)=>n===1||n===3?[tool('fastedit_java',{file:'Calc.java',operation:'find_entity',symbol:'Calc.add'})]:[text('已记录结果。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'Calc.java'),java);
    const agent=await host.createAgent('max');
    await host.send(agent,'定位 Calc.add。');
    assert.equal(resultsOf(host).at(-1).reason,'fastedit-disabled');
    const changed=await host.command(agent,'feature fastEditEnabled on');
    assert.equal(changed.readiness.features[0].configured,true);
    await host.send(agent,'再次定位 Calc.add。');
    const restored=resultsOf(host).at(-1);
    assert.equal(restored.status,'found',JSON.stringify(restored));
  }finally{await host.close();}
});

test('readArgumentRecovery corrects a flat OPS read once and can be disabled', {skip:!hasOps}, async()=>{
  for(const readArgumentRecovery of [true,false]){
    const host=await startHost({workspace:{toolSurface:'full',readArgumentRecovery},extraMounts:await opsMounts(),
      script:(_o,n)=>n===1?[tool('ops_read_files',{path:'a.txt',offset:1,limit:10})]:[text('完成。')]});
    try{
      await fs.writeFile(path.join(host.cwd,'a.txt'),'expected source\n');
      const agent=await host.createAgent('max');await host.send(agent,'读取 a.txt');
      const result=host.events.filter(e=>e.type==='tool/result').at(-1);
      const body=result.data.message.content.map(b=>b.text??'').join('');
      assert.equal(body.includes('expected source'),readArgumentRecovery);
      if(!readArgumentRecovery)assert.match(body,/error|invalid|files/i);
    }finally{await host.close();}
  }
});

test('native read aliases preserve line records, execute once and keep conflicts as errors',async()=>{
  for(const [readArgumentRecovery,args,success,guarded=false]of [
    [true,{path:'a.txt',offset:2,limit:1},true],
    [false,{path:'a.txt',offset:2,limit:1},false],
    [true,{path:'a.txt',file_path:'other.txt'},false],
    [true,{path:'a.txt'},false,true],
  ]){
    const host=await startHost({workspace:{readArgumentRecovery},script:(_o,n)=>n===1?[tool('read',args)]:[text('完成。')]});
    try{
      await fs.writeFile(path.join(host.cwd,'a.txt'),'first\nsecond\nthird\n');
      await fs.writeFile(path.join(host.cwd,'other.txt'),'another explicit target\n');
      let reads=0;
      host.ctx.on('fs/observed',(target,info)=>{if(target.displayPath===path.join(host.cwd,'a.txt')&&info.kind==='present')reads++;});
      if(guarded)host.ctx.tools.guard(exec=>exec.name==='read'&&exec.arguments.file_path==='a.txt'?'native read guard denied the target':undefined);
      const agent=await host.createAgent('max');await host.send(agent,'读取已指定的文件范围');
      const message=host.events.findLast(event=>event.type==='tool/result').data.message;
      assert.equal(!message.isError,success,JSON.stringify(message.content));
      assert.equal(reads,success?1:0,'argument aliases never cause two file reads or select a conflicting path');
      if(success){
        assert.match(message.content.map(block=>block.text??'').join(''),/2: second/);
        const status=await host.command(agent,'detail');
        assert.equal(status.metrics.readArgumentNormalizations,1);
        assert.equal((await host.command(agent,'feature readArgumentRecovery')).features[0].effect.status,'applied');
      }
      if(args.file_path)assert.match(message.content.map(block=>block.text??'').join(''),/Conflicting read path/);
      if(guarded)assert.match(message.content.map(block=>block.text??'').join(''),/native read guard denied/);
    }finally{await host.close();}
  }
});

test('native one-shot read recovery recalls recorded lines without reading the changed file again',async()=>{
  let recalled=null;
  const body='recorded source before external change\n';
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false},
    script:async(options,n)=>{
      if(n===1)return [tool('run_code',{code:'const r=await tools.read({file_path:"a.txt"});console.log(r.content);',description:'Read source'})];
      if(n===2){
        const result=options.messages.findLast(message=>message.role==='tool');
        const output=result?.content?.map(block=>block.text??'').join('')??'';
        assert.match(output,/recorded source before external change/,'the omitted short source is recovered in the tool output');
        const read=host.events.findLast(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read');
        recalled={kind:'event',seq:read.seq,offset:0,maxChars:16000};
        await fs.writeFile(path.join(host.cwd,'a.txt'),'changed current source\n');
        return [tool('run_code',{code:'return await tools.work_recall('+JSON.stringify(recalled)+');',description:'Recall recorded source'})];
      }
      return [text('完成。')];
    }});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),body);
    const agent=await host.createAgent('max');await host.send(agent,'读取 a.txt 并返回原文，不修改文件。');
    const reads=host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read');
    assert.equal(reads.length,1);
    assert.equal(recalled?.seq,reads[0].seq);
    const result=host.events.findLast(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='work_recall');
    const output=result?.data.content.map(block=>block.text??'').join('')??'';
    assert.match(output,/recorded source before external change/);
    assert.doesNotMatch(output,/changed current source/);
    assert.match(output,/historical/);
    assert.equal(await fs.readFile(path.join(host.cwd,'a.txt'),'utf8'),'changed current source\n');
  }finally{await host.close();}
});

test('native read output recovery preserves outcomes and keeps long or deliberately selected output unchanged',async()=>{
  for(const [body,code,recovered,failed]of [
    ['short source\n','const r=await tools.read({file_path:"a.txt"});console.log(r.content.slice(0));',true,true],
    ['short source\n','const r=await tools.read({file_path:"a.txt"});console.log(r.lines.length);',false,false],
    ['','const r=await tools.read({file_path:"a.txt"});console.log(r?.text??"");',false,false],
    ['long source body\n'.repeat(300),'const r=await tools.read({file_path:"a.txt"});console.log(r.content);',false,false],
  ]){
    let observed;
    const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false},
      script:(_options,n)=>n===1?[tool('run_code',{code,description:'Read source'})]:[text('完成。')]});
    host.ctx.on('tools/result',(exec,result)=>{if(exec.name==='run_code')observed=result;});
    try{
      await fs.writeFile(path.join(host.cwd,'a.txt'),body);
      const agent=await host.createAgent('max');await host.send(agent,'读取 a.txt，不修改文件。');
      assert.equal(observed?.isError,failed);
      const output=observed?.content.map(block=>block.text??'').join('')??'';
      assert.equal(output.includes('[Work Evidence recovered native read output]'),recovered);
      if(failed)assert.match(output,/Cannot read properties of undefined/);
      else assert.ok(observed.value?.logs,'the original typed PTC value is retained');
      assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read').length,1);
    }finally{await host.close();}
  }
});

