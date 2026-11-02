import test from 'node:test';
import assert from 'node:assert/strict';
import {createContextEconomics,canonicalUsage,promptTokens,usageCost,textTokens} from '../context-economics.mjs';

test('unsafe disjoint sums stay unknown even when each reported field is a safe integer',()=>{
  const usage={inputTokens:Number.MAX_SAFE_INTEGER,cacheReadTokens:1,cacheWriteTokens:0,outputTokens:1};
  const normalized=canonicalUsage(usage);
  assert.equal(normalized.complete,false);
  assert.equal(normalized.consistent,false);
  assert.equal(normalized.usage.totalTokens,null);
  assert.equal(promptTokens(usage),null);
  assert.equal(usageCost(usage,{input:.15,cacheRead:.003,output:.6}),null);
  let belowLimit=Number.MAX_SAFE_INTEGER;
  belowLimit--;
  const exact=canonicalUsage({inputTokens:belowLimit,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1});
  assert.equal(exact.complete,true);
  assert.equal(exact.usage.totalTokens,Number.MAX_SAFE_INTEGER);
});
function harness(){
  const state={step:0,config:{projectionPricing:[],projectionHorizonSteps:16}};
  const agent={session:{id:'economics',surface:{nodes:[]},requestHeader:()=>({config:{provider:'p',model:'m'}}),requestContext:()=>({contextWindow:10000})}};
  const economics=createContextEconomics({tokenMeter:{measure:()=>({totalTokens:9000})}},{get:()=>state});
  const options={provider:'p',model:'m',messages:[{id:'u',role:'user',content:[{type:'text',text:'request'}]}]};
  function finish(auxiliary=false,usage={inputTokens:1000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:1100}){
    economics.requestFinished(agent,options,{auxiliary,usage,settled:true,finishReason:'stop'});
  }
  return {agent,economics,finish,state,options};
}
test('capacity pressure reads the installed token meter totalTokens field before reported usage exists',()=>{
  const {agent,economics}=harness();
  const pressure=economics.pressure(agent);assert.equal(pressure.tokens,9000);assert.equal(pressure.emergency,true);
});

test('real content density guides Chinese savings without changing the conservative refill scope',()=>{
  const {agent,economics}=harness(),before='源'.repeat(7000),after='摘要';
  const savedTokens=textTokens(before)-textTokens(after);
  const result=economics.assess(agent,{savedChars:before.length-after.length,savedTokensEstimate:savedTokens});
  assert.equal(result.savedTokensEstimate,6998);
  assert.ok(result.savedTokensEstimate>Math.ceil((before.length-after.length)/3.5)*3);
});

test('projection outcome uses the adopted token estimate instead of converting Chinese character savings again',()=>{
  const {agent,economics,finish}=harness();finish();
  economics.reviewAdoption(agent,{kind:'projection',appliedAtStep:1,expectedSavedChars:350,expectedSavedTokens:300});
  finish();finish();finish();
  const review=economics.summary(agent).projectionReviews[0];
  assert.equal(review.expectedRemovedTokensPerRequest,300);assert.equal(review.expectedPromptTokensPerRequest,700);
});

test('cache exposure stays in its configured currency and USD compatibility fields contain only USD',()=>{
  const {agent,economics,finish,state,options}=harness();
  state.config.projectionPricing=[{provider:'p',model:'m',currency:'CNY',input:1,cacheRead:.2,output:2}];
  options.reasoningEffort='low';options.tools=[];
  finish(false,{inputTokens:1000,cacheReadTokens:5000,cacheWriteTokens:0,outputTokens:100,totalTokens:6100});
  options.reasoningEffort='high';options.tools=[{name:'new-tool'}];
  finish(false,{inputTokens:6000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:6100});
  const summary=economics.summary(agent);
  assert.equal(summary.resetTaxUSD,0);assert.equal(summary.effortResetExposureUSD,0);
  assert.equal(summary.resetTaxByCurrency.CNY,.004);assert.equal(summary.effortResetExposureByCurrency.CNY,.004);
  assert.equal(summary.currency,'CNY');assert.equal(summary.compactionRequests,0);
});
test('capacity pressure uses the optional service getter when direct property access requires inject',()=>{
  const {agent}=harness(),state={config:{projectionPricing:[],projectionHorizonSteps:16}};
  const ctx={get:name=>name==='tokenMeter'?{measure:()=>({totalTokens:9500})}:undefined,
    get tokenMeter(){throw Error('cannot get property tokenMeter without inject');}};
  const economics=createContextEconomics(ctx,{get:()=>state}),pressure=economics.pressure(agent);
  assert.equal(pressure.tokens,9500);assert.equal(pressure.emergency,true);
});
test('projection review settles after three main prompt observations and ignores auxiliary and missing usage',()=>{
  const {agent,economics,finish}=harness();finish();
  economics.reviewAdoption(agent,{kind:'projection',appliedAtStep:1,expectedSavedChars:350});
  finish(true,{inputTokens:100000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:100100});
  finish(false,null);finish();finish();
  assert.equal(economics.summary(agent).projectionReviews.length,0);
  finish();const reviewed=economics.summary(agent).projectionReviews;
  assert.equal(reviewed.length,1);assert.equal(reviewed[0].observedRequests,3);
  assert.equal(reviewed[0].referencePromptTokens,1000);assert.equal(reviewed[0].observedPromptTokens,3000);
  assert.equal(reviewed[0].plausible,true);
});
