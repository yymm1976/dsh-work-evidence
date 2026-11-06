import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {newSummary,applyRow,readRun} from '../experiment-store.mjs';
import {nativeChildInventory,importSession} from '../experiment-native.mjs';
import {trialsFor} from '../experiment-cli.mjs';
import {DSH_APP} from './helpers/paths.mjs';

const catalog=(childId,mode='continuable',seq=1)=>({seq,type:'subagent/catalog',data:{version:mode==='external'?2:0,childId,mode,childCreatedAt:100,label:'child label'}});
function run(id,{parent=null,children=[],inventory=true,source='native-session-readonly',tools={}}={}){
  const events=[{seq:0,type:'turn/start'},...children.map((child,index)=>catalog(typeof child==='string'?child:child.id,typeof child==='string'?'continuable':child.mode,index+1))];
  const summary=newSummary({runId:'run-'+id,sessionId:id,parentSession:parent,origin:parent?'subagent':'main',variant:'work-evidence',
    source,startedAt:1,...(inventory?{childInventory:nativeChildInventory(events,{source})}:{})});
  applyRow(summary,{kind:'turn-start',at:1});applyRow(summary,{kind:'request-start',route:{provider:'p',model:'m',reasoningEffort:'low'}});
  applyRow(summary,{kind:'request-end',at:2,usage:{inputTokens:5,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:5,reasoningTokens:0,totalTokens:10}});
  applyRow(summary,{kind:'turn-end',at:3,reason:'stop'});summary.tools.byName=tools;
  summary.attemptAccounting={counts:{unknownConsumptionAttempts:0,retryEvents:0,measuredRetryWaits:0},observedRetryWaitMs:0};
  return summary;
}
const summarize=runs=>trialsFor(path.join(os.tmpdir(),'we-child-accounting-no-labels'),runs);

test('one imported child cannot hide a second child missing from the recorded native parent inventory',async()=>{
  const parent=run('parent',{children:['child-a','child-b']}),a=run('child-a',{parent:'parent'});
  const [result]=await summarize([parent,a]);
  assert.equal(result.childSessions,1);assert.equal(result.tokens.totalTokens.known,20);
  assert.equal(result.importedRequestsComplete,true);assert.equal(result.childCoverageUnknown,true);
  assert.equal(result.reportedTotalTokensComplete,false);assert.equal(result.totalTokensComplete,false);
  assert.deepEqual(result.childCoverage.missingLocalChildren,[{parentSession:'parent',childId:'child-b',mode:'continuable'}]);
});

test('complete imported native descendants are counted once and grandchild coverage is required recursively',async()=>{
  const parent=run('parent',{children:['child-a','child-b']}),a=run('child-a',{parent:'parent',children:['grandchild']}),b=run('child-b',{parent:'parent'});
  const [partial]=await summarize([parent,a,b]);assert.equal(partial.childCoverage.missingLocalChildren[0].childId,'grandchild');
  const complete=await summarize([parent,a,b,run('grandchild',{parent:'child-a'})]);assert.equal(complete.length,1);
  assert.equal(complete[0].tokens.totalTokens.known,40);assert.equal(complete[0].childCoverageUnknown,false);
  assert.equal(complete[0].reportedTotalTokensComplete,true);assert.equal(complete[0].totalTokensComplete,true);
});

test('native catalog identities detect aliased delegation and external executions without local child sessions',async()=>{
  const aliased=run('aliased',{children:['missing-child'],tools:{custom_investigator:{calls:1}}});
  const [missing]=await summarize([aliased]);assert.equal(missing.childCoverage.missingLocalChildren.length,1);
  const [external]=await summarize([run('external-parent',{children:[{id:'provider-activation',mode:'external'}]})]);
  assert.equal(external.childCoverage.missingLocalChildren.length,0);assert.equal(external.childCoverage.externalExecutions.length,1);
  assert.equal(external.importedRequestsComplete,true);assert.equal(external.reportedTotalTokensComplete,false);
});

test('legacy and supplied-artifact runs retain known sums without claiming complete child inventories',async()=>{
  for(const parent of [run('legacy',{inventory:false,tools:{subagent:{calls:1}}}),run('artifact',{source:'engineering-artifact'})]){
    const [result]=await summarize([parent]);assert.equal(result.tokens.totalTokens.known,10);
    assert.equal(result.importedRequestsComplete,true);assert.equal(result.childCoverageUnknown,true);
    assert.equal(result.reportedTotalTokensComplete,false);assert.equal(result.childCoverage.unknownInventorySessions[0],parent.sessionId);
  }
});

test('a trustworthy empty native own catalog covers recorded local requests but auxiliary consumption remains separate',async()=>{
  const [result]=await summarize([run('single')]);assert.equal(result.childCoverageUnknown,false);
  assert.equal(result.totalTokensComplete,true);assert.ok(result.childCoverage.scope.includes('auxiliary'));
});

test('a child header without a parent catalog entry and a conflicting parent relationship keep family coverage unknown',async()=>{
  const [unlisted]=await summarize([run('parent'),run('child',{parent:'parent'})]);
  assert.equal(unlisted.childCoverage.unlistedImportedChildren[0].childId,'child');assert.equal(unlisted.totalTokensComplete,false);
  const roots=await summarize([run('parent',{children:['child']}),run('other-parent'),run('child',{parent:'other-parent'})]);
  const parent=roots.find(row=>row.sessionId==='parent');assert.equal(parent.childCoverageUnknown,true);
  assert.equal(parent.childCoverage.lineageConflicts[0].childId,'child');
});

test('a known delegation call without matching identity facts keeps a supposedly empty native inventory unknown',async()=>{
  const [result]=await summarize([run('parent',{tools:{subagent:{calls:1}}})]);
  assert.equal(result.childCoverageUnknown,true);assert.deepEqual(result.childCoverage.unmatchedDelegationSessions,['parent']);
  assert.equal(result.reportedTotalTokensComplete,false);
});

test('child inventories exclude inherited entries, retain exact event addresses and reject malformed or conflicting identities',()=>{
  const own=[catalog('inherited-child','continuable',0),{seq:1,type:'turn/start'},catalog('own-child','continuable',2)];
  const folded=nativeChildInventory(own,{inherited:1,source:'native-session-readonly'});
  assert.equal(folded.complete,true);assert.equal(folded.children.length,1);assert.equal(folded.children[0].sourceSeq,2);
  assert.ok(!JSON.stringify(folded).includes('child label'));
  for(const events of [[catalog('same'),catalog('same','external',2)],[{seq:1,type:'subagent/catalog',data:{version:99}}]]){
    const invalid=nativeChildInventory(events,{source:'native-session-readonly'});assert.equal(invalid.complete,false);assert.equal(invalid.problems.length,1);
  }
  assert.equal(nativeChildInventory([],{source:'native-session-readonly'}).complete,false);
  assert.throws(()=>nativeChildInventory(own,{inherited:10}),/Invalid native event range/);
});

test('the real file importer retains child facts and readRun preserves them without trusting artifact completeness',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'we-child-import-'));
  try{
    const file=path.join(directory,'saved.json'),events=[{seq:0,type:'turn/start',time:1,data:{turn:1}},catalog('missing-child','continuable',1),
      catalog('external-task','external',2),{seq:3,type:'turn/end',time:3,data:{reason:{kind:'stop'}}}];
    await fs.writeFile(file,JSON.stringify({sessionId:'saved-parent',workspace:directory,events}));
    const result=await importSession({directory,sessionId:'saved-parent',variant:'work-evidence',file,
      app:DSH_APP,home:directory});
    const imported=await readRun(path.join(directory,result.runId));
    assert.equal(imported.childInventory.complete,false);assert.equal(imported.childInventory.source,'engineering-artifact');
    assert.deepEqual(imported.childInventory.children.map(row=>[row.childId,row.mode]),[['missing-child','continuable'],['external-task','external']]);
    const reduced=await fs.readFile(path.join(directory,result.runId,'events.jsonl'),'utf8');assert.ok(reduced.includes('child-identity'));
    const [trial]=await trialsFor(directory,[imported]);assert.equal(trial.childCoverageUnknown,true);
    assert.equal(trial.reportedTotalTokensComplete,false);
    assert.equal(trial.childCoverage.missingLocalChildren[0].childId,'missing-child');
    assert.equal(trial.childCoverage.externalExecutions[0].childId,'external-task');
  }finally{
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(directory,{recursive:true,force:true});
  }
});
