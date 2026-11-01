import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEffectObserver} from '../effect-observer.mjs';

const SESSION='we-effects-session';
const COMPLETE={inputTokens:1000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:1100};
const REJECTED={inputTokens:100,cacheReadTokens:-5,outputTokens:50,totalTokens:150};

const row=(requestId,usage=COMPLETE,extra={})=>({schema:'work-evidence.request-effects.v1',requestId,at:'2026-11-02T00:00:00.000Z',
  provider:'scripted',model:'scripted-model',reasoningEffort:'max',auxiliary:false,usage,usageChunks:1,
  usageAggregation:'last-non-null-adapter-value-per-field',settled:true,failureCode:null,finishReason:'stop',
  toolSurface:'compact',mode:{selected:'aggressive',source:'effort-selection'},purpose:null,
  effects:{directTokensEstimate:5,directChars:10,instructionTokensEstimate:1,systemTokensEstimate:2,messageTokensEstimate:3,
    schemaTokensEstimate:4,byFeature:{},reconstructionMisses:0,coverage:'test',method:'test',causalTaskSaving:false},
  localRequestTokensEstimate:10,decisions:[],sourceSeq:1,step:1,...extra});

async function start(options={}){
  const dir=options.dir??null;
  const telemetryDir=options.telemetryDir??await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-'));
  const state={id:SESSION,dir,telemetryDir,step:4,config:{toolSurface:'compact'},dirty:true};
  const runtime={get:()=>state,isEnabled:()=>true,modeStatus:()=>({selected:'aggressive',source:'effort-selection'}),problem:()=>{}};
  const agent={session:{id:SESSION,seq:42,surface:{nodes:[]},log:[]}};
  return {state,agent,effects:createEffectObserver({on:()=>()=>{}},runtime),telemetryDir};
}
const stored=async telemetryDir=>(await fs.readFile(path.join(telemetryDir,SESSION+'.observability.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
const remove=telemetryDir=>fs.rm(telemetryDir,{recursive:true,force:true,maxRetries:3});

test('a missing trailing newline is repaired so later rows keep their own line',async()=>{
  const created=await start();
  try{
    await fs.writeFile(path.join(created.telemetryDir,SESSION+'.observability.jsonl'),JSON.stringify(row('restored-row')),'utf8');
    await created.effects.load(created.agent);
    await created.effects.finish(created.agent,row('appended-row'));
    await created.effects.flush(created.agent);
    assert.deepEqual((await stored(created.telemetryDir)).map(item=>item.requestId),['restored-row','appended-row']);
    assert.deepEqual(created.effects.snapshot(created.agent).persistence.writeErrors,[]);
    assert.equal(created.effects.snapshot(created.agent).requests.count,2);
  }finally{await remove(created.telemetryDir);}
});

test('a failed trailing-newline write is recorded and does not block later requests',async()=>{
  const created=await start();
  const file=path.join(created.telemetryDir,SESSION+'.observability.jsonl');
  try{
    await fs.writeFile(file,JSON.stringify(row('restored-row')),'utf8');
    await fs.chmod(file,0o444);
    await created.effects.load(created.agent);
    assert.equal(created.effects.snapshot(created.agent).requests.count,1);
    assert.equal(created.effects.snapshot(created.agent).persistence.writeErrors.filter(message=>/newline repair/.test(message)).length,1);
    // The restore is not repeated for later requests, so the file is read only once.
    await created.effects.load(created.agent);
    assert.equal(created.effects.snapshot(created.agent).requests.count,1);
    assert.equal(created.effects.snapshot(created.agent).persistence.writeErrors.length,1);
    // Accounting continues in memory even while this file cannot be written.
    await created.effects.finish(created.agent,row('appended-row'));
    await created.effects.flush(created.agent);
    assert.equal(created.effects.snapshot(created.agent).requests.count,2);
    assert.ok(created.effects.snapshot(created.agent).persistence.writeErrors.some(message=>/EPERM|EACCES/.test(message)));
    assert.deepEqual((await stored(created.telemetryDir)).map(item=>item.requestId),['restored-row']);
  }finally{await fs.chmod(file,0o664);await remove(created.telemetryDir);}
});

test('a rejected adapter usage value is never re-read as a proven zero',async()=>{
  const created=await start();
  try{
    await created.effects.load(created.agent);
    await created.effects.finish(created.agent,row('rejected-value',REJECTED));
    await created.effects.finish(created.agent,row('complete-value'));
    await created.effects.flush(created.agent);
    const [rejected,complete]=await stored(created.telemetryDir);
    assert.equal(rejected.usageSources.cacheReadTokens,'invalid-adapter-value');
    assert.equal(rejected.usageConsistent,false);
    assert.equal(rejected.usageComplete,false);
    assert.equal(rejected.usage.cacheReadTokens,null);
    assert.equal(complete.usageSources.cacheReadTokens,'adapter-reported');
    assert.equal(complete.usageConsistent,true);
    assert.equal(complete.usageComplete,true);
    const restored=await start({telemetryDir:created.telemetryDir});
    await restored.effects.load(restored.agent);
    const snapshot=restored.effects.snapshot(restored.agent);
    assert.deepEqual(snapshot.recentRequests.map(item=>item.requestId),['rejected-value','complete-value']);
    assert.equal(snapshot.recentRequests[0].usageSources.cacheReadTokens,'invalid-adapter-value');
    assert.equal(snapshot.recentRequests[0].usageConsistent,false);
    assert.equal(snapshot.requests.missingUsage,1);
  }finally{await remove(created.telemetryDir);}
});

test('a row stored before source verdicts existed is canonicalized once on restore',async()=>{
  const legacy=row('legacy-row',{inputTokens:100,outputTokens:50,totalTokens:150});
  const created=await start();
  try{
    await fs.writeFile(path.join(created.telemetryDir,SESSION+'.observability.jsonl'),JSON.stringify(legacy)+'\n','utf8');
    await created.effects.load(created.agent);
    const [restored]=created.effects.snapshot(created.agent).recentRequests;
    assert.equal(restored.usageSources.cacheReadTokens,'zero-proven-by-reported-disjoint-total');
    assert.equal(restored.usageComplete,true);
    await created.effects.load(created.agent);
    assert.equal(created.effects.snapshot(created.agent).requests.count,1);
  }finally{await remove(created.telemetryDir);}
});

test('a row that already carries its source verdicts is stored unchanged',async()=>{
  const canonical={inputTokens:100,cacheReadTokens:null,cacheWriteTokens:null,outputTokens:50,reasoningTokens:null,totalTokens:150};
  const verdicts={inputTokens:'adapter-reported',cacheReadTokens:'invalid-adapter-value',cacheWriteTokens:'missing',outputTokens:'adapter-reported',reasoningTokens:'missing',totalTokens:'adapter-reported'};
  const created=await start();
  try{
    await created.effects.load(created.agent);
    await created.effects.finish(created.agent,row('verdicts-from-caller',canonical,{usageSources:verdicts,usageConsistent:false,usageComplete:false}));
    await created.effects.flush(created.agent);
    const [storedRow]=await stored(created.telemetryDir);
    assert.deepEqual(storedRow.usageSources,verdicts);
    assert.equal(storedRow.usageConsistent,false);
    assert.equal(storedRow.usage.cacheReadTokens,null);
    const restored=await start({telemetryDir:created.telemetryDir});
    await restored.effects.load(restored.agent);
    assert.equal(restored.effects.snapshot(restored.agent).recentRequests[0].usageSources.cacheReadTokens,'invalid-adapter-value');
    assert.equal(restored.effects.snapshot(restored.agent).requests.missingUsage,1);
  }finally{await remove(created.telemetryDir);}
});

test('a failed append after a failed newline repair keeps the next row on its own line',async()=>{
  const created=await start();
  const file=path.join(created.telemetryDir,SESSION+'.observability.jsonl');
  try{
    await fs.writeFile(file,JSON.stringify(row('restored-row')),'utf8');
    await fs.chmod(file,0o444);
    await created.effects.load(created.agent);
    await created.effects.finish(created.agent,row('blocked-row'));
    await created.effects.flush(created.agent);
    assert.equal(created.effects.snapshot(created.agent).requests.count,2);
    assert.deepEqual((await stored(created.telemetryDir)).map(item=>item.requestId),['restored-row']);
    // The storage becomes writable again: the row that was lost must not merge with the
    // unfinished line that the failed repair left behind.
    await fs.chmod(file,0o664);
    await created.effects.finish(created.agent,row('late-row'));
    await created.effects.flush(created.agent);
    assert.deepEqual((await stored(created.telemetryDir)).map(item=>item.requestId),['restored-row','late-row']);
  }finally{await fs.chmod(file,0o664);await remove(created.telemetryDir);}
});

test('an inconsistent reported total stays incomplete in memory, on disk and after a restore',async()=>{
  const parts={inputTokens:'adapter-reported',cacheReadTokens:'adapter-reported',cacheWriteTokens:'adapter-reported',
    outputTokens:'adapter-reported',reasoningTokens:'missing',totalTokens:'adapter-reported'};
  const created=await start();
  try{
    await created.effects.load(created.agent);
    // Every required field is a finite count, but they add up to 150 while the adapter reported 999.
    await created.effects.finish(created.agent,row('inconsistent-total',{inputTokens:100,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:50,reasoningTokens:null,totalTokens:999}));
    // A caller verdict that rejects an otherwise well-formed row must not be upgraded either.
    await created.effects.finish(created.agent,row('caller-incomplete',{inputTokens:20,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:5,totalTokens:25},
      {usageSources:parts,usageConsistent:false,usageComplete:false}));
    await created.effects.flush(created.agent);
    const [inconsistent,caller]=await stored(created.telemetryDir);
    assert.equal(inconsistent.usageConsistent,false);
    assert.equal(inconsistent.usageComplete,false);
    assert.equal(inconsistent.unknownConsumption,true);
    assert.equal(caller.usageSources.cacheReadTokens,'adapter-reported');
    assert.equal(caller.usageComplete,false);
    assert.equal(caller.unknownConsumption,true);
    const live=created.effects.snapshot(created.agent);
    assert.equal(live.requests.missingUsage,0);
    assert.equal(live.requests.unknownConsumption,2);
    const restored=await start({telemetryDir:created.telemetryDir});
    await restored.effects.load(restored.agent);
    const snapshot=restored.effects.snapshot(restored.agent);
    assert.deepEqual(snapshot.recentRequests.map(item=>[item.requestId,item.usageComplete,item.unknownConsumption]),
      [['inconsistent-total',false,true],['caller-incomplete',false,true]]);
    assert.equal(snapshot.requests.missingUsage,0);
    assert.equal(snapshot.requests.unknownConsumption,2);
  }finally{await remove(created.telemetryDir);}
});
