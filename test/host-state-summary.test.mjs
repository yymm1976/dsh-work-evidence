import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,toolNames} from './helpers/host.mjs';

function lastResult(options){
  const message=options.messages.findLast(item=>item.role==='tool');
  assert.ok(message);
  return JSON.parse(message.content.map(block=>block.text??'').join(''));
}
function summary(value){
  const observation=value.observability;
  assert.equal(observation.view,'summary');
  assert.equal(Object.hasOwn(observation,'recentRequests'),false);
  assert.equal(Object.hasOwn(observation,'decisions'),false);
  assert.deepEqual(observation.details.arguments,{detail:true});
  assert.equal(observation.details.tool,'work_status');
  assert.ok(Array.isArray(observation.requestDiagnostics));
  for(const item of Object.values(observation.features))assert.equal(Object.hasOwn(item,'reasons'),false);
}
function detail(value){
  assert.ok(Array.isArray(value.observability.recentRequests));
  assert.ok(Array.isArray(value.observability.decisions));
  assert.equal(Object.hasOwn(value.observability,'view'),false);
}
async function directStatus(host,agent,args,id){
  const result=await host.ctx.tools.execute({name:'work_status',arguments:args,agent,callId:id,rootCallId:id,signal:AbortSignal.timeout(10000)});
  assert.equal(result.isError,false,JSON.stringify(result));
  return result.value??JSON.parse(result.content.map(block=>block.text??'').join(''));
}

test('full surface sends summaries and explicit details; idle queries preserve exact counters and storage',async()=>{
  const received={};let usageCalls=0;
  const host=await startHost({workspace:{toolSurface:'full'},
    usage:()=>{const cacheReadTokens=usageCalls===0?-1:0;usageCalls+=1;return {inputTokens:1000,outputTokens:100,cacheReadTokens,totalTokens:1100};},
    script:(options,call)=>{
      assert.ok(call<=7,'bounded scenario');
      if(call===1)return [tool('read',{file_path:'native.txt'})];
      if(call===2)return [tool('work_state',{})];
      if(call===3){received.default=lastResult(options);return [tool('work_state',{mode:'summary'})];}
      if(call===4){received.summary=lastResult(options);return [tool('work_state',{mode:'detail'})];}
      if(call===5){received.detail=lastResult(options);return [tool('work_status',{})];}
      if(call===6){received.status=lastResult(options);return [tool('work_status',{detail:true})];}
      received.statusDetail=lastResult(options);return [text('完成。')];
    }});
  try{
    await fs.writeFile(path.join(host.cwd,'native.txt'),'native data\n');
    const agent=await host.createAgent('max');await host.send(agent,'读取 native.txt 并查询插件状态。');
    assert.equal(host.requests.length,7);
    assert.equal(host.events.findLast(event=>event.type==='turn/end').data.reason.kind,'completed');
    for(const [key,count]of [['default',2],['summary',3],['detail',4],['status',5],['statusDetail',6]]){
      assert.equal(received[key].observability.requests.count,count,key);
      assert.equal(received[key].observability.requests.missingUsage,1,key);
      assert.equal(received[key].observability.requests.unknownConsumption,1,key);
    }
    for(const key of ['default','summary','status'])summary(received[key]);
    for(const key of ['detail','statusDetail'])detail(received[key]);
    assert.equal(Object.hasOwn(received.status,'requestObservations'),false);
    assert.equal(received.status.requestObservationWindow.count,5);
    assert.equal(received.default.observability.requestDiagnostics[0].usageComplete,false);
    const compact=await directStatus(host,agent,{},'idle-summary');
    const full=await directStatus(host,agent,{detail:true},'idle-detail');
    summary(compact);detail(full);
    for(const key of ['requests','totals','persistence','interpretation'])assert.deepEqual(compact.observability[key],full.observability[key]);
    assert.equal(full.observability.requests.count,7);
    assert.equal(full.observability.requests.unknownConsumption,1);
    assert.equal(host.requests.length,7,'read-only status queries make no model calls');
    assert.deepEqual(received.statusDetail.observability.recentRequests,full.observability.recentRequests.slice(0,6));
    assert.deepEqual(received.statusDetail.requestObservations,full.requestObservations.slice(0,6));
    // Each status tool is itself observed after its result. Request accounting
    // stays fixed while feature-decision counters can advance between queries.
    assert.deepEqual(Object.keys(compact.observability.features),Object.keys(full.observability.features));
    for(const item of Object.values(compact.observability.features)){
      assert.equal(typeof item.enabled,'boolean');assert.equal(typeof item.lastReason,'string');
      assert.equal(typeof item.decisions,'number');assert.equal(typeof item.applied,'number');
    }
    const command=await host.command(agent,'detail');
    detail(command.detail);
    for(const key of ['requests','totals','persistence','interpretation','recentRequests'])assert.deepEqual(command.detail.observability[key],full.observability[key]);
    assert.deepEqual(command.requestObservations,full.requestObservations);
    const stored=JSON.parse(await fs.readFile(path.join(full.telemetry.directory,agent.session.id+'.runtime.json'),'utf8'));
    detail(stored);assert.ok(Array.isArray(stored.requestObservations));
    assert.equal(stored.observability.requests.unknownConsumption,1);
    assert.ok(Object.values(stored.observability.features).some(item=>Object.hasOwn(item,'reasons')));
    assert.equal(await fs.readFile(path.join(host.cwd,'native.txt'),'utf8'),'native data\n');
  }finally{await host.close();}
});

test('compact surface keeps management tools hidden and its human detail command usable',async()=>{
  const host=await startHost({workspace:{toolSurface:'compact'},script:(options,call)=>{
    assert.ok(call<=2,'bounded scenario');
    assert.ok(!toolNames(options).includes('work_status'));
    assert.ok(!toolNames(options).includes('work_state'));
    return call===1?[tool('read',{file_path:'native.txt'})]:[text('完成。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'native.txt'),'native data\n');
    const agent=await host.createAgent('max');await host.send(agent,'读取 native.txt。');
    assert.equal(host.requests.length,2);
    assert.equal(host.events.findLast(event=>event.type==='turn/end').data.reason.kind,'completed');
    const status=await host.command(agent,'status'),full=await host.command(agent,'detail');
    detail(status);detail(full.detail);
    assert.equal(full.observability.requests.count,2);
    assert.ok(Array.isArray(full.requestObservations));
    assert.equal(full.contextSettings.toolSurface,'compact');
    assert.equal(host.requests.length,2,'commands do not dispatch model work');
    assert.equal(await fs.readFile(path.join(host.cwd,'native.txt'),'utf8'),'native data\n');
  }finally{await host.close();}
});

test('disabled status summary and detail remain read-only while native reading completes',async()=>{
  const received={};
  const host=await startHost({script:(options,call)=>{
    assert.ok(call<=4,'bounded scenario');
    if(call===1)return [tool('work_status',{})];
    if(call===2){received.status=lastResult(options);return [tool('work_status',{detail:true})];}
    if(call===3){received.detail=lastResult(options);return [tool('read',{file_path:'native.txt'})];}
    received.native=options.messages.findLast(item=>item.role==='tool').content.map(block=>block.text??'').join('');
    return [text('完成。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'native.txt'),'native data\n');
    const agent=await host.createAgent('max');await host.command(agent,'off');
    await host.send(agent,'查看插件关闭状态并读取 native.txt。');
    assert.equal(host.requests.length,4);
    assert.equal(host.events.findLast(event=>event.type==='turn/end').data.reason.kind,'completed');
    summary(received.status);detail(received.detail);
    assert.equal(received.status.requestObservationWindow.count,0);
    for(const value of [received.status,received.detail]){
      assert.equal(value.effective,false);assert.equal(value.session.override,false);
      assert.equal(value.observability.requests.count,0);
      assert.ok(Object.values(value.observability.features).every(item=>item.enabled===false));
    }
    assert.deepEqual(received.detail.requestObservations,[]);
    assert.ok(received.native.includes('native data'));
    const command=await host.command(agent,'detail');
    assert.equal(command.enabled,false);detail(command.detail);
    assert.deepEqual(command.requestObservations,[]);
    assert.equal(await fs.readFile(path.join(host.cwd,'native.txt'),'utf8'),'native data\n');
  }finally{await host.close();}
});
