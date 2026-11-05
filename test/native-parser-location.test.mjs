import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeProgramParseLocation} from '../recovery.mjs';
import {startHost,text,tool} from './helpers/host.mjs';

const code='// Existing complete program.\n'.repeat(40)+'const value = ;\nreturn value;';
const failed=message=>({isError:true,content:[{type:'text',text:'Error: code run failed (exception): '+message+'\nFile sandbox: danger-full-access.'}]});
test('the native parser supplies original source lines only for the same completed parse rejection',()=>{
  const location=nativeProgramParseLocation(code,failed('Expression expected'));
  assert.equal(location.line,41);assert.equal(location.lines.find(line=>line.number===41).text,'const value = ;');
  assert.equal(location.executionOccurred,false);
  assert.equal(nativeProgramParseLocation(code,failed('worker-exit')),null);
  assert.equal(nativeProgramParseLocation(code,{...failed('Expression expected'),isError:false}),null);
  assert.equal(nativeProgramParseLocation('// comment\n'.repeat(110)+'throw new Error("Expression expected");',failed('Expression expected')),null);
  assert.equal(nativeProgramParseLocation(code,failed('Unexpected token')),null);
});

test('actual native PTC carries the parser window and keeps its original failure and native retry',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code,description:'Evaluate the original native program'})];
    if(n===2){
      const context=options.messages.find(message=>message.source?.taskFlow?.key?.includes('native-program-parser'));
      assert.ok(context);assert.match(context.content[0].text,/"line":41/);assert.match(context.content[0].text,/const value = ;/);
      assert.ok(!options.messages.some(message=>message.source?.taskFlow?.key?.includes('program-failure')),'the exact parser window replaces the generic failure reminder');
      return [tool('run_code',{code:code.replace('const value = ;','const value = 42;'),description:'Repair the actual native parser failure'})];
    }
    return [text('42')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'修正程序并返回执行结果。');
    const failures=host.events.filter(event=>event.type==='tool/result'&&event.data.message.isError);assert.equal(failures.length,1);
    assert.match(failures[0].data.message.content[0].text,/Expression expected/);
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch').length,0,'source diagnosis adds no file read or native subtool execution');
    const detail=await host.command(agent,'detail');assert.equal(detail.taskFlow.unresolvedErrors.length,0);
  }finally{await host.close();}
});
