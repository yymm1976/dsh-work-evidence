import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {sameDeclaredInlineExecutable} from '../inline-exec.mjs';
import {startHost as baseStartHost,text,tool} from './helpers/host.mjs';

const startHost=options=>baseStartHost({...options,...(process.platform==='win32'?{}:
  {mountShell:false,extraMounts:[['dsh-bash-local',{}],['dsh-tool-bash',{}]]})});
const command="node <<'JS'\nconsole.log(JSON.stringify({value:42,commonjs:typeof require==='function',argv:process.argv.length}));\nJS\n";
const rows=host=>host.events.filter(event=>event.type==='tool/result').map(event=>JSON.parse(event.data.message.content.map(block=>block.text??'').join('')));

test('a declared interpreter matches its actual file identity rather than a folded path',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'interpreter-identity-'));
  try{
    const first=path.join(directory,'first-node'),other=path.join(directory,'other-node'),alias=path.join(directory,'alias-node');
    await fs.writeFile(first,'same content');await fs.writeFile(other,'same content');await fs.link(first,alias);
    assert.equal(await sameDeclaredInlineExecutable(first,first),true);
    assert.equal(await sameDeclaredInlineExecutable(first,alias),true);
    assert.equal(await sameDeclaredInlineExecutable(first,other),false);
    assert.equal(await sameDeclaredInlineExecutable(first,path.join(directory,'missing')),false);
    assert.equal(await sameDeclaredInlineExecutable(first,'node'),false);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('recorded Bash stdin text runs through the current native executor and retains its CommonJS mode',async()=>{
  let reference='recorded-shell';
  const host=await startHost({pluginConfig:{nativeShellScriptReuse:true,stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('work_exec',{scriptRef:reference,edits:[{before:'value:42',after:'value:63'}]})];
    if(n===2){reference=JSON.parse(options.messages.findLast(message=>message.role==='tool').content[0].text).scriptRef;
      return [tool('work_exec',{scriptRef:reference,edits:[{before:'value:63',after:'value:84'}]})];}
    return [text('done')];
  }});
  try{
    const agent=await host.createAgent('max');
    agent.session.append('tool/call',{callId:'recorded-shell',name:'bash',arguments:{command}});
    const previousPath=process.env.PATH;
    try{process.env.PATH=path.dirname(process.execPath)+path.delimiter+(previousPath??'');
      await host.send(agent,'Revise the recorded JavaScript program.');
    }finally{process.env.PATH=previousPath;}
    const results=rows(host);assert.equal(results.length,2);
    for(const [index,result]of results.entries()){
      assert.equal(result.exitCode,0);
      assert.deepEqual(JSON.parse(result.stdout.text),{value:index===0?63:84,commonjs:true,argv:1});
      assert.equal(result.scriptShellSource.callId,'recorded-shell');
      assert.deepEqual(result.scriptShellSource.nativeArguments,[]);
      assert.equal(result.scriptExecutable,'node');
      assert.equal(result.hostRuntimeSelection,undefined);
    }
  }finally{await host.close();}
});

test('an explicit Shell reference remains unavailable while its feature is off',async()=>{
  const host=await startHost({pluginConfig:{nativeShellScriptReuse:false,stepPacing:false},script:()=>[text('unused')]});
  try{
    const agent=await host.createAgent('max');
    agent.session.append('tool/call',{callId:'recorded-shell',name:'bash',arguments:{command}});
    const result=await host.ctx.tools.execute({name:'work_exec',arguments:{scriptRef:'recorded-shell'},
      agent,callId:'disabled-ref',rootCallId:'disabled-ref',signal:AbortSignal.timeout(20000)});
    assert.equal(result.isError,true);
    assert.match(result.content[0].text,/does not identify/u);
  }finally{await host.close();}
});

test('a literal Shell reference cannot start a new process under the current read-only policy',async()=>{
  const host=await startHost({pluginConfig:{nativeShellScriptReuse:true,stepPacing:false},script:()=>[text('unused')]});
  try{
    const agent=await host.createAgent('max');
    agent.session.append('tool/call',{callId:'recorded-shell',name:'bash',arguments:{command}});
    agent.session.append('sandbox/mode',{mode:'read-only',workspaceRoot:host.cwd});
    const result=await host.ctx.tools.execute({name:'work_exec',arguments:{scriptRef:'recorded-shell'},
      agent,callId:'read-only-ref',rootCallId:'read-only-ref',signal:AbortSignal.timeout(20000)});
    assert.equal(result.value.executionOccurred,false);
    assert.equal(result.value.reason,'native-read-only-session');
  }finally{await host.close();}
});

test('an explicitly authorized interpreter alias retains the user declaration in its result',async()=>{
  const host=await startHost({pluginConfig:{nativeShellScriptReuse:true,stepPacing:false},script:()=>[text('unused')]});
  try{
    const agent=await host.createAgent('max'),alias=path.join(host.cwd,'authorized-node'+(process.platform==='win32'?'.exe':''));
    const declared=path.join(host.cwd,'node'+(process.platform==='win32'?'.exe':''));
    await fs.copyFile(process.execPath,declared);await fs.link(declared,alias);
    await host.send(agent,'Use the existing interpreter at "'+declared+'".');
    const result=await host.ctx.tools.execute({name:'work_exec',arguments:{runtime:'node',executable:alias,code:'console.log(42);'},
      agent,callId:'authorized-alias',rootCallId:'authorized-alias',signal:AbortSignal.timeout(30000)});
    assert.equal(result.value.exitCode,0,JSON.stringify(result));
    assert.equal(result.value.scriptExecutableSource.kind,'user');
    assert.equal(result.value.scriptExecutableAuthorization.declaredExecutable,declared);
    assert.equal(result.value.scriptExecutableAuthorization.matching,'filesystem-file-identity');
  }finally{await host.close();}
});
