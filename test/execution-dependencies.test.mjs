import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createExecutionDependencies,dependencyExecutionComplete} from '../execution-dependencies.mjs';

test('dependency completion checks status, state, and nested job status independently',()=>{
  for(const status of ['failed','running','pending']){
    for(const detail of [{state:status},{job:{status}},{status:'completed',state:status},{state:'completed',job:{status}}])
      assert.equal(dependencyExecutionComplete({exitCode:0,...detail}),false,JSON.stringify(detail));
  }
});

test('legacy zero exit and completed job observations remain complete',()=>{
  assert.equal(dependencyExecutionComplete({exitCode:0}),true);
  assert.equal(dependencyExecutionComplete({job:{status:'completed'}}),true);
  assert.equal(dependencyExecutionComplete({status:'completed',state:'completed',job:{status:'completed'},exitCode:0}),true);
  assert.equal(dependencyExecutionComplete({value:{data:{data:{exitCode:0}}}}),true);
});

test('an inner zero exit cannot erase explicit failures or incomplete flags in any outer data layer',()=>{
  for(const marker of [{status:'failed'},{state:'pending'},{job:{status:'running'}},{success:false},{ok:false},{exitCode:2},
    {completed:false},{complete:false},{executionCompleted:false},{partial:true},{outputPartial:true},{truncated:true},{lossy:true},
    {signal:'SIGTERM'},{stopped:true},{kind:'background',job:{kind:'foreground'}},{kind:'foreground',job:{kind:'background'}}]){
    for(const wrapped of [false,true]){
      const raw={...marker,data:{status:'completed',exitCode:0}},result={value:wrapped?{status:'completed',data:raw}:raw};
      assert.equal(dependencyExecutionComplete(result),false,JSON.stringify({marker,wrapped}));
    }
  }
});

test('every declared status in a data chain must be completed before completion can be certified',()=>{
  for(const status of ['incomplete','success','succeeded','not-a-terminal-status',''])for(const field of ['status','state','job']){
    const marker=field==='job'?{job:{status}}:{[field]:status};
    for(const data of [marker,{status:'completed',exitCode:0,data:marker}]){
      assert.equal(dependencyExecutionComplete({value:{status:'completed',exitCode:0,data:{status:'completed',exitCode:0,data}}}),false);
    }
  }
  assert.equal(dependencyExecutionComplete({value:{status:'completed',data:{status:'completed',exitCode:0,data:{status:'completed'}}}}),true);
});

test('file dependency invalidation follows the physical alias of one workspace file',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'we-dependency-alias-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'Source.txt');
  await fs.writeFile(file,'value\n');
  let alias='SOURCE.TXT';
  const caseAlias=await fs.stat(path.join(root,alias)).then(()=>true,()=>false);
  if(!caseAlias){
    alias='source-alias.txt';
    try{await fs.symlink(file,path.join(root,alias),'file');}
    catch(error){t.skip('The host cannot create a file alias for this check: '+error.code);return;}
  }
  const nativeFiles={async stat(_root,source){
    const absolute=path.resolve(root,source);
    return {path:absolute,exists:true,type:'file',version:'v1',targetKey:'physical-one'};
  }};
  const dependencies=createExecutionDependencies(nativeFiles);
  const before=await dependencies.capture(root,['Source.txt'],new AbortController().signal);
  const finished=await dependencies.finish(before,true,new AbortController().signal);
  const record={seq:0,executionCompleted:true,...finished};
  assert.equal(record.evidenceAssessment.files[0].status,'unchanged');
  dependencies.invalidate(root,[record],{seq:1,path:alias,effectState:'applied'});
  assert.equal(record.evidenceAssessment.files[0].status,'changed-by-file-tool',
    'a case alias or symlink of the same file must invalidate the earlier observation');
  assert.equal(record.evidenceAssessment.validity,'affected');
});
