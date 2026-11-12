import test from 'node:test';
import assert from 'node:assert/strict';
import {subagentResultIndex} from '../host-references.mjs';
import {exportTaskHandoff,handoffPatch} from '../task-handoff.mjs';
import {createTaskFlow} from '../task-flow.mjs';
import {recallHistory} from '../compaction-handoff.mjs';
import {defaults} from '../runtime.mjs';

const content=text=>({type:'text',text});
const catalog=(seq,childId='child',mode='continuable',childCreatedAt=1)=>({seq,type:'subagent/catalog',data:{version:mode==='external'?2:mode==='unknown'?1:0,childId,childCreatedAt,mode,label:'Investigation'}});
const notice=(seq,childId='child',body='CHILD_RESULT: source.txt has the required declaration.')=>({seq,type:'user/message',data:{message:{role:'user',id:'notice-'+seq,
  source:{kind:'subagent-settled',form:'notice',senderSessionId:childId},content:[content('Background subagent '+childId+' finished.'),content('Its closing message:'),content(body)]}}});
const relay=(seq,childId='child')=>({seq,type:'user/message',data:{message:{role:'user',id:'relay-'+seq,
  source:{kind:'agent-message',form:'relay',senderSessionId:childId},content:[content('Agent '+childId+' sent a message: '),content('EARLY_RESULT: do not repeat the source investigation.')]}}});
function fixture(log,inherited=0){
  const agent={session:{id:'parent',header:{cwd:'C:/project',isSeeded:inherited>0},inheritedEventCount:inherited,log,
    eventAt:seq=>log.find(event=>event.seq===seq),requestHeader:()=>({config:{}})}};
  const state={config:defaults(),root:'C:/project'},runtime={get:()=>state,isEnabled:()=>true,activeMode:()=> 'aggressive'};
  const flow=createTaskFlow({},runtime);
  return {agent,build:(options={})=>exportTaskHandoff(agent,runtime,flow,{canRecall:()=>true,canSearchChildEvents:true,...options})};
}

test('received reports survive handoff as claims with recoverable parent originals',()=>{
  const human={seq:0,type:'user/message',data:{message:{role:'user',id:'human',source:{kind:'user'},content:[content('Continue the requested repair.')]}}};
  const f=fixture([human,catalog(1),relay(2),notice(3)]),handoff=f.build(),reports=handoff.observedWork.subagentResults;
  assert.equal(reports.total,2);assert.equal(reports.complete,true);
  assert.equal(handoff.userRequests.total,1);assert.equal(handoff.task.latestRequestSource.seq,0);assert.equal(handoff.task.completion,'not-determined');
  for(const report of reports.items){
    assert.equal(report.authority,'agent-claim');assert.equal(report.locality,'local');
    assert.equal(report.source.sessionId,'parent');assert.equal(report.childOriginalEvents,'not-read');
    assert.equal(report.consumption,'unknown-in-parent-receipt');
    const restored=recallHistory(f.agent,{kind:'event',seq:report.source.seq});
    assert.equal(restored.complete,true);assert.equal(restored.text,report.text);
    assert.equal(JSON.parse(recallHistory(f.agent,{kind:'event',seq:report.catalogSource.seq}).text).childId,'child');
  }
  const index=JSON.parse(recallHistory(f.agent,{kind:'history',seq:0}).text);
  assert.ok(index.some(item=>item.seq===3&&!item.human));
  const humanIndex=JSON.parse(recallHistory(f.agent,{kind:'history',seq:0,filter:'human'}).text);
  assert.deepEqual(humanIndex.map(item=>item.seq),[0]);
  assert.equal(reports.items[1].childLookup.arguments.query,'CHILD_RESULT: source.txt has the required declaration.');
});

test('fork-inherited catalogs and messages do not become own delegated results',()=>{
  const log=[catalog(0,'inherited-child'),notice(1,'inherited-child'),relay(2,'inherited-child'),
    catalog(3,'own-child'),notice(4,'own-child'),relay(5,'inherited-child')];
  const f=fixture(log,3),results=f.build().observedWork.subagentResults;
  assert.equal(results.total,1);assert.equal(results.items[0].childSessionId,'own-child');
  f.agent.session.inheritedEventCount=undefined;
  const unknown=f.build();assert.equal(unknown.observedWork.subagentResults.scopeComplete,false);
  assert.equal(unknown.coverage.exportComplete,false);assert.equal(unknown.coverage.sourcesComplete,false);
});

test('external, unknown and conflicting child identities never advertise local child queries',()=>{
  for(const log of [[catalog(0,'child','external'),notice(1)], [catalog(0,'child','unknown'),notice(1)],
    [notice(0)], [catalog(0),notice(1),catalog(2,'child','external')], [catalog(0),notice(1),catalog(2,'child','continuable',2)]]){
    const item=subagentResultIndex(log,'parent',{recallAvailable:true,searchAvailable:true}).items[0];
    assert.equal(item.childLookup,null);assert.notEqual(item.locality,'local');
    assert.equal(item.source.sessionId,'parent');assert.equal(item.source.recoverable,true);
  }
  const local=subagentResultIndex([catalog(0),notice(1)],'parent',{searchAvailable:false}).items[0];
  assert.equal(local.childLookup,null);assert.equal(local.source.recoverable,false);
});

test('rc.2 named catalog reports preserve local discovery and external boundaries',()=>{
  for(const mode of ['continuable','external']){
    const entry=catalog(0,'child',mode);Object.assign(entry.data,{version:3,name:'investigator'});
    const result=subagentResultIndex([entry,notice(1)],'parent',{searchAvailable:true}).items[0];
    assert.equal(result.locality,mode==='external'?'external':'local');
    assert.equal(!!result.childLookup,mode==='continuable');
    for(const name of [undefined,'lead','Upper','a/b','x'.repeat(33)]){
      const invalid=structuredClone(entry);invalid.data.name=name;
      const unknown=subagentResultIndex([invalid,notice(1)],'parent',{searchAvailable:true}).items[0];
      assert.equal(unknown.locality,'unknown');assert.equal(unknown.childLookup,null);
    }
  }
  const a=catalog(0),b=catalog(2);
  Object.assign(a.data,{version:3,name:'first'});Object.assign(b.data,{version:3,name:'second'});
  assert.equal(subagentResultIndex([a,notice(1),b],'parent',{searchAvailable:true}).items[0].locality,'unknown');
});

test('a malformed later catalog invalidates prior local discovery without poisoning another child',()=>{
  for(const invalid of [
    {version:3,mode:'external'},
    {version:3,mode:'continuable',name:'lead'},
    {version:3,mode:'continuable',name:'valid',childCreatedAt:-1}
  ]){
    const first=catalog(0),other=catalog(1,'other'),broken=catalog(2);
    Object.assign(broken.data,invalid);
    const recovered=catalog(3);
    const rows=subagentResultIndex([first,other,broken,recovered,notice(4),notice(5,'other')],'parent',{searchAvailable:true}).items;
    assert.equal(rows[0].membership,'unknown');assert.equal(rows[0].locality,'unknown');assert.equal(rows[0].childLookup,null);
    assert.equal(rows[1].locality,'local');assert.ok(rows[1].childLookup);
    const invalidSequence=structuredClone(broken);invalidSequence.seq=-1;
    const unchanged=subagentResultIndex([first,invalidSequence,notice(4)],'parent',{searchAvailable:true}).items[0];
    assert.equal(unchanged.locality,'local');assert.ok(unchanged.childLookup);
  }
});

test('clipped and omitted reports retain counts and full parent source recovery',()=>{
  const log=[catalog(0),...Array.from({length:12},(_,index)=>notice(index+1,'child','result-'+index+' '+('Source details. '.repeat(300))))];
  const f=fixture(log),full=f.build(),reports=full.observedWork.subagentResults;
  assert.equal(reports.total,12);assert.equal(reports.items.length,8);assert.equal(reports.omitted,4);assert.equal(reports.complete,false);
  const report=reports.items.at(-1);assert.equal(report.textComplete,false);assert.ok(report.text.length<=1200);
  assert.equal(recallHistory(f.agent,{kind:'event',seq:report.source.seq}).totalChars,report.totalChars);
  const bounded=f.build({maxChars:8000});assert.ok(JSON.stringify(bounded).length<=8000);assert.equal(bounded.coverage.exportComplete,false);
  assert.equal(bounded.observedWork.subagentResults.items.length+bounded.observedWork.subagentResults.omitted,12);
});

test('non-text report blocks and changing reports retain their provenance in deltas',()=>{
  const imageRelay=relay(1);imageRelay.data.message.content.push({type:'image',url:'unreproduced'});
  const f=fixture([catalog(0),imageRelay]),before=f.build();
  assert.equal(before.observedWork.subagentResults.items[0].textComplete,false);
  assert.deepEqual(before.observedWork.subagentResults.items[0].nonTextBlocks,['image']);
  f.agent.session.log.push(notice(2));
  const after=f.build(),patch=handoffPatch(before,after);
  assert.ok(patch.some(item=>item.path.includes('subagentResults')));
  assert.ok(JSON.stringify(patch).includes('CHILD_RESULT'));
  assert.equal(after.task.completion,'not-determined');
});
