import test from 'node:test';
import assert from 'node:assert/strict';
import {createEffectObserver} from '../effect-observer.mjs';
import {observeRequests} from '../request-observation.mjs';

test('summary keeps cumulative observability while omitting rolling diagnostics',async()=>{
  const hooks=new Map();
  const agent={session:{id:'effect-summary',seq:0,surface:{nodes:[],contentGeneration:0},requestHeader:()=>({config:{provider:'p',model:'m'}})}};
  const state={dir:null,config:{requestAccounting:true},metrics:{contextRequests:0,contextRequestChars:0,contextModelTextChars:0},requestObservations:[],auxiliarySignals:new WeakSet()};
  const ctx={on:(name,fn)=>{hooks.set(name,fn);return()=>{};},agents:{get:()=>agent}};
  const runtime={get:()=>state,init:async()=>state,sync:()=>state,isEnabled:()=>true,modeStatus:()=>({selected:'aggressive'})};
  runtime.effects=createEffectObserver(ctx,runtime);observeRequests(ctx,runtime);
  const purposes=[...Array(25).fill(null),'compaction','work-evidence:quality-review'];
  for(const [index,purpose]of purposes.entries()){
    runtime.effects.decide(agent,'qualityReview','applied','summary-window-'+index);
    const options={sessionId:agent.session.id,provider:'p',model:'m',signal:new AbortController().signal,purpose,
      messages:[{role:'user',content:[{type:'text',text:'request'}]}],tools:[]};
    for await(const _chunk of hooks.get('llm/stream')(options,async function*(){
      yield {type:'usage',usage:index===0||index===4?{inputTokens:-1,outputTokens:50,totalTokens:50}:{inputTokens:100,outputTokens:50,totalTokens:150}};
      yield {type:'finish',reason:index===10?{kind:'error',failure:{code:'SCRIPTED_FAILURE'}}:{kind:'stop'}};
    })){}
  }
  const full=runtime.effects.snapshot(agent),summary=runtime.effects.snapshot(agent,{detail:false});
  assert.equal(full.recentRequests.length,24);assert.equal(full.decisions.length,24);
  assert.equal(full.recentRequests[0].requestId!==full.recentRequests.at(-1).requestId,true);
  assert.equal(Object.hasOwn(full,'view'),false);
  assert.deepEqual(summary.requests,full.requests);assert.deepEqual(summary.totals,full.totals);
  assert.deepEqual(summary.persistence,full.persistence);assert.equal(summary.interpretation,full.interpretation);
  assert.equal(summary.requests.count,27);assert.equal(summary.requests.main,25);
  assert.equal(summary.requests.compaction,1);assert.equal(summary.requests.auxiliary,1);
  assert.equal(summary.requests.missingUsage,2);assert.equal(summary.requests.unknownConsumption,3);
  assert.ok(summary.persistence.writeErrors.length>0);
  assert.equal(Object.hasOwn(summary,'recentRequests'),false);assert.equal(Object.hasOwn(summary,'decisions'),false);
  assert.deepEqual(summary.requestDiagnostics.map(row=>({sourceSeq:row.sourceSeq,sessionId:row.sessionId,requestKind:row.requestKind,provider:row.provider,model:row.model,
    settled:row.settled,finishReason:row.finishReason,failureCode:row.failureCode,aborted:row.aborted,usageComplete:row.usageComplete,unknownConsumption:row.unknownConsumption})),
  [{sourceSeq:0,sessionId:'effect-summary',requestKind:'main',provider:'p',model:'m',settled:true,finishReason:'stop',failureCode:null,aborted:false,usageComplete:false,unknownConsumption:true},
    {sourceSeq:0,sessionId:'effect-summary',requestKind:'main',provider:'p',model:'m',settled:true,finishReason:'error',failureCode:'SCRIPTED_FAILURE',aborted:false,usageComplete:true,unknownConsumption:true}]);
  assert.equal(summary.requestDiagnostics[0].requestId,full.recentRequests[1].requestId);
  assert.equal(summary.requestDiagnostics[1].requestId,full.recentRequests[7].requestId);
  assert.ok(summary.requestDiagnostics.every(row=>!Object.hasOwn(row,'effects')&&!Object.hasOwn(row,'usage')));
  assert.equal(summary.requestDiagnostics.length,2,'the evicted unknown request remains only in cumulative counters');
  assert.deepEqual(summary.details,{tool:'work_status',arguments:{detail:true},recentRequests:24,decisions:24,featureReasons:'detail-only'});
  assert.equal(summary.view,'summary');
  for(const [name,item]of Object.entries(full.features)){
    const {reasons,...expected}=item;
    assert.deepEqual(summary.features[name],expected,name);
  }
  assert.ok(full.features.qualityReview.reasons['summary-window-26']);
  assert.equal(full.features.qualityReview.lastReason,'summary-window-26');
  assert.ok(full.recentRequests.every(row=>row.usage&&row.effects));
  assert.ok(full.decisions.every(row=>row.id&&row.reason));
  assert.deepEqual(runtime.effects.snapshot(agent),full);
  await runtime.effects.dispose();
});
