import test from 'node:test';
import assert from 'node:assert/strict';
import {createFinalJsonGuard} from '../final-json.mjs';
import {hasHistoricalReferences} from '../visible-results.mjs';

function jsonGuardHarness({steerFailure=false}={}){
  const hooks=new Map(),config={finalJsonGuard:true};let guard,enabled=true;
  const events=[{seq:0,type:'user/message',data:{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'只返回 JSON'}]}}},
    {seq:1,type:'assistant/message',data:{turn:1,message:{role:'assistant',content:[{type:'text',text:'{"value":1,}'}]}}}];
  const agent={session:{id:'json-lifecycle',log:events},steer:()=>{if(steerFailure)throw Error('inbox unavailable');}};
  const runtime={isEnabled:()=>enabled,get:()=>({config}),problem:()=>{}};
  const control=createFinalJsonGuard({on:(name,fn)=>hooks.set(name,fn),tools:{guard:fn=>{guard=fn;}}},runtime);
  return {agent,config,hooks,control,guard:()=>guard({agent}),disable:()=>{enabled=false;},
    stop:signal=>hooks.get('agent/turn-stopping')({agent,turn:1,signal:signal??new AbortController().signal})};
}

test('JSON repair releases tools after cancellation, disabling or a new direct request',async()=>{
  for(const reason of ['abort','disabled','setting','new-request']){
    const host=jsonGuardHarness();await host.stop();assert.equal(typeof host.guard(),'string');
    if(reason==='abort'){const signal=AbortSignal.abort();await host.stop(signal);}
    if(reason==='disabled')host.disable();
    if(reason==='setting')host.config.finalJsonGuard=false;
    if(reason==='new-request')host.hooks.get('session/event')(host.agent.session,{type:'user/message',data:{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'读取文件'}]}}});
    assert.equal(host.guard(),undefined,reason);
    assert.equal(host.control.summary(host.agent).syntaxRepairActive,false,reason);
  }
});

test('a failed JSON repair notice never leaves an active tool restriction',async()=>{
  const host=jsonGuardHarness({steerFailure:true});await host.stop();
  assert.equal(host.guard(),undefined);assert.equal(host.control.summary(host.agent).syntaxRepairActive,false);
});

test('history reference lookup scans appended events and rechecks replacements',()=>{
  const nodes=Array.from({length:200},(_,index)=>index),events=nodes.map(seq=>({seq,data:{message:{content:[{type:'text',text:'ordinary result'}]}}}));
  let reads=0;
  const session={surface:{nodes,contentGeneration:0},eventAt:seq=>{reads++;return events[seq];}},agent={session};
  assert.equal(hasHistoricalReferences(agent),false);assert.equal(reads,200);
  assert.equal(hasHistoricalReferences(agent),false);assert.equal(reads,200);
  nodes.push(200);events.push({seq:200,data:{message:{content:[{type:'text',text:'recover with work_recall'}]}}});
  assert.equal(hasHistoricalReferences(agent),true);assert.equal(reads,201);
  events[200]={seq:200,data:{message:{content:[{type:'text',text:'replacement has no reference'}]}}};session.surface.contentGeneration++;
  assert.equal(hasHistoricalReferences(agent),false);assert.equal(reads,402);
});
