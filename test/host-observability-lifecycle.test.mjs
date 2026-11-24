import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text} from './helpers/host.mjs';

test('normal telemetry failure keeps the real agent usable and a disposed session can flush after storage recovers',async()=>{
  const host=await startHost({script:()=>[text('done')]});
  let file=null;
  let closed=false;
  try{
    const handle=await host.createAgentHandle('max');
    const agent=handle.agent;
    await host.send(agent,'first request');
    await new Promise(resolve=>setTimeout(resolve,200));
    const initial=await host.command(agent,'status');
    assert.ok(initial.telemetry?.directory,'the real host must expose the plugin telemetry location');
    file=path.join(initial.telemetry.directory,agent.session.id+'.observability.jsonl');
    await fs.rm(file,{recursive:true,force:true});
    await fs.mkdir(file,{recursive:true});

    await host.send(agent,'second request');
    await new Promise(resolve=>setTimeout(resolve,200));
    const degraded=await host.command(agent,'status');
    assert.equal(host.requests.length,2,'normal telemetry failure must not block the next model request');
    assert.equal(degraded.observability.persistence.complete,false);
    assert.ok(degraded.observability.persistence.writeErrors.length>0);

    await fs.rm(file,{recursive:true,force:true});
    await handle.dispose();
    await host.close();
    closed=true;
    const lines=(await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean);
    assert.ok(lines.length>=2,'pending request rows survive real agent disposal and flush after storage recovers');
    assert.ok(lines.some(line=>line.includes('work-evidence.request-start.v1')));
    assert.ok(lines.some(line=>line.includes('work-evidence.request-effects.v1')));
  }finally{
    if(file)await fs.rm(file,{recursive:true,force:true}).catch(()=>{});
    if(!closed)await host.close().catch(()=>{});
  }
});

test('plugin unload retries rows left pending after agent disposal',async()=>{
  const host=await startHost({script:()=>[text('done')]});
  let file=null,closed=false;
  try{
    const handle=await host.createAgentHandle('max');
    const agent=handle.agent;
    await host.send(agent,'first request');
    await new Promise(resolve=>setTimeout(resolve,200));
    const initial=await host.command(agent,'status');
    file=path.join(initial.telemetry.directory,agent.session.id+'.observability.jsonl');
    await fs.rm(file,{recursive:true,force:true});
    await fs.mkdir(file,{recursive:true});
    await host.send(agent,'second request');
    await new Promise(resolve=>setTimeout(resolve,200));
    const degraded=await host.command(agent,'status');
    assert.equal(degraded.observability.persistence.complete,false);
    await handle.dispose();
    await fs.rm(file,{recursive:true,force:true});
    await host.close();
    closed=true;
    const lines=(await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean);
    assert.ok(lines.some(line=>line.includes('work-evidence.request-effects.v1')),
      'plugin unload must finish the request row after the agent has already been disposed');
  }finally{
    if(file)await fs.rm(file,{recursive:true,force:true}).catch(()=>{});
    if(!closed)await host.close().catch(()=>{});
  }
});
