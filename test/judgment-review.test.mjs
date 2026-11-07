import test from 'node:test';
import assert from 'node:assert/strict';
import {auditDshSession,ASSESSMENT_SCHEMA} from '../trajectory-audit.mjs';

function fixture(){
  const events=[],add=(type,data)=>{const event={seq:events.length,type,data};events.push(event);return event;};
  const human=text=>add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text}]}});
  const assistant=text=>add('assistant/message',{turn:1,usage:{inputTokens:5,cacheReadTokens:2,cacheWriteTokens:0,outputTokens:3,totalTokens:10},
    message:{role:'assistant',content:[{type:'text',text}]}});
  const tool=(text,{name='read',args={file_path:'src/a.mjs'},type='tool/result',failed=false}={})=>{
    const id='call-'+events.length;
    add('tool/call',{callId:id,name,arguments:args});
    if(type==='tool/result')return add(type,{message:{role:'tool',source:{callId:id},content:[{type:'text',text}],isError:failed}});
    return add(type,{rootCallId:id,subCallId:id+'-inner',name,arguments:args,content:[{type:'text',text}],isError:failed});
  };
  human('Fix the parser.');
  const claim=assistant('The parser is fixed.');
  const counter=tool('actual parser failure',{failed:true});
  const replacement=assistant('The parser still fails.');
  const assessment={schema:ASSESSMENT_SCHEMA,sourceId:'recorded-session',throughSeq:events.at(-1).seq,reviewer:'human',
    allExplicitRequirementsCovered:false,criteria:[{id:'parser',requirementSeqs:[0],eventSeqs:[counter.seq],outcome:'fail'}]};
  const review={id:'parser-judgment',declaredStatus:'superseded',requirementSeqs:[0],claimSeq:claim.seq,claimQuote:'parser is fixed',
    counterSeq:counter.seq,counterQuote:'actual parser failure',replacementSeq:replacement.seq,replacementQuote:'still fails',
    scopePaths:['src/a.mjs'],reason:'The recorded result contradicts the earlier claim.'};
  return {events,add,human,assistant,tool,claim,counter,replacement,assessment,review};
}

function audit(f,...args){
  const assessment={...f.assessment};
  const review=args.length?args[0]:f.review;
  if(review!==undefined)assessment.judgmentReviews=[review];
  return auditDshSession(f.events,{sourceId:f.assessment.sourceId,assessment,tokenBudget:10});
}

test('source-linked challenged and superseded judgments retain exact references without changing other conclusions',()=>{
  for(const declaredStatus of ['challenged','superseded']){
    const f=fixture(),review={...f.review,declaredStatus};
    if(declaredStatus==='challenged'){delete review.replacementSeq;delete review.replacementQuote;}
    const result=audit(f,review),row=result.judgmentReviews.items[0];
    assert.equal(row.status,declaredStatus);assert.equal(row.authority,'reviewer-judgment');
    assert.equal(row.claim.quoteMatched,true);assert.equal(row.counter.quoteMatched,true);
    assert.equal(row.claim.quoteChars,15);assert.equal(row.claim.source,'recorded-session#event:1');
    assert.equal(row.currentApplicability,'historical-events-only');
    assert.equal(result.taskOutcome,'fail');assert.equal(result.fullSuccessAtBudget.failed,1);assert.equal(result.usage.totalTokens,20);
    assert.equal(result.detectionCounts.reviewedAnnotations,0);assert.equal(result.findings.length,0);
    const serialized=JSON.stringify(result.judgmentReviews);
    for(const text of ['The parser is fixed','actual parser failure','still fails','Fix the parser','private reasoning'])assert.ok(!serialized.includes(text));
  }
});

test('old assessments are not reviewed and malformed or duplicate rows are rejected',()=>{
  const f=fixture();assert.equal(audit(f,undefined).judgmentReviews.status,'not-reviewed');
  assert.throws(()=>audit(f,{...f.review,id:''}),/Invalid judgment review/);
  assert.throws(()=>{f.assessment.judgmentReviews=[f.review,f.review];auditDshSession(f.events,{sourceId:f.assessment.sourceId,assessment:f.assessment});},/Invalid judgment review/);
  assert.throws(()=>audit(f,{...f.review,claimSeq:999}),/Invalid judgment review/);
  const plugin=f.add('user/message',{message:{role:'user',source:{kind:'work-evidence'},content:[{type:'text',text:'hint'}]}});
  f.assessment.throughSeq=plugin.seq;assert.throws(()=>audit(f,{...f.review,requirementSeqs:[plugin.seq]}),/Invalid judgment review/);
});

test('missing, forged, wrong-role and mistimed quotes become unknown with specific reasons',()=>{
  for(const [change,reason] of [
    [{claimQuote:''},'claim-quote-not-matched'],[{claimQuote:'forged'},'claim-quote-not-matched'],
    [{counterQuote:'forged'},'counter-quote-not-matched'],[{claimSeq:2,counterSeq:1},'claim-not-assistant-text'],
    [{replacementSeq:2},'replacement-not-assistant-text'],[{counterSeq:2},'counter-not-tool-or-human-text']
  ]){
    const f=fixture(),row=audit(f,{...f.review,...change}).judgmentReviews.items[0];
    assert.equal(row.status,'unknown',JSON.stringify({change,row}));assert.equal(row.declaredStatus,'superseded');assert.ok(row.reasons.includes(reason),reason);
  }
  const f=fixture(),row=audit(f,{...f.review,claimSeq:f.counter.seq,counterSeq:f.claim.seq}).judgmentReviews.items[0];
  assert.ok(row.reasons.includes('claim-counter-order-invalid'));
  const missing=fixture();delete missing.review.replacementSeq;delete missing.review.replacementQuote;
  assert.ok(audit(missing).judgmentReviews.items[0].reasons.includes('replacement-required'));
});

test('human corrections are valid counters but later unrelated requests do not cross scopes',()=>{
  const f=fixture(),correction=f.human('The earlier parser claim is wrong.'),replacement=f.assistant('The parser still fails.');
  f.assessment.throughSeq=replacement.seq;
  let row=audit(f,{...f.review,counterSeq:correction.seq,counterQuote:'earlier parser claim is wrong',replacementSeq:replacement.seq}).judgmentReviews.items[0];
  assert.equal(row.status,'superseded');
  const g=fixture(),unrelated=g.human('Now explain a different file.');g.assessment.throughSeq=unrelated.seq;
  row=audit(g).judgmentReviews.items[0];assert.equal(row.status,'unknown');assert.ok(row.reasons.includes('later-human-request'));
});

test('requirements cannot postdate claims and requests between claim and counter invalidate review scope',()=>{
  const f=fixture(),later=f.human('A later requirement cannot authorize the old claim.');
  f.assessment.throughSeq=later.seq;
  assert.throws(()=>audit(f,{...f.review,requirementSeqs:[later.seq]}),/Invalid judgment review/);
  const g=fixture();
  g.events.splice(2,0,{type:'user/message',data:{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Unrelated task.'}]}}});
  g.events.forEach((event,seq)=>event.seq=seq);
  g.review.counterSeq=g.counter.seq;g.review.replacementSeq=g.replacement.seq;g.assessment.throughSeq=g.events.at(-1).seq;
  g.assessment.criteria[0].eventSeqs=[g.review.counterSeq];
  const row=audit(g).judgmentReviews.items[0];assert.equal(row.status,'unknown');assert.ok(row.reasons.includes('later-human-request'));
});

test('surface replacements and whitespace quotes cannot serve as original references',()=>{
  const f=fixture();f.events[f.claim.seq].surfaceOp={op:'replace'};
  let row=audit(f).judgmentReviews.items[0];assert.equal(row.status,'unknown');assert.ok(row.reasons.includes('claim-quote-not-matched'));
  const g=fixture();row=audit(g,{...g.review,claimQuote:'   '}).judgmentReviews.items[0];
  assert.equal(row.status,'unknown');assert.equal(row.claim.quoteMatched,false);
});

test('unsettled opaque and file calls remain unknown without claiming execution success',()=>{
  for(const [name,args,reason] of [
    ['run_code',{code:'unknown effects'},'opaque-execution-after-evidence'],
    ['edit',{file_path:'src/a.mjs',old_string:'a',new_string:'b'},'unsettled-mutation'],
    ['write',{content:'unknown target'},'file-scope-unresolved']]){
    const f=fixture();f.add('tool/call',{callId:'unsettled-'+name,name,arguments:args});f.assessment.throughSeq=f.events.at(-1).seq;
    const result=audit(f),row=result.judgmentReviews.items[0];
    assert.equal(row.status,'unknown');assert.ok(row.reasons.includes(reason),reason);
    assert.equal(result.events.toolCalls.at(-1).outcome,'unknown');assert.equal(result.events.toolCalls.at(-1).resultSeq,null);
  }
});

test('review bounds reject excessive paths, reasons and nonempty quotes',()=>{
  const f=fixture();
  for(const review of [{...f.review,scopePaths:Array.from({length:65},(_,index)=>'file-'+index)},
    {...f.review,reason:'x'.repeat(2049)},{...f.review,claimQuote:'x'.repeat(8001)}])assert.throws(()=>audit(f,review),/Invalid judgment review/);
});

test('programs and writes begun before the evidence can still invalidate its file scope',()=>{
  for(const [name,args,settled]of [['run_code',{code:'opaque work'},true],['run_code',{code:'opaque work'},false],
    ['write',{file_path:'src/a.mjs',content:'later content'},false]]){
    const f=fixture(),callId='overlapping-'+name;
    f.events.splice(2,0,{type:'tool/call',data:{callId,name,arguments:args}});
    f.events.forEach((event,seq)=>event.seq=seq);
    f.review.counterSeq=f.counter.seq;f.review.replacementSeq=f.replacement.seq;
    if(settled)f.add('tool/result',{message:{role:'tool',source:{callId},content:[{type:'text',text:'finished'}],isError:false}});
    f.assessment.throughSeq=f.events.at(-1).seq;f.assessment.criteria[0].eventSeqs=[f.counter.seq];
    const row=audit(f).judgmentReviews.items[0];
    assert.equal(row.status,'unknown');
    assert.ok(row.reasons.includes(name==='write'?'unsettled-mutation':'opaque-execution-after-evidence'));
  }
});

test('later file writes and opaque executions invalidate only historical file applicability',()=>{
  for(const opaque of [false,true]){
    const f=fixture();
    if(opaque)f.tool('done',{name:'run_code',args:{code:'modify elsewhere'}});
    else f.tool('written',{name:'edit',args:{file_path:'src/a.mjs',old_string:'a',new_string:'b'}});
    f.assessment.throughSeq=f.events.at(-1).seq;
    const row=audit(f).judgmentReviews.items[0];
    assert.equal(row.status,'unknown');
    assert.ok(row.reasons.includes(opaque?'opaque-execution-after-evidence':'file-changed-after-evidence'));
  }
});

test('possible writes after judgment evidence invalidate overlapping and unresolved scopes',()=>{
  for(const declaredStatus of ['challenged','superseded'])for(const failed of [false,true]){
    for(const [filePath,affected] of [['src/a.mjs',true],['./src/a.mjs',true],['src/other.mjs',false],[undefined,true]]){
      for(const withinReview of [true,false]){
        const sample=fixture(),review={...sample.review,declaredStatus};
        if(declaredStatus==='challenged'){delete review.replacementSeq;delete review.replacementQuote;}
        const write=sample.tool('uncertain',{name:'write',args:{file_path:filePath,content:'later content'},failed});
        if(!failed)delete sample.events.find(event=>event.seq===write.seq).data.message.isError;
        const later=sample.tool('later read');
        sample.assessment.throughSeq=withinReview?later.seq:(review.replacementSeq??review.counterSeq);
        let row=audit(sample,review).judgmentReviews.items[0],invalid=affected&&withinReview;
        assert.equal(row.status,invalid||!withinReview?'unknown':declaredStatus,JSON.stringify({declaredStatus,failed,filePath,withinReview}));
        assert.equal(row.reasons?.includes('possible-file-change-after-evidence')??false,invalid);
        if(!withinReview)assert.ok(row.reasons.includes('events-after-review'));
        sample.events.find(event=>event.seq===write.seq).data.message.content=[{type:'text',text:JSON.stringify({effectState:'none'})}];
        sample.assessment.throughSeq=later.seq;
        row=audit(sample,review).judgmentReviews.items[0];
        assert.equal(row.status,declaredStatus);assert.equal(row.reasons,undefined);
      }
    }
  }
});

test('pending read-only Java operations do not invalidate judgment scopes',()=>{
  for(const operation of ['read_entity','find_entity']){
    const sample=fixture();
    sample.review.scopePaths=['src/Parser.java'];
    sample.add('tool/call',{callId:'pending-java',name:'fastedit_java',arguments:{file:'src/Parser.java',operation,symbol:'Parser.parse'}});
    sample.assessment.throughSeq=sample.events.at(-1).seq;
    const result=audit(sample),row=result.judgmentReviews.items[0];
    assert.equal(row.status,'superseded',operation);assert.equal(row.reasons,undefined);
    assert.equal(result.events.toolCalls.at(-1).resultSeq,null);
  }
});

test('nested tool counters, appended events and damaged sources remain explicit unknowns',()=>{
  const f=fixture(),nested=f.tool('nested parser failure',{type:'tool/ptc-dispatch',failed:true});f.assessment.throughSeq=nested.seq;
  f.review={...f.review,counterSeq:nested.seq,counterQuote:'nested parser failure',replacementSeq:undefined,replacementQuote:undefined,declaredStatus:'challenged'};
  delete f.review.replacementSeq;delete f.review.replacementQuote;
  assert.equal(audit(f).judgmentReviews.items[0].status,'challenged');
  const g=fixture();g.add('assistant/message',{turn:2,message:{role:'assistant',content:[{type:'text',text:'Later unrelated event.'}]}});
  let result=audit(g);assert.equal(result.judgmentReviews.status,'stale');
  assert.equal(result.judgmentReviews.items[0].status,'unknown');
  assert.ok(result.judgmentReviews.items[0].reasons.includes('events-after-review'));
  const h=fixture();result=auditDshSession(h.events,{sourceId:h.assessment.sourceId,
    assessment:{...h.assessment,judgmentReviews:[h.review]},problems:[{line:2,reason:'invalid-json-row'}]});
  assert.equal(result.judgmentReviews.status,'incomplete-source');
  assert.equal(result.judgmentReviews.items[0].status,'unknown');
  assert.ok(result.judgmentReviews.items[0].reasons.includes('incomplete-source'));
});
