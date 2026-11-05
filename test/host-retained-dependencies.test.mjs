import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startHost,text,load} from './helpers/host.mjs';
import {createRetainedCompute} from '../retained-compute.mjs';

test('retained provider retries after a missing native dependency is restored and reuses retained data',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('unused')]});
  let retained;
  try{
    await fs.writeFile(path.join(host.cwd,'retained-data.txt'),'alpha\nbeta\n');
    const scope=host.ctx.isolate('sandbox');
    const runtime={get:()=>({config:{retainedCompute:true}}),isEnabled:()=>true};
    const taskFlow={summary:()=>({mutationVersion:0})};
    let reads=0;
    const call=async(name,args,exec)=>{
      if(name==='read')reads++;
      const callId='host-retained:'+randomUUID();
      return scope.tools.execute({name,arguments:args,callId,rootCallId:callId,agent:exec.agent,signal:exec.signal});
    };
    retained=createRetainedCompute(scope,runtime,taskFlow,call);
    const agent=await host.createAgent('max');
    const controller=new AbortController();
    const exec={agent,signal:controller.signal};

    const initial=retained.summary(agent);
    assert.deepEqual(initial.missingDependencies,['sandbox']);
    assert.equal(initial.loaded,false);
    assert.equal(initial.available,false);
    assert.equal(initial.loadFailure,null);

    const code='const records=(await tools.read({file_path:"retained-data.txt"})).lines.map(line=>line.text);globalThis.records=records;records.length';
    const missing=await retained.execute({code},exec);
    assert.equal(missing.status,'unavailable');
    assert.equal(missing.executionOccurred,false);
    assert.equal(reads,0);
    const failed=retained.summary(agent);
    assert.deepEqual(failed.missingDependencies,['sandbox']);
    assert.equal(failed.loaded,false);
    assert.equal(failed.available,false);
    assert.match(failed.loadFailure,/Native sandbox is unavailable/u);

    const sandbox=await load('dsh-sandbox-local');
    await scope.plugin(sandbox.default??sandbox);
    const restored=retained.summary(agent);
    assert.deepEqual(restored.missingDependencies,[]);
    assert.equal(restored.loaded,false);
    assert.equal(restored.available,false);
    assert.equal(restored.loadFailure,failed.loadFailure);
    assert.equal(reads,0,'mounting the dependency must not retry execution');

    const loaded=await retained.execute({code},exec);
    assert.equal(loaded.status,'completed');
    assert.equal(loaded.value,2);
    assert.equal(reads,1);
    const healthy=retained.summary(agent);
    assert.deepEqual(healthy.missingDependencies,[]);
    assert.equal(healthy.loaded,true);
    assert.equal(healthy.available,true);
    assert.equal(healthy.loadFailure,null);

    const reused=await retained.execute({code:'records.join("|")'},exec);
    assert.equal(reused.status,'completed');
    assert.equal(reused.value,'alpha|beta');
    assert.equal(reads,1,'the second cell must reuse data without another read');

    const reset=await retained.execute({code:'typeof records',reset:true},exec);
    assert.equal(reset.status,'completed');
    assert.equal(reset.value,'undefined');
    assert.equal(reset.resetReason,'explicit-reset');
    assert.equal(reset.resetCount,1);
    assert.equal(reads,1);

    const write=await retained.execute({
      code:"const fsx=await import('node:fs/promises'); await fsx.writeFile('retained-write.txt','probe'); 'write-completed'"},exec);
    assert.equal(write.status,'failed');
    assert.equal(write.sandbox?.denied,true);
    assert.equal(await fs.access(path.join(host.cwd,'retained-write.txt')).then(()=>true,()=>false),false);
    assert.equal(host.requests.length,0,'direct retained calls do not create model requests');
  }finally{
    if(retained)await retained.dispose();
    await host.close();
  }
});

test('failed provider initialization disposes only its fiber and retries on explicit execution',async()=>{
  let pluginLoads=0,active=0,disposals=0,parentDisposals=0;
  const isolated={
    get(){return undefined;},
    plugin(){
      pluginLoads++;active++;
      return {
        then(_resolve,reject){reject(new Error('half-loaded retained runtime'));},
        async dispose(){active--;disposals++;},
      };
    },
  };
  const ctx={
    get(name){return name==='ptcRuntime'?undefined:{};},
    isolate(){return isolated;},
    on(){return()=>{};},
    dispose(){parentDisposals++;},
  };
  const retained=createRetainedCompute(ctx,{get:()=>({config:{retainedCompute:true}}),isEnabled:()=>true},
    {summary:()=>({mutationVersion:0})},async()=>{throw new Error('tool execution should not run');});
  const agent={session:{id:'retained-failure'}};
  const exec={agent,signal:new AbortController().signal};
  try{
    const initial=retained.summary(agent);
    assert.deepEqual(initial.missingDependencies,[]);
    assert.equal(initial.available,null);
    assert.equal(initial.loadFailure,null);

    const first=await retained.execute({code:'1'},exec);
    assert.equal(first.status,'unavailable');
    assert.match(first.detail,/half-loaded retained runtime/u);
    assert.equal(pluginLoads,1);
    assert.equal(active,0);
    assert.equal(disposals,1);
    assert.equal(parentDisposals,0);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(pluginLoads,1,'a failed load must not retry in the background');
    const failed=retained.summary(agent);
    assert.deepEqual(failed.missingDependencies,[]);
    assert.equal(failed.loaded,false);
    assert.equal(failed.available,false);
    assert.match(failed.loadFailure,/half-loaded retained runtime/u);

    const second=await retained.execute({code:'1'},exec);
    assert.equal(second.status,'unavailable');
    assert.equal(pluginLoads,2);
    assert.equal(active,0);
    assert.equal(disposals,2);
    assert.equal(parentDisposals,0);
  }finally{
    await retained.dispose();
  }
});
