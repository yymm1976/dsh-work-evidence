import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {auditDshSession,normalizeDshEvents,readAuditInput,fullSuccessAtBudget,ASSESSMENT_SCHEMA,auditCacheTransitions} from '../trajectory-audit.mjs';
import {canonicalUsage} from '../context-economics.mjs';

const usage={inputTokens:5,cacheReadTokens:2,cacheWriteTokens:0,outputTokens:3,totalTokens:10};
function fixture(){
  const events=[];
  const add=(type,data)=>{const event={seq:events.length,type,data};events.push(event);return event;};
  add('request/header',{header:{config:{provider:'local',model:'deepseek-v4.1-flash',reasoningEffort:'max'}}});
  add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Read and explain the source.'}]}});
  const operation=(name,args,body,{failed=false,nested=false}={})=>{
    const id='call-'+events.length;
    const assistant=add('assistant/message',{turn:1,step:events.length,usage,message:{role:'assistant',content:[{type:'reasoning',text:'private reasoning must not be copied'}]}});
    add('tool/call',{callId:id,name:nested?'run_code':name,arguments:nested?{code:'return await tools.read({file_path:"a.txt"});'}:args});
    if(nested)add('tool/ptc-dispatch',{rootCallId:id,subCallId:id+'-inner',name,arguments:args,content:[{type:'text',text:body}],isError:failed});
    const result=add('tool/result',{message:{role:'tool',source:{callId:id},content:[{type:'text',text:body}],isError:failed}});
    return {requestSeq:assistant.seq,resultSeq:nested?result.seq-1:result.seq};
  };
  return {events,add,operation};
}

test('native wrappers and nested actions are distinct and derived findings preserve raw source',()=>{
  const f=fixture();f.operation('read',{file_path:'a.txt'},'same source',{nested:true});f.operation('read',{file_path:'a.txt'},'same source',{nested:true});
  const before=JSON.stringify(f.events),audit=auditDshSession({events:f.events,quality:{everything:true}});
  assert.equal(JSON.stringify(f.events),before);assert.equal(audit.coverage.rootCalls,2);assert.equal(audit.coverage.nestedCalls,2);
  assert.equal(audit.findings.length,1);assert.deepEqual(audit.findings[0].labels,['W2','W5']);
  assert.equal(audit.taskOutcome,'unknown');assert.equal(audit.modelBuild,'unconfirmed');
  assert.equal(audit.associatedConsumption.knownTokens,20,'one request is counted once across the two labels');
  assert.equal(audit.associatedConsumption.realizableSaving,null);
  assert.ok(!JSON.stringify(audit).includes('private reasoning must not be copied'));
});

test('model build requires a complete exact declaration on every recorded attempt',()=>{
  const f=fixture();f.operation('read',{file_path:'a.txt'},'source');
  f.events[0].data.header.config.model='provider/path/DeepSeek-V4.1-Flash-1017';
  assert.equal(auditDshSession(f.events).modelBuild,'declared-1017');
  f.events[0].data.header.config.model='deepseek-v4.1-flash-1017-preview';
  assert.equal(auditDshSession(f.events).modelBuild,'unconfirmed');
  f.events[0].data.header.config.model='deepseek-v4.1-flash-1017';
  f.events.splice(1,0,{seq:.5,type:'request/header',data:{header:{config:{provider:'local',model:'deepseek-v4.1-flash-1017'}}}});
  assert.equal(auditDshSession(f.events).modelBuild,'declared-1017');
  const first=f.events.find(event=>event.type==='assistant/message'),next=Math.max(...f.events.map(event=>event.seq))+1;
  first.data.turn=100;first.data.step=10;
  f.events.push({seq:next,type:'request/header',data:{header:{config:{provider:'local'}}}},
    {seq:next+1,type:'assistant/message',data:{turn:200,step:20,usage,stream:[{type:'chunk',chunk:{type:'finish',reason:{kind:'stop'}}}]}});
  const result=auditDshSession(f.events);
  assert.equal(result.modelBuild,'unconfirmed');assert.equal(result.modelBuildCoverage.requests,2);
  assert.equal(result.modelBuildCoverage.missingRoutes,1);assert.deepEqual(result.modelBuildCoverage.missingRouteSeqs,[next+1]);
});

test('response model echo stays separate from request declarations and adapter coverage',()=>{
  const echo=(kind,value)=>{
    const f=fixture();f.operation('read',{file_path:'a.txt'},'source');
    f.events[0].data.header.config.model='deepseek-v4.1-flash-1017';
    const assistant=f.events.find(event=>event.type==='assistant/message');
    if(kind){assistant.data.message.source??={kind:'model'};assistant.data.message.source.replayState={response:{kind,responseModel:value,responseId:'sensitive-response-id',blocks:['sensitive-block']}};}
    const result=auditDshSession(f.events);assert.equal(result.modelBuild,'declared-1017');
    assert.equal(result.responseModelEcho.requests,1);
    assert.equal(JSON.stringify(result).includes('sensitive-response-id'),false);
    assert.equal(JSON.stringify(result).includes('sensitive-block'),false);
    return result.responseModelEcho;
  };
  const reported=echo('pi-ai','provider/deepseek-v4.1-flash-1017');
  assert.equal(reported.counts.reported,1);assert.deepEqual(reported.reportedValues,['provider/deepseek-v4.1-flash-1017']);
  assert.equal(reported.reported[0].responseModel,'provider/deepseek-v4.1-flash-1017');
  assert.equal(echo('pi-ai',undefined).counts['not-reported'],1);
  assert.equal(echo('deepseek-messages','deepseek-flash').counts['unsupported-by-adapter'],1);
  assert.equal(echo(null,null).counts.unknown,1);
  assert.equal(echo('pi-ai','bad\nname').counts['not-reported'],1);
});

test('an assistant attempt can report its own finish replay model without a message source',()=>{
  const f=fixture();f.events[0].data.header.config.model='deepseek-v4.1-flash-1017';
  f.events.push({seq:99,type:'assistant/attempt',data:{turn:2,step:2,stream:[{type:'chunk',chunk:{type:'finish',reason:{kind:'stop'},
    replayState:{response:{kind:'pi-ai',responseModel:'deepseek/deepseek-v4.1-flash-1017'}}}}]}});
  const echo=auditDshSession(f.events).responseModelEcho;
  assert.equal(echo.counts.reported,1);assert.equal(echo.counts.unknown,0);
  assert.equal(echo.reported[0].seq,99);assert.equal(echo.reported[0].responseModel,'deepseek/deepseek-v4.1-flash-1017');
});

test('source changes, a new human requirement and incomplete reads prevent exact-repeat findings',()=>{
  for(const variation of ['write','user','truncated']){
    const f=fixture(),body=variation==='truncated'?'x... (line truncated to 2000 chars)':'same source';
    f.operation('read',{file_path:'a.txt'},body);
    if(variation==='write')f.operation('write',{file_path:'a.txt',content:'same source'},'ok');
    if(variation==='user')f.add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Read again for a new question.'}]}});
    f.operation('read',{file_path:'a.txt'},body);
    assert.equal(auditDshSession(f.events).findings.length,0,variation);
  }
});

test('same failures are candidates and a successful edit separates retry observations',()=>{
  const f=fixture();f.operation('pwsh',{command:'node task.mjs'},'Error: bad value',{failed:true});
  f.operation('pwsh',{command:'node task.mjs'},'Error: bad value',{failed:true});
  f.operation('edit',{file_path:'a.mjs',old_string:'bad',new_string:'good'},'edited');
  f.operation('pwsh',{command:'node task.mjs'},'Error: bad value',{failed:true});
  const audit=auditDshSession(f.events);assert.equal(audit.findings.length,1);
  assert.deepEqual(audit.findings[0].labels,['W3','W8']);assert.equal(audit.findings[0].classification,'candidate');
});

test('failed zero and absent counters stay unknown and reference currencies remain separate',()=>{
  const f=fixture();f.operation('read',{file_path:'a'},'one');
  const audit=auditDshSession({events:f.events,requests:[
    {provider:'a',model:'m',usage,finish:{kind:'stop'},purpose:'main'},
    {provider:'b',model:'m',usage,finish:{kind:'stop'},purpose:'compaction'},
    {provider:'a',model:'m',usage:{inputTokens:0,outputTokens:0,totalTokens:0},finish:{kind:'error'},purpose:'auxiliary'},
  ]},{pricing:[{provider:'a',model:'m',input:1,cacheRead:1,output:1,currency:'USD'},
    {provider:'b',model:'m',input:2,cacheRead:2,output:2,currency:'CNY'}]});
  assert.equal(audit.usage.knownTokens,20);assert.equal(audit.usage.totalTokens,null);assert.equal(audit.usage.unknownRequests,1);
  assert.deepEqual(audit.usage.knownReferenceCostByCurrency,{USD:.00001,CNY:.00002});assert.equal(audit.usage.costComplete,false);
});

test('an exported rejected usage verdict cannot become a successful budget result after normalization',()=>{
  const {f,done,assessment}=reviewedFixture();
  assessment.consumption={scope:'all-task-requests',complete:true,eventSeqs:[done.requestSeq]};
  const rejected=canonicalUsage({inputTokens:5,cacheReadTokens:-1,cacheWriteTokens:0,outputTokens:3,totalTokens:8});
  assert.equal(rejected.complete,false);
  const input={events:f.events,requests:[{provider:'local',model:'deepseek-v4.1-flash',finish:{kind:'stop'},
    usage:rejected.usage,usageComplete:rejected.complete,usageConsistent:rejected.consistent,usageSources:rejected.sources}]};
  const before=JSON.stringify(input);
  const audit=auditDshSession(input,{sourceId:assessment.sourceId,assessment,tokenBudget:8,
    pricing:[{provider:'local',model:'deepseek-v4.1-flash',input:1,cacheRead:1,output:1,currency:'USD'}]});
  assert.equal(audit.usage.unknownRequests,1);assert.equal(audit.usage.totalTokens,null);
  assert.equal(audit.usage.requests[0].usage.cacheReadTokens,null,'A rejected cache counter must not be exposed as a known zero.');
  assert.equal(audit.usage.costComplete,false);assert.equal(audit.usage.requests[0].referenceCost,null);
  assert.equal(audit.usage.requests[0].incompleteReason,'source-record-consumption-unknown');
  assert.equal(audit.fullSuccessAtBudget.success,0);assert.equal(audit.fullSuccessAtBudget.unknown,1);
  assert.equal(JSON.stringify(input),before);
});

test('a recorded unsettled consumption stays unknown while an unqualified raw omitted-zero usage stays usable',()=>{
  const f=fixture();f.operation('read',{file_path:'a'},'one');
  const row={provider:'a',model:'m',usage:{inputTokens:5,outputTokens:3,totalTokens:8},finish:{kind:'stop'}};
  const raw=auditDshSession({events:f.events,requests:[row]});
  assert.equal(raw.usage.totalTokens,8);assert.equal(raw.usage.requests[0].usage.cacheReadTokens,0);
  const unknown=auditDshSession({events:f.events,requests:[{...row,unknownConsumption:true}]});
  assert.equal(unknown.usage.totalTokens,null);assert.equal(unknown.usage.unknownRequests,1);
});

test('reviewed annotations require actual event addresses and source-based judgments',()=>{
  const f=fixture();const call=f.operation('read',{file_path:'a'},'one');
  const annotation={eventSeqs:[call.resultSeq],labels:['Q1'],classification:'unknown',reason:'The report lacks current source coverage.'};
  assert.throws(()=>auditDshSession(f.events,{annotations:[annotation]}),/reviewer and counterexample/);
  assert.throws(()=>auditDshSession(f.events,{annotations:[{...annotation,classification:'candidate',eventSeqs:[999]}]}),/unavailable source event/);
  const audit=auditDshSession(f.events,{annotations:[{...annotation,reviewer:'human',counterexample:'A later result may resolve this claim.'}]});
  assert.equal(audit.findings[0].classification,'unknown');assert.equal(audit.taskOutcome,'unknown');
});

test('malformed JSONL and unmatched results remain visible rather than disappearing',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'we-audit-'));
  try{
    const file=path.join(directory,'events.jsonl');await fs.writeFile(file,'{"seq":0,"type":"turn/start","data":{}}\ninvalid-row\n');
    const {input,problems}=await readAuditInput(file);assert.deepEqual(problems,[{line:2,reason:'invalid-json-row'}]);
    assert.equal(auditDshSession(input,{problems}).problems.length,1);
    assert.equal(normalizeDshEvents([{seq:0,type:'tool/result',data:{message:{content:[]}}}]).problems[0].reason,'unmatched-tool-result');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('FullSuccess at budget requires complete reviewed acceptance, known total usage and all criteria',()=>{
  const assessment={allExplicitRequirementsCovered:true,reviewer:'human',criteria:[{outcome:'pass',evidence:['event:4']}]};
  const rows=[{assessment,usage:{totalTokens:10}},{assessment,usage:{totalTokens:null}},
    {assessment:{...assessment,criteria:[{outcome:'fail',evidence:['event:6']}]},usage:{totalTokens:8}},
    {assessment:{...assessment,criteria:[{outcome:'pass',evidence:[]}]},usage:{totalTokens:8}}];
  const result=fullSuccessAtBudget(rows,{tokenBudget:10});
  assert.deepEqual({success:result.success,failed:result.failed,unknown:result.unknown,rate:result.rate},{success:1,failed:1,unknown:2,rate:null});
  assert.equal(result.lowerBound,.25);assert.equal(result.upperBound,.75);
});

test('duplicate native call identifiers remain separate observations with explicit ambiguity',()=>{
  const f=fixture();f.operation('read',{file_path:'a'},'first');f.operation('read',{file_path:'b'},'second');
  const callEvents=f.events.filter(event=>event.type==='tool/call');callEvents[1].data.callId=callEvents[0].data.callId;
  const results=f.events.filter(event=>event.type==='tool/result');results[1].data.message.source.callId=callEvents[0].data.callId;
  const normalized=normalizeDshEvents(f.events);
  assert.equal(normalized.calls.length,2);assert.equal(normalized.calls[0].resultText,'first');assert.equal(normalized.calls[1].resultText,'second');
  assert.ok(normalized.problems.some(problem=>problem.reason==='duplicate-tool-call-id'));
});

test('duplicate results for one call cannot replace the recorded failure with success',()=>{
  const f=fixture();
  const done=f.operation('pwsh',{command:'node check.mjs'},'failed',{failed:true});
  const original=f.events.find(event=>event.seq===done.resultSeq);
  f.add('tool/result',{message:{...original.data.message,isError:false,content:[{type:'text',text:'passed'}]}});
  const normalized=normalizeDshEvents(f.events);
  const call=normalized.calls.find(item=>item.resultSeq===done.resultSeq);
  assert.ok(normalized.problems.some(problem=>problem.reason==='duplicate-tool-result'));
  assert.equal(call.outcome,'failed');
  assert.equal(call.resultText,'failed');
});

test('out-of-order source events cannot support a completed task or budget result',()=>{
  const {f,done,assessment,audit}=reviewedFixture();
  assessment.consumption={scope:'all-task-requests',complete:true,eventSeqs:[done.requestSeq]};
  assert.equal(audit().fullSuccessAtBudget.success,1);
  [f.events[1],f.events[2]]=[f.events[2],f.events[1]];
  const result=audit();
  assert.ok(result.problems.some(problem=>problem.reason==='out-of-order-source-seq'));
  assert.equal(result.taskOutcome,'unknown');
  assert.equal(result.fullSuccessAtBudget.unknown,1);
});

test('invalid budget usage, incomplete source and unsupported assessment claims remain unknown',()=>{
  const assessment={allExplicitRequirementsCovered:true,reviewer:'human',criteria:[{outcome:'pass',evidence:['event:4']}]};
  for(const row of [{assessment,usage:{totalTokens:-1}},{assessment,usage:{}},{assessment,usage:{totalTokens:1},problems:[{reason:'invalid-json-row'}]},
    {assessment:{...assessment,allExplicitRequirementsCovered:'true'},usage:{totalTokens:1}},
    {assessment:{...assessment,criteria:[{outcome:'fail',evidence:[]}]},usage:{totalTokens:1}}])
    assert.equal(fullSuccessAtBudget([row],{tokenBudget:10}).unknown,1);
});

test('dynamic running-job queries are excluded and nested reads retain outer-delivery uncertainty',()=>{
  const f=fixture();f.operation('job_output',{job_id:'running',wait:false},'(no new output)\n[status: running]');
  f.operation('job_output',{job_id:'running',wait:false},'(no new output)\n[status: running]');
  assert.equal(auditDshSession(f.events).findings.length,0);
  f.operation('read',{file_path:'a'},'source',{nested:true});
  const call=normalizeDshEvents(f.events).calls.find(call=>call.nested);
  assert.equal(call.deliveryVisibility,'not-inferred-from-inner-return');assert.equal(call.enclosingOutcome,'succeeded');
});

test('source-based rejection replaces a candidate judgment without counting it twice or keeping its associated cost',()=>{
  const f=fixture();f.operation('read',{file_path:'a'},'same');f.operation('read',{file_path:'a'},'same');
  const initial=auditDshSession(f.events),candidate=initial.findings[0];
  const annotation={...candidate,classification:'rejected',reviewer:'main agent',reason:'The second read answers a different necessary question.',counterexample:'Same text need not answer the same decision.'};
  const reviewed=auditDshSession(f.events,{annotations:[annotation]});
  assert.equal(reviewed.findings.length,1);assert.equal(reviewed.findings[0].classification,'rejected');
  assert.equal(reviewed.associatedConsumption.knownTokens,0);assert.equal(reviewed.labels.W2,1);
  assert.equal(reviewed.detectionCounts.remainingCandidates,0);
  assert.throws(()=>auditDshSession(f.events,{annotations:[{...annotation,eventSeqs:[candidate.eventSeqs[0]]}]}),/retain its original event addresses/);
});

test('the packaged audit command creates derived output and refuses an input hard link as output',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'we-audit-cli-'));
  try{
    const file=path.join(directory,'events.json'),out=path.join(directory,'audit.json'),linked=path.join(directory,'same-input.json');
    const f=fixture(),done=f.operation('read',{file_path:'a.txt'},'observed source');
    const original=JSON.stringify({events:f.events});await fs.writeFile(file,original);await fs.link(file,linked);
    const cli=path.resolve(import.meta.dirname,'../experiment-cli.mjs'),run=promisify(execFile);
    await run(process.execPath,[cli,'audit','--file',file,'--out',out]);
    assert.equal(JSON.parse(await fs.readFile(out,'utf8')).taskOutcome,'unknown');
    await assert.rejects(run(process.execPath,[cli,'audit','--file',file,'--out',linked]),/must not overwrite/);
    assert.equal(await fs.readFile(file,'utf8'),original);
    const assessmentFile=path.join(directory,'assessment.json'),assessmentLink=path.join(directory,'same-assessment.json');
    const assessment={schema:ASSESSMENT_SCHEMA,sourceId:file,throughSeq:f.events.at(-1).seq,reviewer:'human',allExplicitRequirementsCovered:true,
      criteria:[{id:'source',requirementSeqs:[1],eventSeqs:[done.resultSeq],outcome:'pass'}],
      consumption:{scope:'all-task-requests',complete:true,eventSeqs:[done.requestSeq]}};
    assessment.checks=[recordedCheck(f,done,'source','addresses')];
    const reviewText=JSON.stringify(assessment);await fs.writeFile(assessmentFile,reviewText);await fs.link(assessmentFile,assessmentLink);
    const {stdout}=await run(process.execPath,[cli,'audit','--file',file,'--assessment',assessmentFile,'--budget','10','--out',out]);
    assert.equal(JSON.parse(stdout).taskOutcome,'pass');assert.equal(JSON.parse(stdout).fullSuccessAtBudget.success,1);
    assert.equal(JSON.parse(stdout).verification.addressedCriteria,1);
    await assert.rejects(run(process.execPath,[cli,'audit','--file',file,'--assessment',assessmentFile,'--out',assessmentLink]),/must not overwrite/);
    await assert.rejects(run(process.execPath,[cli,'audit','--file',file,'--assessment',assessmentFile,'--budget','1e3']),/positive safe integer/);
    assert.equal(await fs.readFile(assessmentFile,'utf8'),reviewText);assert.equal(await fs.readFile(file,'utf8'),original);
  }finally{
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(directory,{recursive:true,force:true});
  }
});

function reviewedFixture(){
  const f=fixture(),done=f.operation('read',{file_path:'a.txt'},'observed source');
  const assessment={schema:ASSESSMENT_SCHEMA,sourceId:'recorded-session',throughSeq:f.events.at(-1).seq,reviewer:'human',allExplicitRequirementsCovered:true,
    criteria:[{id:'source',requirementSeqs:[1],eventSeqs:[done.resultSeq],outcome:'pass'}]};
  const audit=()=>auditDshSession(f.events,{sourceId:'recorded-session',assessment,tokenBudget:10});
  return {f,done,assessment,audit};
}

test('source-linked judgment and complete consumption are separate requirements for budget success',()=>{
  const {assessment,done,audit}=reviewedFixture();
  const partial=audit();assert.equal(partial.taskOutcome,'pass');assert.equal(partial.fullSuccessAtBudget.unknown,1);
  assessment.consumption={scope:'all-task-requests',complete:true,eventSeqs:[done.requestSeq]};
  const complete=audit();assert.equal(complete.fullSuccessAtBudget.success,1);assert.equal(complete.fullSuccessAtBudget.rate,1);
  assert.ok(!JSON.stringify(complete).includes('private reasoning must not be copied'));
  assert.ok(!JSON.stringify(complete).includes('Read and explain the source.'));
});

test('missing result evidence and a later human requirement keep claimed completion unknown',()=>{
  const {f,assessment,audit}=reviewedFixture();
  assessment.criteria[0].eventSeqs=[];assessment.criteria[0].artifactRefs=[path.resolve(import.meta.filename)];let result=audit();
  assert.equal(result.taskOutcome,'unknown');assert.equal(result.assessment.criteria[0].declaredOutcome,'pass');
  assert.equal(result.assessment.criteria[0].reason,'missing-outcome-evidence');
  assert.deepEqual(result.assessment.criteria[0].artifactRefs,[path.resolve(import.meta.filename)]);
  assessment.criteria[0].eventSeqs=[f.events.at(-1).seq];
  const added=f.add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Also deliver a JSON answer.'}]}});
  result=audit();assert.deepEqual(result.assessment.unassessedRequirementSeqs,[added.seq]);
  assert.equal(result.assessment.allExplicitRequirementsCovered,false);assert.equal(result.taskOutcome,'unknown');
});

test('review rejects another session, nonexistent evidence, repeated ids and a plugin message as a requirement',()=>{
  const {f,assessment,audit}=reviewedFixture();
  assessment.sourceId='another-session';assert.throws(audit,/matching sourceId/);assessment.sourceId='recorded-session';
  assessment.criteria[0].eventSeqs=[999];assert.throws(audit,/Unavailable assessment event/);
  assessment.criteria[0].eventSeqs=[f.events.at(-1).seq];assessment.criteria.push({...assessment.criteria[0]});
  assert.throws(audit,/Invalid assessment criterion/);assessment.criteria.pop();
  const plugin=f.add('user/message',{message:{role:'user',source:{kind:'work-evidence-task-flow'},content:[{type:'text',text:'A plugin hint.'}]}});
  assessment.criteria[0].requirementSeqs=[plugin.seq];assert.throws(audit,/human requirement/);
});

test('one source-backed explicit failure disproves full success even when other requirements or usage remain unknown',()=>{
  const {assessment,audit}=reviewedFixture();assessment.allExplicitRequirementsCovered=false;
  assessment.criteria[0].outcome='fail';assessment.criteria.push({id:'unresolved',requirementSeqs:[1],eventSeqs:[],outcome:'unknown'});
  const result=audit();assert.equal(result.taskOutcome,'fail');assert.equal(result.fullSuccessAtBudget.failed,1);
  assert.equal(result.fullSuccessAtBudget.unknown,0);assert.equal(result.usage.totalTokens,10);
});

test('a damaged source keeps a supplied failure judgment unknown and native-only consumption cannot claim a full budget result',()=>{
  const {f,assessment,done,audit}=reviewedFixture();
  assessment.consumption={scope:'recorded-native-attempts',complete:true,eventSeqs:[done.requestSeq]};
  assert.throws(audit,/all-task-requests/);delete assessment.consumption;
  assessment.criteria[0].outcome='fail';
  const result=auditDshSession(f.events,{sourceId:assessment.sourceId,assessment,tokenBudget:10,problems:[{line:2,reason:'invalid-json-row'}]});
  assert.equal(result.taskOutcome,'unknown');assert.equal(result.fullSuccessAtBudget.unknown,1);
  assert.equal(result.requirements.requirements[0].status,'unknown');
});

test('a later operation invalidates an older review even without another human message',()=>{
  const {f,done,assessment,audit}=reviewedFixture();
  assessment.consumption={scope:'all-task-requests',complete:true,eventSeqs:[done.requestSeq]};
  assert.equal(audit().fullSuccessAtBudget.success,1);
  f.operation('write',{file_path:'a.txt',content:'changed after review'},'written');
  const result=audit();assert.equal(result.assessment.sourceCurrent,false);assert.equal(result.taskOutcome,'unknown');
  assert.equal(result.fullSuccessAtBudget.unknown,1);assert.equal(result.assessment.criteria[0].reason,'events-after-review');
  assert.equal(result.assessment.consumption.complete,false);assert.equal(result.sourceThroughSeq,f.events.at(-1).seq);
});

function recordedCheck(f,done,criterionId,reach){
  const call=normalizeDshEvents(f.events).calls.find(row=>row.resultSeq===done.resultSeq);
  return {id:'recorded-check-'+done.resultSeq,callSeq:call.callSeq,resultSeq:done.resultSeq,
    coverage:[{criterionId,reach,reason:'Reviewed the recorded operation against this explicit requirement.'}]};
}

test('the requirement evidence view links seven nodes without claiming unobserved delivery',()=>{
  const {f,assessment,audit,done}=reviewedFixture();
  assessment.checks=[recordedCheck(f,done,'source','addresses')];
  assessment.checks[0].coverage[0].scopePaths=['a.txt'];
  const result=audit(),view=result.requirements;
  assert.equal(view.counts.supported,1);
  const row=view.requirements[0],nodes=row.nodes;
  assert.deepEqual(nodes.humanRequirement.eventSeqs,[1]);
  assert.deepEqual(nodes.sourceScope.paths,['a.txt']);
  assert.equal(nodes.relevantMutation.status,'none-recorded');
  assert.equal(nodes.checkExecution.checks[0].seq,result.verification.checks[0].resultSeq);
  assert.equal(nodes.result.outcomes[0].toolOutcome,'succeeded');
  assert.equal(nodes.currentValidity.status,'supported');
  assert.equal(nodes.deliveryClaim.status,'unknown');
  assert.equal(nodes.humanRequirement.textRetained,false);
});

test('the requirement view keeps gaps, contradictions and stale checks distinct',()=>{
  const gapFixture=reviewedFixture();
  assert.equal(gapFixture.audit().requirements.requirements[0].status,'gap');
  const missFixture=reviewedFixture();
  missFixture.assessment.checks=[recordedCheck(missFixture.f,missFixture.done,'source','misses')];
  assert.equal(missFixture.audit().requirements.requirements[0].status,'gap');
  const staleFixture=reviewedFixture();
  staleFixture.assessment.checks=[recordedCheck(staleFixture.f,staleFixture.done,'source','addresses')];
  staleFixture.assessment.checks[0].coverage[0].scopePaths=['a.txt'];
  staleFixture.assessment.throughSeq=staleFixture.f.events.at(-1).seq;
  staleFixture.f.operation('write',{file_path:'a.txt',content:'changed after check'},'written');
  const stale=staleFixture.audit().requirements.requirements[0];
  assert.equal(stale.status,'stale');
  assert.equal(stale.nodes.currentValidity.reason,'events-after-review');
});

test('the requirement view stays empty without an explicit review and does not infer an undeclared scope',()=>{
  const f=fixture();f.operation('read',{file_path:'a.txt'},'source');
  assert.equal(auditDshSession(f.events).requirements.reason,'no-source-linked-review');
  const reviewed=reviewedFixture();
  reviewed.assessment.checks=[recordedCheck(reviewed.f,reviewed.done,'source','addresses')];
  const row=reviewed.audit().requirements.requirements[0];
  assert.equal(row.nodes.sourceScope.status,'unknown');
  assert.equal(row.nodes.relevantMutation.status,'unknown');
});

test('a successful recorded check that misses a requirement cannot turn a reviewed failure into success',()=>{
  const {f,assessment,audit}=reviewedFixture();
  const check=f.operation('pwsh',{command:'node check_regex.js'},JSON.stringify({exitCode:0,stdout:'16/16'}));
  assessment.throughSeq=f.events.at(-1).seq;assessment.criteria[0].outcome='fail';
  assessment.checks=[recordedCheck(f,check,'source','misses')];
  const original=JSON.stringify(f.events),result=audit();
  assert.equal(result.verification.checks[0].toolOutcome,'succeeded');
  assert.equal(result.verification.missedCriteria,1);assert.equal(result.verification.allListedCriteriaAddressed,false);
  assert.equal(result.taskOutcome,'fail');assert.equal(result.fullSuccessAtBudget.failed,1);
  assert.equal(result.requirements.requirements[0].status,'contradicted');
  assert.equal(JSON.stringify(f.events),original);assert.equal(result.verification.criteria[0].outcome,'fail');
});

test('a failing check can address a risk without proving that its requirement was satisfied',()=>{
  const {f,assessment,audit}=reviewedFixture();
  const check=f.operation('pwsh',{command:'node regression.js'},JSON.stringify({exitCode:1,stdout:'wrong newline'}),{failed:true});
  assessment.throughSeq=f.events.at(-1).seq;assessment.criteria[0].outcome='unknown';
  assessment.checks=[recordedCheck(f,check,'source','addresses')];
  const result=audit();assert.equal(result.verification.checks[0].toolOutcome,'failed');
  assert.equal(result.verification.allListedCriteriaAddressed,true);assert.equal(result.taskOutcome,'unknown');
  assert.equal(result.fullSuccessAtBudget.success,0);assert.equal(result.fullSuccessAtBudget.unknown,1);
  assert.equal(result.requirements.requirements[0].status,'unknown');
});

test('requirement support requires a current review and a successful applicable check',()=>{
  const {f,assessment,audit}=reviewedFixture();
  const failed=f.operation('pwsh',{command:'node regression.js'},JSON.stringify({exitCode:1}),{failed:true});
  assessment.throughSeq=f.events.at(-1).seq;
  assessment.checks=[recordedCheck(f,failed,'source','addresses')];
  assessment.checks[0].coverage[0].scopePaths=['a.txt'];
  assert.notEqual(audit().requirements.requirements[0].status,'supported');

  const passed=f.operation('pwsh',{command:'node regression.js'},JSON.stringify({exitCode:0}));
  assessment.throughSeq=f.events.at(-1).seq;
  assessment.criteria[0].eventSeqs=[passed.resultSeq];
  assessment.checks.push(recordedCheck(f,passed,'source','addresses'));
  assessment.checks[1].coverage[0].scopePaths=['a.txt'];
  assert.equal(audit().requirements.requirements[0].status,'supported');

  assessment.criteria[0].outcome='unknown';
  assert.equal(audit().requirements.requirements[0].status,'unknown');
});

test('a different successful check cannot replace a failed check in the same file scope',()=>{
  const {f,assessment,audit}=reviewedFixture();
  const failed=f.operation('read',{file_path:'a.txt'},'failed',{failed:true});
  const passed=f.operation('read',{file_path:'./a.txt'},'source');
  assessment.throughSeq=f.events.at(-1).seq;
  assessment.criteria[0].eventSeqs=[passed.resultSeq];
  assessment.checks=[recordedCheck(f,failed,'source','addresses'),recordedCheck(f,passed,'source','addresses')];
  for(const check of assessment.checks)check.coverage[0].scopePaths=['a.txt'];
  assert.equal(audit().requirements.requirements[0].status,'unknown');
  const result=f.events.find(event=>event.seq===failed.resultSeq).data.message;
  result.isError=false;result.content=[{type:'text',text:'source'}];
  assert.equal(audit().requirements.requirements[0].status,'supported');
});

test('unknown mutation paths remain visible in the requirement view',()=>{
  const {f,assessment,audit}=reviewedFixture();
  const mutation=f.operation('write',{content:'changed'},'written');
  const check=f.operation('read',{file_path:'a.txt'},'current');
  assessment.throughSeq=f.events.at(-1).seq;
  assessment.criteria[0].eventSeqs=[check.resultSeq];
  assessment.checks=[recordedCheck(f,check,'source','addresses')];
  assessment.checks[0].coverage[0].scopePaths=['a.txt'];
  const node=audit().requirements.requirements[0].nodes.relevantMutation;
  assert.equal(node.status,'unknown');
  assert.ok(node.unresolvedEventSeqs.includes(mutation.resultSeq));
});

test('an unscoped check cannot remain supported after an unclassified mutation',()=>{
  const {f,done,assessment,audit}=reviewedFixture();
  f.operation('write',{file_path:'other.txt',content:'changed'},'written');
  assessment.throughSeq=f.events.at(-1).seq;
  assessment.checks=[recordedCheck(f,done,'source','addresses')];
  assert.equal(audit().requirements.requirements[0].status,'unknown');
});

test('an uncertain settled write cannot preserve check validity without a no-effect result',()=>{
  for(const scoped of [false,true]){
    for(const error of [undefined,true]){
      const {f,done,assessment,audit}=reviewedFixture();
      const write=f.operation('write',{file_path:'a.txt',content:'possibly changed'},'uncertain');
      const result=f.events.find(event=>event.seq===write.resultSeq).data.message;
      result.isError=error;
      assessment.throughSeq=f.events.at(-1).seq;
      assessment.checks=[recordedCheck(f,done,'source','addresses')];
      if(scoped)assessment.checks[0].coverage[0].scopePaths=['a.txt'];
      assert.notEqual(audit().requirements.requirements[0].status,'supported');
      result.content=[{type:'text',text:JSON.stringify({effectState:'none'})}];
      assert.equal(audit().requirements.requirements[0].status,'supported');
    }
  }
});

test('an uncertain write to an unrelated scoped file does not invalidate the check',()=>{
  const {f,done,assessment,audit}=reviewedFixture();
  const write=f.operation('write',{file_path:'other.txt',content:'possibly changed'},'uncertain');
  delete f.events.find(event=>event.seq===write.resultSeq).data.message.isError;
  assessment.throughSeq=f.events.at(-1).seq;
  assessment.checks=[recordedCheck(f,done,'source','addresses')];
  assessment.checks[0].coverage[0].scopePaths=['a.txt'];
  assert.equal(audit().requirements.requirements[0].status,'supported');
});

test('a pending operation started before a check cannot validate an overlapping scope',()=>{
  for(const [name,args,scoped,expected] of [
    ['write',{file_path:'a.txt',content:'new'},true,'stale'],
    ['write',{file_path:'other.txt',content:'new'},true,'supported'],
    ['write',{file_path:'a.txt',content:'new'},false,'unknown'],
    ['run_code',{code:'modifyProject()'},true,'stale'],
    ['run_code',{code:'modifyProject()'},false,'unknown'],
    ['fastedit_java',{file_path:'a.txt',mode:'read'},true,'supported'],
    ['fastedit_java',{file_path:'a.txt',mode:'read'},false,'supported']
  ]){
    const f=fixture();
    f.add('tool/call',{callId:'pending',name,arguments:args});
    const done=f.operation('read',{file_path:'a.txt'},'source');
    const assessment={schema:ASSESSMENT_SCHEMA,sourceId:'recorded-session',throughSeq:done.resultSeq,reviewer:'human',
      allExplicitRequirementsCovered:true,criteria:[{id:'source',requirementSeqs:[1],eventSeqs:[done.resultSeq],outcome:'pass'}],
      checks:[recordedCheck(f,done,'source','addresses')]};
    if(scoped)assessment.checks[0].coverage[0].scopePaths=['a.txt'];
    const row=auditDshSession(f.events,{sourceId:assessment.sourceId,assessment}).requirements.requirements[0];
    assert.equal(row.status,expected,`${name} ${JSON.stringify(args)} scoped=${scoped}`);
  }
});

test('a repeated check is identified independently of argument property order',()=>{
  const {f,assessment,audit}=reviewedFixture();
  const failed=f.operation('read',{file_path:'a.txt',offset:1},'failed',{failed:true});
  const passed=f.operation('read',{offset:1,file_path:'a.txt'},'source');
  assessment.throughSeq=f.events.at(-1).seq;
  assessment.criteria[0].eventSeqs=[passed.resultSeq];
  assessment.checks=[recordedCheck(f,failed,'source','addresses'),recordedCheck(f,passed,'source','addresses')];
  for(const check of assessment.checks)check.coverage[0].scopePaths=['a.txt'];
  assert.equal(audit().requirements.requirements[0].status,'supported');
});

test('a check that misses a requirement does not itself contradict it',()=>{
  const {f,done,assessment,audit}=reviewedFixture();
  assessment.checks=[recordedCheck(f,done,'source','misses')];
  assert.equal(audit().requirements.requirements[0].status,'gap');
});

test('an unsuccessful producer completion cannot support a requirement',()=>{
  const {f,call,result}=processFixture();
  const assessment={schema:ASSESSMENT_SCHEMA,sourceId:'process-source',throughSeq:result.seq,reviewer:'human',allExplicitRequirementsCovered:true,
    criteria:[{id:'source',requirementSeqs:[1],eventSeqs:[result.seq],outcome:'pass'}],
    checks:[{id:'process-check',callSeq:call.seq,resultSeq:result.seq,coverage:[{criterionId:'source',reach:'addresses',reason:'Reviewed operation.'}]}]};
  const audited=auditDshSession(f.events,{sourceId:assessment.sourceId,assessment});
  assert.equal(audited.verification.checks[0].processOutcome,'exited-nonzero');
  assert.notEqual(audited.requirements.requirements[0].status,'supported');
});

test('check review rejects unrelated event pairs, duplicate operation counts and unknown criteria',()=>{
  const {f,done,assessment,audit}=reviewedFixture();
  const other=f.operation('read',{file_path:'another.txt'},'another source');assessment.throughSeq=f.events.at(-1).seq;
  assessment.checks=[recordedCheck(f,done,'source','addresses')];
  assessment.checks[0].resultSeq=other.resultSeq;assert.throws(audit,/exact result/);
  assessment.checks=[recordedCheck(f,done,'missing-criterion','addresses')];assert.throws(audit,/coverage relation/);
  assessment.checks=[recordedCheck(f,done,'source','addresses')];
  assessment.checks.push({...assessment.checks[0],id:'count-again'});assert.throws(audit,/counted twice/);
  assessment.checks.pop();assessment.checks[0].coverage.push({...assessment.checks[0].coverage[0]});assert.throws(audit,/coverage relation/);
});

test('manual label coverage is source-bound and expires with the source',()=>{
  const {f,done,assessment,audit}=reviewedFixture();
  assessment.labelCoverage={Q4:{throughSeq:done.resultSeq,eventSeqs:[done.resultSeq]}};
  let result=audit();
  assert.equal(result.labelCoverage.Q4.manualCoverage,'reviewed');
  assert.deepEqual(result.labelCoverage.Q4.manualEventSeqs,[done.resultSeq]);
  assert.match(result.labelCoverage.Q1.manualCoverage,/unknown/);
  f.operation('read',{file_path:'a.txt'},'new result');result=audit();
  assert.equal(result.labelCoverage.Q4.manualCoverage,'stale');
  assessment.labelCoverage.Q4.eventSeqs=[9999];assert.throws(audit,/Invalid label coverage/);
});

test('outside workspace temporary reads stay source-bound candidates',()=>{
  const {f,audit}=reviewedFixture();
  f.events.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'修复并检查，不要安装依赖、修改pyproject.toml、读取项目外文件、Git写操作或派子代理。'}];
  const code='import tempfile\np=tempfile.mkdtemp()\nopen(p+"/a.env").read()';
  const done=f.operation('work_exec',{runtime:'python',code},'token=do-not-copy C:\\Users\\name\\AppData\\Local\\Temp\\tmp123\\a.env\\r\\n');
  const result=audit();assert.equal(result.constraints.items.length,1);
  const item=result.constraints.items[0];assert.equal(item.resultSeq,done.resultSeq);
  assert.equal(item.evidence.includes('do-not-copy'),false);assert.equal(item.evidence.includes('\\r\\n'),false);
  assert.ok(item.evidence.startsWith('C:'));
  assert.equal(item.classification,'candidate');assert.equal(item.violation,'not-inferred');
  assert.equal(result.taskOutcome,'unknown');
  f.operation('work_exec',{code:'print(42)'},'C:\\Users\\name\\AppData\\Local\\Temp\\tmp456\\a.env');
  assert.equal(audit().constraints.items.length,1);
  const reused=f.operation('work_exec',{scriptRef:'event:'+(done.requestSeq+1)},'completed');
  assert.equal(audit().constraints.items.length,2);
  assert.equal(audit().constraints.items[1].resultSeq,reused.resultSeq);
  f.operation('write',{file_path:'check_set_keys.py',content:code},'written');
  const scripted=f.operation('work_exec',{runtime:'python',code:'import runpy\nrunpy.run_path("check_set_keys.py", run_name="__main__")'},'completed');
  assert.equal(audit().constraints.items.length,3);
  assert.equal(audit().constraints.items[2].resultSeq,scripted.resultSeq);
  const shell=f.operation('pwsh',{command:'& "C:\\runtime\\python.exe" check_set_keys.py'},'completed');
  assert.equal(audit().constraints.items.length,4);
  assert.equal(audit().constraints.items[3].resultSeq,shell.resultSeq);
  f.operation('edit',{file_path:'check_set_keys.py',old_string:'tempfile',new_string:'os'},'edited');
  f.operation('pwsh',{command:'& "C:\\runtime\\python.exe" check_set_keys.py'},'completed');
  assert.equal(audit().constraints.items.length,4,'an edited script cannot inherit the earlier full-write evidence');
  const project=reviewedFixture();
  project.f.events.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'不要读取项目外文件。'}];
  project.f.operation('work_exec',{runtime:'python',code:'import tempfile\ntmp=tempfile.mkdtemp(dir=".")\nopen(tmp+"/a.env").read()'},'completed');
  assert.equal(project.audit().constraints.items.length,0,'an explicit project-local temporary directory is not an outside-read candidate');
});

test('temporary-read evidence ignores trailing secrets and only trusts recorded script effects',()=>{
  const withRequirement=()=>{
    const {f,audit}=reviewedFixture();
    f.events.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'不要读取项目外文件。'}];
    return {f,audit};
  };
  const code='import tempfile\np=tempfile.mkdtemp()\nopen(p+"/a.env").read()';
  {
    const {f,audit}=withRequirement();
    f.operation('work_exec',{runtime:'python',code},'C:\\Users\\name\\AppData\\Local\\Temp\\tmp1\\a.env token=do-not-copy');
    const item=audit().constraints.items[0];
    assert.ok(item.evidence.endsWith('a.env'),JSON.stringify(item.evidence));assert.equal(item.evidence.includes('do-not-copy'),false);
  }
  {
    const {f,audit}=withRequirement();
    f.operation('write',{file_path:'check set keys.py',content:code},'written');
    f.operation('edit',{file_path:'check set keys.py',old_string:'tempfile',new_string:'os'},'failed',{failed:true});
    const shell=f.operation('pwsh',{command:'& "C:\\runtime\\python.exe" "check set keys.py"'},'completed');
    assert.equal(audit().constraints.items.at(-1).resultSeq,shell.resultSeq);
  }
  {
    const {f,audit}=withRequirement();
    f.operation('work_exec',{runtime:'python',code:'import tempfile\np=tempfile.mkdtemp(dir=PROJECT_ROOT.parent)\nopen(p+"/a.env").read()'},'completed');
    assert.equal(audit().constraints.items.length,1,'a variable name does not prove the directory is inside the project');
  }
  {
    const {f,audit}=withRequirement();
    f.operation('work_exec',{runtime:'python',code:'import tempfile\na=tempfile.mkdtemp(dir=".")\nb=tempfile.mkdtemp()\nopen(a+"/a.env").read()'},'completed');
    assert.equal(audit().constraints.items.length,1,'one local call does not exclude the script when another call uses the system temp root');
  }
});

test('an unconfirmed later write does not hide the confirmed script or create a candidate',()=>{
  const {f,audit}=reviewedFixture();
  f.events.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'不要读取项目外文件。'}];
  f.operation('write',{file_path:'check.py',content:'print(42)'},'written');
  const id='unconfirmed-write';
  f.add('tool/call',{callId:id,name:'write',arguments:{file_path:'check.py',content:'import tempfile\np=tempfile.mkdtemp()\nopen(p+"/a.env").read()'}});
  f.add('tool/result',{message:{role:'tool',source:{callId:id},content:[{type:'text',text:'not confirmed'}]}});
  f.operation('pwsh',{command:'& "C:\\runtime\\python.exe" check.py'},'completed');
  assert.equal(audit().constraints.items.length,0);
});

test('a pwsh call without script text does not abort the audit',()=>{
  const {f,audit}=reviewedFixture();
  f.events.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'不要读取项目外文件。'}];
  f.operation('pwsh',{},'completed');
  assert.doesNotThrow(()=>audit());
  assert.equal(audit().constraints.items.length,0);
});

test('temporary-read evidence keeps Windows path segments beginning with n or r',()=>{
  const {f,audit}=reviewedFixture();
  f.events.find(event=>event.type==='user/message').data.message.content=[{type:'text',text:'不要读取项目外文件。'}];
  const code='import tempfile\np=tempfile.mkdtemp()\nopen(p+"/a.env").read()';
  const resultPath='C:\\Users\\name\\AppData\\Local\\Temp\\tmp123\\node_modules\\pkg\\new\\reports\\a.env\\r\\n';
  f.operation('work_exec',{runtime:'python',code},resultPath);
  const evidence=audit().constraints.items[0].evidence;
  assert.ok(evidence.endsWith('node_modules\\pkg\\new\\reports\\a.env'),evidence);
  assert.equal(evidence.includes('\\r\\n'),false);
});

test('change scope reviews retain unsupported and unknown declarations without a requirement source',()=>{
  const {f,assessment,audit}=reviewedFixture(),done=f.operation('edit',{file_path:'a.txt',old_string:'old',new_string:'new'},'applied');
  assessment.throughSeq=f.events.at(-1).seq;
  const call=normalizeDshEvents(f.events).calls.find(row=>row.resultSeq===done.resultSeq);
  assessment.scopeReviews=[{id:'unsupported-change',callSeq:call.callSeq,resultSeq:done.resultSeq,path:'a.txt',
    declaredRelation:'unsupported',requirementSeqs:[],dependencyEvidenceSeqs:[],reviewer:'human',
    reason:'No requirement or dependency basis was supplied.',counterexample:'A later source could establish a necessary dependency.'}];
  let result=audit();
  assert.equal(result.changeScopeReviews.items[0].relation,'unsupported');
  assert.equal(result.changeScopeReviews.items[0].violation,'not-inferred');
  assessment.scopeReviews[0].declaredRelation='direct-requirement';
  assert.throws(audit,/Invalid change-scope review/);
  assessment.scopeReviews[0].declaredRelation='unknown';result=audit();
  assert.equal(result.changeScopeReviews.items[0].relation,'unknown');
  assessment.scopeReviews[0].declaredRelation='unsupported';assessment.scopeReviews[0].requirementSeqs=[1];result=audit();
  assert.equal(result.changeScopeReviews.items[0].declaredRelation,'unsupported');
  assert.equal(result.changeScopeReviews.items[0].relation,'unknown');
  assert.ok(result.changeScopeReviews.items[0].unknownReasons.includes('conflicting-support-basis'));
});

test('change scope review status becomes stale when the source advances',()=>{
  const {f,assessment,audit}=reviewedFixture(),done=f.operation('edit',{file_path:'a.txt',old_string:'old',new_string:'new'},'applied');
  assessment.throughSeq=done.resultSeq;
  const call=normalizeDshEvents(f.events).calls.find(row=>row.resultSeq===done.resultSeq);
  assessment.scopeReviews=[{id:'scoped-change',callSeq:call.callSeq,resultSeq:done.resultSeq,path:'a.txt',
    declaredRelation:'direct-requirement',requirementSeqs:[1],dependencyEvidenceSeqs:[],reviewer:'human',
    reason:'The user requested this file change.',counterexample:'A later operation can change its current applicability.'}];
  assert.equal(audit().changeScopeReviews.status,'reviewed');
  f.operation('read',{file_path:'a.txt'},'new source');
  const result=audit().changeScopeReviews;
  assert.equal(result.status,'stale');assert.equal(result.items[0].declaredRelation,'direct-requirement');
  assert.equal(result.items[0].relation,'direct-requirement');
});

test('new operations and damaged source preserve declared check coverage but make effective reach unknown',()=>{
  const {f,done,assessment,audit}=reviewedFixture();assessment.checks=[recordedCheck(f,done,'source','addresses')];
  let result=auditDshSession(f.events,{sourceId:assessment.sourceId,assessment,problems:[{line:4,reason:'invalid-json-row'}]});
  assert.equal(result.verification.status,'incomplete-source');assert.equal(result.verification.unknownCriteria,1);
  assert.equal(result.verification.checks[0].coverage[0].unavailableReason,'incomplete-source');
  f.operation('write',{file_path:'a.txt',content:'later source'},'written');result=audit();
  assert.equal(result.verification.status,'stale');assert.equal(result.verification.allListedCriteriaAddressed,false);
  assert.equal(result.verification.checks[0].coverage[0].declaredReach,'addresses');
  assert.equal(result.verification.checks[0].coverage[0].unavailableReason,'events-after-review');
});

test('a scoped source change after a check downgrades only that coverage relation',()=>{
  const {f,assessment,audit}=reviewedFixture();
  const check=f.operation('pwsh',{command:'node check.js'},JSON.stringify({exitCode:0}));
  f.operation('write',{file_path:'src/main.py',content:'changed'},'written');
  assessment.throughSeq=f.events.at(-1).seq;
  assessment.checks=[recordedCheck(f,check,'source','addresses')];
  assessment.checks[0].coverage[0].scopePaths=['src/main.py'];
  let result=audit();
  assert.equal(result.verification.checks[0].coverage[0].reach,'unknown');
  assert.equal(result.verification.checks[0].coverage[0].declaredReach,'addresses');
  assert.equal(result.verification.checks[0].coverage[0].unavailableReason,'file-changed-after-check');
  assert.equal(result.verification.allListedCriteriaAddressed,false);
  assessment.checks[0].coverage[0].scopePaths=['src/other.py'];
  result=audit();assert.equal(result.verification.checks[0].coverage[0].reach,'addresses');
});

test('later opaque execution and unscoped changes cannot preserve a current scoped coverage claim',()=>{
  const {f,assessment,audit}=reviewedFixture();
  const check=f.operation('pwsh',{command:'node check.js'},JSON.stringify({exitCode:0}));
  f.add('tool/call',{callId:'later',name:'write',arguments:{file_path:'src/main.py',content:'changed'}});
  assessment.throughSeq=f.events.at(-1).seq;assessment.checks=[recordedCheck(f,check,'source','addresses')];
  assessment.checks[0].coverage[0].scopePaths=['src/main.py'];
  assert.equal(audit().verification.checks[0].coverage[0].unavailableReason,'unsettled-mutation');
  assessment.checks[0].coverage[0].scopePaths=[];
  assert.equal(audit().verification.checks[0].coverage[0].unavailableReason,'file-scope-unresolved');
  assessment.checks[0].coverage[0].scopePaths=['src/main.py'];f.operation('run_code',{code:'modifyProject()'},'done');
  assessment.throughSeq=f.events.at(-1).seq;
  assert.deepEqual(audit().verification.checks[0].coverage[0].unavailableReasons,['opaque-execution-after-check','unsettled-mutation']);
});

test('partial check output and a later requirement cannot inherit a complete check coverage claim',()=>{
  const {f,done,assessment,audit}=reviewedFixture();
  const check=f.operation('pwsh',{command:'node partial.js'},JSON.stringify({exitCode:0,stdout:'ok',truncated:true}));
  assessment.throughSeq=f.events.at(-1).seq;assessment.checks=[recordedCheck(f,check,'source','addresses')];
  let result=audit();assert.equal(result.verification.checks[0].coverage[0].unavailableReason,'incomplete-check-result');
  const added=f.add('user/message',{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Now also support Windows.'}]}});
  assessment.throughSeq=added.seq;assessment.criteria[0].requirementSeqs.push(added.seq);
  assessment.checks=[recordedCheck(f,done,'source','addresses')];result=audit();
  assert.equal(result.verification.checks[0].coverage[0].unavailableReason,'check-before-linked-requirement');
  assert.equal(result.verification.unknownCriteria,1);
});

test('nested check review preserves delivery uncertainty and unreviewed requirements remain unknown',()=>{
  const {f,assessment,audit}=reviewedFixture();
  const check=f.operation('read',{file_path:'a.txt'},'source',{nested:true});
  assessment.throughSeq=f.events.at(-1).seq;assessment.checks=[recordedCheck(f,check,'source','addresses')];
  assessment.criteria.push({id:'another-requirement',requirementSeqs:[1],eventSeqs:[],outcome:'unknown'});
  const result=audit(),observed=result.verification.checks[0];
  assert.equal(observed.nested,true);assert.equal(observed.deliveryVisibility,'not-inferred-from-inner-return');
  assert.equal(observed.enclosingOutcome,'succeeded');assert.equal(result.verification.addressedCriteria,1);
  assert.equal(result.verification.unknownCriteria,1);assert.equal(result.verification.allListedCriteriaAddressed,false);
  delete assessment.checks;const unreviewed=audit();assert.equal(unreviewed.verification.status,'not-reviewed');
  assert.equal(unreviewed.verification.unknownCriteria,2);assert.equal(unreviewed.taskOutcome,'unknown');
});

function processFixture({variation=null,body='[exit code: 1]'}={}){
  const f=fixture(),call=f.add('tool/call',{callId:'native-call',name:'pwsh',arguments:{command:'node check.js'}});
  const job={jobId:'native-job',owner:'session-a',kind:'pwsh',toolCall:{callId:'native-call',rootCallId:'native-call'}};
  const registered=f.add('job/registered',job),end={...job,status:'completed',cause:'producer',producerReported:true,detail:'exit code: 1'};
  if(variation==='owner')end.owner='session-b';
  if(variation==='caller')end.toolCall={...end.toolCall,callId:'different-call'};
  if(variation==='producer')end.producerReported=false;
  if(variation==='status'){end.status='failed';end.detail='exit code: 0';}
  const settled=f.add('job/settled',end);
  if(variation==='duplicate')f.add('job/settled',end);
  const result=f.add('tool/result',{message:{role:'tool',source:{callId:'native-call'},content:[{type:'text',text:body}],isError:false}});
  return {f,call,registered,settled,result};
}

test('producer completion separates a successful tool return from a failed command',()=>{
  const {f,registered,settled}=processFixture(),call=normalizeDshEvents(f.events).calls[0];
  assert.equal(call.toolOutcome,'succeeded');assert.equal(call.outcome,'failed');assert.equal(call.processOutcome,'exited-nonzero');
  assert.equal(call.exitCode,1);assert.equal(call.completionObservation.registrationSeq,registered.seq);
  assert.equal(call.completionObservation.seq,settled.seq);
});

test('process outcome does not come from printable exit text or unrelated or inconsistent producer events',()=>{
  for(const variation of ['owner','caller','producer','status','duplicate']){
    const {f}=processFixture({variation}),call=normalizeDshEvents(f.events).calls[0];
    assert.equal(call.processOutcome,'unknown',variation);assert.equal(call.exitCode,null,variation);
    assert.equal(call.completionObservation,undefined,variation);
  }
});

test('contradictory structured and producer exit codes invalidate a supplied coverage claim',()=>{
  const {f,call,result}=processFixture({body:JSON.stringify({exitCode:0,stdout:'OK'})});
  const assessment={schema:ASSESSMENT_SCHEMA,sourceId:'process-source',throughSeq:result.seq,reviewer:'human',allExplicitRequirementsCovered:true,
    criteria:[{id:'source',requirementSeqs:[1],eventSeqs:[result.seq],outcome:'pass'}],
    checks:[{id:'process-check',callSeq:call.seq,resultSeq:result.seq,coverage:[{criterionId:'source',reach:'addresses',reason:'The declared result was reviewed.'}]}]};
  const audited=auditDshSession(f.events,{sourceId:assessment.sourceId,assessment});
  assert.ok(audited.problems.some(item=>item.reason==='contradictory-process-exit-code'));
  assert.equal(audited.taskOutcome,'unknown');assert.equal(audited.verification.unknownCriteria,1);
  assert.equal(audited.verification.checks[0].processOutcome,'unknown');
});

test('projection forecast and adjacent main usage stay separate from causal refill attribution',()=>{
  const event=(seq,type,data)=>({seq,type,data});
  const request=(seq,effort='low',input=100,cacheRead=800,cacheWrite=0)=>event(seq,'assistant/message',{turn:1,step:seq,
    usage:{inputTokens:input,cacheReadTokens:cacheRead,cacheWriteTokens:cacheWrite,outputTokens:10,totalTokens:input+cacheRead+cacheWrite+10},
    stream:[{type:'chunk',chunk:{type:'finish',reason:{kind:'stop'}}}]});
  const route=(seq,effort='low')=>event(seq,'request/header',{header:{config:{provider:'local',model:'deepseek-v4.1-flash',reasoningEffort:effort}}});
  const projection=event(2,'user/message',{message:{role:'user',source:{kind:'work-evidence-working-set',workingSet:{action:'project',
    decision:{savedTokensEstimate:300,cachedSuffixTokensEstimate:200,refillCostEstimate:0.0001,currency:'USD',cachedExposureMethod:'recorded forecast',
      route:{provider:'local',model:'deepseek-v4.1-flash',reasoningEffort:'low'}},candidateAssessment:{eligible:2,plansEvaluated:1}}}}});
  const events=[route(.5),request(1),projection,route(2.5),request(3,'low',500,400,50)];
  events[1].data.turn=1;events[4].data.turn=1;
  const accounting={schema:'work-evidence.session-request-accounting.v1',sessionId:null,throughSeq:3,nativeRequests:2,
    requests:[{requestId:'before',requestKind:'main',sourceSeq:1,complete:true},{requestId:'applied',requestKind:'main',sourceSeq:3,complete:true}],
    mainRequestLinks:[{requestId:'before',sourceSeq:1,projectionObservation:null},{requestId:'applied',sourceSeq:3,
      projectionObservation:{status:'matched',planSeq:2,planMessageId:null,resultSeqs:[1],reason:null}}]};
  events[2].data.message.id='projection-plan';
  accounting.mainRequestLinks[1].projectionObservation.planMessageId='projection-plan';
  const result=auditCacheTransitions(events);
  assert.equal(result.compared,0);assert.equal(result.unknown,1);assert.equal(result.items[0].predicted.refillTokens,200);
  assert.equal(result.items[0].reasons.includes('applied-request-identity-unrecorded'),true);
  assert.equal(result.items[0].observed,null);
  assert.equal(result.items[0].attribution,'not-established');
  events[3]=route(2.5,'max');
  events[4]=request(3,'max',500,400,50);
  assert.equal(auditCacheTransitions(events,accounting).items[0].reasons.includes('route-or-effort-changed'),true);
  events.splice(3,1,event(2.5,'user/message',{message:{role:'user',source:{kind:'work-evidence-working-set',workingSet:{action:'project'}}}}));
  events[4]=request(3,'low',500,400,50);
  assert.equal(auditCacheTransitions(events).items[0].reasons.includes('multiple-rewrites-before-next-main'),true);
  const auxiliaryAccounting={requests:[{requestId:'auxiliary',requestKind:'auxiliary',sourceSeq:3,complete:true}]};
  assert.equal(auditCacheTransitions([request(1),projection,request(3,'low',500,400,50)],auxiliaryAccounting).items[0].observed,null);
});

test('projection plans must resolve to their original tool results',()=>{
  const event=(seq,type,data)=>({seq,type,data});
  const request=(seq,input,cacheRead,cacheWrite)=>event(seq,'assistant/message',{turn:1,step:seq,
    usage:{inputTokens:input,cacheReadTokens:cacheRead,cacheWriteTokens:cacheWrite,outputTokens:10},
    stream:[{type:'chunk',chunk:{type:'finish',reason:{kind:'stop'}}}]});
  const route=seq=>event(seq,'request/header',{header:{config:{provider:'local',model:'deepseek-v4.1-flash',reasoningEffort:'low'}}});
  const original=event(2,'tool/result',{message:{id:'result-original',role:'tool',source:{callId:'source-call'},content:[{type:'text',text:'source'}]}});
  const projection=event(3,'user/message',{message:{id:'projection-plan',role:'user',source:{kind:'work-evidence-working-set',workingSet:{version:1,action:'project',
    entries:[{seq:2,id:'result-original'}],decision:{route:{provider:'local',model:'deepseek-v4.1-flash',reasoningEffort:'low'}}}}}});
  const events=[route(0),request(1,100,800,0),original,projection,route(4),request(5,500,400,50)];
  const accounting={requests:[{requestId:'before',requestKind:'main',sourceSeq:1,complete:true},{requestId:'applied',requestKind:'main',sourceSeq:5,complete:true}],
    mainRequestLinks:[{requestId:'before',sourceSeq:1,projectionObservation:null},{requestId:'applied',sourceSeq:5,
      projectionObservation:{status:'matched',planSeq:3,planMessageId:'projection-plan',resultSeqs:[2],reason:null}}]};
  const valid=auditCacheTransitions(events,accounting).items[0];
  assert.equal(valid.resultScope,'full-plan');assert.equal(valid.observationKind,'projection-matched');assert.equal(valid.plannedResultCount,1);
  assert.equal(valid.applicationOrder,'first-recorded-projection');assert.deepEqual(valid.reasons,[]);
  for(const invalidate of [
    plan=>{delete plan.version;},plan=>{plan.version=2;},plan=>{plan.entries=[];},
    plan=>{plan.entries[0].id='different-result';},plan=>{plan.entries[0].id=null;},plan=>{plan.entries[0].seq=1;},
  ]){
    const invalid=structuredClone(events),plan=invalid[3].data.message.source.workingSet;invalidate(plan);
    const item=auditCacheTransitions(invalid,accounting).items[0];
    assert.equal(item.resultScope,'unknown');assert.equal(item.observationKind,'projection-observation-unknown');
    assert.equal(item.projectedResultSeqs.length,0);assert.ok(item.reasons.includes('projection-plan-or-results-unmatched'));
  }
});

test('change scope dependency evidence must precede the reviewed operation',()=>{
  const {f,assessment,audit}=reviewedFixture(),done=f.operation('edit',{file_path:'a.txt',old_string:'old',new_string:'new'},'applied');
  assessment.throughSeq=f.events.at(-1).seq;
  const call=normalizeDshEvents(f.events).calls.find(row=>row.resultSeq===done.resultSeq);
  assessment.scopeReviews=[{id:'dependency-change',callSeq:call.callSeq,resultSeq:done.resultSeq,path:'a.txt',
    declaredRelation:'necessary-dependency',requirementSeqs:[],dependencyEvidenceSeqs:[1],reviewer:'human',
    reason:'The earlier requirement established the dependency.',counterexample:'Another implementation might not need it.'}];
  assert.equal(audit().changeScopeReviews.items[0].relation,'necessary-dependency');
  assessment.scopeReviews[0].dependencyEvidenceSeqs=[];
  const missing=audit().changeScopeReviews.items[0];
  assert.equal(missing.relation,'unknown');assert.ok(missing.unknownReasons.includes('dependency-evidence-missing'));
  assessment.scopeReviews[0].dependencyEvidenceSeqs=[call.callSeq];assert.throws(audit,/Invalid change-scope review/);
  assessment.scopeReviews[0].dependencyEvidenceSeqs=[done.resultSeq];assert.throws(audit,/Invalid change-scope review/);
});

test('an unobserved file effect does not also claim a non-unique effect',()=>{
  const {f,assessment,audit}=reviewedFixture(),done=f.operation('run_code',{code:'writeFile()'},'files written');
  assessment.throughSeq=f.events.at(-1).seq;
  const call=normalizeDshEvents(f.events).calls.find(row=>row.resultSeq===done.resultSeq);
  assessment.scopeReviews=[{id:'opaque-change',callSeq:call.callSeq,resultSeq:done.resultSeq,path:'a.txt',
    declaredRelation:'unknown',requirementSeqs:[],dependencyEvidenceSeqs:[],reviewer:'human',
    reason:'The program did not expose its file effects.',counterexample:'The file may not have been written.'}];
  const reasons=audit().changeScopeReviews.items[0].unknownReasons;
  assert.ok(reasons.includes('no-recorded-file-effect'));
  assert.equal(reasons.includes('file-effect-not-unique'),false);
  assert.equal(reasons.includes('file-effect-unconfirmed'),false);
});

test('temporary directory paths are normalized before deciding they are project-local', () => {
  for (const [dir, expected] of [['./../outside', 1], ['safe/../../../outside', 1], ['a/../../b', 1], ['..\\outside', 1],
    ['.', 0], ['safe/..', 0], ['safe/../inside', 0], ['sub/dir', 0]]) {
    const {f, audit} = reviewedFixture();
    f.events.find(event => event.type === 'user/message').data.message.content = [{type: 'text', text: '不要读取项目外文件。'}];
    const code = 'import tempfile\ntmp=tempfile.mkdtemp(dir=' + JSON.stringify(dir) + ')\nopen(tmp+"/a.env").read()';
    f.operation('work_exec', {runtime: 'python', code}, 'completed');
    assert.equal(audit().constraints.items.length, expected, dir);
  }
});
