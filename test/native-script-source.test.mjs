import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskFlow} from '../task-flow.mjs';
import {defaults} from '../runtime.mjs';
import {startHost,text,tool} from './helpers/host.mjs';

const code='// Keep the original program source available.\n'.repeat(60)+'console.log(42);';
function recorded({value={},config={},count=1}={}){
  const log=[{seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'user/message',data:{message:{id:'request',role:'user',source:{kind:'user'},content:[{type:'text',text:'运行已有程序并按实际需要接续。'}]}}},
    {seq:2,type:'tool/call',data:{callId:'root',name:'run_code',arguments:{code:'return output;'}}}];
  for(let index=0;index<count;index++){
    const start=log.length,subCallId='root-inner-'+index;
    log.push({seq:start,type:'tool/ptc-dispatch-start',data:{rootCallId:'root',subCallId,name:'work_exec',arguments:{runtime:'node',code}}});
    log.push({seq:log.length,type:'tool/ptc-dispatch',data:{rootCallId:'root',subCallId,name:'work_exec',arguments:{runtime:'node',code},
      content:[{type:'text',text:JSON.stringify({exitCode:0,stdout:{text:'42\n'},stderr:{text:''},scriptRef:subCallId,scriptEventRef:'event:'+start,
        scriptChars:code.length,scriptRuntime:'node',scriptSourceRefs:[],...value})}]}});
  }
  const agent={session:{id:'script-source',log}},runtimeState={config:{...defaults(),...config},root:process.cwd()};
  const runtime={get:()=>runtimeState,isEnabled:()=>true,activeMode:()=> 'aggressive'};
  return {agent,log,runtime,flow:createTaskFlow({},runtime)};
}
const context=(state,output='42\n',extra={})=>state.flow.executionReferenceContext({agent:state.agent,name:'run_code',callId:'root',...extra},
  {isError:false,content:[{type:'text',text:output}]});

test('a completed native long program exposes only its exact source address when the root omits metadata',()=>{
  const state=recorded(),notice=context(state),detail=JSON.parse(notice.content[0].text.split('\n').at(-1));
  assert.equal(notice.source.taskFlow.kind,'scriptSource');
  assert.deepEqual(detail.programs,[{tool:'work_exec',scriptRef:'event:3',runtime:'node',scriptChars:code.length,sourceResultSeq:4,processExitCode:0,evidenceValidity:'unknown'}]);
  assert.equal(detail.programsOmitted,0);assert.equal(context(state),null);
  state.log.push({seq:state.log.length,type:'user/message',data:{message:notice}});
  const restored={...state,flow:createTaskFlow({},state.runtime)};
  assert.equal(context(restored),null,'the recorded notice prevents another delivery after state reconstruction');
});

test('source addresses are bounded and do not replace a visible ref, failed report or unresolved execution',()=>{
  for(const value of [{scriptChars:2399},{scriptChars:64001},{exitCode:1},{kind:'background',jobId:'job'},
    {stdout:{text:'42',truncated:true}},{complete:false},{executionCompleted:false},{partial:true},
    {stdout:{text:'FAIL: remaining input\n'}},{scriptSourceRefs:['original']},{scriptEventRef:null},
    {scriptEventRef:'event:9007199254740992'},{scriptRuntime:'other'}])assert.equal(context(recorded({value})),null,JSON.stringify(value));
  assert.equal(context(recorded({config:{executionTriage:false}})),null);
  assert.equal(context(recorded(),'event:3'),null);assert.equal(context(recorded(),'root-inner-0'),null);
  assert.equal(context(recorded(),'42',{parent:{callId:'outer'}}),null);
  assert.equal(context(recorded(),'42',{callId:'another-root'}),null);
  assert.equal(context(recorded(),'42',{signal:{aborted:true}}),null);
  const notice=context(recorded({count:5})),detail=JSON.parse(notice.content[0].text.split('\n').at(-1));
  assert.equal(detail.programs.length,3);assert.equal(detail.programsOmitted,2);
});

test('a different address with the same prefix does not hide the current source address',()=>{
  assert.ok(context(recorded(),'the other program is event:30'));
  assert.ok(context(recorded(),'the other program is root-inner-00'));
  assert.equal(context(recorded(),'the current program is event:3'),null);
});

test('revised long sources are visible while identity edits and unchanged references stay quiet',()=>{
  const state=recorded({value:{scriptSourceRefs:['parent'],scriptEditCount:1}});
  const notice=context(state);
  assert.ok(notice);assert.match(notice.content[0].text,/event:3/u);
  assert.equal(context(recorded({value:{scriptSourceRefs:['parent'],scriptEditCount:0}})),null);
  state.log.push({seq:state.log.length,type:'tool/result',data:{message:{role:'tool',source:{callId:'root'},content:[{type:'text',text:'42\n'}]}}});
  state.log.push({seq:state.log.length,type:'user/message',data:{message:notice}});
  const restored=createTaskFlow({},state.runtime);
  assert.ok(!restored.beforeStep(state.agent).some(message=>message.source?.taskFlow?.kind==='scriptVersion'));
});

test('actual native stdout-only results keep their original output and expose one source notice for explicit reuse',async()=>{
  let originalRef;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'const result=await tools.work_exec('+JSON.stringify({runtime:'node',code})+');console.log(result.stdout.text);',description:'Print only the original program output'})];
    if(n===2){
      const notices=options.messages.filter(message=>message.source?.taskFlow?.kind==='scriptSource');assert.equal(notices.length,1);
      const detail=JSON.parse(notices[0].content[0].text.split('\n').at(-1));originalRef=detail.programs[0].scriptRef;
      assert.match(originalRef,/^event:\d+$/u);assert.equal(detail.programs[0].scriptChars,code.length);
      assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='work_exec').length,1,'the notice does not execute the program');
      return [tool('run_code',{code:'const result=await tools.work_exec('+JSON.stringify({scriptRef:originalRef})+');console.log(result.stdout.text);',description:'Explicitly reuse the recorded source once'})];
    }
    assert.equal(options.messages.filter(message=>message.source?.taskFlow?.kind==='scriptSource').length,1,'unchanged explicit reuse adds no duplicate source notice');
    return [text('42')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行原程序，再沿原文地址显式执行一次。');
    const results=host.events.filter(event=>event.type==='tool/result');assert.equal(results.length,2);
    assert.deepEqual(results.map(event=>event.data.message.content.map(block=>block.text??'').join('').trim()),['42','42']);
    assert.equal((await host.command(agent,'detail')).taskFlow.unresolvedErrors.length,0);
  }finally{await host.close();}
});

test('actual native full results already carry their source without another notice',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'return await tools.work_exec('+JSON.stringify({runtime:'node',code})+');',description:'Return the complete original tool result'})];
    assert.ok(!options.messages.some(message=>message.source?.taskFlow?.kind==='scriptSource'));
    return [text('42')];
  }});
  try{const agent=await host.createAgent('max');await host.send(agent,'运行程序并保留完整原生结果。');}
  finally{await host.close();}
});

test('actual stdout-only consecutive revisions each expose their new address without a duplicate version notice',async()=>{
  const addresses=[];
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    const sources=options.messages.filter(message=>message.source?.taskFlow?.kind==='scriptSource');
    assert.ok(!options.messages.some(message=>message.source?.taskFlow?.kind==='scriptVersion'));
    if(n===1)return [tool('run_code',{code:'const result=await tools.work_exec('+JSON.stringify({runtime:'node',code})+');console.log(result.stdout.text);'})];
    assert.equal(sources.length,n-1);
    const current=JSON.parse(sources.at(-1).content[0].text.split('\n').at(-1)).programs[0].scriptRef;
    assert.ok(!addresses.includes(current));addresses.push(current);
    if(n===4)return [text('84')];
    return [tool('run_code',{code:'const result=await tools.work_exec('+JSON.stringify({scriptRef:current,
      edits:[{before:n===2?'console.log(42);':'console.log(63);',after:n===2?'console.log(63);':'console.log(84);'}]})+');console.log(result.stdout.text);'})];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行程序，随后沿最新版本依次修改输出为 63 和 84，每版只执行一次。');
    const results=host.events.filter(event=>event.type==='tool/result');
    assert.deepEqual(results.map(event=>event.data.message.content.map(block=>block.text??'').join('').trim()),['42','63','84']);
    assert.equal(addresses.length,3);
  }finally{await host.close();}
});

test('actual full revised results prevent redundant source and version notices',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    assert.ok(!options.messages.some(message=>['scriptSource','scriptVersion'].includes(message.source?.taskFlow?.kind)));
    if(n===1)return [tool('run_code',{code:'return await tools.work_exec('+JSON.stringify({runtime:'node',code})+');'})];
    if(n===4)return [text('84')];
    const latest=options.messages.findLast(message=>message.role==='tool');
    const value=JSON.parse(latest.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'));
    return [tool('run_code',{code:'return await tools.work_exec('+JSON.stringify({scriptRef:value.scriptEventRef,
      edits:[{before:n===2?'console.log(42);':'console.log(63);',after:n===2?'console.log(63);':'console.log(84);'}]})+');'})];
  }});
  try{const agent=await host.createAgent('max');await host.send(agent,'运行并两次修改程序，每次保留完整工具结果。');}
  finally{await host.close();}
});
