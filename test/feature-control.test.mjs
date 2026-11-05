import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {defaults,RETIRED_SETTINGS} from '../runtime.mjs';
import {featureDefinition,featurePatch} from '../feature-control.mjs';
import {startHost,load,text,tool,toolNames} from './helpers/host.mjs';

test('every retained switch has an explicit feature entry and retired fields cannot claim activation',()=>{
  for(const [key,value]of Object.entries(defaults()))if(typeof value==='boolean'&&!RETIRED_SETTINGS.includes(key)){
    assert.ok(featureDefinition(key),key);assert.deepEqual(featurePatch(key,'on'),{[key]:true});
    assert.deepEqual(featurePatch(key.toUpperCase(),'off'),{[key]:false});
  }
  assert.deepEqual(featurePatch('toolSurface','full'),{toolSurface:'full'});
  assert.deepEqual(featurePatch('qualityReviewEffort','low'),{qualityReviewEffort:'low'});
  assert.deepEqual(featurePatch('qualityReviewScope','full'),{qualityReviewScope:'full'});
  assert.throws(()=>featurePatch('qualityReviewScope','none'),/auto.*full/);
  assert.throws(()=>featurePatch('qualityReviewEffort','wrong'),/auto.*inherit.*low/);
  assert.throws(()=>featurePatch('toolSurface','wrong'),/compact.*full/);
  assert.throws(()=>featurePatch('swEviction','true'),/on.*off/);
  assert.throws(()=>featurePatch('programHistory','on'),/retired/);
  assert.throws(()=>featurePatch('missing','on'),/Unknown/);
});

test('human commands expose compact-hidden tools and immediately restore the disabled surface',async()=>{
  const host=await startHost({script:options=>{
    assert.ok(toolNames(options).includes('work_state'));
    return [text('full tools available')];
  }});
  try{
    const agent=await host.createAgent('max');
    let view=await host.command(agent,'features');
    assert.equal(view.tools.find(item=>item.name==='work_state').exposed,false);
    const changed=await host.command(agent,'feature toolSurface full');
    assert.equal(changed.scope,'workspace');assert.equal(changed.readiness.features[0].configured,'full');
    assert.equal(changed.readiness.features[0].effect.status,'applied');
    assert.equal(changed.readiness.features[0].effect.lastReason,'full-surface');
    view=await host.command(agent,'features');assert.equal(view.tools.find(item=>item.name==='work_state').exposed,true);
    await host.send(agent,'列出当前可用的工程工具。');
    await host.command(agent,'off');
    view=await host.command(agent,'features');assert.equal(view.pluginEffective,false);
    assert.equal(view.tools.find(item=>item.name==='work_state').exposed,false);
    await host.command(agent,'feature nativeProgramReuse on');
    view=await host.command(agent,'feature nativeProgramReuse');
    assert.equal(view.features[0].configured,true);assert.equal(view.features[0].status,'blocked');
    assert.ok(view.features[0].reasons.includes('plugin-disabled'));
    await host.command(agent,'on');
    view=await host.command(agent,'features');assert.equal(view.pluginEffective,true);
    assert.equal(view.tools.find(item=>item.name==='work_state').exposed,true);
  }finally{await host.close();}
});

test('feature readiness distinguishes required settings, runtime dependencies and task conditions',async()=>{
  const host=await startHost({pluginConfig:{swEviction:true,requestProjection:true,finalJsonResultGuard:true,finalJsonGuard:false,
    nativeProgramReuse:true,structuredCalls:true,nativeReasoningReplay:true,qualityReview:true,stubSummary:true,deferPressureCompaction:true,
    fastEditPython:path.resolve('missing-python.exe')},script:()=>[text('done')]});
  try{
    const agent=await host.createAgent('max');
    const view=await host.command(agent,'features'),entry=key=>view.features.find(item=>item.key===key);
    assert.ok(view.features.every(item=>item.effect&&typeof item.effect.status==='string'));
    assert.equal(entry('enabled').effect.status,'not-observed');
    assert.equal(view.dependencies.archiveDecoder.available,true);
    assert.deepEqual(entry('swEviction').reasons,['requires-setting:swLedger']);
    assert.ok(entry('requestProjection').reasons.includes('requires-setting:projectionRestore'));
    assert.ok(entry('finalJsonResultGuard').reasons.includes('requires-setting:finalJsonGuard'));
    assert.ok(entry('nativeProgramReuse').reasons.includes('requires-ptc-tool-mode'));
    assert.ok(entry('structuredCalls').reasons.includes('requires-typescript-function-body-runtime'));
    assert.ok(entry('fastEditEnabled').reasons.includes('fastedit-runtime-files-unavailable'));
    assert.ok(entry('fastEditEnabled').reasons.includes('tool-unavailable:ops_stat'));
    assert.equal(entry('nativeReasoningReplay').status,'waiting');
    assert.equal(entry('qualityReview').status,'waiting');
    assert.ok(entry('qualityReview').reasons.includes('requires-ultra-quality-mode'));
    assert.ok(entry('stubSummary').reasons.includes('native-compaction-not-attached'));
    assert.ok(entry('deferPressureCompaction').reasons.includes('native-compaction-not-attached'));
    const summary=await host.command(agent,'status');assert.ok(summary.featureReadiness.blocked.some(item=>item.key==='fastEditEnabled'));
    const changed=await host.command(agent,'config {"swLedger":true,"finalJsonGuard":true}');
    assert.equal(changed.readiness.features.find(item=>item.key==='swEviction').status,'ready');
    assert.equal(changed.readiness.features.find(item=>item.key==='finalJsonResultGuard').status,'ready');
  }finally{await host.close();}
});

test('retained feature readiness follows missing dependencies, explicit retry and successful loading',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('unused')]});
  const scope=host.ctx.isolate('sandbox');
  try{
    await scope.plugin(await import('../index.mjs'),{toolSurface:'full',stepPacing:false});
    const agent=await host.createAgent('max');
    let invocation=0;
    const compute=async code=>{
      const callId='retained-readiness-'+(++invocation);
      const result=await host.ctx.tools.execute({name:'work_compute',arguments:{code},agent,callId,rootCallId:callId,signal:AbortSignal.timeout(30000)});
      assert.equal(result.isError,false,JSON.stringify(result));
      return result.value;
    };
    let view=await host.command(agent,'feature retainedCompute');
    assert.equal(view.features[0].configured,true);
    assert.equal(view.features[0].status,'blocked');
    assert.deepEqual(view.features[0].reasons,['native-service-unavailable:sandbox']);
    assert.deepEqual(view.dependencies.retainedCompute.missingDependencies,['sandbox']);
    const failed=await compute('var retainedInput=[12,15,8]; retainedInput.reduce((a,b)=>a+b,0)');
    assert.equal(failed.executionOccurred,false);
    const sandbox=await load('dsh-sandbox-local');await scope.plugin(sandbox.default??sandbox);
    view=await host.command(agent,'feature retainedCompute');
    assert.equal(view.features[0].status,'waiting');
    assert.deepEqual(view.features[0].reasons,['retained-runtime-retry-on-next-call']);
    assert.equal(view.dependencies.retainedCompute.loaded,false);
    assert.equal((await compute('var retainedInput=[12,15,8]; retainedInput.reduce((a,b)=>a+b,0)')).value,35);
    assert.equal((await compute('retainedInput.length')).value,3);
    view=await host.command(agent,'feature retainedCompute');
    assert.equal(view.features[0].status,'ready');
    assert.deepEqual(view.features[0].reasons,[]);
    assert.equal(view.dependencies.retainedCompute.available,true);
    assert.equal(view.dependencies.retainedCompute.loadFailure,null);
    assert.equal(host.requests.length,0);
    await host.command(agent,'feature retainedCompute off');
    view=await host.command(agent,'feature retainedCompute');
    assert.equal(view.features[0].status,'off');
    assert.equal((await compute('retainedInput.length')).executionOccurred,false);
  }finally{await host.close();}
});

test('readiness preserves workspace settings while reporting session overrides and the selected effort gate',async()=>{
  const host=await startHost({workspace:{enabled:false},script:()=>[text('done')]});
  try{
    const agent=await host.createAgent('max');
    let view=await host.command(agent,'feature enabled');
    assert.equal(view.features[0].status,'off');assert.equal(view.features[0].effectiveValue,false);
    await host.command(agent,'on');
    view=await host.command(agent,'feature enabled');
    assert.equal(view.features[0].configured,false);assert.equal(view.features[0].effectiveValue,true);
    assert.equal(view.features[0].status,'ready');assert.equal(view.pluginEffective,true);
    await host.command(agent,'feature aggressiveMode off');
    view=await host.command(agent,'feature enabled');
    assert.equal(view.features[0].effectiveValue,true);assert.equal(view.features[0].status,'blocked');
    assert.ok(view.features[0].reasons.includes('aggressive-off-and-no-ultra'));
    const ultra=await host.createAgent('ultra');await host.command(ultra,'on');
    await host.command(ultra,'feature qualityReview on');
    view=await host.command(ultra,'feature qualityReview');
    assert.equal(view.features[0].status,'ready');
    await host.command(agent,'inherit');
    view=await host.command(agent,'feature enabled');assert.equal(view.features[0].status,'off');
  }finally{await host.close();}
});

test('workspace changes preserve exact JSON values, reject ignored settings and survive another session',async()=>{
  const host=await startHost({script:()=>[text('done')]});
  try{
    const first=await host.createAgent('max');
    const interpreter=path.join(host.cwd,'MixedCase','PYTHON.exe');
    await host.command(first,'config '+JSON.stringify({fastEditPython:interpreter,projectionPricing:[{provider:'CaseProvider',model:'CaseModel',input:1,cacheRead:0,output:2,currency:'USD'}]}));
    await Promise.all([host.command(first,'feature swLedger on'),host.command(first,'feature swEviction on')]);
    const saved=JSON.parse(await fs.readFile(path.join(host.cwd,'.dsh','work-evidence','config.json'),'utf8'));
    assert.equal(saved.fastEditPython,interpreter);assert.equal(saved.projectionPricing[0].provider,'CaseProvider');
    assert.equal(saved.swLedger,true);assert.equal(saved.swEviction,true);
    for(const input of ['feature programHistory on','config {"compactionTiming":"adaptive"}','config {"contextPruningPolicy":"online-batch"}','config {"mode":"quality"}','config {"swEviction":7}','config nope'])
      await assert.rejects(()=>host.command(first,input));
    assert.equal(await fs.readFile(path.join(host.cwd,'.dsh','work-evidence','config.json'),'utf8'),JSON.stringify(saved,null,2)+'\n');
    const second=await host.createAgent('max'),view=await host.command(second,'features');
    assert.equal(view.features.find(item=>item.key==='swEviction').configured,true);
    assert.equal(view.features.find(item=>item.key==='swLedger').configured,true);
  }finally{await host.close();}
});

test('configuration through model tools uses the same validation and never enables a disabled plugin',async()=>{
  const host=await startHost({pluginConfig:{toolSurface:'full'},script:(_options,n)=>n===1?
    [tool('work_status',{config:{swLedger:true,swEviction:true}})]:[text('configured')]});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'开启重复结果记录和折叠。');
    let view=await host.command(agent,'features');assert.equal(view.features.find(item=>item.key==='swEviction').configured,true);
    await host.command(agent,'off');
    const result=await host.ctx.tools.execute({name:'work_status',arguments:{config:{enabled:true}},callId:'disabled-setting-attempt',
      rootCallId:'disabled-setting-attempt',agent,signal:AbortSignal.timeout(10000)});
    assert.equal(result.isError,true);
    view=await host.command(agent,'features');assert.equal(view.pluginEffective,false);
  }finally{await host.close();}
});

test('structured calls and program references both work after live activation in the same native PTC session',async()=>{
  let original;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:(options,n)=>{
    const schema=options.tools.find(item=>item.name==='run_code').parameters;
    assert.ok(schema.properties.calls);assert.ok(n<=2||schema.properties.programRef);
    if(n===1)return [tool('run_code',{calls:[{name:'read',arguments:{file_path:'input.txt'}}]})];
    if(n===2)return [tool('run_code',{code:'/*'+'.'.repeat(1000)+'*/console.log("kept");return 42;',description:'Record original program'})];
    if(n===3){
      const call=host.events.findLast(event=>event.type==='tool/call'&&event.data.name==='run_code');original='event:'+call.seq;
      return [tool('run_code',{programRef:original,edits:[{before:'return 42;',after:'return 63;'}]})];
    }
    return [text('63')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'input.txt'),'source=42');
    const agent=await host.createAgent('max');
    await host.command(agent,'config {"structuredCalls":true,"nativeProgramReuse":true}');
    await host.send(agent,'读取 input.txt，随后按准确版本修改已有只读程序。');
    const results=host.events.filter(event=>event.type==='tool/result');assert.equal(results.length,3);
    assert.ok(results.every(event=>!event.data.message.isError));
    assert.ok(results.at(-1).data.message.content.some(block=>block.text?.includes('63')));
    await host.command(agent,'config {"structuredCalls":false,"nativeProgramReuse":false}');
    const view=await host.command(agent,'features');
    assert.equal(view.features.find(item=>item.key==='structuredCalls').status,'off');
    assert.equal(view.features.find(item=>item.key==='structuredCalls').effect.status,'applied');
    assert.ok(view.features.find(item=>item.key==='structuredCalls').effect.applied>0);
    assert.equal(view.features.find(item=>item.key==='nativeProgramReuse').status,'off');
    assert.equal(view.features.find(item=>item.key==='nativeProgramReuse').effect.status,'applied');
  }finally{await host.close();}
});
