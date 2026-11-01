import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {defaults} from '../runtime.mjs';
import {createContextWindow} from '../context-window.mjs';
import {createHistoryCoordinator} from '../history-coordinator.mjs';
import {startHost,text,tool,requestText} from './helpers/host.mjs';
test('enabled SW exits before history reads or economic assessment when outputs are unique',()=>{
  const config=defaults({swLedger:true,swEviction:true}),events=new Map(),nodes=[];let historyReads=0,assessments=0;
  assert.equal(defaults().swLedger,false);assert.equal(defaults().swEviction,false);
  const agent={session:{id:'sw-unique',seq:0,surface:{nodes},eventAt:seq=>{historyReads++;return events.get(seq);}}};
  const state={config,viewEpoch:0};
  const runtime={get:()=>state,isEnabled:()=>true,canRecall:()=>true,contextControl:{assess:()=>{assessments++;return {allowed:true};}}};
  const sw=createContextWindow({},runtime);
  for(let i=0;i<220;i++){
    const event={seq:i,type:'tool/result',data:{message:{content:[{type:'text',text:'observation '+i+' '+'x'.repeat(12000)}]}}};
    events.set(i,event);nodes.push(i);agent.session.seq=i+1;sw.recordResult(agent,{name:'pwsh'},event);
  }
  const began=performance.now();for(let i=0;i<5000;i++)assert.equal(sw.propose(agent),null);
  const elapsed=performance.now()-began,metrics=sw.metrics(agent);
  assert.equal(historyReads,0);assert.equal(assessments,0);assert.equal(metrics.observations,200);
  assert.equal(metrics.duplicateBodies,0);assert.ok(metrics.retainedChars<8*1024*1024);
  console.log('measurement',JSON.stringify({feature:'sw-unique-idle',proposals:5000,historyReads,assessments,elapsedMs:Math.round(elapsed*100)/100}));
});
async function ordinary(swEviction){
  const host=await startHost({workspace:{swLedger:swEviction,swEviction},script:(_o,n)=>n<=12?[tool('read',{file_path:`f${n}.txt`})]:[text('完成。')]});
  try{
    for(let i=1;i<=12;i++)await fs.writeFile(path.join(host.cwd,`f${i}.txt`),'unique file '+i+'\n');
    const agent=await host.createAgent('max');await host.send(agent,'读取文件后总结');
    return {bodies:host.requests.map(requestText).map(s=>s.replaceAll(JSON.stringify(host.cwd).slice(1,-1),'<workspace>').replaceAll(host.cwd,'<workspace>')),aux:host.auxiliaryRequests.length,
      sw:(await host.command(agent,'detail')).sw};
  }finally{await host.close();}
}
test('enabled SW leaves ordinary unique read requests unchanged and adds no model calls',async()=>{
  const on=await ordinary(true),off=await ordinary(false);
  assert.equal(on.bodies.length,off.bodies.length);
  for(let i=0;i<on.bodies.length;i++)if(on.bodies[i]!==off.bodies[i]){
    const a=on.bodies[i],b=off.bodies[i];let j=0;while(j<a.length&&a[j]===b[j])j++;
    assert.fail('request '+i+' differs at '+j+': '+JSON.stringify({on:a.slice(j-60,j+120),off:b.slice(j-60,j+120)}));
  }
  assert.equal(on.aux,0);assert.equal(off.aux,0);
  assert.equal(on.sw.evicted,0);assert.equal(on.sw.duplicateBodies,0);assert.equal(off.sw.observations,0);
});

function ledgerFixture(){
  const events=new Map(),session={id:'sw-counts',seq:0,surface:{nodes:[],contentGeneration:0},eventAt:seq=>events.get(seq)};
  session.append=(type,data,options={})=>{
    const event={seq:session.seq++,type,data,...options};events.set(event.seq,event);
    if(options.surfaceOp){const i=session.surface.nodes.indexOf(options.surfaceOp.startSeq);session.surface.nodes.splice(i,1,event.seq);}
    else session.surface.nodes.push(event.seq);
    session.surface.contentGeneration++;return event;
  };
  const agent={session},state={config:defaults({swLedger:true,swEviction:true}),viewEpoch:0};
  const runtime={get:()=>state,isEnabled:()=>true,canRecall:()=>true,contextControl:{
    assess:()=>({allowed:true}),remember:(_a,decision)=>decision,pressure:()=>({emergency:true})}};
  const sw=createContextWindow({},runtime);
  const record=(body,toolName='pwsh')=>{
    const event=session.append('tool/result',{message:{content:[{type:'text',text:body}]}});
    sw.recordResult(agent,{name:toolName},event);return event;
  };
  return {agent,state,sw,record};
}
test('SW duplicate counts survive eviction and later pruning without retaining removed bodies',()=>{
  const {agent,sw,record}=ledgerFixture(),body='duplicate body '.repeat(5000);
  for(let i=0;i<3;i++)record(body);
  assert.equal(sw.metrics(agent).duplicateBodies,1);
  sw.get(agent).step=10;
  assert.equal(sw.beforeStep(agent).replaced,2);
  assert.equal(sw.metrics(agent).duplicateBodies,0);
  assert.equal(sw.get(agent).bodyCounts.get('pwsh').get(body),1);
  for(let i=0;i<201;i++)record('unique '+i);
  const metrics=sw.metrics(agent);
  assert.equal(metrics.observations,200);assert.equal(metrics.duplicateBodies,0);
  assert.equal(sw.get(agent).bodyCounts.get('pwsh').has(body),false);
  assert.equal(metrics.retainedChars,sw.get(agent).observations.reduce((n,item)=>n+item.chars,0));
});
test('SW bounds retained characters and keeps duplicate counts separate by tool',()=>{
  const {agent,sw,record}=ledgerFixture(),body='a'.repeat(600000);
  record(body,'read');record(body,'pwsh');assert.equal(sw.metrics(agent).duplicateBodies,0);
  record(body,'read');record(body,'read');assert.equal(sw.metrics(agent).duplicateBodies,1);
  for(let i=0;i<20;i++)record(String(i)+'x'.repeat(600000));
  const metrics=sw.metrics(agent);
  assert.ok(metrics.observations<200);assert.ok(metrics.retainedChars<=8*1024*1024);
  assert.equal(metrics.duplicateBodies,0);assert.equal(sw.get(agent).bodyCounts.has('read'),false);
  assert.equal(metrics.retainedChars,sw.get(agent).observations.reduce((n,item)=>n+item.chars,0));
  assert.equal(sw.propose(agent),null);
});
test('history coordination also avoids history reads when enabled SW has no duplicate',()=>{
  const {agent,state,sw,record}=ledgerFixture();record('one unique output');let reads=0;
  agent.session.eventAt=()=>{reads++;throw Error('idle coordination must not read the log');};
  const runtime={get:()=>state,isEnabled:()=>true},unreachable=()=>{throw Error('idle coordination must not assess plans');};
  const coordinator=createHistoryCoordinator(runtime,sw,{pressure:unreachable});
  const decision={kind:'enter',messages:[]};
  for(let i=0;i<100;i++)assert.equal(coordinator.beforeStep({agent},decision,agent.session.surface.contentGeneration),decision);
  assert.equal(reads,0);
});
