import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startHost,text,tool} from './helpers/host.mjs';

const lastValue=options=>JSON.parse(options.messages.findLast(message=>message.role==='tool').content.map(block=>block.text??'').join(''));
const outputs=host=>host.events.filter(event=>event.type==='tool/result').map(event=>{
  const body=event.data.message.content.map(block=>block.text??'').join('');
  try{return JSON.parse(body);}catch{return {text:body,isError:event.data.message.isError};}
});
const linuxDocker=process.platform!=='win32'&&process.env.DSH_TEST_LINUX_WORK_EXEC==='1';
const pythonImage=process.env.DSH_TEST_LINUX_PYTHON_IMAGE??'5f3c5824b551';
const nodeImage=process.env.DSH_TEST_LINUX_NODE_IMAGE??'node:24.22.1-bookworm-slim';

async function installBashDockerShim(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-linux-work-exec-bash-'));
  const executable=path.join(directory,'bash');
  await fs.writeFile(executable,`#!/bin/sh
set -eu
exec /usr/bin/docker run --rm -i --pull never --network none -v "$PWD:$PWD" -w "$PWD" "$WORK_EXEC_TEST_IMAGE" /usr/bin/bash "$@"
`,{mode:0o755});
  const previousPath=process.env.PATH??'';
  process.env.PATH=directory+path.delimiter+previousPath;
  process.env.WORK_EXEC_TEST_IMAGE=pythonImage;
  return async()=>{
    process.env.PATH=previousPath;
    delete process.env.WORK_EXEC_TEST_IMAGE;
    await fs.rm(directory,{recursive:true,force:true});
  };
}

async function assertWindowsNativeShell(){
  const trickyText="single ' double \" backslash \\\\ $(New-Item windows-injected) `New-Item tick-injected` $env:HOME 你好";
  const moduleCode='console.log('+JSON.stringify(trickyText)+');';
  let moduleRef;
  const host=await startHost({script:(options,request)=>{
    if(request===1)return [tool('work_exec',{runtime:'node',code:moduleCode})];
    if(request===2){
      moduleRef=lastValue(options).scriptRef;
      return [tool('work_exec',{runtime:'node',format:'commonjs',code:'const assert=require("node:assert/strict"); assert.equal(6*7,42); console.log("commonjs-ok");'})];
    }
    if(request===3)return [tool('work_exec',{scriptRef:moduleRef,edits:[{before:moduleCode,after:'console.log("windows-edited");'}]})];
    return [text('Windows 原生 pwsh 路径已完成。')];
  }});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'使用当前原生 shell 执行 Node 程序并沿用准确程序版本。');
    const [module,commonjs,edited]=outputs(host);
    assert.equal(module.exitCode,0);
    assert.equal(module.stdout.text,trickyText+'\n');
    assert.equal(commonjs.exitCode,0);
    assert.equal(commonjs.stdout.text,'commonjs-ok\n');
    assert.equal(edited.exitCode,0);
    assert.equal(edited.stdout.text,'windows-edited\n');
    assert.equal(edited.scriptReused,true);
    assert.deepEqual(edited.scriptSourceRefs,[moduleRef]);
    assert.equal(await fs.stat(path.join(host.cwd,'windows-injected')).then(()=>true,()=>false),false);
    assert.equal(await fs.stat(path.join(host.cwd,'tick-injected')).then(()=>true,()=>false),false);
  }finally{await host.close();}
}

async function assertLinuxNativeBash(){
  const restoreShim=await installBashDockerShim();
  const trickyText="single ' double \" backslash \\\\ $(touch python-injected) `touch tick-injected` ${HOME} 你好";
  const pythonCode='text = '+JSON.stringify(trickyText)+'\nprint(text)';
  const nodeCode='console.log('+JSON.stringify(trickyText)+');';
  let nodeRef;
  const host=await startHost({
    mountShell:false,extraMounts:[['dsh-bash-local',{}],['dsh-tool-bash',{}]],
    script:(options,request)=>{
      if(request===1){
        process.env.WORK_EXEC_TEST_IMAGE=pythonImage;
        return [tool('work_exec',{runtime:'python',executable:'/usr/bin/python3',code:pythonCode})];
      }
      if(request===2){
        process.env.WORK_EXEC_TEST_IMAGE=nodeImage;
        return [tool('work_exec',{runtime:'node',executable:'node',code:nodeCode})];
      }
      if(request===3){
        nodeRef=lastValue(options).scriptRef;
        return [tool('work_exec',{runtime:'node',format:'commonjs',executable:'node',code:'const assert=require("node:assert/strict"); assert.equal(6*7,42); console.log("commonjs-ok");'})];
      }
      if(request===4){
        process.env.WORK_EXEC_TEST_IMAGE=pythonImage;
        return [tool('work_exec',{runtime:'python',executable:'/usr/bin/python3',code:'import sys\nprint("native failure", file=sys.stderr)\nsys.exit(42)'})];
      }
      if(request===5){
        process.env.WORK_EXEC_TEST_IMAGE=nodeImage;
        return [tool('work_exec',{scriptRef:nodeRef,edits:[{before:JSON.stringify(trickyText),after:JSON.stringify('edited')}]})];
      }
      return [text('Linux work_exec 已按原生 bash 路径完成。')];
    }});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'用 work_exec 执行 Python 和 Node，并沿用准确程序版本。');
    const [python,node,commonjs,pythonFailure,edited]=outputs(host);
    assert.equal(python.exitCode,0);
    assert.equal(python.stdout.text,trickyText+'\n');
    assert.equal(node.exitCode,0);
    assert.equal(node.stdout.text,trickyText+'\n');
    assert.equal(commonjs.exitCode,0);
    assert.equal(commonjs.stdout.text,'commonjs-ok\n');
    assert.equal(pythonFailure.exitCode,42);
    assert.match(pythonFailure.stderr.text,/native failure/u);
    assert.equal(edited.exitCode,0);
    assert.equal(edited.stdout.text,'edited\n');
    assert.match(node.scriptEventRef,/^event:\d+$/u);
    assert.equal(edited.scriptReused,true);
    assert.deepEqual(edited.scriptSourceRefs,[nodeRef]);
    assert.equal(edited.scriptRuntime,'node');
    assert.equal(edited.scriptExecutable,'node');
    assert.equal(await fs.stat(path.join(host.cwd,'python-injected')).then(()=>true,()=>false),false);
    assert.equal(await fs.stat(path.join(host.cwd,'tick-injected')).then(()=>true,()=>false),false);
    const status=await host.command(agent,'detail');
    assert.equal(status.observability.features.inlineExec.applied,4);
    assert.equal(status.observability.features.inlineExec.failed,1);
  }finally{
    await host.close();
    await restoreShim();
  }
}

test('work_exec preserves complete scripts through the current platform native shell',async()=>{
  if(process.platform==='win32')return assertWindowsNativeShell();
  if(linuxDocker)return assertLinuxNativeBash();
  const host=await startHost({mountShell:false,script:(_options,request)=>request===1?
    [tool('work_exec',{runtime:'python',executable:'python3',code:'print(42)'})]:[text('保留不可用结果。')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'执行程序并保留真实不可用结果。');
    assert.deepEqual(outputs(host)[0],{status:'unavailable',reason:'native-bash-unavailable',executionOccurred:false});
  }finally{await host.close();}
});

test('work_exec reports the exact unavailable reason when no native shell tool is mounted',async()=>{
  const host=await startHost({mountShell:false,script:(_options,request)=>request===1?
    [tool('work_exec',{runtime:'python',code:'print(42)'})]:[text('保留不可用结果。')]});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'执行程序并保留真实不可用结果。');
    assert.deepEqual(outputs(host)[0],{
      status:'unavailable',
      reason:process.platform==='win32'?'native-pwsh-unavailable':'native-bash-unavailable',
      executionOccurred:false
    });
  }finally{await host.close();}
});
