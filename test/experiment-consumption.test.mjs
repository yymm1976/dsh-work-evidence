import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {accountSessionRequests,readRequestAccounting} from '../experiment-consumption.mjs';
import {canonicalUsage} from '../context-economics.mjs';
import {newSummary,applyRow,readRun} from '../experiment-store.mjs';
import {trialsFor,compareTrials} from '../experiment-cli.mjs';
import {nativeChildInventory,importSession} from '../experiment-native.mjs';
import {summarizeAttempts} from '../experiment-attempts.mjs';
import {startHost,text} from './helpers/host.mjs';
import {createEffectObserver} from '../effect-observer.mjs';

const usage=total=>({inputTokens:total-10,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:10,totalTokens:total});
function fixture(sessionId='accounted-session',{extra=true}={}){
  const mainUsage=usage(100),attempt={attemptId:sessionId+':1',turn:1,step:1};
  const events=[{seq:0,time:0,type:'request/header',data:{header:{config:{provider:'p',model:'m',reasoningEffort:'low'}}}},
    {seq:1,time:1,type:'turn/start',data:{turn:1}},{seq:2,time:2,type:'step/start',data:{turn:1,step:1}},
    {seq:3,time:3,type:'assistant/message',data:{turn:1,step:1,usage:mainUsage,
      message:{role:'assistant',source:{provider:'p',model:'m'},content:[{type:'text',text:'Done.'}]},
      stream:[{type:'chunk',chunk:{type:'usage',usage:mainUsage}},{type:'chunk',chunk:{type:'finish',reason:{kind:'stop'}}}]}},
    {seq:4,time:4,type:'step/end',data:{turn:1,step:1}},{seq:5,time:5,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];
  const rows=[];
  const add=(id,kind,total,nativeAttempt=null)=>{
    const request={sessionId,requestId:id,at:'2026-11-05T00:00:00.000Z',sourceSeq:kind==='main'?3:5,
      requestKind:kind,purpose:kind==='main'?null:kind==='compaction'?'compaction':'work-evidence:quality-review',
      provider:'p',model:'m',reasoningEffort:'low',nativeAttempt};
    rows.push({schema:'work-evidence.request-start.v1',...request});
    const canonical=canonicalUsage(usage(total));
    rows.push({schema:'work-evidence.request-effects.v1',...request,startRecorded:true,settled:true,
      finishReason:'stop',usage:canonical.usage,usageSources:canonical.sources,usageComplete:true,usageConsistent:true,unknownConsumption:false});
    return request;
  };
  add('main','main',100,attempt);
  rows.push({schema:'work-evidence.request-link.v1',sessionId,requestId:'main',nativeAttempt:attempt,
    outcome:'committed',eventType:'assistant/message',sourceSeq:3});
  if(extra){add('review','auxiliary',20);add('compression','compaction',30);}
  return {sessionId,events,rows,account:()=>accountSessionRequests(events,rows,{sessionId})};
}
async function temporary(t){
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'we-task-consumption-'));
  t.after(async()=>{const relative=path.relative(os.tmpdir(),folder);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    await fs.rm(folder,{recursive:true,force:true});});
  return folder;
}

test('a native main settlement is counted once while review and compaction are separate additions',()=>{
  const f=fixture(),result=f.account();
  assert.equal(result.complete,true);assert.equal(result.matchedNativeRequests,1);assert.equal(result.additionalRequests,2);
  assert.equal(result.additionalTokens.totalTokens.known,50);assert.equal(result.byKind.auxiliary.tokens.totalTokens.known,20);
  assert.equal(result.byKind.compaction.tokens.totalTokens.known,30);assert.equal(result.requests.length,2);
  for(const row of f.rows)if(row.requestId==='review')row.sourceSeq=6;
  assert.equal(f.account().complete,true,'A nonmain stream can use the next cursor at the native snapshot tail.');
  f.rows.push(structuredClone(f.rows[0]),structuredClone(f.rows[1]));
  assert.equal(f.account().exactDuplicateRows,2);assert.equal(f.account().additionalTokens.totalTokens.known,50);
});

test('dangling starts, conflicting settlements and rejected normalized usage keep consumption unknown',()=>{
  for(const mode of ['dangling','conflict','rejected']){
    const f=fixture();
    const index=f.rows.findIndex(row=>row.requestId==='review'&&row.schema==='work-evidence.request-effects.v1');
    if(mode==='dangling')f.rows.splice(index,1);
    if(mode==='conflict')f.rows.push({...f.rows[index],usage:usage(40)});
    if(mode==='rejected'){
      const invalid=canonicalUsage({inputTokens:10,cacheReadTokens:-1,cacheWriteTokens:0,outputTokens:10,totalTokens:20});
      Object.assign(f.rows[index],{usage:invalid.usage,usageSources:invalid.sources,usageComplete:false});
    }
    const result=f.account();assert.equal(result.complete,false,mode);assert.equal(result.byKind.auxiliary.unknownRequests,1,mode);
    assert.equal(result.additionalTokens.totalTokens.known,30,mode);
    if(mode==='dangling')assert.deepEqual(result.unsettledRequestIds,['review']);
  }
});

test('foreign or legacy identities and wrong native links cannot claim coverage or duplicate a native request',()=>{
  for(const mode of ['foreign','legacy','wrong-link','nonmain-link']){
    const f=fixture();
    if(mode==='foreign')f.rows.find(row=>row.requestId==='review').sessionId='another-session';
    if(mode==='legacy')for(const row of f.rows)delete row.sessionId;
    if(mode==='wrong-link')f.rows.find(row=>row.schema==='work-evidence.request-link.v1').sourceSeq=4;
    if(mode==='nonmain-link')f.rows.push({...f.rows.find(row=>row.schema==='work-evidence.request-link.v1'),requestId:'review'});
    const result=f.account();assert.equal(result.complete,false,mode);assert.ok(result.problems.length,mode);
    if(mode==='nonmain-link')assert.equal(result.additionalTokens.totalTokens.known,30);
  }
});

test('the audit command prices native and nonmain requests once and protects the supplied ledger',async t=>{
  const folder=await temporary(t),f=fixture(),input=path.join(folder,'native.json'),ledger=path.join(folder,'requests.jsonl'),prices=path.join(folder,'prices.json');
  await fs.writeFile(input,JSON.stringify({sessionId:f.sessionId,events:f.events}));
  await fs.writeFile(ledger,f.rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await fs.writeFile(prices,JSON.stringify([{provider:'p',model:'m',input:1,cacheRead:1,cacheWrite:0,output:1,currency:'USD'}]));
  const run=promisify(execFile),cli=path.resolve(import.meta.dirname,'../experiment-cli.mjs');
  const {stdout}=await run(process.execPath,[cli,'audit','--file',input,'--observations',ledger,'--prices',prices]);
  const result=JSON.parse(stdout);assert.equal(result.usage.requests.length,3);assert.equal(result.usage.totalTokens,150);
  assert.ok(Math.abs(result.usage.knownReferenceCostByCurrency.USD-.00015)<Number.EPSILON);assert.equal(result.usage.costComplete,true);
  const linked=path.join(folder,'ledger-link.jsonl');await fs.link(ledger,linked);
  await assert.rejects(run(process.execPath,[cli,'audit','--file',input,'--observations',ledger,'--out',linked]),/must not overwrite/);
  await fs.appendFile(ledger,'not-json\n');
  const damaged=await readRequestAccounting(ledger,f.events,{sessionId:f.sessionId});assert.equal(damaged.complete,false);
  assert.equal(damaged.problems.at(-1)?.reason??damaged.problems[0].reason,'invalid-json-row');
  const changed=JSON.parse((await run(process.execPath,[cli,'audit','--file',input,'--observations',ledger,'--prices',prices])).stdout);
  assert.equal(changed.usage.totalTokens,null);assert.equal(changed.usage.costComplete,false);
});

test('explicit file import and readRun retain session accounting without upgrading child provenance',async t=>{
  const folder=await temporary(t),f=fixture(),file=path.join(folder,'engineering.json'),observations=path.join(folder,'requests.jsonl');
  for(const event of f.events)event.seq++;
  f.events.unshift({seq:0,time:0,type:'agent-preset/selected',data:{agentPreset:'ptc'}});
  for(const row of f.rows)row.sourceSeq++;
  await fs.writeFile(file,JSON.stringify({sessionId:f.sessionId,workspace:folder,events:f.events}));
  await fs.writeFile(observations,f.rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const imported=await importSession({directory:folder,sessionId:f.sessionId,variant:'work-evidence',file,observations,
    home:folder,app:'C:/Users/杨铭/AppData/Local/Programs/DSH Desktop/dsh-desktop'});
  const saved=await readRun(path.join(folder,imported.runId));assert.equal(saved.requestAccounting.complete,true);
  assert.equal(saved.preset,'ptc');assert.equal(saved.recordedPluginAvailability,null);
  assert.equal(saved.variantSource,'operator-label','A shared PTC preset does not prove the plugin was disabled.');
  const [trial]=await trialsFor(folder,[saved]);assert.equal(trial.tokens.totalTokens.known,100);assert.equal(trial.taskTokens.totalTokens.known,150);
  assert.equal(trial.taskRequests,3);assert.equal(trial.childCoverageUnknown,true);assert.equal(trial.totalTaskTokensComplete,false);
});

test('family comparison includes every imported descendant and reports complete task totals separately from native totals',async t=>{
  const folder=await temporary(t);
  const make=(id,{parent=null,children=[],extra=true}={})=>{
    const f=fixture(id,{extra});
    for(const childId of children)f.events.push({seq:f.events.length,type:'subagent/catalog',data:{version:0,mode:'continuable',childId,childCreatedAt:1,label:'child'}});
    const meta={runId:'run-'+id,sessionId:id,parentSession:parent,variant:'work-evidence',source:'native-session-readonly',startedAt:1,
      childInventory:nativeChildInventory(f.events,{source:'native-session-readonly'}),requestAccounting:f.account()};
    const summary=newSummary(meta);applyRow(summary,{kind:'turn-start',at:1});applyRow(summary,{kind:'request-start',route:{provider:'p',model:'m'}});
    applyRow(summary,{kind:'request-end',at:3,usage:usage(100)});applyRow(summary,{kind:'turn-end',at:5,reason:'completed'});
    summary.attemptAccounting=summarizeAttempts(f.events);
    return summary;
  };
  const [on]=await trialsFor(folder,[make('parent',{children:['child']}),make('child',{parent:'parent'})]);
  assert.equal(on.totalTaskTokensComplete,true);assert.equal(on.tokens.totalTokens.known,200);assert.equal(on.taskTokens.totalTokens.known,300);
  const [off]=await trialsFor(folder,[make('off',{extra:false})]);
  for(const row of [on,off])Object.assign(row,{taskKey:'same-task',contextKey:'same-start',rubric:'same-quality',outcome:'pass'});
  off.variant='recorder-only';const compared=compareTrials([off,on],{taskKey:'same-task',contextKey:'same-start'});
  assert.equal(compared.groups.find(row=>row.variant==='work-evidence').meanTokens,300);
  assert.equal(compared.groups.find(row=>row.variant==='work-evidence').nativeMeanTokens,200);
  assert.equal(compared.groups.find(row=>row.variant==='work-evidence').tokenChangePct,200);
  const single=make('overlap');
  const [overlap]=await trialsFor(folder,[single,{...single,runId:'second-snapshot'}]);
  assert.equal(overlap.taskRequests,3);assert.equal(overlap.taskTokens.totalTokens.known,150,'Overlapping recorded request identities are counted once.');
  single.childInventory.children.push({childId:'external-task',mode:'external',version:2,childCreatedAt:1,sourceSeq:1});
  const [external]=await trialsFor(folder,[single]);assert.equal(external.totalTaskTokensComplete,false);
  assert.equal(external.taskTokens.totalTokens.known,150);
  delete on.totalTaskTokensComplete;
  assert.equal(compareTrials([off,on],{taskKey:'same-task',contextKey:'same-start'}).groups.find(row=>row.variant==='work-evidence').meanTokens,null);
});

test('native host frames bind the real stream to its durable event while auxiliary and compaction remain separate',async()=>{
  let host,agent,closed=false;
  host=await startHost({script:async options=>{
    for(const purpose of ['work-evidence:quality-review','compaction'])for await(const _chunk of host.ctx.llm.stream({
      provider:'scripted',model:'scripted-model',sessionId:options.sessionId,purpose,system:'Return JSON.',
      messages:[{role:'user',content:[{type:'text',text:'{}'}]}],tools:[],signal:options.signal})){}
    return [text('Done.')];
  },usage:options=>usage(options.purpose==='compaction'?30:options.purpose?20:100)});
  try{
    agent=await host.createAgent();await host.send(agent,'Reply Done.');
    const status=await host.command(agent,'status'),file=status.observability.persistence.file;
    const events=structuredClone(host.events),sessionId=agent.session.id;
    await host.close();closed=true;
    const result=await readRequestAccounting(file,events,{sessionId});
    assert.equal(result.nativeRequests,1);assert.equal(result.matchedNativeRequests,1);
    assert.equal(result.additionalRequests,2);assert.equal(result.additionalTokens.totalTokens.known,50);
    assert.equal(result.complete,true,JSON.stringify(result.problems));
    const state={telemetryDir:path.dirname(file),dir:host.cwd,config:{toolSurface:'compact'},step:1,dirty:false};
    const restored=createEffectObserver({on:()=>()=>{}},{get:()=>state,isEnabled:()=>true,modeStatus:()=>({selected:'aggressive'})});
    const detached={session:{id:sessionId}};await restored.load(detached);
    assert.equal(restored.snapshot(detached).requests.count,3,'Start and link rows do not become extra dispatched requests after restoration.');
    await restored.dispose();
  }finally{if(!closed)await host.close();}
});
