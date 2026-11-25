import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryHygiene} from '../history-hygiene.mjs';
import {defaults} from '../runtime.mjs';

function fixture(command,body,{allow=true,blocks=[]}={}){
  const log=[],session={id:'protected-history',log,surface:{nodes:[],contentGeneration:0},eventAt:seq=>log[seq]},agent={session};
  const add=(type,data)=>{const event={seq:log.length,type,data};log.push(event);session.surface.nodes.push(event.seq);session.seq=event.seq;return event;};
  const state={config:defaults({contextProtocol:false}),root:process.cwd()};let protectedResult=false,allowCurrent=allow;
  const hygiene=createHistoryHygiene({get:()=>state,isEnabled:()=>true,contextControl:{assess:()=>({allowed:allowCurrent,reason:'fixture-forecast'}),remember:()=>{}}}, {phase:()=>({focus:[]})},{isProtected:()=>protectedResult,canRecall:()=>true});
  add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Inspect output.'}]}});
  add('step/start',{});add('tool/call',{name:'bash',callId:'body-call',arguments:{command}});
  const message={id:'body',role:'tool',source:{callId:'body-call'},content:[{type:'text',text:body},...blocks]};
  const event=add('tool/result',{message});add('step/start',{});
  return {agent,hygiene,add,message,seq:event.seq,protect:()=>{protectedResult=true;},setAllow:value=>{allowCurrent=value;}};
}
test('receipt application rechecks a result protected after receipt capture',()=>{
  for(const [command,body] of [['git status','native output\n'+'x'.repeat(12000)],['python -m pytest -q','100 passed in 0.2s\n'+'x'.repeat(12000)]]){
    const h=fixture(command,body);
    assert.notDeepEqual(h.hygiene.project(h.agent,[h.message])[0].content,h.message.content);
    h.protect();assert.deepEqual(h.hygiene.project(h.agent,[h.message])[0].content,h.message.content);
  }
});
test('generic receipts preserve output when the cache forecast denies a new rewrite',()=>{
  const h=fixture('git status','native output\n'+'x'.repeat(12000),{allow:false});
  assert.deepEqual(h.hygiene.project(h.agent,[h.message])[0].content,h.message.content);
  assert.equal(h.hygiene.bodyVisible(h.agent,h.seq),true);
});
test('a recorded test digest stays stable across consecutive requests when a new forecast would deny it',()=>{
  const h=fixture('python -m pytest -q','100 passed in 0.2s\n'+'x'.repeat(12000));
  const first=h.hygiene.project(h.agent,[h.message])[0];
  h.setAllow(false);
  const second=h.hygiene.project(h.agent,[h.message])[0];
  const third=h.hygiene.project(h.agent,[h.message])[0];
  assert.deepEqual(second,first);
  assert.deepEqual(third,first);
});
test('generic and test receipts preserve every image or file block beside text',()=>{
  for(const command of ['git status','python -m pytest -q'])for(const block of [{type:'image',data:'retained-image'},{type:'file',id:'retained-file'}]){
    const h=fixture(command,'100 passed in 0.2s\n'+'x'.repeat(12000),{blocks:[block]});
    assert.deepEqual(h.hygiene.project(h.agent,[h.message])[0].content,h.message.content);
  }
});
test('a full-output request restores reported visibility while retaining managed history',()=>{
  const h=fixture('git status','native output\n'+'x'.repeat(12000));h.hygiene.project(h.agent,[h.message]);
  assert.equal(h.hygiene.bodyVisible(h.agent,h.seq),false);
  h.add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Keep full output.'}]}});
  assert.equal(h.hygiene.fullOutputRequested(h.agent),true);
  assert.equal(h.hygiene.bodyVisible(h.agent,h.seq),true);assert.equal(h.hygiene.manages(h.agent,h.seq),true);
});

test('full-output requests preserve the ordinary pruned middle and normal requests can resume pruning',()=>{
  for(const priorProjection of [false,true]){
    const body='head\n'+'ordinary-result-middle '.repeat(450)+'\ntail',h=fixture('printf data',body);
    h.add('step/start',{});
    if(priorProjection)assert.notDeepEqual(h.hygiene.project(h.agent,[h.message])[0].content,h.message.content);
    h.add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Keep full output.'}]}});
    assert.deepEqual(h.hygiene.project(h.agent,[h.message])[0].content,h.message.content);
    assert.equal(h.hygiene.bodyVisible(h.agent,h.seq),true);
    h.add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Continue with the summary.'}]}});
    assert.notDeepEqual(h.hygiene.project(h.agent,[h.message])[0].content,h.message.content);
    assert.equal(h.hygiene.bodyVisible(h.agent,h.seq),false);
  }
});

test('saved receipts preserve a later surface replacement with the original message id',()=>{
  for(const command of ['git status','python -m pytest -q']){
    const h=fixture(command,'100 passed in 0.2s\n'+'x'.repeat(12000));
    assert.notDeepEqual(h.hygiene.project(h.agent,[h.message])[0].content,h.message.content);
    const current={...h.message,content:[{type:'text',text:'New visible locator and retained detail\n'+'y'.repeat(7000)}]};
    const replacement=h.add('tool/result',{message:current});
    replacement.surfaceOp={op:'replace',startSeq:h.seq,endSeq:h.seq};
    assert.deepEqual(h.hygiene.project(h.agent,[current])[0],current,command);
    assert.equal(h.hygiene.bodyVisible(h.agent,h.seq),true);
  }
});

function definitionFixture({definitionSummary='off'}={}){
  const log=[],session={id:'definition-summary',log,surface:{nodes:[],contentGeneration:0},eventAt:seq=>log[seq]},agent={session};
  const state={config:defaults({contextProtocol:false,historyHygiene:true,definitionSummary}),root:process.cwd()};
  const hygiene=createHistoryHygiene({get:()=>state,isEnabled:()=>true,contextControl:{assess:()=>({allowed:false,reason:'fixture'}),remember:()=>{}}},
    {phase:()=>({focus:[]})},{canRecall:()=>true});
  const add=(type,data)=>{const event={seq:log.length,type,data};log.push(event);session.surface.nodes.push(event.seq);session.seq=event.seq;return event;};
  add('step/start',{});
  add('tool/call',{name:'grep',callId:'grep-definitions',arguments:{pattern:'birthday'}});
  const text='Found 2 matches\n\nsrc/identity_metadata.py\nLine 10: def normalize_user_birthday(value):\n\nsrc/group_identity_tools.py\nLine 20: def normalize_birthday_number(value):';
  hygiene.observe({agent,rootCallId:'grep-definitions',callId:'grep-definitions',name:'grep',arguments:{pattern:'birthday'}},
    {content:[{type:'text',text}],value:{matches:[]}});
  const message={id:'grep-definitions-result',role:'tool',source:{callId:'grep-definitions'},content:[{type:'text',text}]};
  add('tool/result',{message});
  add('step/start',{});
  return {agent,hygiene,message};
}

test('definition summaries are counted as candidates but only sent when opted in',()=>{
  const off=definitionFixture(),offResult=off.hygiene.project(off.agent,[off.message])[0],offView=off.hygiene.summary(off.agent).definitionSummary;
  assert.doesNotMatch(offResult.content[0].text,/Definition hits/u);
  assert.equal(offView.enabled,false);
  assert.equal(offView.candidateCalls,1);
  assert.equal(offView.sentCalls,0);
  assert.ok(offView.candidateInjectedChars>0);
  assert.equal(offView.injectedChars,0);

  const on=definitionFixture({definitionSummary:'on'}),onResult=on.hygiene.project(on.agent,[on.message])[0],onView=on.hygiene.summary(on.agent).definitionSummary;
  assert.match(onResult.content[0].text,/Definition hits \(2\)/u);
  assert.equal(onView.enabled,true);
  assert.equal(onView.candidateCalls,1);
  assert.equal(onView.sentCalls,1);
  assert.equal(onView.injectedChars,onView.candidateInjectedChars);
  assert.equal(onView.projectedInjectedChars,onView.injectedChars);
  assert.equal(onView.cumulativeInjectedChars,onView.projectedInjectedChars);
  assert.equal(onView.projectionCalls,1);
  assert.equal(onView.netChars,onView.compactedChars-onView.projectedInjectedChars);
  assert.equal(onView.observedNetChars,onView.compactedChars-onView.injectedChars);
});
