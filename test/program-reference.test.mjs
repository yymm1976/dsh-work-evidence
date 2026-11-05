import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveNativeProgram,latestNativeProgram,nativeProgramAddress} from '../program-reference.mjs';
import {startHost,text,tool} from './helpers/host.mjs';

const user=seq=>({seq,type:'user/message',data:{message:{role:'user',source:{kind:'user'},content:[{type:'text',text:'修改当前项目'}]}}});
const call=(seq,id,args)=>({seq,type:'tool/call',data:{callId:id,name:'run_code',arguments:args}});
const body='// Keep the existing native program text.\n'.repeat(30)+'const value = ;\nreturn value;';

test('native program references preserve exact text, literal replacements and session boundaries',()=>{
  const session={log:[user(1),call(2,'original',{code:body,sandbox_permissions:'danger-full-access'}),
    call(3,'fixed',{programRef:'original',edits:[{before:'const value = ;',after:'const value = 42;'}]})]};
  const resolved=resolveNativeProgram({programRef:'fixed',edits:[{before:'return value;',after:'return "$&" + value;'}]},session);
  assert.ok(resolved.code.endsWith('const value = 42;\nreturn "$&" + value;'));
  assert.deepEqual(Object.keys(resolved).sort(),['code','sourceCallIds']);
  assert.equal(latestNativeProgram(session).programRef,'fixed');
  assert.throws(()=>resolveNativeProgram({programRef:'original',edits:[{before:'//',after:''}]},session),/exactly once/);
  assert.throws(()=>resolveNativeProgram({programRef:'original',code:'return 1;'},session),/exactly one/);
  assert.throws(()=>resolveNativeProgram({programRef:'missing'},session),/this session/);
  session.log.push(call(4,'cycle',{programRef:'cycle'}));
  assert.throws(()=>resolveNativeProgram({programRef:'cycle'},session),/cyclic/);
  session.log.push(user(5));
  assert.equal(latestNativeProgram(session).programRef,'fixed');
  assert.equal(resolveNativeProgram({programRef:'original'},session).code,body,'explicit reuse across user messages retains text only');
  assert.throws(()=>resolveNativeProgram({programRef:'original'},{log:[user(1)]}),/this session/);
});

test('short call and result addresses select the same native program and preserve version chains',()=>{
  const result=(seq,id)=>({seq,type:'tool/result',data:{message:{role:'tool',toolCallId:id,content:[{type:'text',text:'original result'}]}}});
  const session={log:[user(1),call(2,'original',{code:body}),result(3,'original'),
    call(4,'fixed',{programRef:'event:3',edits:[{before:'const value = ;',after:'const value = 42;'}]}),result(5,'fixed'),user(6)]};
  assert.equal(nativeProgramAddress(session,'original'),'event:2');
  assert.equal(resolveNativeProgram({programRef:'event:2'},session).code,body);
  assert.equal(resolveNativeProgram({programRef:'event:3'},session).code,body);
  const resolved=resolveNativeProgram({programRef:'event:5',edits:[{before:'return value;',after:'return "$&" + value;'}]},session);
  assert.ok(resolved.code.endsWith('const value = 42;\nreturn "$&" + value;'));
  assert.deepEqual(resolved.sourceCallIds,['fixed','original']);
  assert.equal(session.log[1].data.arguments.code,body);
  session.log.push({seq:7,type:'tool/ptc-dispatch',data:{name:'work_exec',subCallId:'nested',arguments:{code:'return 1;'}}},result(8,'missing'));
  for(const programRef of ['event:1','event:6','event:7','event:8','event:9007199254740992'])
    assert.throws(()=>resolveNativeProgram({programRef},session),/this session/,programRef);
  session.log.push(call(10,'loop-a',{programRef:'event:11'}),call(11,'loop-b',{programRef:'loop-a'}));
  assert.throws(()=>resolveNativeProgram({programRef:'event:10'},session),/cyclic/);
  assert.equal(nativeProgramAddress(session,'missing'),null);
  assert.throws(()=>resolveNativeProgram({programRef:'event:2'},{log:[user(1)]}),/this session/);
});

test('the default configuration adds no native program schema or successful-program receipt',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false},script:(options,n)=>{
    assert.ok(!options.tools.find(tool=>tool.name==='run_code').parameters.properties.programRef);
    assert.ok(!options.messages.some(message=>message.source?.kind==='work-evidence-native-program'));
    return n===1?[tool('run_code',{code:'// Existing native body.\n'.repeat(50)+'return 42;',description:'Run an existing native program'})]:[text('42')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'返回当前程序的结果。');
    const detail=await host.command(agent,'detail');assert.equal(detail.observability.features.nativeProgramReuse.enabled,false);
    assert.equal(detail.observability.features.nativeProgramReference.enabled,false);
  }finally{await host.close();}
});

test('native PTC receives the optional reference schema, reuses the body and keeps native file dispatch',async()=>{
  let originalRef;
  const code=body.replace('return value;','const record = await tools.read({file_path:"source.txt"});console.log(record.lines);return value;');
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false,nativeProgramReuse:true},script:(options,n)=>{
    const schema=options.tools.find(entry=>entry.name==='run_code').parameters;
    if(n===1){assert.ok(!schema.properties.programRef);return [tool('run_code',{code,description:'Read a project value after parsing the program'})];}
    if(n===2){
      assert.equal(schema.properties.programRef.type,'string');assert.ok(!schema.required.includes('code'));
      const notice=options.messages.find(message=>message.source?.taskFlow?.key?.includes('program-failure')||message.source?.taskFlow?.key?.includes('native-program-parser'));
      assert.ok(notice);const detail=JSON.parse(notice.content[0].text.split('\n').at(-1));originalRef=detail.reuse.programRef;
      assert.match(originalRef,/^event:\d+$/u);
      assert.equal(Object.hasOwn(detail.reuse,'edits'),false);assert.match(detail.reuse.editRequirements,/\[\{before,after\}\]/u);
      return [tool('run_code',{programRef:originalRef,edits:[{before:'const value = ;',after:'const value = 42;'}],description:'Repair the recorded native program and read the source'})];
    }
    assert.match(options.messages.findLast(message=>message.role==='tool').content.map(block=>block.text??'').join(''),/42/);
    return [text('原生读取完成。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'exact source\n');
    const agent=await host.createAgent('max');await host.send(agent,'修改程序并读取 source.txt。');
    const calls=host.events.filter(event=>event.type==='tool/call');assert.equal(calls.length,2);
    const reference=JSON.parse(calls[1].data.arguments);assert.equal(reference.programRef,originalRef);assert.ok(!Object.hasOwn(reference,'code'));
    const reads=host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read');assert.equal(reads.length,1);
    const result=await host.command(agent,'detail');assert.equal(result.taskFlow.unresolvedErrors.length,0);
    assert.equal(result.observability.features.nativeProgramReuse.applied,1);
    assert.equal(result.observability.features.nativeProgramReference.enabled,false);
  }finally{await host.close();}
});

test('success adds no address message and an explicit result address still works in a later user request',async()=>{
  let ref;
  const code='// Existing graph computation.\n'.repeat(40)+'return 42;';
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false,nativeProgramReuse:true},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code,description:'Compute the first requested result'})];
    assert.ok(!options.messages.some(message=>message.source?.kind==='work-evidence-native-program'));
    if(n===2){ref='event:'+host.events.findLast(event=>event.type==='tool/result').seq;return [text('第一次结果为 42。')];}
    if(n===3)return [tool('run_code',{programRef:ref,edits:[{before:'return 42;',after:'return 63;'}],description:'Extend the same recorded program'})];
    assert.match(options.messages.findLast(message=>message.role==='tool').content[0].text,/63/);return [text('第二次结果为 63。')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'计算第一次结果。');await host.send(agent,'保留原程序，修改为第二次结果。');
    const detail=await host.command(agent,'detail');assert.equal(detail.observability.features.nativeProgramReuse.applied,1);
    assert.equal(detail.observability.features.nativeProgramReference.applied,0);
    assert.equal(detail.observability.features.nativeProgramReference.retired,true);
    assert.ok(!detail.taskFlow.unresolvedErrors.length);
  }finally{await host.close();}
});

test('referenced programs use the current sandbox and do not inherit earlier wider permission arguments',async()=>{
  let ref,agent;
  const code='// Previously authorized program.\n'.repeat(35)+'const fsx=await import("node:fs/promises");await fsx.writeFile("blocked.txt","changed");console.log("written");';
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false,nativeProgramReuse:true},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code,description:'Write the initially allowed file'})];
    if(n===2){ref=options.messages.findLast(message=>message.role==='tool').source.callId;agent.session.append('sandbox/mode',{mode:'read-only',workspaceRoot:host.cwd});
      return [tool('run_code',{programRef:ref,edits:[{before:'blocked.txt',after:'denied.txt'}],description:'Observe the current read-only permission'})];}
    return [text('当前只读权限已阻止写入。')];
  }});
  try{
    agent=await host.createAgent('max');await host.send(agent,'本次仅观察不同权限下的实际写入结果。');
    assert.equal(await fs.readFile(path.join(host.cwd,'blocked.txt'),'utf8'),'changed');
    assert.equal(await fs.stat(path.join(host.cwd,'denied.txt')).then(()=>true,()=>false),false);
    assert.ok(host.events.some(event=>event.type==='tool/result'&&event.data.message.isError));
  }finally{await host.close();}
});
