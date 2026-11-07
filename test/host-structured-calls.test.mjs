import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,systemOf} from './helpers/host.mjs';
import {DSH_PYTHON} from './helpers/paths.mjs';
import {installStructuredCalls} from '../structured-calls.mjs';

const rootValue=options=>JSON.parse(options.messages.findLast(message=>message.role==='tool').content.map(block=>block.text??'').join('').replace(/\nFile sandbox[^\r\n]*$/u,''));
const ptc={toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']]};

test('structured calls stay absent by default and regular JavaScript still executes',async()=>{
  const host=await startHost({...ptc,script:(options,n)=>{
    const transport=options.tools.find(item=>item.name==='run_code');
    assert.equal(transport.parameters.properties.calls,undefined);
    assert.match(systemOf(options),/`run_code` takes two required arguments: `code`/u);
    return n===1?[tool('run_code',{code:'return 42;',description:'Run the original JavaScript transport'})]:[text('42')];
  }});
  try{const agent=await host.createAgent('max');await host.send(agent,'运行原生程序。');assert.equal(rootValue(host.requests.at(-1)),42);}
  finally{await host.close();}
});

test('structured edits preserve literal program text and sequential reads see the written value',async()=>{
  const content='中文 `quoted` ${unchanged} \\n \\b\n"double" and \'single\'\n';
  let result;
  const host=await startHost({...ptc,pluginConfig:{structuredCalls:true,stepPacing:false},script:(options,n)=>{
    if(n===1){
      const transport=options.tools.find(item=>item.name==='run_code');
      assert.ok(transport.parameters.properties.calls);
      assert.ok(!transport.parameters.required?.includes('code'));
      assert.match(systemOf(options),/`run_code` accepts exactly one of `code` or `calls`/u);
      assert.doesNotMatch(systemOf(options),/`run_code` takes two required arguments: `code`/u);
      assert.match(systemOf(options),/`run_code` is the only tool you can call directly/u);
      assert.match(systemOf(options),/Program-only SDK bindings:/u);
      return [tool('run_code',{calls:[{name:'write',arguments:{file_path:'literal.py',content}},
        {name:'read',arguments:{file_path:'literal.py',offset:1,limit:20}}],description:'Write and read literal source data'})];
    }
    result=rootValue(options);return [text('原文已保存。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'保存给定源码并读取结果。');
    assert.equal(await fs.readFile(path.join(host.cwd,'literal.py'),'utf8'),content);
    assert.equal(result.length,2);assert.equal(result[1].lines[0].text,content.split('\n')[0]);
    assert.equal(result[0].submittedContentMatchesAfter,true,'the native write confirms the exact submitted string without requiring another read');
    const dispatches=host.events.filter(event=>event.type==='tool/ptc-dispatch');
    assert.deepEqual(dispatches.map(event=>event.data.name),['write','read']);
    assert.equal(dispatches[0].data.arguments.content,content);
    const status=await host.command(agent,'detail');assert.equal(status.observability.features.structuredCalls.applied,1);
  }finally{await host.close();}
});

test('unsupported runtime and unknown SDK instructions retain native transport without hidden forwarding',async()=>{
  const nativeText='`run_code` takes two required arguments: `code`, the program to execute, and `description`, a short summary of what the program does. Native bindings and restrictions remain.';
  for(const setup of [{language:'python',programFormat:'function-body'},{language:'typescript',programFormat:'repl'},
    {language:'typescript',programFormat:'function-body',sdkText:'New unrecognized SDK instructions'}]){
    const hooks=new Map(),agent={},config={structuredCalls:true};
    const ctx={get:()=>setup,tools:{modeFor:()=> 'ptc'},on:(name,fn)=>hooks.set(name,fn)};
    installStructuredCalls(ctx,{isEnabled:()=>true,get:()=>({config})});
    const original={name:'run_code',description:'Native transport',parameters:{type:'object',required:['code'],properties:{code:{type:'string'}}}};
    const assembly={tools:[original],sections:[{name:'tools:sdk',text:setup.sdkText??nativeText}]};
    await hooks.get('system-prompt/assemble')(assembly,{agent},async()=>assembly);
    assert.equal(assembly.tools[0],original);assert.equal(assembly.sections[0].text,setup.sdkText??nativeText);
    const args={calls:[{name:'write',arguments:{file_path:'untouched.txt',content:'no'}}]},exec={agent,name:'run_code',arguments:args};
    let nextCalls=0;await hooks.get('tools/pre-execute')(exec,async()=>{nextCalls++;});
    assert.equal(nextCalls,1);assert.equal(exec.arguments,args);assert.equal(exec.arguments.code,undefined);
  }
});

test('structured script execution keeps native process output and script-reference metadata',async()=>{
  const results=[];
  const host=await startHost({...ptc,pluginConfig:{structuredCalls:true,stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{calls:[{name:'work_exec',arguments:{runtime:'node',code:'console.log(42);'}}],description:'Run a complete program without a JavaScript string wrapper'})];
    results.push(rootValue(options));
    if(n===2)return [tool('run_code',{calls:[{name:'work_exec',arguments:{runtime:'python',executable:DSH_PYTHON,code:'print(42)'}}],description:'Run the existing Python interpreter through the same native tool'})];
    return [text('42')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行已有程序。');
    for(const result of results){assert.equal(result.exitCode,0);assert.equal(result.stdout.text.trim(),'42');assert.match(result.scriptEventRef,/^event:\d+$/u);}
    assert.deepEqual(results.map(result=>result.scriptRuntime),['node','python']);
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='work_exec').length,2);
  }finally{await host.close();}
});

test('structured batches reject every unavailable name before dispatching any earlier write',async()=>{
  const host=await startHost({...ptc,pluginConfig:{structuredCalls:true,stepPacing:false},script:(_options,n)=>n===1?
    [tool('run_code',{calls:[{name:'write',arguments:{file_path:'must-not-exist.txt',content:'no'}},
      {name:'missing-native-tool',arguments:{}}],description:'Reject the incomplete tool set'})]:[text('工具不可用。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'检查无效工具名。');
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch').length,0);
    await assert.rejects(fs.stat(path.join(host.cwd,'must-not-exist.txt')),{code:'ENOENT'});
    assert.ok(host.events.some(event=>event.type==='tool/result'&&event.data.message.isError));
  }finally{await host.close();}
});

test('a sequential native failure retains earlier effects and does not dispatch later calls',async()=>{
  const host=await startHost({...ptc,pluginConfig:{structuredCalls:true,stepPacing:false},script:(_options,n)=>n===1?
    [tool('run_code',{calls:[{name:'write',arguments:{file_path:'first.txt',content:'retained'}},
      {name:'read',arguments:{file_path:'missing.txt'}},{name:'write',arguments:{file_path:'later.txt',content:'must not run'}}],description:'Preserve native stop-on-error behavior'})]:[text('读取失败，前面的写入仍保留。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'依次执行，失败后停止。');
    assert.equal(await fs.readFile(path.join(host.cwd,'first.txt'),'utf8'),'retained');
    await assert.rejects(fs.stat(path.join(host.cwd,'later.txt')),{code:'ENOENT'});
    assert.deepEqual(host.events.filter(event=>event.type==='tool/ptc-dispatch').map(event=>[event.data.name,event.data.isError]),[['write',false],['read',true]]);
  }finally{await host.close();}
});

test('structured calls preserve native execution guards and explicit parallel result ordering',async()=>{
  let result;
  const host=await startHost({...ptc,pluginConfig:{structuredCalls:true,stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{calls:[{name:'read',arguments:{file_path:'a.txt'}},{name:'read',arguments:{file_path:'b.txt'}}],parallel:true,description:'Read independent inputs'})];
    if(n===2){result=rootValue(options);return [tool('run_code',{calls:[{name:'write',arguments:{file_path:'denied.txt',content:'no'}}],description:'Exercise the native read-only boundary'})];}
    if(n===3)return [tool('run_code',{code:'return await tools.write({file_path:"denied-js.txt",content:"no"});',description:'Apply the same native guard to the original JavaScript form'})];
    return [text('读取完成，写入被拒绝。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'A');await fs.writeFile(path.join(host.cwd,'b.txt'),'B');
    const agent=await host.createAgent('max');
    agent.ctx.tools.guard(exec=>exec.name==='write'?'Writes denied by the native execution guard':undefined);
    await host.send(agent,'读取现有文件，并保留原生守卫对写入的拒绝。');
    assert.deepEqual(result.map(value=>value.lines[0].text),['A','B']);
    await assert.rejects(fs.stat(path.join(host.cwd,'denied.txt')),{code:'ENOENT'});
    await assert.rejects(fs.stat(path.join(host.cwd,'denied-js.txt')),{code:'ENOENT'});
    assert.equal(host.events.filter(event=>event.type==='tool/result'&&event.data.message.isError).length,2);
  }finally{await host.close();}
});

test('structured calls reject mixed programs and recursion without executing either path',async()=>{
  const host=await startHost({...ptc,pluginConfig:{structuredCalls:true,stepPacing:false},script:(_options,n)=>n===1?
    [tool('run_code',{code:'await tools.write({file_path:"bad.txt",content:"no"});',calls:[{name:'read',arguments:{file_path:'missing'}}],description:'Reject ambiguous input'})]:n===2?
    [tool('run_code',{calls:[{name:'run_code',arguments:{code:'return 42;'}}],description:'Reject recursive transport'})]:[text('两次均未执行。')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'检查不允许的调用形式。');
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch').length,0);
    await assert.rejects(fs.stat(path.join(host.cwd,'bad.txt')),{code:'ENOENT'});
  }finally{await host.close();}
});

test('disabling Work Evidence removes structured schemas and stops forwarding in the next request',async()=>{
  const host=await startHost({...ptc,pluginConfig:{structuredCalls:true,stepPacing:false},script:(options,n)=>{
    const declared=!!options.tools.find(item=>item.name==='run_code').parameters.properties.calls;
    if(n===1){assert.equal(declared,true);return [text('候选已开启。')];}
    assert.equal(declared,false);
    if(n===2)return [tool('run_code',{calls:[{name:'write',arguments:{file_path:'disabled.txt',content:'no'}}],description:'The disabled extension must not forward calls'})];
    return [text('插件已关闭。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'查询候选状态。');
    await host.command(agent,'off');await host.send(agent,'保持插件关闭。');
    await assert.rejects(fs.stat(path.join(host.cwd,'disabled.txt')),{code:'ENOENT'});
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch').length,0);
    assert.equal((await host.command(agent,'detail')).effective,false);
  }finally{await host.close();}
});

test('compact edit results omit full source bodies while full results preserve them explicitly',async()=>{
  const original='large source body\n'.repeat(1000);let compact,full;
  const host=await startHost({...ptc,pluginConfig:{structuredCalls:true,stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{calls:[{name:'edit',arguments:{file_path:'large.txt',old_string:'large source body',new_string:'changed source body',replace_all:true}}],description:'Return compact native edit metadata'})];
    if(n===2){compact=rootValue(options);return [tool('run_code',{calls:[{name:'edit',arguments:{file_path:'large.txt',old_string:'changed source body',new_string:'final source body',replace_all:true}}],resultView:'full',description:'Explicitly retain native full source values'})];}
    full=rootValue(options);return [text('两次修改均完成。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'large.txt'),original);
    const agent=await host.createAgent('max');await host.send(agent,'修改已有文件，分别查看简明结果与完整结果。');
    assert.equal(compact.before,undefined);assert.equal(compact.after,undefined);
    assert.deepEqual(compact.omittedFileText,{before:{chars:original.length},after:{chars:'changed source body\n'.repeat(1000).length}});
    assert.equal(full.before,'changed source body\n'.repeat(1000));assert.equal(full.after,'final source body\n'.repeat(1000));
    assert.equal(full.omittedFileText,undefined);
    assert.equal(await fs.readFile(path.join(host.cwd,'large.txt'),'utf8'),full.after);
  }finally{await host.close();}
});

test('compact write confirmation preserves mismatches and errors and does not invent missing native evidence',async()=>{
  const submitted='supplied literal ${name} \\b\n';
  for(const [nativeValue,resultView]of [
    [{path:'literal.txt',operation:'create',before:null,after:submitted},'compact'],
    [{path:'literal.txt',operation:'create',before:null,after:'different native text'},'compact'],
    [{path:'literal.txt',after:submitted,error:{message:'partial write'}},'compact'],
    [{path:'literal.txt',after:submitted,success:false},'compact'],
    [{path:'literal.txt',operation:'create'},'compact'],
    [{path:'literal.txt',operation:'create',before:null,after:submitted},'full'],
  ]){
    const hooks=new Map(),agent={},ctx={get:()=>({language:'typescript',programFormat:'function-body'}),
      tools:{modeFor:()=> 'ptc',get:name=>name==='write'?{}:null},on:(name,fn)=>hooks.set(name,fn)};
    installStructuredCalls(ctx,{isEnabled:()=>true,get:()=>({config:{structuredCalls:true}})});
    const assembly={tools:[{name:'run_code',description:'Native transport',parameters:{type:'object',required:['code'],properties:{code:{type:'string'}}}}],
      sections:[{name:'tools:sdk',text:'`run_code` takes two required arguments: `code`, the program to execute, and `description`, a short summary of what the program does.'}]};
    await hooks.get('system-prompt/assemble')(assembly,{agent},async()=>assembly);
    const exec={agent,name:'run_code',arguments:{calls:[{name:'write',arguments:{file_path:'literal.txt',content:submitted}}],resultView}};
    await hooks.get('tools/pre-execute')(exec,async()=>{});
    let output;
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    await new AsyncFunction('tools','console',exec.arguments.code)({write:async()=>nativeValue},{log:value=>{output=JSON.parse(value);}});
    if(resultView==='full'||nativeValue.error||nativeValue.success===false){assert.deepEqual(output,nativeValue);continue;}
    if(typeof nativeValue.after!=='string'){assert.equal(output.submittedContentMatchesAfter,undefined);continue;}
    const matches=nativeValue.after===submitted;
    assert.equal(output.submittedContentMatchesAfter,matches);
    if(matches){assert.equal(output.after,undefined);assert.deepEqual(output.omittedFileText.after,{chars:submitted.length});}
    else assert.equal(output.after,nativeValue.after,'a native mismatch must remain visible');
  }
});
