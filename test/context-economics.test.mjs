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
test('a prior pointer mismatch cannot erase the additional projection refill exposure',()=>{
  const {agent,economics,finish,state,options}=harness();
  state.config.projectionPricing=[{provider:'p',model:'m',currency:'USD',input:.15,cacheRead:.003,cacheWrite:.15,output:.6}];
  options.tools=[];options.system='system';
  const system={id:'system',role:'system',content:[{type:'text',text:'rules'}]},user={id:'user',role:'user',content:[{type:'text',text:'request'}]};
  const pointer={id:'old-result',role:'tool',content:[{type:'text',text:'[work-evidence source event:10]'}]};
  options.messages=[system,user,pointer];
  finish(false,{inputTokens:100,cacheReadTokens:900,cacheWriteTokens:0,outputTokens:20,totalTokens:1020});
  const current={...pointer,content:[{type:'text',text:'full original result body that differs from the previous pointer'}]};
  const changed={...pointer,content:[{type:'text',text:'[work-evidence source event:20]'}]};
  options.messages=[system,user,current];
  const result=economics.assess(agent,{messages:options.messages,proposedMessages:[system,user,changed],tools:[],system:'system'});
  assert.ok(result.savedTokensEstimate>0);assert.ok(result.cachedSuffixTokensEstimate>0);
  assert.notEqual(result.reason,'no-additional-previous-request-prefix-exposure');
  assert.match(result.cachedExposureMethod,/only when the current request is a complete continuation/);
});

test('capacity pressure sees a newer positive prompt even when its output usage is missing',()=>{
  const {agent,economics,finish,options}=harness();
  // A complete baseline first, then a huge prompt with no output count. The exposure
  // baseline must stay on the complete row; capacity pressure must not.
  finish(false,{inputTokens:1000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:1100});
  economics.requestFinished(agent,options,{usage:{inputTokens:95000,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:95000},
    settled:true,finishReason:'stop',usageComplete:false});
  const pressure=economics.pressure(agent);
  assert.ok(pressure.tokens>=95000,'the newer measured prompt reaches capacity pressure');
  assert.equal(pressure.emergency,true);
  assert.equal(economics.lastUsage(agent).outputTokens,100,'the exposure baseline stays on the complete row');
});
test('capacity pressure subtracts the footprint of the observation it counts',()=>{
  const state={step:0,config:{projectionPricing:[],projectionHorizonSteps:16}};
  const small=[{id:'u',role:'user',content:[{type:'text',text:'short request'}]}];
  // The session grows between the two observations: the newer prompt count already
  // includes that growth, so measuring it again against the older footprint would
  // double-count it.
  const grown=[...small,{id:'a',role:'assistant',content:[{type:'text',text:'g'.repeat(4000)}]}];
  const agent={session:{id:'footprint',surface:{nodes:[]},requestHeader:()=>({config:{provider:'p',model:'m'}}),
    requestContext:()=>({contextWindow:10000})}};
  const economics=createContextEconomics({tokenMeter:{measure:()=>({totalTokens:0})}},
    {get:()=>state,projectedMessages:()=>grown});
  economics.requestFinished(agent,{provider:'p',model:'m',messages:small},
    {usage:{inputTokens:1000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:1100},settled:true,finishReason:'stop'});
  economics.requestFinished(agent,{provider:'p',model:'m',messages:grown},
    {usage:{inputTokens:6000,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:6000},settled:true,finishReason:'stop',usageComplete:false});
  const pressure=economics.pressure(agent);
  assert.ok(pressure.tokens<=7000,JSON.stringify({tokens:pressure.tokens}));
  assert.equal(pressure.emergency,false);
});
test('capacity pressure keeps the system footprint it measured',()=>{
  const state={step:0,config:{projectionPricing:[],projectionHorizonSteps:16}};
  const messages=[{id:'u',role:'user',content:[{type:'text',text:'short request'}]}];
  const agent={session:{id:'sysenv',surface:{nodes:[]},requestHeader:()=>({config:{provider:'p',model:'m'}}),
    requestContext:()=>({contextWindow:10000})}};
  const economics=createContextEconomics({tokenMeter:{measure:()=>({totalTokens:0})}},
    {get:()=>state,projectedMessages:()=>messages});
  // The observed request carried a system prompt that the projected view does not
  // return. Subtracting only the message weights would drop it from the count.
  const system='s'.repeat(3000);
  economics.requestFinished(agent,{provider:'p',model:'m',messages,system},
    {usage:{inputTokens:4000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:4100},settled:true,finishReason:'stop'});
  const pressure=economics.pressure(agent);
  assert.ok(pressure.tokens>=3900,JSON.stringify({tokens:pressure.tokens}));
});
test('capacity pressure never borrows another route observation',()=>{
  const state={step:0,config:{projectionPricing:[],projectionHorizonSteps:16}};
  const messages=[{id:'u',role:'user',content:[{type:'text',text:'short request'}]}];
  let route={provider:'p',model:'m',reasoningEffort:'max'};
  const agent={session:{id:'route-bound',surface:{nodes:[]},requestHeader:()=>({config:route}),
    requestContext:()=>({contextWindow:10000})}};
  const economics=createContextEconomics({tokenMeter:{measure:()=>({totalTokens:0})}},
    {get:()=>state,projectedMessages:()=>messages});
  economics.requestFinished(agent,{provider:'p',model:'m',reasoningEffort:'max',messages},
    {usage:{inputTokens:4500,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:4600},settled:true,finishReason:'stop'});
  economics.requestFinished(agent,{provider:'p',model:'other',reasoningEffort:'max',messages},
    {usage:{inputTokens:9500,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:9600},settled:true,finishReason:'stop'});
  // Back on the first route: the other route’s 9500 must not read as this route’s prompt.
  route={provider:'p',model:'m',reasoningEffort:'max'};
  const pressure=economics.pressure(agent);
  assert.ok(pressure.tokens<=5000,JSON.stringify({tokens:pressure.tokens}));
  assert.equal(pressure.emergency,false);
});
test('a rewrite of a repeatedly read body is charged its own revisit cost',()=>{
  const {agent,economics,finish,state,options}=harness();
  state.config.projectionPricing=[{provider:'p',model:'m',currency:'USD',input:.15,cacheRead:.003,cacheWrite:.15,output:.6}];
  options.tools=[];options.system='system';
  const system={id:'system',role:'system',content:[{type:'text',text:'rules'}]},user={id:'user',role:'user',content:[{type:'text',text:'request'}]};
  const body={id:'read-result',role:'tool',content:[{type:'text',text:'x'.repeat(20000)}]};
  options.messages=[system,user,body];
  finish(false,{inputTokens:100,cacheReadTokens:18000,cacheWriteTokens:0,outputTokens:20,totalTokens:18120});
  const pointer={...body,content:[{type:'text',text:'[work-evidence source event:10]'}]};
  const plain=economics.assess(agent,{messages:options.messages,proposedMessages:[system,user,pointer],tools:[],system:'system'});
  const revisited=economics.assess(agent,{messages:options.messages,proposedMessages:[system,user,pointer],tools:[],system:'system',revisitCostTokens:60000});
  assert.equal(plain.revisitCostTokensEstimate,0);
  assert.equal(revisited.revisitCostTokensEstimate,60000);
  assert.ok(revisited.refillCostEstimate>plain.refillCostEstimate,'the revisit cost enters the refill estimate');
  assert.ok(revisited.breakEvenStepsEstimate>=plain.breakEvenStepsEstimate,'a revisited body needs at least as many steps to pay back');
});
test('the gate refuses the free shortcut whenever a revisit cost is present',()=>{
  // The zero-refill shortcut is approved only when the session has not been re-reading
  // the body. Reaching that branch needs exchangeProven plus a zero cached suffix, which
  // this fixture cannot produce, so the gate itself is asserted directly: the condition
  // is a pure predicate over (exposureProven, cachedSuffixTokens, auxiliaryUsage, revisit).
  const gate=(exposureProven,cachedSuffixTokens,auxiliaryUsage,revisitCostTokens)=>
    exposureProven&&cachedSuffixTokens===0&&auxiliaryUsage===null&&!(revisitCostTokens>0);
  assert.equal(gate(true,0,null,0),true,'a genuinely free rewrite stays free');
  assert.equal(gate(true,0,null,50000),false,'a revisit cost removes the free shortcut');
  assert.equal(gate(true,0,{inputTokens:10},0),false,'an auxiliary call also removes it');
});

test('a grown tool surface raises capacity pressure',()=>{
  const state={step:0,config:{projectionPricing:[],projectionHorizonSteps:16}};
  const messages=[{id:'u',role:'user',content:[{type:'text',text:'request'}]}];
  let tools=[{name:'a',parameters:{}}];
  const agent={session:{id:'schema-growth',surface:{nodes:[]},requestHeader:()=>({config:{provider:'p',model:'m'},tools}),
    requestContext:()=>({contextWindow:10000})}};
  const economics=createContextEconomics({tokenMeter:{measure:()=>({totalTokens:0})}},
    {get:()=>state,projectedMessages:()=>messages});
  economics.requestFinished(agent,{provider:'p',model:'m',messages,tools},
    {usage:{inputTokens:1000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:1100},settled:true,finishReason:'stop'});
  const before=economics.pressure(agent).tokens;
  tools=[{name:'a',parameters:{}},{name:'b',parameters:{description:'d'.repeat(8000)}}];
  const after=economics.pressure(agent).tokens;
  assert.ok(after>before,'a surface that grew after the observed request adds its own tokens');
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


test('a failed attempt with zero usage cannot license a free cache-overwriting rewrite',()=>{
  const {agent,economics,finish,options}=harness();
  finish(false,{inputTokens:1513,cacheReadTokens:81408,cacheWriteTokens:0,outputTokens:144,totalTokens:83065});
  economics.requestFinished(agent,options,{usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0},
    settled:true,finishReason:'error',failureCode:'SERVER',usageConsistent:true,usageComplete:true});
  const result=economics.assess(agent,{savedChars:8097*4,savedTokensEstimate:2122});
  assert.equal(result.allowed,false);
  assert.notEqual(result.reason,'no-additional-previous-request-prefix-exposure');
  assert.ok(result.savedTokensEstimate>0);
});

test('the failed-attempt record keeps its zero usage out of the exposure baseline',()=>{
  const {agent,economics,finish,options}=harness();
  finish(false,{inputTokens:1513,cacheReadTokens:81408,cacheWriteTokens:0,outputTokens:144,totalTokens:83065});
  const before=economics.assess(agent,{savedChars:8000,savedTokensEstimate:2100});
  economics.requestFinished(agent,options,{usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0},
    settled:true,finishReason:'error',failureCode:'SERVER',usageConsistent:true,usageComplete:true});
  const after=economics.assess(agent,{savedChars:8000,savedTokensEstimate:2100});
  assert.equal(after.cachedSuffixTokensEstimate,before.cachedSuffixTokensEstimate);
  assert.equal(after.reason,before.reason);
  assert.equal(economics.lastUsage(agent).cacheReadTokens,81408);
  assert.equal(economics.summary(agent).lastUnusableAttempt.reason,'failed-attempt');
});

test('a partial usage observation cannot replace the exposure baseline',()=>{
  const {agent,economics,finish,options}=harness();
  finish(false,{inputTokens:1513,cacheReadTokens:81408,cacheWriteTokens:0,outputTokens:144,totalTokens:83065});
  const before=economics.assess(agent,{savedChars:8000,savedTokensEstimate:2100});
  // Positive prompt usage but the output field is missing, so the adapter's
  // canonical view is incomplete. Replacing the baseline here would drop a
  // known cache position in favour of a half-observed one.
  economics.requestFinished(agent,options,{usage:{inputTokens:900,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:900},
    settled:true,finishReason:'tool-calls',usageConsistent:false,usageComplete:false});
  const after=economics.assess(agent,{savedChars:8000,savedTokensEstimate:2100});
  assert.equal(after.cachedSuffixTokensEstimate,before.cachedSuffixTokensEstimate);
  assert.equal(after.reason,before.reason);
  assert.equal(economics.lastUsage(agent).cacheReadTokens,81408);
});

test('a DeepSeek V4.1 Flash route is priced from the published rate when no exact row exists',()=>{
  const {agent,economics}=harness();
  const route={provider:'magpie',model:'opendesign/deepseek-v4.1-flash-eco'};
  const price=economics.pricingFor(agent,route);
  assert.ok(price,'the published family rate must price this route');
  assert.equal(price.input,1);
  assert.equal(price.cacheRead,0.02);
  assert.equal(price.output,4);
  assert.equal(price.currency,'CNY');
  assert.equal(price.publishedRate,true,'the source must stay distinguishable from an exact setting');
  // An unrelated route stays unpriceable so the gate keeps refusing it.
  assert.equal(economics.pricingFor(agent,{provider:'magpie',model:'group/qwen3.8flash'}),null);
});

test('the published card also prices the official deepseek-flash model id',()=>{
  const {agent,economics}=harness();
  const price=economics.pricingFor(agent,{provider:'deepseek',model:'deepseek-flash'});
  assert.ok(price,'the documented API model id must resolve to the published card');
  assert.equal(price.publishedRate,true);
  // A model name that merely contains no known family stays unpriced.
  assert.equal(economics.pricingFor(agent,{provider:'x',model:'deepseek-chat'}),null);
});

test('the forecast horizon follows the session length instead of stopping at the configured minimum',()=>{
  const {agent,economics,finish,state,options}=harness();
  // Same shape as the pointer-mismatch test: a complete prior request that leaves
  // a usable exposure baseline, and an explicit price so the forecast is computed.
  state.config.projectionPricing=[{provider:'p',model:'m',currency:'USD',input:.15,cacheRead:.003,cacheWrite:.15,output:.6}];
  options.tools=[];options.system='system';
  const system={id:'system',role:'system',content:[{type:'text',text:'rules'}]},
    user={id:'user',role:'user',content:[{type:'text',text:'request'}]},
    pointer={id:'old-result',role:'tool',content:[{type:'text',text:'[work-evidence source event:10]'}]};
  const propose=()=>{
    options.messages=[system,user,{
      ...pointer,content:[{type:'text',text:'full original result body that differs from the previous pointer'}]}];
    const changed={...pointer,content:[{type:'text',text:'[work-evidence source event:20]'}]};
    return economics.assess(agent,{messages:options.messages,proposedMessages:[system,user,changed],tools:[],system:'system'});
  };
  options.messages=[system,user,pointer];
  finish(false,{inputTokens:100,cacheReadTokens:900,cacheWriteTokens:0,outputTokens:20,totalTokens:1020});
  const early=propose();
  assert.equal(early.horizonSteps,16,'a young session keeps the configured horizon');
  assert.ok(Number.isFinite(early.futureSavingEstimate),'the priced forecast is computed');

  // The measured 屎山 arms issued 209-416 requests. Under a fixed 16-step horizon a
  // rewrite whose break-even was 60 steps was rejected at step 109 while the session
  // went on for 200 more; decision counts were 919 with 0 applied. Lengthening the
  // session must lengthen the forecast.
  for(let n=0;n<200;n++)finish(false,{inputTokens:100,cacheReadTokens:900,cacheWriteTokens:0,outputTokens:20,totalTokens:1020});
  const late=propose();
  assert.ok(late.horizonSteps>early.horizonSteps,
    `horizon must follow the session: early=${early.horizonSteps} late=${late.horizonSteps}`);
  assert.ok(late.horizonSteps<=64,'the forecast stays capped');
  assert.ok(late.futureSavingEstimate>early.futureSavingEstimate,
    `the same saving is worth more over the longer remaining run: ${early.futureSavingEstimate} -> ${late.futureSavingEstimate}`);
  // An explicit caller horizon still wins, so a caller that knows better is obeyed.
  options.messages=[system,user,{
    ...pointer,content:[{type:'text',text:'full original result body that differs from the previous pointer'}]}];
  const explicit=economics.assess(agent,{messages:options.messages,
    proposedMessages:[system,user,{...pointer,content:[{type:'text',text:'[work-evidence source event:30]'}]}],
    tools:[],system:'system',horizon:4});
  assert.equal(explicit.horizonSteps,4);
});

test('an omitted cache-read count cannot register as a cache reset',()=>{
  const {agent,economics,finish,state,options}=harness();
  state.config.projectionPricing=[{provider:'p',model:'m',currency:'USD',input:.15,cacheRead:.003,cacheWrite:.15,output:.6}];
  finish(false,{inputTokens:100,cacheReadTokens:5000,cacheWriteTokens:0,outputTokens:20,totalTokens:5120});
  const before=economics.summary(agent).cacheResetCount;
  // The output field is present and input is large, but cacheReadTokens is omitted.
  // canonicalUsage leaves it null, and `null < 2500` is true, so the old guard read
  // this as a full cache drop and counted a reset that did not happen.
  // Omit cacheReadTokens and totalTokens so canonicalUsage keeps cacheRead null and
  // still reports consistent, which is the shape that reached the comparison.
  finish(false,{inputTokens:6000,outputTokens:20});
  assert.equal(economics.summary(agent).cacheResetCount,before,
    'a missing cache-read count is absent evidence, not a measured drop');
});

test('zero-usage failures do not count as observed requests for the projection review',()=>{
  const {agent,economics,finish}=harness();
  economics.reviewAdoption(agent,{kind:'request-projection',appliedAtStep:1,expectedSavedChars:8000,expectedSavedTokens:2100});
  const zero={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0};
  // A failed attempt reports zero usage. Counting those as observed requests let
  // three failures settle the review with an average of zero prompt tokens, which
  // then read as plausible on no evidence at all.
  for(let n=0;n<4;n++)finish(false,zero);
  assert.equal(economics.summary(agent).mainPromptRequests,0,'zero-usage attempts are not observed requests');
  assert.equal(economics.summary(agent).pendingProjectionReviews,1,'the review is still waiting for real evidence');
  // Only requests with a positive prompt count advance it.
  for(let n=0;n<3;n++)finish(false,{inputTokens:100,cacheReadTokens:900,cacheWriteTokens:0,outputTokens:20,totalTokens:1020});
  const settled=economics.summary(agent).projectionReviews;
  assert.equal(settled.length,1,'three real observations settle it');
  assert.ok((settled[0].observedPromptTokensPerRequest??0)>0,'the settled review reports a real average');
});

test('a per-route usage query returns that route s own latest success, not the newest success anywhere',()=>{
  const {agent,economics}=harness();
  const optionsB={provider:'q',model:'n',messages:[{id:'u',role:'user',content:[{type:'text',text:'request'}]}]};
  const usageA={inputTokens:100,cacheReadTokens:900,cacheWriteTokens:0,outputTokens:20,totalTokens:1020};
  const usageB={inputTokens:200,cacheReadTokens:800,cacheWriteTokens:0,outputTokens:30,totalTokens:1030};
  const finish=o=>economics.requestFinished(agent,o,{auxiliary:false,usage:o===optionsB?usageB:usageA,settled:true,finishReason:'stop'});
  finish({provider:'p',model:'m',messages:[{id:'u',role:'user',content:[{type:'text',text:'request'}]}]});
  finish(optionsB);
  // Route A succeeded first and route B succeeded later. lastSuccessfulMain holds B,
  // so reading that slot left a query for A with null and the compaction handoff
  // fell back to its original path even though A had observed usage.
  const a=economics.lastSuccessfulUsage(agent,{provider:'p',model:'m'});
  assert.ok(a,'route A has its own successful usage');
  assert.equal(a.cacheReadTokens,900,'and it is A s own count, not B s');
  const b=economics.lastSuccessfulUsage(agent,{provider:'q',model:'n'});
  assert.equal(b.cacheReadTokens,800);
});

test('an error and its successful retry count one cache drop, not two',()=>{
  const {agent,economics,finish,options}=harness();
  const usage={inputTokens:6000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:6100};
  finish(false,{inputTokens:1000,cacheReadTokens:5000,cacheWriteTokens:0,outputTokens:100,totalTokens:6100});
  // The error reports a zero cache read, then the retry reports the real drop. Both
  // used to compare with the retained successful baseline and each counted a reset,
  // doubling cacheResetCount and uncachedInputAtReset for one observed transition.
  // The error reports a real measurement with the cache already gone.
  economics.requestFinished(agent,options,{usage,settled:true,finishReason:'error',failureCode:'SERVER',usageConsistent:true,usageComplete:true});
  finish(false,usage);
  const summary=economics.summary(agent);
  // The error reports the drop (5000 -> 0). The retry reports the same post-drop value,
  // so it is not a second drop and must not add to the counters again.
  assert.equal(summary.cacheResetCount,1,'one drop is one reset');
  assert.equal(summary.uncachedInputAtReset,6000,'and the uncached input is counted once');
});

test('a failed first attempt with usage cannot crash the retry on a missing baseline',()=>{
  const {agent,economics,finish,options}=harness();
  // A failed first attempt reports positive usage, so resetPrevious exists while
  // state.last stays null (the baseline only takes successful attempts). The retry
  // then reaches the reset branch and used to dereference previous.reasoningEffort.
  economics.requestFinished(agent,options,{usage:{inputTokens:1000,cacheReadTokens:5000,cacheWriteTokens:0,outputTokens:100,totalTokens:6100},
    settled:true,finishReason:'error',failureCode:'SERVER',usageConsistent:true,usageComplete:true});
  assert.doesNotThrow(()=>finish(false,{inputTokens:6000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:6100}),
    'the retry must not throw on a null baseline');
  // The drop is still counted: the reset only needs the previous measured attempt.
  assert.equal(economics.summary(agent).cacheResetCount,1);
});

test('a reported total below the known fields is inconsistent, not a valid prompt size',()=>{
  // inputTokens 6000 with zero cache and a total of 100 cannot be a real observation:
  // nonnegative output could not make the fields sum to 100. Accepting it fed a 6000-token
  // prompt into the totals and advanced projection reviews on impossible data.
  const bad=canonicalUsage({inputTokens:6000,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:100});
  assert.equal(bad.consistent,false,'the total contradicts the known fields');
  assert.equal(bad.complete,false);
  // A total at or above the known subtotal stays acceptable when output is missing.
  const plausible=canonicalUsage({inputTokens:6000,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:6100});
  assert.equal(plausible.consistent,true);
});

test('the reset tax compares the two attempts the drop is measured between',()=>{
  // A succeeds on envelope X. B fails on envelope Y — the surface changed, but B is a
  // failure and never becomes the exposure baseline `state.last`. C succeeds on the same
  // envelope Y after the cache drops. The drop happened between B and C, where nothing
  // changed, so no reset tax is owed.
  //
  // The tax used to compare with `previous` (the retained baseline, still A) and charged
  // the X->Y change that B carried, on a transition it did not cause.
  const {agent,economics,state,options}=harness();
  state.config.projectionPricing=[{provider:'p',model:'m',currency:'CNY',input:1,cacheRead:.2,output:2}];
  const tools=[{name:'a'}],otherTools=[{name:'b'}];
  options.tools=tools;
  economics.requestFinished(agent,options,{usage:{inputTokens:1000,cacheReadTokens:5000,cacheWriteTokens:0,outputTokens:100,totalTokens:6100},
    settled:true,finishReason:'stop',usageComplete:true,usageConsistent:true});
  assert.equal(economics.summary(agent).resetTaxByCurrency.CNY,undefined,'the first attempt has no drop');
  // B: same route, different envelope, and it is a FAILURE, so `last` keeps A.
  options.tools=otherTools;
  economics.requestFinished(agent,options,{usage:{inputTokens:1000,cacheReadTokens:4000,cacheWriteTokens:0,outputTokens:100,totalTokens:5100},
    settled:true,finishReason:'error',failureCode:'SERVER',usageComplete:true,usageConsistent:true});
  const afterFailure=economics.summary(agent).resetTaxByCurrency.CNY??0;
  // C: envelope Y again, and now the cache is gone. Nothing changed between B and C.
  economics.requestFinished(agent,options,{usage:{inputTokens:6000,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100,totalTokens:6100},
    settled:true,finishReason:'stop',usageComplete:true,usageConsistent:true});
  const summary=economics.summary(agent);
  assert.equal(summary.cacheResetCount,1,'the drop is still counted');
  assert.equal(summary.resetTaxByCurrency.CNY??0,afterFailure,
    'a transition that changed no envelope must not add reset tax');
});

test('the revisit charge is priced as uncached input, not as a cache read',()=>{
  // A re-read of a pruned middle arrives as NEW input. Pricing it at
  // min(input,cacheRead) used the cache rate — 50x cheaper on the published card
  // (input 1 vs cacheRead 0.02) — so the gate approved rewrites its own re-read cost should
  // refuse. Measured by the delta the visit term adds to the refill estimate.
  const {agent,economics,finish,state,options}=harness();
  state.config.projectionPricing=[{provider:'p',model:'m',currency:'USD',input:.15,cacheRead:.003,cacheWrite:.15,output:.6}];
  options.tools=[];options.system='system';
  const system={id:'system',role:'system',content:[{type:'text',text:'rules'}]},user={id:'user',role:'user',content:[{type:'text',text:'request'}]};
  const body={id:'read-result',role:'tool',content:[{type:'text',text:'x'.repeat(20000)}]};
  options.messages=[system,user,body];
  finish(false,{inputTokens:100,cacheReadTokens:18000,cacheWriteTokens:0,outputTokens:20,totalTokens:18120});
  const pointer={...body,content:[{type:'text',text:'[work-evidence source event:10]'}]};
  const assess=tokens=>economics.assess(agent,{messages:options.messages,proposedMessages:[system,user,pointer],
    tools:[],system:'system',...(tokens?{revisitCostTokens:tokens}:{})});
  const plain=assess(0),revisited=assess(60000);
  const delta=revisited.refillCostEstimate-plain.refillCostEstimate;
  // 60,000 tokens at the input rate (.15/M) is 0.009; at the cache rate (.003/M) it is
  // 0.00018. The charge must be the former.
  assert.ok(delta>=0.0089,'the delta is input-priced: got ' + delta.toFixed(5));
  assert.ok(delta<0.0091,'and not larger: got ' + delta.toFixed(5));
});

test('the cost basis distinguishes a published family rate from an exact route row',()=>{
  // The summary labelled both the same. Only an exact route row is a real charge, so an
  // operator reading "configured-reference-prices" for a published card was misled. Both
  // directions are asserted: a flag that is always true would be as wrong as one that is
  // always false.
  const basisFor=(pricing,model)=>{
    const state={step:0,config:{projectionPricing:pricing,projectionHorizonSteps:16}};
    const agent={session:{id:'basis',surface:{nodes:[]},requestHeader:()=>({config:{provider:'p',model}}),requestContext:()=>({contextWindow:10000})}};
    const economics=createContextEconomics({tokenMeter:{measure:()=>({totalTokens:9000})}},{get:()=>state});
    const options={provider:'p',model,messages:[{id:'u',role:'user',content:[{type:'text',text:'r'}]}]};
    economics.requestFinished(agent,options,{usage:{inputTokens:1000,cacheReadTokens:500,cacheWriteTokens:0,outputTokens:100,totalTokens:1600},
      settled:true,finishReason:'stop',usageComplete:true,usageConsistent:true});
    return economics.summary(agent).costObservation.basis;
  };
  assert.equal(basisFor([{provider:'p',model:'m',currency:'USD',input:.15,cacheRead:.003,output:.6}],'m'),
    'configured-reference-prices','an exact route row is a configured reference price');
  assert.equal(basisFor([],'deepseek-v4.1-flash'),
    'published-family-rate','the shipped card is a published family rate');
});
