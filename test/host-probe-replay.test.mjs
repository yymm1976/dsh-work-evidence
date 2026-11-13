import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost as baseStartHost,text,tool} from './helpers/host.mjs';
import {defaults} from '../runtime.mjs';
import {createExecutionEvidence} from '../execution-evidence.mjs';

const shell=process.platform==='win32'?'pwsh':'bash';
const startHost=options=>baseStartHost({...options,...(process.platform==='win32'?{}:
  {mountShell:false,extraMounts:[['dsh-bash-local',{}],['dsh-tool-bash',{}]]})});
const quote=value=>"'"+value.replaceAll("'",process.platform==='win32'?"''":"'\\''")+"'";
const code='console.log(JSON.stringify(JSON.parse(require("node:fs").readFileSync("value.json","utf8"))));';
const command=(process.platform==='win32'?'& ':'')+quote(process.execPath)+' -e '+quote(code);
const plan={question:'Does the current project value equal the specified answer?',tool:shell,arguments:{command,description:'Read the current project value'},
  sources:['value.json'],cases:[{name:'answer',pointer:'/answer',expectedJson:'42'}]};
const results=host=>host.events.filter(event=>event.type==='tool/result').map(event=>JSON.parse(event.data.message.content.map(block=>block.text??'').join('')));

test('probe replay is an explicit opt-in',()=>{
  assert.equal(defaults().probeReplay,false);
  assert.throws(()=>defaults({probeReplay:'yes'}),/Invalid probeReplay/u);
});

test('probe replay restores the original command and expectation after the observed file changes',async()=>{
  let first;
  const host=await startHost({pluginConfig:{probeReplay:true,toolSurface:'full',stepPacing:false},script:async(options,n)=>{
    if(n===1)return [tool('work_probe',plan)];
    if(n===2){first=JSON.parse(options.messages.findLast(message=>message.role==='tool').content[0].text);
      await fs.writeFile(path.join(host.cwd,'value.json'),' {"answer":42} ');
      return [tool('work_probe',{mode:'replay',id:first.id})];}
    return [text('done')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'value.json'),'{"answer":7}');
    const agent=await host.createAgent('max');await host.send(agent,'Check the supplied condition, then repeat the original check after the implementation changes.');
    const rows=results(host);assert.equal(rows.length,2);
    assert.equal(first.status,'different');assert.equal(first.cases[0].actualJson,'7');
    assert.equal(rows[1].status,'observed');assert.equal(rows[1].cases[0].status,'matched');
    assert.equal(rows[1].cases[0].expectedJson,'42');assert.equal(rows[1].replayOf.id,first.id);
    assert.equal(rows[1].replayOf.expectations,'unchanged');
    assert.notEqual(rows[1].id,first.id);
    const detail=await host.command(agent,'detail');
    assert.equal(detail.taskFlow.unresolvedErrors.some(item=>item.tool==='work_probe'),false,JSON.stringify({errors:detail.taskFlow.unresolvedErrors,observations:rows}));
  }finally{await host.close();}
});

test('editing a saved record cannot alter the executable replay recipe or expected value',async()=>{
  let first;
  const host=await startHost({pluginConfig:{probeReplay:true,toolSurface:'full',stepPacing:false},script:async(options,n)=>{
    if(n===1)return [tool('work_probe',plan)];
    if(n===2){first=JSON.parse(options.messages.findLast(message=>message.role==='tool').content[0].text);
      const record=path.join(host.cwd,'.dsh','work-evidence','probes',first.retrieveOriginal?.arguments?.sessionId??agent.session.id,first.id+'.json');
      const saved=JSON.parse(await fs.readFile(record,'utf8'));
      saved.arguments.command='a fabricated command that must not be dispatched';saved.requestedCases[0].expectedJson='7';
      await fs.writeFile(record,JSON.stringify(saved));
      return [tool('work_probe',{mode:'replay',id:first.id})];}
    return [text('done')];
  }});
  let agent;
  try{
    await fs.writeFile(path.join(host.cwd,'value.json'),'{"answer":7}');
    agent=await host.createAgent('max');await host.send(agent,'Run the explicit check and repeat its exact recorded inputs.');
    const rows=results(host);assert.equal(rows.length,2);
    assert.equal(rows[1].status,'different');assert.equal(rows[1].cases[0].expectedJson,'42');
    assert.equal(rows[1].cases[0].actualJson,'7');
  }finally{await host.close();}
});

test('a new passing expectation for the same question does not clear the original failed check',async()=>{
  const host=await startHost({pluginConfig:{probeReplay:true,toolSurface:'full',stepPacing:false},script:(_options,n)=>{
    if(n===1)return [tool('work_probe',plan)];
    if(n===2)return [tool('work_probe',{...plan,cases:[{...plan.cases[0],expectedJson:'7'}]})];
    return [text('done')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'value.json'),'{"answer":7}');
    const agent=await host.createAgent('max');await host.send(agent,'Observe both explicitly supplied checks without treating their different expectations as equivalent.');
    const rows=results(host);assert.equal(rows[0].status,'different');assert.equal(rows[1].status,'observed');
    const detail=await host.command(agent,'detail');
    assert.ok(detail.taskFlow.unresolvedErrors.some(item=>item.probeRootId===rows[0].id));
    assert.equal(detail.taskFlow.unresolvedErrors.some(item=>item.probeRootId===rows[1].id),false);
  }finally{await host.close();}
});

test('probe replay rejects input overrides, foreign ids and disabled execution',async()=>{
  const host=await startHost({pluginConfig:{probeReplay:true,toolSurface:'full',stepPacing:false},script:(_options,n)=>n===1?[tool('work_probe',plan)]:[text('done')]});
  try{
    await fs.writeFile(path.join(host.cwd,'value.json'),'{"answer":7}');
    const agent=await host.createAgent('max');await host.send(agent,'Run the explicit check.');
    const first=results(host)[0];
    const invoke=async(current,args,id)=>host.ctx.tools.execute({name:'work_probe',arguments:args,agent:current,callId:id,rootCallId:id,signal:AbortSignal.timeout(30000)});
    const changed=await invoke(agent,{mode:'replay',id:first.id,cases:[]},'override-refused');
    assert.equal(changed.isError,true);assert.match(changed.content[0].text,/cannot be overridden/u);
    const foreign=await host.createAgent('max'),missing=await invoke(foreign,{mode:'replay',id:first.id},'foreign-refused');
    assert.equal(missing.isError,true);assert.match(missing.content[0].text,/from this session/u);
    await host.command(agent,'feature probeReplay off');
    const disabled=await invoke(agent,{mode:'replay',id:first.id},'disabled-refused');
    assert.equal(disabled.value.status,'disabled');assert.equal(disabled.value.executionOccurred,false);
  }finally{await host.close();}
});

test('a replayed Shell check obeys the current read-only boundary',async()=>{
  const host=await startHost({pluginConfig:{probeReplay:true,toolSurface:'full',stepPacing:false},script:(_options,n)=>n===1?[tool('work_probe',plan)]:[text('done')]});
  try{
    await fs.writeFile(path.join(host.cwd,'value.json'),'{"answer":7}');
    const agent=await host.createAgent('max');await host.send(agent,'Run the explicit check.');
    const id=results(host)[0].id;agent.session.append('sandbox/mode',{mode:'read-only',workspaceRoot:host.cwd});
    const result=await host.ctx.tools.execute({name:'work_probe',arguments:{mode:'replay',id},agent,
      callId:'readonly-replay',rootCallId:'readonly-replay',signal:AbortSignal.timeout(30000)});
    assert.equal(result.value.executionOccurred,false);assert.equal(result.value.reason,'native-read-only-session');
  }finally{await host.close();}
});

test('a pending background probe cannot be duplicated through replay',async()=>{
  let nativeCalls=0;
  const host=await startHost({pluginConfig:{probeReplay:true,toolSurface:'full',stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('work_probe',plan)];
    if(n===2){const first=JSON.parse(options.messages.findLast(message=>message.role==='tool').content[0].text);
      return [tool('work_probe',{mode:'replay',id:first.id})];}
    return [text('done')];
  }});
  try{
    const agent=await host.createAgent('max'),original=host.ctx.tools.get(shell,agent);
    agent.ctx.tools.register({...original,execute:async()=>{
      nativeCalls++;
      return {kind:'promoted',cwd:host.cwd,jobId:'fixture-pending-job',timeoutMs:10000,output:''};
    }});
    await host.send(agent,'Run the supplied check and inspect its replay availability.');
    assert.equal(nativeCalls,1);
    const last=host.events.findLast(event=>event.type==='tool/result').data.message;
    assert.match(last.content.map(block=>block.text??'').join(''),/original job id/u);
  }finally{await host.close();}
});

test('a matching replay cannot clear the original failure while a declared file changes during execution',async()=>{
  let nativeCalls=0;
  const host=await startHost({pluginConfig:{probeReplay:true,toolSurface:'full',stepPacing:false},script:async(options,n)=>{
    if(n===1)return [tool('work_probe',plan)];
    if(n===2){const first=JSON.parse(options.messages.findLast(message=>message.role==='tool').content[0].text);
      await fs.writeFile(path.join(host.cwd,'value.json'),'{"answer":42}');
      return [tool('work_probe',{mode:'replay',id:first.id})];}
    return [text('done')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'value.json'),'{"answer":7}');
    const agent=await host.createAgent('max'),original=host.ctx.tools.get(shell,agent);
    agent.ctx.tools.register({...original,execute:async(args,exec)=>{
      const result=await original.execute(args,exec);nativeCalls++;
      if(nativeCalls===2)await fs.writeFile(path.join(host.cwd,'value.json'),'{"answer":99}');
      return result;
    }});
    await host.send(agent,'Observe the check and repeat it after the implementation changes.');
    const rows=results(host);assert.equal(rows.length,2);assert.equal(rows[1].status,'observed');
    assert.equal(rows[1].cases[0].status,'matched');assert.equal(rows[1].evidenceValidity,'affected');
    const detail=await host.command(agent,'detail');
    assert.ok(detail.taskFlow.unresolvedErrors.some(item=>item.probeRootId===rows[0].id));
  }finally{await host.close();}
});

test('a background descendant blocks another replay of its initially completed root',async()=>{
  let nativeCalls=0,rootId;
  const host=await startHost({pluginConfig:{probeReplay:true,toolSurface:'full',stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('work_probe',plan)];
    if(n===2){rootId=JSON.parse(options.messages.findLast(message=>message.role==='tool').content[0].text).id;return [tool('work_probe',{mode:'replay',id:rootId})];}
    if(n===3)return [tool('work_probe',{mode:'replay',id:rootId})];
    return [text('done')];
  }});
  try{
    const agent=await host.createAgent('max'),original=host.ctx.tools.get(shell,agent);
    agent.ctx.tools.register({...original,execute:async()=>{
      nativeCalls++;
      return nativeCalls===1?{kind:'foreground',cwd:host.cwd,exitCode:0,signal:null,timedOut:false,aborted:false,timeoutMs:10000,
        stdout:{text:'{"answer":7}',truncated:false},stderr:{text:'',truncated:false}}:
        {kind:'promoted',cwd:host.cwd,jobId:'fixture-descendant-job',timeoutMs:10000,output:''};
    }});
    await host.send(agent,'Run the check and explicitly request replay while retaining the original job state.');
    assert.equal(nativeCalls,2);
    const last=host.events.findLast(event=>event.type==='tool/result').data.message;
    assert.match(last.content.map(block=>block.text??'').join(''),/background replay/u);
  }finally{await host.close();}
});

for(const producerReported of [true,false])test('a background root resumes only after its producer settlement: '+producerReported,async()=>{
  let nativeCalls=0,registration;
  const host=await startHost({pluginConfig:{probeReplay:true,toolSurface:'full',stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('work_probe',{...plan,sources:[]})];
    if(n===2){const first=JSON.parse(options.messages.findLast(message=>message.role==='tool').content[0].text);
      agent.session.append('job/settled',{...registration,status:'completed',detail:'exit code: 0',cause:'producer',producerReported});
      return [tool('work_probe',{mode:'replay',id:first.id})];}
    return [text('done')];
  }});
  let agent;
  try{
    agent=await host.createAgent('max');const original=host.ctx.tools.get(shell,agent);
    agent.ctx.tools.register({...original,execute:async(_args,exec)=>{
      nativeCalls++;
      if(nativeCalls===1){
        registration={jobId:'fixture-settled-job',owner:agent.session.id,kind:shell,toolCall:{callId:exec.callId,rootCallId:exec.rootCallId??exec.callId}};
        agent.session.append('job/registered',registration);
        return {kind:'promoted',cwd:host.cwd,jobId:registration.jobId,timeoutMs:10000,output:''};
      }
      return {kind:'foreground',cwd:host.cwd,exitCode:0,signal:null,timedOut:false,aborted:false,timeoutMs:10000,
        stdout:{text:'{"answer":42}',truncated:false},stderr:{text:'',truncated:false}};
    }});
    await host.send(agent,'Observe the original background check and its recorded settlement before requesting the same check again.');
    assert.equal(nativeCalls,producerReported?2:1);
    const last=host.events.findLast(event=>event.type==='tool/result').data.message.content.map(block=>block.text??'').join('');
    if(producerReported)assert.equal(JSON.parse(last).status,'observed');
    else assert.match(last,/original job id/u);
  }finally{await host.close();}
});

test('concurrent replay calls cannot dispatch the same original check twice',async()=>{
  const host=await startHost({pluginConfig:{probeReplay:true,toolSurface:'full',stepPacing:false},script:(_options,n)=>n===1?[tool('work_probe',plan)]:[text('done')]});
  try{
    await fs.writeFile(path.join(host.cwd,'value.json'),'{"answer":7}');
    const agent=await host.createAgent('max');await host.send(agent,'Run the original check.');
    const id=results(host)[0].id,original=host.ctx.tools.get(shell,agent);let dispatches=0;
    agent.ctx.tools.register({...original,execute:async(args,exec)=>{
      dispatches++;await new Promise(resolve=>setTimeout(resolve,30));return original.execute(args,exec);
    }});
    const replay=callId=>host.ctx.tools.execute({name:'work_probe',arguments:{mode:'replay',id},agent,callId,rootCallId:callId,signal:AbortSignal.timeout(30000)});
    const values=await Promise.all([replay('concurrent-one'),replay('concurrent-two')]);
    assert.equal(dispatches,1);
    assert.equal(values.filter(value=>value.value?.reason==='probe-replay-in-flight').length,1);
  }finally{await host.close();}
});

test('an older pending replay cannot release a newer invocation lock',async()=>{
  const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
  const pendingSaved=deferred(),releasePending=deferred(),secondStarted=deferred(),releaseSecond=deferred();
  const log=[],session={id:'replay-lock-owner',log,get seq(){return log.length;},
    append(type,data){log.push({seq:log.length,type,data});}},agent={session};
  const state={id:session.id,root:process.cwd(),dir:process.cwd(),config:{executionTriage:true,probeReplay:true}};
  const runtime={init:async()=>state,get:()=>state,execFor:()=>({}),save:async(_agent,_path,source)=>{
    if(JSON.parse(source).observation.background){pendingSaved.resolve();await releasePending.promise;}
  }};
  let dispatches=0,registration;
  const foreground=()=>({value:{kind:'foreground',exitCode:0,stdout:{text:'{}',truncated:false},stderr:{text:'',truncated:false}}});
  const evidence=createExecutionEvidence({tools:{get:()=>({})},get:()=>null},runtime,async()=>{
    dispatches++;
    if(dispatches===2){
      registration={jobId:'replay-owner-job',owner:session.id,kind:shell,
        toolCall:{callId:'inner-pending',rootCallId:'outer-pending'}};
      session.append('job/registered',registration);
      return {value:{kind:'promoted',jobId:registration.jobId}};
    }
    if(dispatches===3){secondStarted.resolve();await releaseSecond.promise;}
    return foreground();
  },{executionDependencies:{capture:async()=>({}),finish:async()=>({})}});
  const signal=AbortSignal.timeout(10000),originalPlan={question:'Observe this exact check.',tool:shell,
    arguments:{command:'original command'},sources:[],cases:[]};
  session.append('tool/call',{callId:'original',name:'work_probe',arguments:originalPlan});
  const original=await evidence.execute(agent,originalPlan,signal);
  session.append('tool/result',{message:{source:{callId:'original'},content:[{type:'text',text:JSON.stringify(original)}]}});
  const replay=()=>evidence.execute(agent,{mode:'replay',id:original.id},signal);
  const first=replay();let second;
  try{
    await pendingSaved.promise;
    session.append('job/settled',{...registration,status:'completed',cause:'producer',producerReported:true});
    second=replay();await secondStarted.promise;
    releasePending.resolve();assert.equal((await first).status,'pending');
    const third=await replay();
    assert.equal(third.executionOccurred,false);
    assert.equal(third.reason,'probe-replay-in-flight');
    assert.equal(dispatches,3,'Only the original and two sequential native executions are dispatched');
  }finally{
    releasePending.resolve();releaseSecond.resolve();await first;await second;evidence.dispose();
  }
});

test('an outer pending native status prevents success and replay despite a completed inner payload',async()=>{
  for(const status of ['running','pending','queued','stopping'])for(const outerResult of [false,true]){
    const log=[],session={id:'probe-outer-'+status,log,get seq(){return log.length;}},agent={session};
    const state={id:session.id,root:process.cwd(),dir:process.cwd(),config:{executionTriage:true,probeReplay:true}};
    const runtime={init:async()=>state,get:()=>state,execFor:()=>({}),save:async()=>{}};
    let dispatches=0;
    const evidence=createExecutionEvidence({tools:{get:()=>({})},get:()=>null},runtime,async()=>{
      dispatches++;const value={data:{status:'completed',exitCode:0,jobId:'active-'+status,
        stdout:{text:'{"answer":42}',truncated:false},stderr:{text:'',truncated:false}}};
      return outerResult?{status,value}:{value:{status,...value}};
    },{executionDependencies:{capture:async()=>({}),finish:async()=>({})}});
    const originalPlan={...plan,sources:[]},signal=AbortSignal.timeout(10000);
    log.push({seq:0,type:'tool/call',data:{callId:'original',name:'work_probe',arguments:originalPlan}});
    const original=await evidence.execute(agent,originalPlan,signal);
    assert.equal(original.status,'pending',status);
    assert.equal(original.executionCompleted,false,status);
    assert.equal(original.cases[0].status,'unresolved',status);
    log.push({seq:log.length,type:'tool/result',data:{message:{source:{callId:'original'},content:[{type:'text',text:JSON.stringify(original)}]}}});
    const replay=await evidence.execute(agent,{mode:'replay',id:original.id},signal);
    assert.equal(replay.executionOccurred,false,status);
    assert.equal(replay.reason,'probe-replay-pending',status);
    assert.equal(dispatches,1,status);
    evidence.dispose();
  }
});

test('probe observations retain outer failure, incomplete and unknown execution envelopes',async()=>{
  for(const [outer,expected]of [
    [{status:'failed'},'failed'],[{state:'failed'},'failed'],[{job:{status:'failed'}},'failed'],
    [{success:false},'failed'],[{ok:false},'failed'],[{exitCode:2},'failed'],
    [{status:'failed',data:{status:'running',exitCode:0}},'failed'],
    [{complete:false},'partial'],[{executionCompleted:false},'partial'],[{outputPartial:true},'partial'],
    [{lossy:true},'partial'],[{stdout:{truncated:true}},'partial'],[{status:'unknown'},'unknown']]){
    const session={id:'probe-envelope',log:[]},agent={session};
    const state={id:session.id,root:process.cwd(),dir:process.cwd(),config:{executionTriage:true,probeReplay:true}};
    const runtime={init:async()=>state,get:()=>state,execFor:()=>({}),save:async()=>{}};
    const evidence=createExecutionEvidence({tools:{get:()=>({})},get:()=>null},runtime,async()=>({value:{
      data:{status:'completed',exitCode:0,stdout:{text:'{"answer":42}',truncated:false}},...outer}}),
      {executionDependencies:{capture:async()=>({}),finish:async()=>({})}});
    const observation=await evidence.execute(agent,{...plan,sources:[]},AbortSignal.timeout(10000));
    assert.equal(observation.status,expected,JSON.stringify(outer));
    assert.equal(observation.executionCompleted,false,JSON.stringify(outer));
    assert.equal(observation.cases[0].status,'unresolved',JSON.stringify(outer));
    assert.equal(observation.exitCode,0,'The actual inner producer exit remains separate from wrapper status');
    evidence.dispose();
  }
});
