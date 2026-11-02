import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostReferences,hostReferenceIndex,nativeReadObservation} from '../host-references.mjs';
import {createReferenceContext} from '../reference-context.mjs';
import {createTaskFlow} from '../task-flow.mjs';
import {exportTaskHandoff} from '../task-handoff.mjs';
import {defaults} from '../runtime.mjs';

function fixture({text='Original source text. '.repeat(650),truncated=false,body=true,malformed=false}={}){
  const capture={sessionId:'source',label:'Source task',cwd:'C:/projects/source',capturedThroughSeq:12,
    conversation:[{role:'user',text},{role:'assistant',text:'Historical assistant claim.'}]};
  const reference={sessionId:capture.sessionId,label:capture.label,inputIndex:0,capturedThroughSeq:12,capturedFormatVersion:3,
    originalMessages:truncated?3:2,retainedMessages:2,omittedMessages:truncated?1:0,omittedBytes:0,compacted:false,truncated};
  const log=[{seq:0,type:'user/message',data:{message:{id:'current',role:'user',source:{kind:'user'},content:[{type:'text',text:'Continue the requested task using historical sources only as background.'}]}}},
    {seq:1,type:'user/message',data:{message:{id:'capture',role:'user',source:{kind:'session-reference',version:1,form:'recall',references:[reference]},
      content:[{type:'text',text:body?'<referenced-sessions>'+JSON.stringify([{...capture,conversation:malformed?[]:capture.conversation}])+'</referenced-sessions>':'Capture text is missing.'}]}}}];
  const agent={session:{id:'receiver',header:{cwd:'C:/projects/current'},log,get seq(){return log.length;},requestHeader:()=>({config:{}}),eventAt:seq=>log.find(e=>e.seq===seq)}};
  const queries=[];
  const ctx={get:name=>name==='sessionQuery'?{readEvent:async args=>{queries.push(args);return {session:{id:agent.session.id},target:log.find(e=>e.seq===args.seq)};}}:undefined};
  const host=createHostReferences(ctx),state={config:defaults(),root:'C:/projects/current'};
  const runtime={get:()=>state,isEnabled:()=>true,activeMode:()=> 'aggressive'};
  const args={kind:'reference',seq:1,referenceSessionId:'source',offset:0,maxChars:64000};
  const append=(type,data)=>{const event={seq:log.length,type,data};log.push(event);return event;};
  return {capture,reference,log,agent,queries,host,runtime,args,append};
}

test('captured source pages retain host cwd and distinguish the end from an out-of-range offset',async()=>{
  const f=fixture(),index=hostReferenceIndex(f.log,f.agent.session.id,true).items[0];
  assert.equal(index.status,'captured');assert.equal(index.source.recoverable,true);assert.equal(index.textComplete,true);
  let offset=0,text='';
  do{
    const page=await f.host.recall(f.agent,{...f.args,offset,maxChars:256});
    assert.equal(page.status,'observed');assert.equal(page.authority,'untrusted-background');text+=page.text;offset=page.nextOffset;
  }while(offset!==null);
  const projection=JSON.parse(text);
  for(const key of ['sessionId','label','cwd','capturedThroughSeq','conversation'])assert.deepEqual(projection[key],f.capture[key]);
  const end=await f.host.recall(f.agent,{...f.args,offset:text.length});
  assert.equal(end.status,'observed');assert.equal(end.complete,true);assert.equal(end.text,'');
  const beyond=await f.host.recall(f.agent,{...f.args,offset:text.length+1});
  assert.equal(beyond.status,'unavailable');assert.equal(beyond.reason,'reference-offset-out-of-range');assert.equal(beyond.complete,undefined);
  assert.ok(f.queries.every(query=>query.sessionId==='receiver'),'local capture reads never query the foreign source session');
});

test('missing or mismatched capture bodies cannot advertise a complete recoverable source',async()=>{
  for(const options of [{body:false},{malformed:true}]){
    const f=fixture(options),item=hostReferenceIndex(f.log,'receiver',true).items[0];
    assert.equal(item.status,'unavailable');assert.equal(item.reason,'host-capture-body-unavailable');
    assert.equal(item.textComplete,false);assert.equal(item.snapshotComplete,false);assert.equal(item.source.recoverable,false);assert.equal(item.recall,null);
    const result=await f.host.recall(f.agent,f.args);assert.equal(result.status,'unavailable');
    assert.equal(result.reason,'host-capture-body-unavailable');
    const flow=createTaskFlow({},f.runtime),handoff=exportTaskHandoff(f.agent,f.runtime,flow,{canRecall:()=>true,canRecallReference:true});
    assert.equal(handoff.referencedSessions.items[0].source.recoverable,false);
    assert.equal(handoff.referencedSessions.items[0].textComplete,false);
  }
});

test('a fully returned truncated projection does not become a complete original snapshot',async()=>{
  const f=fixture({truncated:true}),page=await f.host.recall(f.agent,f.args);
  assert.equal(page.complete,true);assert.equal(page.snapshotComplete,false);assert.equal(page.omittedMessages,1);
  assert.equal(hostReferenceIndex(f.log,'receiver',true).items[0].textComplete,false);
  const callId='reference-read';f.append('tool/call',{callId,name:'work_recall',arguments:f.args});
  f.append('tool/result',{message:{id:'reference-page',role:'tool',source:{callId},content:[{type:'text',text:JSON.stringify(page)}]}});
  const flow=createTaskFlow({},f.runtime),handoff=exportTaskHandoff(f.agent,f.runtime,flow,{canRecall:()=>true,canRecallReference:true});
  const read=handoff.observedWork.sourceReads.items.at(-1);
  assert.equal(read.authority,'untrusted-background');assert.equal(read.deliveryVisibility,'not-assessed');
  assert.equal(read.page.endReached,true);assert.equal(read.page.wholeSourceReturned,false);assert.equal(read.page.snapshotComplete,false);
});

test('native source observations never assert model visibility or convert read authorization into action authority',()=>{
  const observed=nativeReadObservation('receiver',{session_id:'source',seq:12},{content:[{type:'text',text:'Session source — historical\nTarget event seq 12:\n```json\n'+JSON.stringify({seq:12,type:'tool/result'})+'\n```'}]});
  assert.equal(observed.status,'observed');assert.equal(observed.authorization,'host-authorized-at-read');
  assert.equal(observed.deliveryVisibility,'not-assessed');assert.equal(observed.authority,'historical-data');
  const denied=nativeReadObservation('receiver',{session_id:'source',seq:12},{isError:true,content:[{type:'text',text:'session target is outside the caller workspace'}]});
  assert.equal(denied.status,'denied');assert.equal(denied.deliveryVisibility,'not-assessed');
});

test('source replacement requires complete visible pages and expires on a new direct user request',async()=>{
  const f=fixture(),context=createReferenceContext(f.runtime,f.host,{canRecall:()=>true});
  const whole=await f.host.recall(f.agent,f.args),split=Math.floor(whole.totalChars/2);
  for(const [index,offset]of [0,split].entries()){
    const args={...f.args,offset,maxChars:index===0?split:64000},page=await f.host.recall(f.agent,args),callId='page-'+index;
    f.append('tool/call',{callId,name:'work_recall',arguments:args});
    f.append('tool/result',{message:{id:callId,role:'tool',source:{callId},content:[{type:'text',text:JSON.stringify(page)}]}});
  }
  for(const event of f.log)context.consume(f.agent,event);
  const messages=f.log.filter(e=>['user/message','tool/result'].includes(e.type)).map(e=>e.data.message);
  const missing=messages.filter(message=>message.id!=='page-0');
  assert.equal(context.project(f.agent,missing,{allowed:()=>true}),missing);
  assert.equal(context.hasRequestView(f.agent),false);
  const projected=context.project(f.agent,messages,{allowed:()=>true});
  assert.notEqual(projected,messages);assert.equal(context.hasRequestView(f.agent),true);
  assert.ok(projected.find(m=>m.id==='capture').content[0].text.includes('workEvidenceReference'));
  assert.ok(f.log[1].data.message.content[0].text.includes(f.capture.conversation[0].text),'canonical source text remains in the event');
  const next=f.append('user/message',{message:{id:'next',role:'user',source:{kind:'user'},content:[{type:'text',text:'Start the next request.'}]}});
  context.consume(f.agent,next);
  assert.equal(context.project(f.agent,[...messages,next.data.message],{allowed:()=>true}).find(m=>m.id==='capture'),messages.find(m=>m.id==='capture'));
  assert.equal(context.hasRequestView(f.agent),false);
});
