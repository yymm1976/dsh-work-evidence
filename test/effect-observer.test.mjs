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
  const state={id:SESSION,dir,telemetryDir,step:4,config:{toolSurface:'compact',...options.config},dirty:true};
  const runtime={get:()=>state,isEnabled:()=>true,modeStatus:()=>({selected:'aggressive',source:'effort-selection'}),problem:()=>{}};
  const agent={session:{id:SESSION,seq:42,surface:{nodes:[]},log:[]}};
  const handlers=new Map();
  const ctx={on:(event,handler)=>{handlers.set(event,handler);return()=>{};}};
  return {state,agent,handlers,effects:createEffectObserver(ctx,runtime,{io:options.io}),telemetryDir};
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
    assert.deepEqual((await stored(created.telemetryDir)).map(item=>item.requestId),['restored-row','blocked-row','late-row'],
      'the recovered blocked row is retried before the later row instead of being dropped');
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
    assert.deepEqual((await stored(created.telemetryDir)).map(item=>item.requestId),['chinese-row','partial-row','surviving-row'],
      'the partial append is repaired, then the pending row is persisted in order');
    const restored=await start({telemetryDir:created.telemetryDir});
    await restored.effects.load(restored.agent);
    assert.equal(restored.effects.snapshot(restored.agent).requests.count,3);
  }finally{realFs.appendFile=original;await remove(created.telemetryDir);}
});

test('a failed boundary repair is retried before the next row is appended',async()=>{
  // A complete unterminated row, then a partial append joined to it, then a repair that
  // also fails. A bare newline before the next row would seal the join and lose the
  // complete row, so the repair must run again once storage recovers.
  const created=await start();
  const file=path.join(created.telemetryDir,SESSION+'.observability.jsonl');
  const append=realFs.appendFile,truncate=realFs.truncate;
  let appended=false,repairFailed=false;
  realFs.appendFile=async(...args)=>{
    if(!appended&&args[0]===file){
      appended=true;
      const text=String(args[1]);
      await append(file,text.slice(0,Math.floor(text.length/2)),'utf8');
      throw new Error('injected partial append');
    }
    return append(...args);
  };
  realFs.truncate=async(...args)=>{
    if(!repairFailed&&args[0]===file){repairFailed=true;throw new Error('injected repair failure');}
    return truncate(...args);
  };
  try{
    await fs.writeFile(file,JSON.stringify(row('unterminated-row',COMPLETE,{note:'中文字符'})),'utf8');
    await created.effects.finish(created.agent,row('partial-row'));
    await created.effects.flush(created.agent);
    assert.equal(repairFailed,true,'the first repair was attempted and failed');
    await created.effects.finish(created.agent,row('surviving-row'));
    await created.effects.flush(created.agent);
    assert.deepEqual((await stored(created.telemetryDir)).map(item=>item.requestId),['unterminated-row','partial-row','surviving-row'],
      'the repair is retried, then the pending row is persisted after the retained complete row');
  }finally{realFs.appendFile=append;realFs.truncate=truncate;await remove(created.telemetryDir);}
});

test('a complete row without a newline survives a following partial append',async()=>{
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
    await fs.writeFile(file,JSON.stringify(row('unterminated-row',COMPLETE,{note:'中文字符'})),'utf8');
    // No load here: load would repair the missing newline first and the partial-append
    // precondition would not exist.
    await created.effects.finish(created.agent,row('partial-row'));
    await created.effects.flush(created.agent);
    await created.effects.finish(created.agent,row('surviving-row'));
    await created.effects.flush(created.agent);
    assert.deepEqual((await stored(created.telemetryDir)).map(item=>item.requestId),['unterminated-row','partial-row','surviving-row'],
      'the complete unterminated row is retained and the repaired pending row is persisted');
    const restored=await start({telemetryDir:created.telemetryDir});
    await restored.effects.load(restored.agent);
    assert.equal(restored.effects.snapshot(restored.agent).requests.count,3);
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
    assert.equal(overflow.length, 300, 'flush writes every pending decision, including the overflow');
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

test('a small saving against a larger overhead keeps every balance field lossless',async()=>{
  // Deliver a real row: with no request the totals are all zero, ratioPercent is omitted,
  // and the assertions below could never see the failing input. savedTokens=-5 against
  // spentTokens=2000 makes the ratio round to -0, which the host rejects as non-lossless.
  const created=await start();
  try{
    await created.effects.load(created.agent);
    await created.effects.finish(created.agent,row('balance-negzero',COMPLETE,{
      effects:{directTokensEstimate:-2005,directChars:-10,instructionTokensEstimate:1000,systemTokensEstimate:2,messageTokensEstimate:3,
        schemaTokensEstimate:1000,byFeature:{},reconstructionMisses:0,coverage:'test',method:'test',causalTaskSaving:false}}));
    await created.effects.flush(created.agent);
    const totals=created.effects.snapshot(created.agent).totals;
    // Gross saving recovers the pre-overhead value, then spentTokens is subtracted.
    assert.equal(totals.balance.savedTokensEstimate,-5);
    assert.equal(totals.balance.spentTokensEstimate,2000);
    for(const value of [totals.directTokensEstimate,totals.balance.savedTokensEstimate,
      totals.balance.spentTokensEstimate,totals.balance.netTokensEstimate]){
      assert.ok(!Object.is(value,-0),'balance fields must not be negative zero');
    }
    assert.ok(!Object.is(totals.balance.ratioPercent,-0),'a -0 ratio is normalised to 0');
    assert.equal(totals.balance.ratioPercent,0);
    const snap=created.effects.snapshot(created.agent);
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(snap))),JSON.stringify(snap));
  }finally{await remove(created.telemetryDir);}
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

test('a caller source-event seq does not overwrite the decision sequence',async()=>{
  // decide() is called with {seq,...} from the prune path, where that seq names the pruned
  // RESULT, not the decision. Spreading it after the generated seq made the two meanings
  // share a field: with source events 100 and 20, the live feature reported 20 as latest
  // while a restored log picked 100, because restore compares decision.seq.
  const built=await start();
  try{
    built.effects.decide(built.agent,'contextPrune','applied','first',{seq:100});
    built.effects.decide(built.agent,'contextPrune','deferred','second',{seq:20});
    const decisions=built.effects.snapshot(built.agent).decisions.filter(item=>item.feature==='contextPrune');
    // Decision identities are monotone; the source events are not.
    assert.deepEqual(decisions.map(item=>item.seq),[1,2],'decision seq stays the generated one');
    assert.deepEqual(decisions.map(item=>item.sourceSeq),[100,20],'and the source event is preserved separately');
    const feature=built.effects.snapshot(built.agent).features.contextPrune;
    assert.equal(feature.lastReason,'second','the last decision is the one emitted last');
  }finally{await remove(built.telemetryDir);}
});

test('a caller detail reason does not overwrite the decision reason',()=>{
  // reviewOutcomes passes the review object as details, and that object carries its own
  // `reason`. Spreading it over the generated reason made the live feature tally
  // 'projection-outcome' while a restored log tallied the review's reason.
  const built=void 0;
  return start().then(async created=>{
    try{
      created.effects.decide(created.agent,'projection','applied','projection-outcome',{reason:'review-implausible',plausible:false});
      const [decision]=created.effects.snapshot(created.agent).decisions;
      assert.equal(decision.reason,'projection-outcome','the generated reason wins');
      assert.equal(decision.detailReason,'review-implausible','and the caller reason is kept separately');
    }finally{await remove(created.telemetryDir);}
  });
});

test('more than 32 failed request rows are retained and flushed in order',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-many-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  let failing=true;
  const io={...realFs,appendFile:async(...args)=>{
    if(failing&&args[0]===file)throw Object.assign(new Error('injected append failure'),{code:'EACCES'});
    return realFs.appendFile(...args);
  }};
  const created=await start({telemetryDir,io});
  try{
    for(let index=0;index<40;index++)created.effects.finish(created.agent,row('retained-'+index));
    await created.effects.flush(created.agent);
    assert.ok(created.effects.snapshot(created.agent).persistence.pendingRequestRows>=33,
      'the old slice(-32) would have discarded early rows');
    failing=false;
    const flushed=await created.effects.flush(created.agent);
    assert.equal(flushed.complete,true);
    const rows=await stored(telemetryDir);
    assert.equal(rows.length,40);
    assert.deepEqual(rows.map(item=>item.requestId),Array.from({length:40},(_,index)=>'retained-'+index));
  }finally{await remove(telemetryDir);}
});

test('normal mode lets the next request proceed when the prior row is pending',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-gate-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  let failing=true;
  const io={...realFs,appendFile:async(...args)=>{
    if(failing&&args[0]===file)throw Object.assign(new Error('injected append failure'),{code:'EACCES'});
    return realFs.appendFile(...args);
  }};
  const created=await start({telemetryDir,io});
  try{
    created.effects.finish(created.agent,row('unsettled-row'));
    await created.effects.flush(created.agent);
    const next=row('next-row');
    await created.effects.start(created.agent,next);
    assert.equal(next.startRecorded,false);
    failing=false;
    await created.effects.flush(created.agent);
    await created.effects.start(created.agent,next);
    assert.equal(next.startRecorded,true);
    const schemas=(await stored(telemetryDir)).map(item=>item.schema);
    assert.ok(schemas.includes('work-evidence.request-effects.v1'));
    assert.ok(schemas.includes('work-evidence.request-start.v1'));
  }finally{await remove(telemetryDir);}
});

test('strict mode blocks the next request-start until the pending row is persisted',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-strict-gate-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  let failing=true;
  const io={...realFs,appendFile:async(...args)=>{
    if(failing&&args[0]===file)throw Object.assign(new Error('injected append failure'),{code:'EACCES'});
    return realFs.appendFile(...args);
  }};
  const created=await start({telemetryDir,io,config:{strictObservability:true}});
  try{
    created.effects.finish(created.agent,row('strict-unsettled-row'));
    await created.effects.flush(created.agent);
    const next=row('strict-next-row');
    await assert.rejects(()=>created.effects.start(created.agent,next,{strict:true}),error=>
      error.code==='EFFECT_PERSISTENCE_UNAVAILABLE'&&error.effectsDispatched===false);
    assert.equal(next.startRecorded,undefined,'strict mode must not claim an undispatched start');
  }finally{await remove(telemetryDir);}
});

test('an append that publishes a complete row and then throws is not duplicated',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-published-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  let injected=false;
  const io={...realFs,appendFile:async(...args)=>{
    if(!injected&&args[0]===file){
      injected=true;
      await realFs.appendFile(...args);
      throw new Error('injected failure after publication');
    }
    return realFs.appendFile(...args);
  }};
  const created=await start({telemetryDir,io});
  try{
    created.effects.finish(created.agent,row('published-once'));
    const flushed=await created.effects.flush(created.agent);
    assert.equal(flushed.complete,true);
    assert.equal((await stored(telemetryDir)).filter(item=>item.requestId==='published-once').length,1);
  }finally{await remove(telemetryDir);}
});

test('an append whose publication readback also fails is proved before retry',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-readback-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  let appendCalls=0,readFailures=0;
  const io={...realFs,
    appendFile:async(...args)=>{
      if(args[0]===file&&appendCalls++===0){
        await realFs.appendFile(...args);
        throw Object.assign(new Error('lost append acknowledgement'),{code:'EIO'});
      }
      return realFs.appendFile(...args);
    },
    readFile:async(...args)=>{
      if(args[0]===file&&readFailures<2){
        readFailures++;
        throw Object.assign(new Error('injected readback failure'),{code:'EIO'});
      }
      return realFs.readFile(...args);
    }};
  const created=await start({telemetryDir,io});
  try{
    created.effects.finish(created.agent,row('published-readback-unknown'));
    const flushed=await created.effects.flush(created.agent);
    assert.equal(flushed.complete,true);
    assert.equal(appendCalls,1,'a row proved present after an unknown append is never appended twice');
    assert.equal(readFailures,2);
    assert.equal((await stored(telemetryDir)).filter(item=>item.requestId==='published-readback-unknown').length,1);
  }finally{await remove(telemetryDir);}
});

test('an in-flight finish is pending until its row is written',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-finish-pending-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  let release=null,blocked=false;
  const io={...realFs,appendFile:async(...args)=>{
    if(args[0]===file&&!blocked){
      blocked=true;
      await new Promise(resolve=>{release=resolve;});
    }
    return realFs.appendFile(...args);
  }};
  const created=await start({telemetryDir,io});
  try{
    created.effects.finish(created.agent,row('finish-pending'));
    await new Promise(resolve=>setTimeout(resolve,20));
    const pending=created.effects.snapshot(created.agent).persistence;
    assert.equal(pending.finishPending,1);
    assert.equal(pending.complete,false,'an asynchronous finish cannot report complete before its append resolves');
    assert.equal(pending.queueEmpty,false);
    release();
    const flushed=await created.effects.flush(created.agent);
    assert.equal(flushed.complete,true);
    assert.equal(created.effects.snapshot(created.agent).persistence.finishPending,0);
  }finally{release?.();await remove(telemetryDir);}
});

test('disposeAgent retries pending request rows before dropping state',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-dispose-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  let failing=true;
  const io={...realFs,appendFile:async(...args)=>{
    if(failing&&args[0]===file)throw Object.assign(new Error('injected append failure'),{code:'EACCES'});
    return realFs.appendFile(...args);
  }};
  const created=await start({telemetryDir,io});
  try{
    created.effects.finish(created.agent,row('dispose-row'));
    await created.effects.flush(created.agent);
    failing=false;
    await created.effects.disposeAgent(created.agent);
    assert.deepEqual((await stored(telemetryDir)).map(item=>item.requestId),['dispose-row']);
  }finally{await remove(telemetryDir);}
});

test('a request-link append failure is retained and reported as incomplete',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-link-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  let failing=true;
  const io={...realFs,appendFile:async(...args)=>{
    if(failing&&String(args[1]).includes('request-link'))throw Object.assign(new Error('injected link failure'),{code:'EACCES'});
    return realFs.appendFile(...args);
  }};
  const created=await start({telemetryDir,io});
  try{
    const stream=created.handlers.get('agent/assistant-stream');
    assert.equal(typeof stream,'function');
    stream({agent:created.agent,frame:{type:'start',attemptId:'attempt-1',turn:1,step:1}});
    created.effects.begin(created.agent,{provider:'p',model:'m',messages:[],tools:[],system:''},{requestKind:'main'});
    stream({agent:created.agent,frame:{type:'end',attemptId:'attempt-1',outcome:{kind:'completed',seq:3}}});
    const before=await created.effects.flush(created.agent);
    assert.equal(before.complete,false);
    assert.equal(created.effects.snapshot(created.agent).persistence.pendingLinkRows,1);
    failing=false;
    const after=await created.effects.flush(created.agent);
    assert.equal(after.complete,true);
    assert.ok((await stored(telemetryDir)).some(item=>item.schema==='work-evidence.request-link.v1'));
  }finally{await remove(telemetryDir);}
});

test('a conflicting row with the same stable identity is reported instead of being treated as an idempotent duplicate',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-conflict-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  let injected=false;
  const io={...realFs,appendFile:async(...args)=>{
    if(!injected&&args[0]===file){
      injected=true;
      await realFs.appendFile(file,JSON.stringify(row('conflicting-row',COMPLETE,{step:99}))+'\n','utf8');
      throw new Error('injected failure after writing a different row');
    }
    return realFs.appendFile(...args);
  }};
  const created=await start({telemetryDir,io});
  try{
    const pending=row('conflicting-row',COMPLETE,{step:1});
    created.effects.finish(created.agent,pending);
    const flushed=await created.effects.flush(created.agent);
    assert.equal(flushed.complete,false);
    assert.equal(created.effects.snapshot(created.agent).persistence.persistenceConflict,true);
    assert.equal(created.effects.snapshot(created.agent).persistence.pendingRequestRows,1);
    assert.ok(created.effects.snapshot(created.agent).persistence.writeErrors.some(message=>/Conflicting/u.test(message)));
    const rows=await stored(telemetryDir);
    assert.equal(rows.length,1,'the conflicting on-disk row is not overwritten');
    assert.equal(rows[0].step,99);
    assert.equal((await created.effects.disposeAgent(created.agent)).status,'unrecoverable',
      'a conflicting stable identity cannot claim a recoverable pending state');
  }finally{await remove(telemetryDir);}
});

test('a conflicting persisted identity makes load incomplete without double-counting the request',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-load-conflict-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  const created=await start({telemetryDir});
  try{
    await fs.writeFile(file,JSON.stringify(row('duplicate-id'))+'\n'+JSON.stringify(row('duplicate-id',COMPLETE,{step:7}))+'\n','utf8');
    await created.effects.load(created.agent);
    const snapshot=created.effects.snapshot(created.agent);
    assert.equal(snapshot.persistence.persistenceConflict,true);
    assert.equal(snapshot.persistence.complete,false);
    assert.equal(snapshot.requests.count,1,'a conflicting duplicate is not counted twice');
    assert.ok(snapshot.persistence.writeErrors.some(message=>/Conflicting persistent row/u.test(message)));
  }finally{await remove(telemetryDir);}
});

test('an explicitly undispatched start is not a ghost consumption record',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-ghost-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  try{
    await fs.writeFile(file,JSON.stringify({schema:'work-evidence.request-start.v1',sessionId:SESSION,
      requestId:'never-dispatched',dispatchState:'not-dispatched',at:'2026-11-02T00:00:00.000Z'})+'\n','utf8');
    const created=await start({telemetryDir});
    await created.effects.load(created.agent);
    const summary=created.effects.snapshot(created.agent).persistence;
    assert.equal(summary.unsettledRequestStarts,0);
    assert.equal(summary.recoveredRequestStarts,1);
    assert.equal(summary.complete,true,'a start explicitly recorded as not dispatched is not unknown consumption');
  }finally{await remove(telemetryDir);}
});

test('plugin disposal retains an unsettled dispatched start instead of clearing its evidence',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-dispose-unsettled-'));
  const file=path.join(telemetryDir,SESSION+'.observability.jsonl');
  try{
    await fs.writeFile(file,JSON.stringify({schema:'work-evidence.request-start.v1',sessionId:SESSION,
      requestId:'dispatch-unknown',dispatchState:'dispatch-intent',at:'2026-11-02T00:00:00.000Z'})+'\n','utf8');
    const created=await start({telemetryDir});
    await created.effects.load(created.agent);
    const disposed=await created.effects.dispose();
    assert.equal(disposed.status,'pending');
    assert.equal(created.effects.snapshot(created.agent).persistence.unsettledRequestStarts,1,
      'plugin unload must not erase a start whose upstream outcome is still unknown');
  }finally{await remove(telemetryDir);}
});

test('without session storage, finished request rows stay pending and complete stays false',async()=>{
  const telemetryDir=await fs.mkdtemp(path.join(os.tmpdir(),'we-effects-no-storage-'));
  const created=await start({telemetryDir});
  try{
    created.state.telemetryDir=null;
    created.state.dir=null;
    created.effects.finish(created.agent,row('retained-without-storage'));
    const flushed=await created.effects.flush(created.agent);
    assert.equal(flushed.complete,false);
    assert.equal(flushed.pendingRequestRows,1);
    assert.equal(created.effects.snapshot(created.agent).persistence.complete,false);
    assert.equal((await created.effects.disposeAgent(created.agent)).status,'unrecoverable',
      'a session without any persistent identity cannot promise later recovery');
  }finally{await remove(telemetryDir);}
});
