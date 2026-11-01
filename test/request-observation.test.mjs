import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {observeRequests} from '../request-observation.mjs';
import {createContextEconomics} from '../context-economics.mjs';
import {createEffectObserver} from '../effect-observer.mjs';
import {defaults} from '../runtime.mjs';

test('raw invalid usage keeps its provenance across request accounting, economics and persistent effects',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'we-usage-provenance-'));
  t.after(async()=>{const relative=path.relative(os.tmpdir(),folder);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await fs.rm(folder,{recursive:true,force:true});});
  const cases=[{label:'invalid-cache',usage:{inputTokens:100,cacheReadTokens:-1,outputTokens:50,totalTokens:150},valid:false},
    {label:'inconsistent-total',usage:{inputTokens:100,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:50,totalTokens:151},valid:false},
    {label:'proven-zero-cache',usage:{inputTokens:100,outputTokens:50,totalTokens:150},valid:true}];
  for(const item of cases){
    const hooks=new Map(),agent={session:{id:item.label,seq:0,surface:{nodes:[],contentGeneration:0},requestHeader:()=>({config:{provider:'p',model:'m',reasoningEffort:'max'}})}};
    const state={root:path.join(folder,item.label,'project'),dir:path.join(folder,item.label,'project/.dsh/work-evidence'),telemetryDir:path.join(folder,item.label,'telemetry'),
      config:{...defaults(),projectionPricing:[{provider:'p',model:'m',currency:'USD',input:.15,cacheRead:.003,cacheWrite:0,output:.6}]},
      metrics:{contextRequests:0,contextRequestChars:0,contextModelTextChars:0},requestObservations:[],auxiliarySignals:new WeakSet()};
    const ctx={on:(name,fn)=>{hooks.set(name,fn);return ()=>{};},agents:{get:()=>agent}};
    const runtime={get:()=>state,init:async()=>state,sync:()=>state,isEnabled:()=>true,modeStatus:()=>({selected:'aggressive'})};
    runtime.effects=createEffectObserver(ctx,runtime);runtime.contextControl=createContextEconomics(ctx,runtime);observeRequests(ctx,runtime);
    const options={sessionId:agent.session.id,provider:'p',model:'m',reasoningEffort:'max',signal:new AbortController().signal,
      messages:[{role:'user',content:[{type:'text',text:'continue'}]}],tools:[]};
    for await(const _chunk of hooks.get('llm/stream')(options,async function*(){yield {type:'usage',usage:item.usage};yield {type:'finish',reason:{kind:'stop'}};})){}
    await runtime.effects.flush(agent);
    const observation=state.requestObservations[0],effect=runtime.effects.snapshot(agent).recentRequests[0],economics=runtime.contextControl.summary(agent);
    assert.equal(observation.usageComplete,item.valid,item.label);assert.equal(effect.usageComplete,item.valid,item.label);
    assert.equal(effect.unknownConsumption,!item.valid,item.label);assert.equal(economics.costComplete,item.valid,item.label);
    assert.equal(runtime.contextControl.lastSuccessfulUsage(agent,options)!==null,item.valid,item.label);
    if(item.label==='invalid-cache'){
      assert.equal(observation.usageSources.cacheReadTokens,'invalid-adapter-value');
      assert.equal(effect.usageSources.cacheReadTokens,'invalid-adapter-value');
    }
    const persisted=JSON.parse((await fs.readFile(path.join(state.telemetryDir,item.label+'.observability.jsonl'),'utf8')).trim());
    assert.equal(persisted.usageComplete,item.valid,item.label);assert.equal(persisted.usageConsistent,item.valid,item.label);
    await runtime.effects.dispose();
  }
});
