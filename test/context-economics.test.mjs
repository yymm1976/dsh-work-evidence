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
