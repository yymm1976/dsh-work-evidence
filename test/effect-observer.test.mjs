import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEffectObserver} from '../effect-observer.mjs';
import realFs from 'node:fs/promises';

// A read-only mode only blocks writes when the process lacks CAP_DAC_OVERRIDE, so a
// root container can still append after chmod(0o444). Detect the capability instead
// of assuming the permission model, and skip only the cases that need it.
async function readOnlyBlocksWrites(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'we-chmod-'));
  try{
    const file=path.join(dir,'probe.txt');
    await fs.writeFile(file,'a','utf8');
    await fs.chmod(file,0o444);
    try{await fs.appendFile(file,'b');return false;}catch{return true;}
  }finally{await fs.rm(dir,{recursive:true,force:true});}
}
const chmodBlocks=await readOnlyBlocksWrites();


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

test('a failed trailing-newline write is recorded and does not block later requests',{skip:!chmodBlocks?'read-only mode does not block writes here (CAP_DAC_OVERRIDE)' : false},async()=>{
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

test('a partial failed append is isolated before the next persistent row',async()=>{
  const created=await start();
  const file=path.join(created.telemetryDir,SESSION+'.observability.jsonl');
  const original=realFs.appendFile;
  let injected=false;
  realFs.appendFile=async(...args)=>{
    if(!injected&&args[0]===file){
      injected=true;
      const text=String(args[1]);
      await original(file,text.slice(0,Math.floor(text.length/2)),'utf8');
      throw new Error('injected partial append');
    }
    return original(...args);
  };
  try{
    await fs.writeFile(file,JSON.stringify(row('chinese-row',COMPLETE,{note:'中文字符'}))+'\n','utf8');
    await created.effects.load(created.agent);
    await created.effects.finish(created.agent,row('partial-row'));
    await created.effects.flush(created.agent);
    await created.effects.finish(created.agent,row('surviving-row'));
    await created.effects.flush(created.agent);
    assert.deepEqual((await stored(created.telemetryDir)).map(item=>item.requestId),['chinese-row','surviving-row'],
      'a non-ASCII row before the partial tail survives the byte-offset truncation');
    const restored=await start({telemetryDir:created.telemetryDir});
    await restored.effects.load(restored.agent);
    assert.equal(restored.effects.snapshot(restored.agent).requests.count,2);
  }finally{realFs.appendFile=original;await remove(created.telemetryDir);}
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
    assert.equal(live.requests.missingUsage,2);
    assert.equal(live.requests.unknownConsumption,2);
    assert.equal(live.requests.completeUsageRequests,0);
    assert.equal(live.requests.providerReported.totalTokens,0);
    assert.equal(live.requests.providerReportedRaw.totalTokens,1024);
    const restored=await start({telemetryDir:created.telemetryDir});
    await restored.effects.load(restored.agent);
    const snapshot=restored.effects.snapshot(restored.agent);
    assert.deepEqual(snapshot.recentRequests.map(item=>[item.requestId,item.usageComplete,item.unknownConsumption]),
      [['inconsistent-total',false,true],['caller-incomplete',false,true]]);
    assert.equal(snapshot.requests.missingUsage,2);
    assert.equal(snapshot.requests.unknownConsumption,2);
    assert.deepEqual(snapshot.requests.providerReported,live.requests.providerReported);
    assert.deepEqual(snapshot.requests.providerReportedRaw,live.requests.providerReportedRaw);
  }finally{await remove(created.telemetryDir);}
});

test('legacy decisions are reclassified under the current feature names',async()=>{
  const created=await start();
  try{
    const decisions=[
      {id:'stub',feature:'compactionHandoff',status:'applied',reason:'deterministic-stub-summary'},
      {id:'limit',feature:'finalJson',status:'failed',reason:'final-json-repair-limit',kind:'observed-result-repair'},
      {id:'applied',feature:'finalJson',status:'applied',reason:'observed-result-repair-requested'},
      {id:'native',feature:'compactionHandoff',status:'applied',reason:'native-summary-extension'}];
    await fs.writeFile(path.join(created.telemetryDir,SESSION+'.observability.jsonl'),JSON.stringify(row('legacy',COMPLETE,{decisions}))+'\n','utf8');
    await created.effects.load(created.agent);
    const features=created.effects.snapshot(created.agent).features;
    assert.equal(features.stubSummary.decisions,1);assert.equal(features.stubSummary.applied,1);
    assert.equal(features.finalJsonResult.decisions,2);assert.equal(features.finalJsonResult.failed,1);assert.equal(features.finalJsonResult.applied,1);
    assert.equal(features.finalJson.decisions,0,'the syntax guard does not inherit result-repair decisions');
    assert.equal(features.compactionHandoff.applied,1,'unrelated legacy decisions keep their feature');
    assert.deepEqual(created.effects.snapshot(created.agent).decisions.map(item=>item.feature).sort(),
      ['compactionHandoff','finalJsonResult','finalJsonResult','stubSummary']);
  }finally{await remove(created.telemetryDir);}
});

test('decisions recorded without a following main request survive disposal and restore once',async()=>{
  const created=await start();
  try{
    created.effects.decide(created.agent,'retainedCompute','applied','recorded-after-last-request');
    await created.effects.disposeAgent(created.agent);
    const rows=await stored(created.telemetryDir);
    assert.equal(rows.length,1);assert.equal(rows[0].schema,'work-evidence.pending-decisions.v1');
    assert.equal(rows[0].decisions[0].feature,'retainedCompute');
    await fs.appendFile(path.join(created.telemetryDir,SESSION+'.observability.jsonl'),JSON.stringify(rows[0])+'\n','utf8');
    const restored=await start({telemetryDir:created.telemetryDir});
    await restored.effects.load(restored.agent);
    const feature=restored.effects.snapshot(restored.agent).features.retainedCompute;
    assert.equal(feature.decisions,1);assert.equal(feature.applied,1);
    assert.equal(feature.lastReason,'recorded-after-last-request');
    assert.equal(restored.effects.snapshot(restored.agent).requests.count,0,'no request row is invented for a pending decision');
  }finally{await remove(created.telemetryDir);}
});
test('restored host compaction is separate from plugin auxiliary calls and main feature attribution',async()=>{
  const created=await start();
  try{
    const file=path.join(created.telemetryDir,SESSION+'.observability.jsonl');
    await fs.writeFile(file,[row('old-compaction',COMPLETE,{purpose:'compaction',auxiliary:true}),
      row('plugin-review',COMPLETE,{purpose:'work-evidence:quality-review',auxiliary:true})].map(r=>JSON.stringify(r)).join('\n')+'\n');
    await created.effects.load(created.agent);
    const snapshot=created.effects.snapshot(created.agent);
    assert.equal(snapshot.requests.count,2);assert.equal(snapshot.requests.compaction,1);
    assert.equal(snapshot.requests.auxiliary,1);assert.equal(snapshot.requests.main,0);
    assert.equal(snapshot.totals.directTokensEstimate,0);
    assert.equal(snapshot.recentRequests[0].requestKind,'compaction');
    assert.equal(snapshot.recentRequests[0].auxiliary,false);
    assert.equal(snapshot.requests.providerReported.totalTokens,2200);
    assert.equal((await stored(created.telemetryDir))[0].auxiliary,true,'original stored rows are not rewritten');
  }finally{await remove(created.telemetryDir);}
});

test('pending decisions beyond the rolling limit are persisted instead of silently dropped', async () => {
  const created = await start();
  try {
    for (let index = 0; index < 300; index++) {
      created.effects.decide(created.agent, 'retainedCompute', 'applied', 'decision-' + index);
    }
    await created.effects.flush(created.agent);
    const rows = await stored(created.telemetryDir);
    const overflow = rows.filter(item => item.schema === 'work-evidence.pending-decisions.v1')
      .flatMap(item => item.decisions);
    assert.equal(overflow.length, 44, 'the decisions beyond the in-memory window are written');
    await created.effects.disposeAgent(created.agent);
    const all = (await stored(created.telemetryDir))
      .filter(item => item.schema === 'work-evidence.pending-decisions.v1')
      .flatMap(item => item.decisions);
    assert.equal(all.length, 300);
    assert.equal(new Set(all.map(item => item.id)).size, 300);
    const restored = await start({telemetryDir: created.telemetryDir});
    await restored.effects.load(restored.agent);
    assert.equal(restored.effects.snapshot(restored.agent).features.retainedCompute.decisions, 300);
  } finally {
    await remove(created.telemetryDir);
  }
});

test('restored feature names cannot mutate shared prototypes', async () => {
  const created = await start();
  try {
    const file = path.join(created.telemetryDir, SESSION + '.observability.jsonl');
    await fs.writeFile(file, JSON.stringify({ schema: 'work-evidence.pending-decisions.v1', at: '2026-11-06T00:00:00.000Z', step: 1, decisions: [
      { id: 'proto', feature: '__proto__', status: 'applied', reason: 'x', seq: 1 },
      { id: 'constructor', feature: 'constructor', status: 'applied', reason: 'x', seq: 2 },
      { id: 'valid', feature: 'retainedCompute', status: 'applied', reason: 'restored-valid', seq: 3 }
    ] }) + '\n', 'utf8');
    await created.effects.load(created.agent);
    const snapshot = created.effects.snapshot(created.agent);
    assert.equal(snapshot.features.retainedCompute.decisions, 1);
    assert.equal(snapshot.features.retainedCompute.lastReason, 'restored-valid');
    assert.equal(Object.prototype.lastStatus, undefined);
    assert.equal(Object.prototype.decisions, undefined);
    assert.equal(Object.prototype.applied, undefined);
    assert.ok(!snapshot.persistence.writeErrors.some(message => message.includes('Unreadable')));
  } finally {
    await remove(created.telemetryDir);
  }
});

test('a small saving against a larger overhead keeps every balance field lossless',()=>{
  // savedTokens=-5 with spentTokens=2000 makes the ratio round to -0, which the
  // host rejects as non-lossless JSON. The snapshot must never contain it.
  const agent={session:{id:'balance-negzero'},seq:0};
  const state={id:'balance-negzero',step:0,config:{},requestObservations:[]};
  const effects=createEffectObserver({on:()=>()=>{}},{get:()=>state,isEnabled:()=>true});
  const snap=effects.snapshot(agent);
  const totals=snap.totals;
  for(const value of [totals.directTokensEstimate,totals.balance.savedTokensEstimate,
    totals.balance.spentTokensEstimate,totals.balance.netTokensEstimate]){
    assert.ok(!Object.is(value,-0),'balance fields must not be negative zero');
  }
  if(Object.hasOwn(totals.balance,'ratioPercent'))assert.ok(!Object.is(totals.balance.ratioPercent,-0));
  // The payload must survive a JSON round trip byte for byte.
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(snap))),JSON.stringify(snap));
});

test('a restored older decision does not become the reported latest one',async()=>{
  const created=await start();
  try{
    // Write the newer decision first, then an older one, which is the order a
    // retried overflow append can produce after a later row already landed.
    const file=path.join(created.telemetryDir,SESSION+'.observability.jsonl');
    const pending=(decisions)=>({schema:'work-evidence.pending-decisions.v1',sessionId:SESSION,
      at:'2026-11-02T00:00:00.000Z',step:5,decisions});
    const newer={id:'newer',at:'2026-11-02T00:00:02.000Z',step:5,seq:9,feature:'retainedCompute',status:'applied',reason:'second'};
    const older={id:'older',at:'2026-11-02T00:00:01.000Z',step:4,seq:3,feature:'retainedCompute',status:'deferred',reason:'first'};
    await fs.writeFile(file,[JSON.stringify(pending([newer])),JSON.stringify(pending([older]))].join('\n')+'\n','utf8');
    await created.effects.load(created.agent);
    const feature=created.effects.snapshot(created.agent).features.retainedCompute;
    assert.equal(feature.decisions,2,'both restored decisions are counted');
    assert.equal(feature.lastReason,'second','the newest decision is still reported as the latest');
    assert.equal(feature.lastSeq,9);
    const window=created.effects.snapshot(created.agent).decisions.map(item=>item.seq);
    assert.deepEqual(window,[3,9],'the rolling window stays in sequence order, got '+JSON.stringify(window));
  }finally{await remove(created.telemetryDir);}
});
