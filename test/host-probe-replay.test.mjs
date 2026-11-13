import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost as baseStartHost,text,tool} from './helpers/host.mjs';
import {defaults} from '../runtime.mjs';

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
