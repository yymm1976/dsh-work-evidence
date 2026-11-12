import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
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
  const hadPath=Object.hasOwn(process.env,'PATH'),previousPath=process.env.PATH;
  const originalPath="'"+(previousPath??'').replaceAll("'","'\\''")+"'";
  const owner=path.basename(directory),dockerOptions={encoding:'utf8',timeout:15000,env:{...process.env,PATH:previousPath??''}};
  await fs.writeFile(executable,`#!/bin/sh
set -eu
PATH=${originalPath} exec docker run --rm -i --pull never --network none --label dsh-work-evidence-fixture=${owner} -e DSH_WORK_EVIDENCE_STDIN_ID -e DSH_WORK_EVIDENCE_STDIN_0 -e DSH_WORK_EVIDENCE_STDIN_1 -e DSH_WORK_EVIDENCE_STDIN_2 -v "$PWD:$PWD" -w "$PWD" "$WORK_EXEC_TEST_IMAGE" /usr/bin/bash "$@"
`,{mode:0o755});
  const hadImage=Object.hasOwn(process.env,'WORK_EXEC_TEST_IMAGE'),previousImage=process.env.WORK_EXEC_TEST_IMAGE;
  process.env.PATH=directory+path.delimiter+(previousPath??'');
  process.env.WORK_EXEC_TEST_IMAGE=pythonImage;
  return async()=>{
    const errors=[];
    try{
      // Killing the native Docker client may leave the container's PID 1 alive.
      const ids=execFileSync('docker',['ps','-aq','--no-trunc','--filter','label=dsh-work-evidence-fixture='+owner],dockerOptions).trim().split(/\s+/u).filter(Boolean);
      for(const id of ids)try{
        const [container]=JSON.parse(execFileSync('docker',['inspect',id],dockerOptions));
        assert.equal(container.Id,id);assert.equal(container.Config.Labels?.['dsh-work-evidence-fixture'],owner);
        if(container.State.Running)execFileSync('docker',['stop','--time','2',id],dockerOptions);
      }catch(error){errors.push(error);}
      const remaining=execFileSync('docker',['ps','-aq','--filter','label=dsh-work-evidence-fixture='+owner],dockerOptions).trim();
      if(remaining)errors.push(new Error('work_exec fixture containers remain after cleanup: '+remaining));
    }catch(error){errors.push(error);}
    finally{
      if(hadPath)process.env.PATH=previousPath;
      else delete process.env.PATH;
      if(hadImage)process.env.WORK_EXEC_TEST_IMAGE=previousImage;
      else delete process.env.WORK_EXEC_TEST_IMAGE;
      try{await fs.rm(directory,{recursive:true,force:true});}catch(error){errors.push(error);}
    }
    if(errors.length)throw new AggregateError(errors,'work_exec fixture container cleanup failed');
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

function paddedProgram(runtime,body){
  const prefix=runtime==='python'?'#':'//';
  const code=prefix+'界'.repeat(64000-prefix.length-body.length)+body;
  if(code.length!==64000)throw new Error('fixture program must contain exactly 64000 characters');
  return code;
}

async function assertLinuxNativeBash(){
  const expectedPath=process.env.PATH;
  const hadImage=Object.hasOwn(process.env,'WORK_EXEC_TEST_IMAGE'),expectedImage=process.env.WORK_EXEC_TEST_IMAGE;
  const restoreShim=await installBashDockerShim();
  const trickyText="single ' double \" backslash \\\\ $(touch python-injected) `touch tick-injected` ${HOME} 你好";
  const pythonCode='text = '+JSON.stringify(trickyText)+'\nprint(text)';
  const nodeCode='console.log('+JSON.stringify(trickyText)+');';
  const largePython=paddedProgram('python','\nprint("large-python-ok")');
  const largeNode=paddedProgram('node','\nconsole.log("large-node-ok");');
  const largeTimeout=paddedProgram('python','\nimport time\nprint("large-timeout-start", flush=True)\ntime.sleep(86400)');
  let nodeRef;
  let host,agent,failure,promotedJobId,promotedJobSettled=false;
  try{
    host=await startHost({
      workspace:{toolSurface:'full'},
      mountShell:false,extraMounts:[['dsh-bash-local',{}],['dsh-tool-bash',{}],['dsh-tool-jobs',{}]],
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
        if(request===6){
          process.env.WORK_EXEC_TEST_IMAGE=pythonImage;
          return [tool('work_exec',{runtime:'python',executable:'/usr/bin/python3',code:largePython,timeoutMs:60000})];
        }
        if(request===7){
          process.env.WORK_EXEC_TEST_IMAGE=nodeImage;
          return [tool('work_exec',{runtime:'node',executable:'node',code:largeNode,timeoutMs:60000})];
        }
        if(request===8){
          process.env.WORK_EXEC_TEST_IMAGE=pythonImage;
          return [tool('work_exec',{runtime:'python',executable:'/usr/bin/python3',code:largeTimeout,timeoutMs:3000})];
        }
        if(request===9){
          process.env.WORK_EXEC_TEST_IMAGE=nodeImage;
          return [tool('work_exec',{runtime:'node',code:'console.log(JSON.stringify(Object.keys(process.env).filter(key=>key.startsWith("DSH_WORK_EVIDENCE_STDIN"))));'})];
        }
        if(request===10)return [tool('bash',{description:'Check completed transport environment is absent',command:'env | grep "^DSH_WORK_EVIDENCE_STDIN"; result=$?; if [ "$result" = 1 ]; then printf "stdin-env-absent\\n"; else exit 1; fi',timeoutMs:10000})];
        return [text('Linux work_exec 已按原生 bash 路径完成。')];
      }
    });
    const nativeResults=[];
    host.ctx.on('tools/result',(execution,result)=>{if(execution.name==='bash')nativeResults.push(result.value?.data??result.value??result);});
    agent=await host.createAgent('max');
    await host.send(agent,'用 work_exec 执行 Python 和 Node，并沿用准确程序版本。');
    const [python,node,commonjs,pythonFailure,edited,largePythonResult,largeNodeResult,largeTimeoutResult,privateEnvironment]=outputs(host);
    promotedJobId=largeTimeoutResult?.jobId;
    const laterBash=nativeResults.at(-1);
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
    assert.equal(largePythonResult.exitCode,0);
    assert.equal(largePythonResult.stdout.text,'large-python-ok\n');
    assert.equal(largePythonResult.cwd,host.cwd);
    assert.equal(largeNodeResult.exitCode,0);
    assert.equal(largeNodeResult.stdout.text,'large-node-ok\n');
    assert.equal(largeNodeResult.cwd,host.cwd);
    assert.equal(largeTimeoutResult.kind,'promoted');
    assert.match(largeTimeoutResult.jobId,/^bash-/u);
    assert.equal(largeTimeoutResult.scriptChars,64000);
    assert.equal(largeTimeoutResult.scriptRuntime,'python');
    assert.equal(largeTimeoutResult.scriptExecutable,'/usr/bin/python3');
    assert.equal(privateEnvironment.exitCode,0);
    assert.equal(privateEnvironment.stdout.text,'[]\n');
    assert.equal(laterBash.exitCode,0,JSON.stringify(laterBash));
    assert.equal(laterBash.stdout.text,'stdin-env-absent\n');
    assert.equal(await fs.stat(path.join(host.cwd,'python-injected')).then(()=>true,()=>false),false);
    assert.equal(await fs.stat(path.join(host.cwd,'tick-injected')).then(()=>true,()=>false),false);
    const status=await host.command(agent,'detail');
    assert.equal(status.observability.features.inlineExec.applied,7);
    assert.equal(status.observability.features.inlineExec.failed,1);
    assert.equal(host.ctx.jobs.kill(largeTimeoutResult.jobId,agent.session.id,'transport fixture complete'),'requested');
    const settled=await host.ctx.jobs.wait(largeTimeoutResult.jobId,30000,agent.session.id,AbortSignal.timeout(32000));
    assert.equal(settled.status,'killed');
    promotedJobSettled=true;
    assert.deepEqual((await fs.readdir(host.cwd)).filter(name=>name.startsWith('.dsh-work-exec-')),[]);
  }catch(error){
    failure=error;
  }finally{
    const cleanupErrors=[];
    if(host&&agent&&!promotedJobSettled){
      const jobId=promotedJobId??outputs(host).find(value=>value.kind==='promoted'&&typeof value.jobId==='string')?.jobId;
      if(jobId)try{
        host.ctx.jobs.kill(jobId,agent.session.id,'failed transport fixture cleanup');
        const settled=await host.ctx.jobs.wait(jobId,30000,agent.session.id,AbortSignal.timeout(32000));
        if(['running','stopping'].includes(settled.status))throw new Error('work_exec fixture job did not settle during cleanup');
      }catch(error){cleanupErrors.push(error);}
    }
    if(host)try{await host.close();}catch(error){cleanupErrors.push(error);}
    try{await restoreShim();}catch(error){cleanupErrors.push(error);}
    if(process.env.PATH!==expectedPath)cleanupErrors.push(new Error('work_exec Linux test did not restore PATH'));
    if(hadImage?process.env.WORK_EXEC_TEST_IMAGE!==expectedImage:Object.hasOwn(process.env,'WORK_EXEC_TEST_IMAGE'))
      cleanupErrors.push(new Error('work_exec Linux test did not restore WORK_EXEC_TEST_IMAGE'));
    if(failure){
      if(cleanupErrors.length)failure.cleanupErrors=cleanupErrors;
      throw failure;
    }
    if(cleanupErrors.length===1)throw cleanupErrors[0];
    if(cleanupErrors.length>1)throw new AggregateError(cleanupErrors,'work_exec Linux test cleanup failed');
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
