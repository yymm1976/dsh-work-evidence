import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRuntime} from '../runtime.mjs';
import {startHost,text} from './helpers/host.mjs';

test('cancelled metadata persistence cannot follow a storage junction outside the workspace',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('unused')]}),outside=await fs.mkdtemp(path.join(os.tmpdir(),'outside-storage-'));
  try{
    await fs.mkdir(path.join(host.cwd,'.dsh'));await fs.symlink(outside,path.join(host.cwd,'.dsh','work-evidence'),process.platform==='win32'?'junction':'dir');
    const agent=await host.createAgent(),runtime=createRuntime(host.ctx,async()=>{throw new Error('No native tool dispatch required');});
    const state=await runtime.init(agent),target=path.join(state.dir,'cancelled.json');
    await assert.rejects(runtime.save(agent,target,{status:'partial'},AbortSignal.timeout(10000),{background:true}),/outside|storage|workspace/iu);
    assert.deepEqual(await fs.readdir(outside),[]);
  }finally{await host.close();await fs.rm(outside,{recursive:true,force:true});}
});
test('cancelled report storage preserves native read-only permissions',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('unused')]});
  try{
    const agent=await host.createAgent(),runtime=createRuntime(host.ctx,async()=>{throw new Error('No tool dispatch required');}),state=await runtime.init(agent);
    agent.session.append('sandbox/mode',{mode:'read-only',workspaceRoot:host.cwd});
    const target=path.join(state.dir,'blocked.json');
    await assert.rejects(runtime.save(agent,target,{status:'partial'},AbortSignal.timeout(10000),{background:true}),/authorized|provider|permission/iu);
    await assert.rejects(fs.stat(target),error=>error.code==='ENOENT');
  }finally{await host.close();}
});
