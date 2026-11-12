import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createTaskFlow,textPaths} from '../task-flow.mjs';
import {defaults} from '../runtime.mjs';
import {startHost,text,tool,requestText} from './helpers/host.mjs';

const pending=value=>[{id:'request',role:'user',source:{kind:'user'},content:[{type:'text',text:value}]}];
function fixture(files,{blocked=[],stepPacing=true}={}){
  const root=path.resolve('source-location-fixture'),lookups=[],globs=[],decisions=[];
  const runtime={get:()=>({root,config:{...defaults(),stepPacing}}),isEnabled:()=>true,
    effects:{decide:(_agent,...entry)=>decisions.push(entry)},execFor:()=>({})};
  const nativeFiles={stat:async(_root,file)=>{
    lookups.push(file);
    if(blocked.includes(file))throw Object.assign(new Error('Unavailable source metadata'),{code:'EACCES'});
    return {path:path.resolve(root,file),exists:files.includes(file),type:files.includes(file)?'file':null};
  }};
  const flow=createTaskFlow({tools:{get:()=>true}},runtime,{nativeFiles,call:async(...args)=>{globs.push(args);return {isError:false,value:{paths:[]}};}});
  return {lookups,globs,decisions,run:value=>flow.startupPaths({session:{id:'source-location'}},pending(value),AbortSignal.timeout(10000))};
}

test('README preserves the authorized Magpie route and prevents model fallbacks',async()=>{
  const readme=await fs.readFile(path.resolve(import.meta.dirname,'..','README.md'),'utf8');
  assert.match(readme,/必须使用宿主提供的 Magpie 子代理入口/u);
  assert.match(readme,/`model: "opendesign\/deepseek-v4\.1-flash-eco"`/u);
  assert.match(readme,/`reasoning_effort: "max"`/u);
  assert.match(readme,/不得通过其他模型、后台 CLI 或另建用户聊天替代/u);
  assert.match(readme,/复审子代理只读/u);
  assert.match(readme,/没有报告不能记为已复审/u);
  assert.match(readme,/`subagent-unavailable`/u);
  assert.doesNotMatch(readme,/multi_agent_v1__spawn_agent\(\{/u);
  assert.doesNotMatch(readme,/必须使用 ZCode 的 Agent 工具启动/u);
});

test('reStructuredText paths are recognized alongside the existing source extensions',()=>{
  assert.deepEqual(textPaths('读 docs/README.rst、src/main.py 和 README.md。'),['docs/README.rst','src/main.py','README.md']);
  assert.deepEqual(textPaths('README.rstx'),[]);
});

test('a bare README resolves to the unique root file and preserves the mentioned source order',async()=>{
  const first=fixture(['README.rst','src/main.py']);
  assert.deepEqual(await first.run('先读 src/main.py，再在README补充用法。'),['src/main.py','README.rst']);
  assert.equal(first.globs.length,0);
  assert.equal(first.lookups.filter(file=>file==='README.rst').length,1);
  assert.deepEqual(await fixture(['README.rst','src/main.py']).run('先读 README，再读 src/main.py。'),['README.rst','src/main.py']);
});

test('ambiguous, absent or partly unavailable README names are not selected',async()=>{
  for(const files of [[],['README.md','README.rst']]){
    const f=fixture(files);assert.deepEqual(await f.run('在 README 补充用法。'),[]);
    assert.equal(f.lookups.length,4);assert.equal(f.globs.length,0);
    assert.ok(f.decisions.some(entry=>entry.includes('startup-readme-location-unavailable')));
  }
  const denied=fixture(['README.rst'],{blocked:['README.md']});
  assert.deepEqual(await denied.run('在 README 补充用法。'),[]);
  assert.ok(denied.decisions.some(entry=>entry.includes('startup-location-unavailable')));
});

test('a modification ban in a prohibited-action list does not suppress unrelated source discovery',async()=>{
  const f=fixture(['README.rst','pyproject.toml']);
  assert.deepEqual(await f.run('在 README 补充用法。不要安装依赖、修改 pyproject.toml、读取项目外文件、Git 写操作或派子代理。'),['README.rst','pyproject.toml']);
  assert.deepEqual(await fixture(['read.py']).run('Do not modify read.py.'),['read.py']);
});

test('negative read instructions, disabled discovery and nonliteral README names do not start optional lookups',async()=>{
  for(const value of ['不要读取README。','Do not read readme.','不要读取配置文件、README。','不要安装依赖、修改其他文件、读取README。','不要碰 README。','README_parser is a symbol.','查看 docs/README 的说明。']){
    const f=fixture(['README.rst']);assert.deepEqual(await f.run(value),[]);assert.equal(f.lookups.length,0,value);
  }
  const disabled=fixture(['README.rst'],{stepPacing:false});
  assert.deepEqual(await disabled.run('在 README 补充用法。'),[]);assert.equal(disabled.lookups.length,0);
});

test('a warmed writable first request locates README despite an explicit pyproject modification ban',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true},script:(options,n)=>{
    if(n===1){
      const locations=options.messages.filter(message=>message.source?.taskFlow?.key?.includes('startup'));
      assert.ok(locations.some(message=>message.content.some(block=>block.text?.includes('README.rst'))));
      assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read').length,0);
      return [tool('run_code',{code:'const r=await tools.read({file_path:"README.rst"});console.log(r.lines);',description:'Read the located task requirements'})];
    }
    return [text('首轮已取得说明文件位置。')];
  }});
  try{
    await Promise.all([fs.writeFile(path.join(host.cwd,'README.rst'),'requested source\n'),fs.writeFile(path.join(host.cwd,'pyproject.toml'),'[project]\nname="fixture"\n')]);
    const agent=await host.createAgent('max');await host.command(agent,'detail');
    await host.send(agent,'增加公开 API 并写入实现，在 README 补充用法。不要安装依赖、修改 pyproject.toml、读取项目外文件或派子代理。');
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read').length,1);
  }finally{await host.close();}
});

test('an explicit nested README.rst remains a literal path without a root-name search',async()=>{
  const f=fixture(['docs/README.rst','README.md']);
  assert.deepEqual(await f.run('读取 docs/README.rst。'),['docs/README.rst']);
  assert.deepEqual(f.lookups,['docs/README.rst']);assert.equal(f.globs.length,0);
});

test('the native first request receives the resolved filename without source text or an extra read',async()=>{
  const sentinel='not-yet-read-document-sentinel';
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true},script:(options,n)=>{
    if(n===1){
      const contexts=options.messages.filter(message=>message.source?.taskFlow).map(message=>(message.content??[]).map(block=>block.text??'').join('\n')).join('\n');
      assert.match(contexts,/README\.rst/u);assert.match(contexts,/src\/main\.py/u);
      assert.ok(!requestText(options).includes(sentinel));
      assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read').length,0);
      return [tool('run_code',{code:'const r=await Promise.all([tools.read({file_path:"README.rst"}),tools.read({file_path:"src/main.py"})]);console.log(r.map(x=>x.lines));',description:'Read the two located sources together'})];
    }
    return [text('已读取说明文件和源码。')];
  }});
  try{
    await fs.mkdir(path.join(host.cwd,'src'));
    await Promise.all([fs.writeFile(path.join(host.cwd,'README.rst'),sentinel),fs.writeFile(path.join(host.cwd,'src/main.py'),'print(42)\n')]);
    const agent=await host.createAgent('max');await host.send(agent,'读取 src/main.py 和 README，说明内容，不修改文件。');
    const reads=host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read');
    assert.deepEqual(reads.map(event=>event.data.arguments.file_path).sort(),['README.rst','src/main.py']);
    assert.equal(host.events.filter(event=>event.type==='tool/result'&&event.data.message.isError).length,0);
  }finally{await host.close();}
});
