import test from 'node:test';
import assert from 'node:assert/strict';
import {createContextEconomics} from '../context-economics.mjs';
function harness(){
  const state={step:0,config:{projectionPricing:[],projectionHorizonSteps:16}};
  const agent={session:{id:'economics',surface:{nodes:[]},requestHeader:()=>({config:{provider:'p',model:'m'}}),requestContext:()=>({contextWindow:10000})}};
  const economics=createContextEconomics({tokenMeter:{measure:()=>({totalTokens:9000})}},{get:()=>state});
  const options={provider:'p',model:'m',messages:[{id:'u',role:'user',content:[{type:'text',text:'request'}]}]};
  function finish(auxiliary=false,usage={inputTokens:1000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:1100}){
    economics.requestFinished(agent,options,{auxiliary,usage,settled:true,finishReason:'stop'});
  }
  return {agent,economics,finish};
}
test('capacity pressure reads the installed token meter totalTokens field before reported usage exists',()=>{
  const {agent,economics}=harness();
  const pressure=economics.pressure(agent);assert.equal(pressure.tokens,9000);assert.equal(pressure.emergency,true);
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
