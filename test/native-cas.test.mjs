import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {createNativeCas} from '../native-cas.mjs';
import {startHost,text,tool,APP,load} from './helpers/host.mjs';

const output=result=>(result.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
let ordinal=0;
async function invoke(host,agent,input){
  const id='native-cas-test-'+(++ordinal);
  const result=await host.ctx.tools.execute({name:'verified_exec',arguments:input,callId:id,rootCallId:id,agent,signal:AbortSignal.timeout(20000)});
  assert.equal(result.isError,false,output(result));return result.value??JSON.parse(output(result));
}
const require=createRequire(path.join(APP,'package.json'));
const nativeSupported=JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-tools/package.json'),'utf8')).version==='0.2.2-rc.2';

test('native edits capture file tools registered after plugin activation and preserve the sandbox filesystem fence',async()=>{
  const host=await startHost({mountPlugin:false,filesystem:nativeSupported?'dsh-fs-sandbox':'dsh-fs-local',fileTools:{write:false},
    workspace:{nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    await host.ctx.plugin(await import('../index.mjs'),{});
    const early=await host.createAgent();
    const initial=await host.command(early,'features');
    assert.equal(initial.features.find(item=>item.key==='nativeVerifiedEdits').status,'blocked');
    const fsTools=await load('dsh-tool-fs');
    await host.ctx.plugin(fsTools,{read:false,readImage:false,write:true,edit:false});
    await fs.writeFile(path.join(host.cwd,'late.txt'),'before');const agent=await host.createAgent();
    const plan={summary:'Apply through a late native tool registration',apply:true,edits:[{file:'late.txt',mode:'replace_exact',old_text:'before',new_text:'after'}]};
    const result=await invoke(host,agent,plan);
    if(!nativeSupported){assert.equal(result.status,'deopt');return;}
    assert.equal(result.status,'applied');assert.equal(await fs.readFile(path.join(host.cwd,'late.txt'),'utf8'),'after');
    agent.session.append('sandbox/mode',{mode:'read-only',workspaceRoot:host.cwd});
    const denied=await host.ctx.tools.execute({name:'verified_exec',arguments:{...plan,edits:[{file:'late.txt',mode:'replace_exact',old_text:'after',new_text:'forbidden'}]},
      callId:'sandbox-denial',rootCallId:'sandbox-denial',agent,signal:AbortSignal.timeout(20000)});
    assert.equal(denied.isError,true);assert.match(output(denied),/read-only|denied/iu);
    assert.equal(await fs.readFile(path.join(host.cwd,'late.txt'),'utf8'),'after');
  }finally{await host.close();}
});

test('native conditional editing applies multiple exact changes without OPS and retains a preview with its switch off',async()=>{
  const host=await startHost({workspace:{toolSurface:'full',nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  let nativeWrites=0;
  host.ctx.on('tools/result',exec=>{if(exec.name==='write'&&exec.callId?.startsWith('work-evidence:native-cas:'))nativeWrites++;});
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'\uFEFFalpha\r\nbeta\r\n');
    const agent=await host.createAgent();
    const plan={summary:'Apply two exact edits and create a result',edits:[
      {file:'source.txt',mode:'replace_exact',old_text:'alpha',new_text:'ALPHA'},
      {file:'source.txt',mode:'replace_exact',old_text:'beta',new_text:'BETA'},
      {file:'created.txt',mode:'create',content:'created\r\n'}]};
    const preview=await invoke(host,agent,plan);
    const readiness=(await host.command(agent,'feature nativeVerifiedEdits')).features[0];
    if(!nativeSupported){
      assert.equal(readiness.status,'blocked');assert.ok(readiness.reasons.includes('rc2-native-conditional-write-unavailable'));
      assert.equal(preview.reason,'cas-file-tools-unavailable');
      assert.deepEqual(preview.missing,['rc2-native-conditional-write']);
      assert.equal(await fs.readFile(path.join(host.cwd,'source.txt'),'utf8'),'\uFEFFalpha\r\nbeta\r\n');return;
    }
    assert.equal(preview.status,'previewed',JSON.stringify(preview));assert.equal(preview.effectState,'none');
    assert.equal(readiness.status,'ready');
    assert.equal(readiness.effect.applied,0,'a preview must not be counted as an applied edit');
    assert.equal(await fs.readFile(path.join(host.cwd,'source.txt'),'utf8'),'\uFEFFalpha\r\nbeta\r\n');
    const result=await invoke(host,agent,{...plan,apply:true});
    assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(result.effectState,'applied');
    assert.equal(await fs.readFile(path.join(host.cwd,'source.txt'),'utf8'),'\uFEFFALPHA\r\nBETA\r\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'created.txt'),'utf8'),'created\r\n');
    assert.equal(host.ctx.tools.get('ops_stat',agent),undefined);
    assert.equal(nativeWrites,2);
    const record=JSON.parse(await fs.readFile(result.reportPath,'utf8'));
    const mutations=(await host.command(agent,'status')).state.recentMutations.filter(item=>/source\.txt|created\.txt/u.test(item.path));
    assert.equal(mutations.length,2,'one mutation per file; nested native writes are internal');
    for(const mutation of mutations)assert.equal(mutation.revision,record.files.find(item=>mutation.path.endsWith(item.file)).effect.contentHash,'the existing ledger uses content SHA256, not opaque native versions');
    assert.equal(record.backend,'dsh-native-cas');assert.equal(record.versionKind,'native-opaque');
    assert.equal(record.files.every(file=>file.effect.guarded===true),true);
    assert.equal((await host.command(agent,'feature nativeVerifiedEdits')).features[0].effect.status,'applied');
  }finally{await host.close();}
  const off=await startHost({workspace:{toolSurface:'full',nativeVerifiedEdits:false},script:()=>[text('Ready.')]});
  try{
    const agent=await off.createAgent();
    const result=await invoke(off,agent,{summary:'Do not activate the candidate implicitly',apply:true,edits:[{file:'new.txt',mode:'create',content:'new'}]});
    assert.equal(result.status,'deopt');assert.equal(result.reason,'cas-file-tools-unavailable');
    await assert.rejects(fs.stat(path.join(off.cwd,'new.txt')),error=>error.code==='ENOENT');
  }finally{await off.close();}
});

test('a native replacement race preserves the newer file and reports that the edit did not succeed',async()=>{
  const host=await startHost({workspace:{toolSurface:'full',nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    const file=path.join(host.cwd,'source.txt');await fs.writeFile(file,'original');
    let race=false;
    host.ctx.on('fs/write-intent',async(target,actor,next)=>{
      if(actor?.callId?.startsWith('work-evidence:native-cas:')&&!race){race=true;await fs.writeFile(file,'concurrent update');}
      return next();
    },{prepend:true});
    const agent=await host.createAgent();
    const result=await invoke(host,agent,{summary:'Keep newer source',apply:true,edits:[{file:'source.txt',mode:'replace_exact',old_text:'original',new_text:'changed'}]});
    if(!nativeSupported){assert.equal(result.reason,'cas-file-tools-unavailable');assert.equal(race,false);return;}
    assert.equal(race,true);assert.equal(result.status,'partial');assert.equal(result.reason,'file-apply-failed');
    assert.equal(result.effectState,'none');assert.equal(result.files[0].effectState,'none');
    assert.equal(await fs.readFile(file,'utf8'),'concurrent update');
  }finally{await host.close();}
});

test('native conditional creation cannot overwrite a file created after preflight',async()=>{
  const host=await startHost({workspace:{toolSurface:'full',nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    const file=path.join(host.cwd,'created.txt');let race=false;
    host.ctx.on('fs/write-intent',async(target,actor,next)=>{
      if(actor?.callId?.startsWith('work-evidence:native-cas:')&&!race){race=true;await fs.writeFile(file,'concurrent create');}
      return next();
    },{prepend:true});
    const agent=await host.createAgent();
    const result=await invoke(host,agent,{summary:'Create only if absent',apply:true,edits:[{file:'created.txt',mode:'create',content:'requested create'}]});
    if(!nativeSupported){assert.equal(result.reason,'cas-file-tools-unavailable');assert.equal(race,false);return;}
    assert.equal(race,true);assert.equal(result.status,'partial');
    assert.equal(await fs.readFile(file,'utf8'),'concurrent create');
  }finally{await host.close();}
});

test('native conditional editing retains the native read-only permission denial',async()=>{
  const host=await startHost({workspace:{toolSurface:'full',nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    const file=path.join(host.cwd,'source.txt');await fs.writeFile(file,'original');
    const agent=await host.createAgent();agent.session.append('sandbox/mode',{mode:'read-only',workspaceRoot:host.cwd});
    const result=await host.ctx.tools.execute({name:'verified_exec',arguments:{summary:'Respect the read-only session',apply:true,
      edits:[{file:'source.txt',mode:'replace_exact',old_text:'original',new_text:'changed'}]},callId:'read-only-edit',rootCallId:'read-only-edit',agent,signal:AbortSignal.timeout(20000)});
    if(nativeSupported){assert.equal(result.isError,true);assert.match(output(result),/denied|read-only/iu);}
    else {assert.equal(result.isError,false);assert.equal(result.value.status,'deopt');}
    assert.equal(await fs.readFile(file,'utf8'),'original');
  }finally{await host.close();}
});

test('a native PTC invocation reaches the conditional edit through the real nested write token',async()=>{
  const plan={summary:'Edit through native PTC',apply:true,edits:[{file:'source.txt',mode:'replace_exact',old_text:'before',new_text:'after'}]};
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],workspace:{nativeVerifiedEdits:true},
    script:(_options,n)=>n===1?[tool('run_code',{code:'const result=await tools.verified_exec('+JSON.stringify(plan)+');console.log(JSON.stringify(result));',description:'Apply the explicit conditional edit'})]:[text('Reported the actual edit result.')]});
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'before');
    const agent=await host.createAgent();await host.send(agent,'Perform the explicit conditional edit and report its actual state.');
    const dispatch=host.events.find(event=>['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)&&event.data.name==='verified_exec');
    assert.ok(dispatch);assert.equal(dispatch.data.isError,false);
    const result=JSON.parse(output(dispatch.data));
    if(nativeSupported){assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(await fs.readFile(path.join(host.cwd,'source.txt'),'utf8'),'after');}
    else {assert.equal(result.status,'deopt');assert.equal(await fs.readFile(path.join(host.cwd,'source.txt'),'utf8'),'before');}
  }finally{await host.close();}
});

test('native multiline replacements retain BOM, CRLF insertions and lone carriage returns',async()=>{
  const host=await startHost({workspace:{toolSurface:'full',nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    const file=path.join(host.cwd,'source.txt'),before='\uFEFFfirst\r\nsecond\r\n';await fs.writeFile(file,before);
    const agent=await host.createAgent();
    const result=await invoke(host,agent,{summary:'Retain storage line endings',apply:true,edits:[
      {file:'source.txt',mode:'replace_exact',old_text:'first\nsecond',new_text:'FIRST\ninserted\nSECOND'}]});
    if(!nativeSupported){assert.equal(result.status,'deopt');assert.equal(await fs.readFile(file,'utf8'),before);return;}
    const after='\uFEFFFIRST\r\ninserted\r\nSECOND\r\n';
    assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(await fs.readFile(file,'utf8'),after);
    assert.equal(result.files[0].versionKind,'native-opaque');assert.equal(result.files[0].changed,true);
    assert.equal(result.files[0].contentHash,createHash('sha256').update(after).digest('hex'));
    await fs.writeFile(file,'left\rright');
    const lone=await invoke(host,agent,{summary:'Retain literal lone CR bytes',apply:true,edits:[{file:'source.txt',mode:'replace_exact',old_text:'left',new_text:'LEFT'}]});
    assert.equal(lone.status,'applied',JSON.stringify(lone));assert.equal(await fs.readFile(file,'utf8'),'LEFT\rright');
  }finally{await host.close();}
});

test('a scoped replacement of the native write tool deopts before it can write',async()=>{
  const host=await startHost({workspace:{toolSurface:'full',nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    const agent=await host.createAgent(),original=host.ctx.tools.get('write',agent);let calls=0;
    agent.ctx.tools.register({...original,execute:async(args,exec)=>{
      if(args.file_path.endsWith('new.txt')){calls++;throw new Error('This replacement must not execute for the planned edit');}
      return original.execute(args,exec);
    }});
    const result=await invoke(host,agent,{summary:'Reject an unknown write implementation',apply:true,edits:[{file:'new.txt',mode:'create',content:'new'}]});
    assert.equal(result.status,'deopt');assert.equal(result.reason,'cas-file-tools-unavailable');assert.equal(calls,0);
    await assert.rejects(fs.stat(path.join(host.cwd,'new.txt')),error=>error.code==='ENOENT');
  }finally{await host.close();}
});

test('native cross-file partial effects retain the first write when a later policy conflicts',async()=>{
  const host=await startHost({workspace:{toolSurface:'full',nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    await fs.writeFile(path.join(host.cwd,'first.txt'),'before');await fs.writeFile(path.join(host.cwd,'second.txt'),'before');
    host.ctx.on('fs/write-intent',async(target,actor,next)=>actor.callId?.startsWith('work-evidence:native-cas:')&&target.displayPath.endsWith('second.txt')
      ?{kind:'replaceIfVersion',version:'a conflicting policy version'}:next(),{prepend:true});
    const agent=await host.createAgent(),result=await invoke(host,agent,{summary:'Record per-file effects',apply:true,edits:[
      {file:'first.txt',mode:'replace_exact',old_text:'before',new_text:'after'},
      {file:'second.txt',mode:'replace_exact',old_text:'before',new_text:'after'}]});
    if(!nativeSupported){assert.equal(result.status,'deopt');assert.equal(await fs.readFile(path.join(host.cwd,'first.txt'),'utf8'),'before');return;}
    assert.equal(result.status,'partial');assert.equal(result.files[0].effectState,'applied');assert.notEqual(result.files[1].status,'completed');
    assert.equal(await fs.readFile(path.join(host.cwd,'first.txt'),'utf8'),'after');assert.equal(await fs.readFile(path.join(host.cwd,'second.txt'),'utf8'),'before');
  }finally{await host.close();}
});

test('an aborted readback retains a write that already returned a guarded successful outcome',async()=>{
  const controller=new AbortController(),agent={session:{}},target={targetKey:'one'};let hook;
  const ctx={on:(_name,listener)=>{hook=listener},get:name=>name==='sandboxPolicy'?{resolve:()=>({mode:'danger-full-access'})}:null,
    tools:{get:()=>null,execute:async exec=>{
      await hook(target,{...exec,agent},async()=>undefined);controller.abort(new Error('after the write'));
      return {isError:false,value:{before:'before',after:'after'}};
    }}};
  const cas=createNativeCas(ctx,{get:()=>({root:process.cwd()}),execFor:()=>({})});
  const result=await cas.apply(agent,{mode:'replace_exact',file:'source.txt',expectedText:'after'},{revision:'opaque',target},controller.signal);
  assert.equal(result.ok,false);assert.equal(result.status,'partial');assert.equal(result.effectState,'applied');
  assert.match(result.error.message,/write completed; readback failed/u);
});

test('native edits keep their project-root target after the session changes directory',async()=>{
  const host=await startHost({workspace:{nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'before');await fs.mkdir(path.join(host.cwd,'sub'));
    const agent=await host.createAgent();await host.ctx.workingDirectory.set(agent,'sub',AbortSignal.timeout(10000));
    const result=await invoke(host,agent,{summary:'Edit the preflighted project-root file',apply:true,
      edits:[{file:'source.txt',mode:'replace_exact',old_text:'before',new_text:'after'}]});
    if(!nativeSupported){assert.equal(result.status,'deopt');return;}
    assert.equal(result.status,'applied',JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(host.cwd,'source.txt'),'utf8'),'after');
    await assert.rejects(fs.stat(path.join(host.cwd,'sub','source.txt')),error=>error.code==='ENOENT');
  }finally{await host.close();}
});

test('the real native tool channel retains cancelled file effects and a saved report',async()=>{
  const host=await startHost({workspace:{nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'before');const agent=await host.createAgent(),controller=new AbortController();let aborted=false;
    host.ctx.on('tools/result',exec=>{
      if(!aborted&&exec.name==='write'&&exec.callId?.startsWith('work-evidence:native-cas:')){aborted=true;controller.abort(new Error('cancel after native write'));}
    });
    const input={summary:'Keep cancellation effects',apply:true,edits:[{file:'source.txt',mode:'replace_exact',old_text:'before',new_text:'after'}]};
    const callEvent=agent.session.append('tool/call',{callId:'cancel-effects',name:'verified_exec',arguments:input});
    const result=await host.ctx.tools.execute({name:'verified_exec',arguments:input,callId:'cancel-effects',rootCallId:'cancel-effects',agent,signal:controller.signal});
    if(!nativeSupported){assert.equal(aborted,false);return;}
    const {createToolResultMessage}=await load('dsh-llm');
    agent.session.append('tool/result',{message:createToolResultMessage({callId:'cancel-effects',content:result.content,isError:result.isError})},
      {surfaceOp:'append',sourceEventSeqs:[callEvent.seq]});
    assert.equal(aborted,true);assert.equal(result.isError,true);assert.equal(await fs.readFile(path.join(host.cwd,'source.txt'),'utf8'),'after');
    const body=output(result),start=body.indexOf('{');assert.ok(start>=0,body);
    const report=JSON.parse(body.slice(start));assert.equal(report.status,'partial');assert.equal(report.effectState,'applied');
    assert.equal(report.files[0].effectState,'applied');assert.equal(report.reportSaved,true);
    const saved=JSON.parse(await fs.readFile(report.reportPath,'utf8'));assert.equal(saved.files[0].effect.effectState,'applied');
    const detail=await host.command(agent,'detail');
    assert.ok(detail.taskFlow.mutationVersion>0,'The real failed tool channel must retain its committed mutation');
    assert.ok(detail.taskFlow.lastMutationSeq>=0);
    assert.ok(detail.taskFlow.unresolvedErrors.some(error=>error.tool==='verified_exec'));
  }finally{await host.close();}
});
test('native edits merge Windows case aliases of one existing file before planning changes',async()=>{
  const host=await startHost({workspace:{nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    const file=path.join(host.cwd,'Case.txt');await fs.writeFile(file,'AB');const agent=await host.createAgent();
    const alias=process.platform==='win32'?'case.txt':'Case.txt';
    const result=await invoke(host,agent,{summary:'Apply both edits to the same file identity',apply:true,edits:[
      {file:'Case.txt',mode:'replace_exact',old_text:'A',new_text:'X'},{file:alias,mode:'replace_exact',old_text:'B',new_text:'Y'}]});
    if(!nativeSupported){assert.equal(result.status,'deopt');return;}
    assert.equal(result.status,'applied',JSON.stringify(result));assert.equal(result.files.length,1);
    assert.equal(await fs.readFile(file,'utf8'),'XY');
  }finally{await host.close();}
});
test('cancellation after an outcome report commits preserves its saved state',async()=>{
  const host=await startHost({workspace:{nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'before');const agent=await host.createAgent(),controller=new AbortController();let sourceWritten=false,aborted=false;
    host.ctx.on('tools/result',(exec,result)=>{
      if(exec.name!=='write'||result.isError)return;
      if(exec.callId?.startsWith('work-evidence:native-cas:'))sourceWritten=true;
      else if(sourceWritten&&!aborted&&exec.arguments.file_path.endsWith('.json')){aborted=true;controller.abort(new Error('cancel after report commit'));}
    });
    const result=await host.ctx.tools.execute({name:'verified_exec',arguments:{summary:'Keep the committed report',apply:true,
      edits:[{file:'source.txt',mode:'replace_exact',old_text:'before',new_text:'after'}]},callId:'cancel-report',rootCallId:'cancel-report',agent,signal:controller.signal});
    if(!nativeSupported){assert.equal(aborted,false);return;}
    assert.equal(aborted,true);assert.equal(result.isError,true);const body=output(result),at=body.indexOf('{');assert.ok(at>=0,body);
    const report=JSON.parse(body.slice(at));assert.equal(report.reportSaved,true,body);
    assert.equal(JSON.parse(await fs.readFile(report.reportPath,'utf8')).effectState,'applied');
  }finally{await host.close();}
});

test('a committed outcome remains saved when cancellation also changes the policy to read-only',async()=>{
  const host=await startHost({workspace:{nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'before');const agent=await host.createAgent(),controller=new AbortController();let sourceWritten=false,switched=false;
    host.ctx.on('tools/result',(exec,result)=>{
      if(exec.name!=='write'||result.isError)return;
      if(exec.callId?.startsWith('work-evidence:native-cas:'))sourceWritten=true;
      else if(sourceWritten&&!switched&&exec.arguments.file_path.endsWith('.json')){
        switched=true;agent.session.append('sandbox/mode',{mode:'read-only',workspaceRoot:host.cwd});controller.abort(new Error('cancel after report commit and policy change'));
      }
    });
    const result=await host.ctx.tools.execute({name:'verified_exec',arguments:{summary:'Observe the existing committed outcome',apply:true,
      edits:[{file:'source.txt',mode:'replace_exact',old_text:'before',new_text:'after'}]},callId:'cancel-report-read-only',rootCallId:'cancel-report-read-only',agent,signal:controller.signal});
    if(!nativeSupported){assert.equal(switched,false);return;}
    assert.equal(switched,true);assert.equal(result.isError,true);const body=output(result),at=body.indexOf('{');assert.ok(at>=0,body);
    const report=JSON.parse(body.slice(at));assert.equal(report.reportSaved,true,body);assert.equal(report.reportObservedAfterWriteError,true);
    assert.equal(JSON.parse(await fs.readFile(report.reportPath,'utf8')).status,'applied');
    assert.equal(await fs.readFile(path.join(host.cwd,'source.txt'),'utf8'),'after');
  }finally{await host.close();}
});

test('an older preflight report cannot certify that a cancelled final outcome was saved',async()=>{
  const host=await startHost({workspace:{nativeVerifiedEdits:true},script:()=>[text('Ready.')]});
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'before');const agent=await host.createAgent(),controller=new AbortController();let switched=false;
    host.ctx.on('tools/result',(exec,result)=>{
      if(!switched&&exec.name==='write'&&!result.isError&&exec.callId?.startsWith('work-evidence:native-cas:')){
        switched=true;agent.session.append('sandbox/mode',{mode:'read-only',workspaceRoot:host.cwd});controller.abort(new Error('cancel before outcome report'));
      }
    });
    const result=await host.ctx.tools.execute({name:'verified_exec',arguments:{summary:'Keep an unsaved final outcome distinct from preflight',apply:true,
      edits:[{file:'source.txt',mode:'replace_exact',old_text:'before',new_text:'after'}]},callId:'cancel-before-final-report',rootCallId:'cancel-before-final-report',agent,signal:controller.signal});
    if(!nativeSupported){assert.equal(switched,false);return;}
    assert.equal(switched,true);assert.equal(result.isError,true);const body=output(result),at=body.indexOf('{');assert.ok(at>=0,body);
    const report=JSON.parse(body.slice(at));assert.equal(report.reportSaved,false,body);assert.equal(report.effectState,'applied');
    assert.equal(JSON.parse(await fs.readFile(report.reportPath,'utf8')).status,'preflight');
  }finally{await host.close();}
});
