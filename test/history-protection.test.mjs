import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryHygiene} from '../history-hygiene.mjs';
import {defaults} from '../runtime.mjs';

function fixture(command,body){
  const log=[],session={id:'protected-history',log,surface:{nodes:[],contentGeneration:0},eventAt:seq=>log[seq]},agent={session};
  const add=(type,data)=>{const event={seq:log.length,type,data};log.push(event);session.surface.nodes.push(event.seq);session.seq=event.seq;return event;};
  const state={config:defaults({contextProtocol:false}),root:process.cwd()};let protectedResult=false;
  const hygiene=createHistoryHygiene({get:()=>state,isEnabled:()=>true}, {phase:()=>({focus:[]})},{isProtected:()=>protectedResult,canRecall:()=>true});
  add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Inspect output.'}]}});
  add('step/start',{});add('tool/call',{name:'bash',callId:'body-call',arguments:{command}});
  const message={id:'body',role:'tool',source:{callId:'body-call'},content:[{type:'text',text:body}]};
  const event=add('tool/result',{message});add('step/start',{});
  return {agent,hygiene,add,message,seq:event.seq,protect:()=>{protectedResult=true;}};
}
test('receipt application rechecks a result protected after receipt capture',()=>{
  for(const [command,body] of [['git status','native output\n'+'x'.repeat(12000)],['python -m pytest -q','100 passed in 0.2s\n'+'x'.repeat(12000)]]){
    const h=fixture(command,body);
    assert.notDeepEqual(h.hygiene.project(h.agent,[h.message])[0].content,h.message.content);
    h.protect();assert.deepEqual(h.hygiene.project(h.agent,[h.message])[0].content,h.message.content);
  }
});
test('a full-output request restores reported visibility while retaining managed history',()=>{
  const h=fixture('git status','native output\n'+'x'.repeat(12000));h.hygiene.project(h.agent,[h.message]);
  assert.equal(h.hygiene.bodyVisible(h.agent,h.seq),false);
  h.add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Keep full output.'}]}});
  assert.equal(h.hygiene.fullOutputRequested(h.agent),true);
  assert.equal(h.hygiene.bodyVisible(h.agent,h.seq),true);assert.equal(h.hygiene.manages(h.agent,h.seq),true);
});
