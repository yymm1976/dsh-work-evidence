import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {startHost as baseStartHost,text,tool} from './helpers/host.mjs';
import {defaults} from '../runtime.mjs';

const startHost=options=>baseStartHost({...options,...(process.platform==='win32'?{}:
  {mountShell:false,extraMounts:[['dsh-bash-local',{}],['dsh-tool-bash',{}]]})});

const outputs=host=>host.events.filter(event=>event.type==='tool/result').map(event=>
  JSON.parse(event.data.message.content.map(block=>block.text??'').join('')));

async function withNoPathNode(run){
  const original=process.env.PATH;
  const marker=process.platform==='win32'?'node.exe':'node';
  const fs=await import('node:fs');
  process.env.PATH=(original??'').split(path.delimiter).filter(directory=>
    directory&&!fs.existsSync(path.join(directory,marker))).join(path.delimiter);
  try{return await run();}finally{process.env.PATH=original;}
}

test('host Node fallback is off by default and validates its setting',()=>{
  assert.equal(defaults().hostNodeFallback,false);
  assert.throws(()=>defaults({hostNodeFallback:'true'}),/Invalid hostNodeFallback/u);
});

test('missing PATH Node reuses the installed host runtime through the native shell',async()=>{
  let reference;
  const host=await startHost({pluginConfig:{hostNodeFallback:true,stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('work_exec',{runtime:'node',code:'console.log(JSON.stringify({answer:42,executable:process.execPath}));'})];
    if(n===2){
      const message=options.messages.findLast(message=>message.role==='tool');
      reference=JSON.parse(message.content.map(block=>block.text??'').join('')).scriptRef;
      return [tool('work_exec',{scriptRef:reference,edits:[{before:'answer:42',after:'answer:63'}]})];
    }
    return [text('done')];
  }});
  try{
    const agent=await host.createAgent('max');
    await withNoPathNode(()=>host.send(agent,'Run the JavaScript program and revise its exact version.'));
    const rows=outputs(host);
    assert.equal(rows.length,2);
    assert.equal(rows[0].exitCode,0);
    assert.deepEqual(JSON.parse(rows[0].stdout.text),{answer:42,executable:process.execPath});
    assert.equal(rows[0].scriptExecutable,process.execPath);
    assert.equal(rows[0].scriptExecutableSource,'host-node-runtime');
    assert.equal(rows[0].hostRuntimeSelection.pathNodeAvailable,false);
    assert.equal(rows[1].exitCode,0);
    assert.equal(JSON.parse(rows[1].stdout.text).answer,63);
    assert.equal(rows[1].scriptExecutable,process.execPath);
    assert.equal(rows[1].scriptReused,true);
  }finally{await host.close();}
});

test('an existing PATH Node remains selected when fallback is enabled',async()=>{
  const host=await startHost({pluginConfig:{hostNodeFallback:true,stepPacing:false},script:(_options,n)=>n===1?
    [tool('work_exec',{runtime:'node',code:'console.log(42);'})]:[text('done')]});
  try{
    const agent=await host.createAgent('max');
    const previousPath=process.env.PATH;
    if(process.platform!=='win32'){
      const executableDirectory=path.join(host.cwd,'available-node');
      await fs.mkdir(executableDirectory);await fs.symlink(process.execPath,path.join(executableDirectory,'node'));
      process.env.PATH=executableDirectory+path.delimiter+(previousPath??'');
    }
    try{await host.send(agent,'Run the JavaScript program.');}finally{process.env.PATH=previousPath;}
    const [row]=outputs(host);
    assert.equal(row.exitCode,0);assert.equal(row.stdout.text.trim(),'42');
    assert.equal(row.scriptExecutable,'node');assert.equal(row.scriptExecutableSource,null);
    assert.equal(row.hostRuntimeSelection,undefined);
  }finally{await host.close();}
});

test('explicit PATH and task-declared absolute interpreters never use the fallback',async()=>{
  const missing=path.resolve('missing-required-runtime','node'+(process.platform==='win32'?'.exe':''));
  const host=await startHost({pluginConfig:{hostNodeFallback:true,stepPacing:false},script:(_options,n)=>n===1?
    [tool('work_exec',{runtime:'node',executable:'node',code:'console.log(42);'})]:
    n===2?[tool('work_exec',{runtime:'node',executable:missing,code:'console.log(63);'})]:[text('done')]});
  try{
    const agent=await host.createAgent('max');
    await withNoPathNode(()=>host.send(agent,'Use the explicitly supplied interpreter for each call.'));
    const rows=outputs(host);assert.equal(rows.length,2);
    assert.equal(rows[0].hostRuntimeSelection,undefined);
    assert.notEqual(rows[0].exitCode,0);
    assert.equal(rows[1].executionOccurred,false);
    assert.equal(rows[1].error.code,'WORK_EXEC_EXECUTABLE_NOT_FOUND');
    assert.equal(rows[1].scriptExecutable,missing);
  }finally{await host.close();}
});

test('a textual interpreter constraint keeps native failure instead of substituting the host',async()=>{
  const host=await startHost({pluginConfig:{hostNodeFallback:true,stepPacing:false},script:(_options,n)=>n===1?
    [tool('work_exec',{runtime:'node',code:'console.log(42);'})]:[text('done')]});
  try{
    const agent=await host.createAgent('max');
    await withNoPathNode(()=>host.send(agent,'Use only the system Node interpreter; do not substitute a bundled runtime.'));
    const [row]=outputs(host);
    assert.equal(row.hostRuntimeSelection,undefined);
    assert.notEqual(row.exitCode,0);
    assert.equal(row.scriptExecutable,'node');
  }finally{await host.close();}
});

test('host fallback supplies no new interpreter in a native read-only session',async()=>{
  const host=await startHost({pluginConfig:{hostNodeFallback:true,stepPacing:false},script:()=>[text('ready')]});
  try{
    const agent=await host.createAgent('max');
    agent.session.append('sandbox/mode',{mode:'read-only',workspaceRoot:host.cwd});
    const code='(await import("node:fs/promises")).writeFile("must-not-exist.txt","changed");';
    const result=await withNoPathNode(()=>host.ctx.tools.execute({name:'work_exec',arguments:{runtime:'node',code},
      callId:'read-only-host-node',rootCallId:'read-only-host-node',agent,signal:AbortSignal.timeout(20000)}));
    assert.equal(result.value?.executionOccurred,false);
    assert.equal(result.value?.reason,'native-read-only-session');
    assert.equal(result.value?.isError,true);
    assert.equal(result.value?.hostRuntimeSelection,undefined);
    assert.notEqual(result.value?.exitCode,0);
    assert.equal(await fs.stat(path.join(host.cwd,'must-not-exist.txt')).then(()=>true,()=>false),false);
  }finally{await host.close();}
});

test('a read-only session also rejects an explicit interpreter with recovery disabled',async()=>{
  const host=await startHost({pluginConfig:{hostNodeFallback:false,stepPacing:false},script:()=>[text('ready')]});
  try{
    const agent=await host.createAgent('max');
    agent.session.append('sandbox/mode',{mode:'read-only',workspaceRoot:host.cwd});
    const code='await (await import("node:fs/promises")).writeFile("must-not-exist.txt","changed");';
    const result=await host.ctx.tools.execute({name:'work_exec',arguments:{runtime:'node',executable:process.execPath,code},
      callId:'read-only-explicit-node',rootCallId:'read-only-explicit-node',agent,signal:AbortSignal.timeout(20000)});
    assert.equal(result.value?.executionOccurred,false);
    assert.equal(result.value?.reason,'native-read-only-session');
    assert.equal(await fs.stat(path.join(host.cwd,'must-not-exist.txt')).then(()=>true,()=>false),false);
  }finally{await host.close();}
});
