import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {startHost,text,tool} from './helpers/host.mjs';

// OPS is a profile package, not part of the desktop runtime; skip when it is absent.
const OPS_ROOT='C:/Users/杨铭/Documents/DSH Desktop/home/profiles/web/node_modules/dsh-ops/lib/components';
const hasOps=existsSync(OPS_ROOT+'/file/index.js');
const PYTHON=process.env.DSH_TEST_FASTEDIT_PYTHON??path.resolve(import.meta.dirname,'..','.fastedit-venv','Scripts','python.exe');

async function opsMounts(){
  const file=await import(pathToFileURL(OPS_ROOT+'/file/index.js').href);
  const discovery=await import(pathToFileURL(OPS_ROOT+'/discovery/index.js').href);
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

test('fastedit_java finds, reads and replaces one method through the native pwsh bridge', {skip:!hasOps||!existsSync(PYTHON)}, async()=>{
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

