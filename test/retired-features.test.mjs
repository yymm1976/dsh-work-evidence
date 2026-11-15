import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {defaults} from '../runtime.mjs';
import {createEffectObserver} from '../effect-observer.mjs';
import {startHost,text,tool,reasoning} from './helpers/host.mjs';
const retired=['programHistory','ledgerFoldWrite','reasoningHistory','cacheOrderedStub','archiveEntries','ledgerFoldPlan','executionAdvice','finishAdvice','taskEffort','nativeReadView','nativeExecutionEvidence'];
test('retired settings accept old boolean values without re-enabling code',()=>{
  const config=defaults(Object.fromEntries(retired.map(key=>[key,true])));
  for(const key of retired){assert.equal(config[key],false);assert.throws(()=>defaults({[key]:'true'}),new RegExp('Invalid '+key));}
});
test('retired environment flags cannot restore removed stub modes',()=>{
  const names=['DSH_EXPERIMENT_CACHE_ORDERED_STUB','DSH_EXPERIMENT_ARCHIVE_ENTRIES'];
  const prior=names.map(name=>process.env[name]);
  try{for(const name of names)process.env[name]='1';assert.equal(defaults().cacheOrderedStub,false);assert.equal(defaults().archiveEntries,false);}
  finally{names.forEach((name,i)=>{if(prior[i]===undefined)delete process.env[name];else process.env[name]=prior[i];});}
});

test('historical feature counts remain visible without advertising removed features as enabled',()=>{
  const state={id:'legacy-metrics',config:defaults()},agent={session:{id:'legacy-metrics'}};
  const effects=createEffectObserver({on:()=>()=>{}},{get:()=>state,isEnabled:()=>true});
  for(const name of ['reasoningHistory','programHistory','ledgerFold','foldPlan']){
    effects.decide(agent,name,'applied','historical-record');
    const value=effects.snapshot(agent).features[name];
    assert.equal(value.applied,1);assert.equal(value.retired,true);assert.equal(value.enabled,false);
  }
});
test('old workspace settings preserve raw reasoning and do not make auxiliary calls',async()=>{
  const original='Original reasoning remains in the native message. '.repeat(400);
  const host=await startHost({workspace:Object.fromEntries(retired.map(key=>[key,true])),efforts:['off','max'],
    auxiliary:()=>{throw new Error('removed features must not call the model');},
    script:(_o,n)=>n===1?[reasoning(original),tool('read',{file_path:'a.txt'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'a\n');const agent=await host.createAgent('max');await host.send(agent,'读取 a.txt');
    const status=await host.command(agent,'detail');assert.equal(status.effective,true);assert.equal(host.auxiliaryRequests.length,0);
    assert.equal(host.requests[1].messages.flatMap(m=>m.content??[]).find(b=>b.type==='reasoning').text,original);
    for(const key of retired)assert.ok(!Object.hasOwn(status.features,key));
    assert.equal(status.reasoningHistory,undefined);
  }finally{await host.close();}
});

test('changing a workspace setting does not write retired keys back into the file',async()=>{
  const host=await startHost({workspace:Object.fromEntries([...retired,'opsAdapters','fastEditEnabled'].map(key=>[key,false])),
    efforts:['off','max'],script:(_o,n)=>n===1?[tool('read',{file_path:'a.txt'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'a\n');
    const agent=await host.createAgent('max');await host.send(agent,'读取 a.txt');
    // workspaceConfig() folds a retired key to false so old files still load,
    // but the key must not be echoed back on the next settings write.
    await host.command(agent,'config {"stepPacing":false}');
    const saved=JSON.parse(await fs.readFile(path.join(host.cwd,'.dsh','work-evidence','config.json'),'utf8'));
    assert.equal(saved.stepPacing,false);
    for(const key of [...retired,'opsAdapters','fastEditEnabled'])assert.ok(!Object.hasOwn(saved,key),key+' must not be persisted');
  }finally{await host.close();}
});
