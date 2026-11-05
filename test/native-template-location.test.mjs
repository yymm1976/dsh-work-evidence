import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {nativeTemplateCallLocation} from '../recovery.mjs';
import {startHost,text,tool} from './helpers/host.mjs';

const padding='// Recorded original program.\n'.repeat(40);
const code=padding+'const source = `Heading\n\n``inline``\n`;\nreturn 42;';
const corrected=padding+'const source = '+JSON.stringify('Heading\n\n``inline``\n')+';\nreturn 42;';
const failed=literal=>({isError:true,content:[{type:'text',text:'Error: code run failed (exception): TypeError: "'+literal+'" is not a function\n    at eval (<anonymous>:46:2)\nFile sandbox: danger-full-access.'}]});
const rawCode=code.replace('const source = `','const source = String.raw`');
const rawFailed=(line=46,column=2)=>({isError:true,content:[{type:'text',text:'Error: code run failed (exception): TypeError: String.raw(...) is not a function\n'+
  '    at eval (eval at runProgram (file:///runtime/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js:1031:31), <anonymous>:'+line+':'+column+')\nFile sandbox: danger-full-access.'}]});

test('a runtime string-template error is located by its unique source literal rather than transformed stack lines',()=>{
  const location=nativeTemplateCallLocation(code,failed('Heading\n\n'));
  assert.equal(location.line,43);assert.equal(location.lines.find(line=>line.number===43).text,'``inline``');
  assert.equal(location.parserOnly,false);assert.equal(location.executionOccurred,true);
  assert.equal(nativeTemplateCallLocation(code,{...failed('Heading\n\n'),isError:false}),null);
  assert.equal(nativeTemplateCallLocation(code,failed('different error string')),null);
  assert.equal(nativeTemplateCallLocation(code+'\n// Heading\n\n',failed('Heading\n\n')),null);
  assert.equal(nativeTemplateCallLocation(padding+'const source = "Heading\n\n"; source();',failed('Heading\n\n')),null);
  assert.equal(nativeTemplateCallLocation(padding+'const source = `Heading\n\n`; source();',failed('Heading\n\n')),null);
});

test('a String.raw call is located only when the native frame matches the original adjacent template boundary',()=>{
  for(const newline of ['\n','\r\n','\r']){
    const original=rawCode.replaceAll('\n',newline),location=nativeTemplateCallLocation(original,rawFailed());
    assert.equal(location.kind,'string-raw-template-call');assert.equal(location.line,43);assert.equal(location.column,2);
    assert.equal(location.lines.find(line=>line.number===43).text,'``inline``');
    assert.equal(location.parserOnly,false);assert.equal(location.executionOccurred,true);
  }
  assert.equal(nativeTemplateCallLocation(rawCode,{...rawFailed(),isError:false}),null);
  for(const [line,column]of [[45,2],[47,2],[46,1],[46,3],[46,999],[999,2]])assert.equal(nativeTemplateCallLocation(rawCode,rawFailed(line,column)),null);
  const elsewhere=rawFailed();elsewhere.content[0].text=elsewhere.content[0].text.replace('@deepseek-ai/dsh-ptc-runtime-node','another-runtime');
  assert.equal(nativeTemplateCallLocation(rawCode,elsewhere),null);
  const noNativeFrame=rawFailed();noNativeFrame.content[0].text=noNativeFrame.content[0].text.replace(/eval at runProgram[^\n]+/u,'<anonymous>:46:2)');
  assert.equal(nativeTemplateCallLocation(rawCode,noNativeFrame),null);
  assert.equal(nativeTemplateCallLocation(rawCode.replace('Heading','${value}'),rawFailed()),null);
  assert.equal(nativeTemplateCallLocation(rawCode.replace('``inline``','\\`\\`inline\\`\\`'),rawFailed()),null);
  assert.equal(nativeTemplateCallLocation(rawCode.replace('String.raw','anotherTag'),rawFailed()),null);
});

test('actual native String.raw failure exposes its original line and preserves an explicit successful retry',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:rawCode,description:'Execute the recorded raw-template mistake'})];
    if(n===2){
      const context=options.messages.find(message=>message.source?.taskFlow?.key?.includes('native-program-template'));
      assert.ok(context);assert.match(context.content[0].text,/"kind":"string-raw-template-call"/u);
      assert.match(context.content[0].text,/"line":43/u);assert.match(context.content[0].text,/"column":2/u);
      assert.ok(!options.messages.some(message=>message.source?.taskFlow?.key?.includes('program-failure')));
      return [tool('run_code',{code:corrected,description:'Explicitly correct the original raw-template representation'})];
    }
    return [text('42')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'修正原程序字符串包装并返回结果。');
    assert.equal(host.requests.length,3);
    const failures=host.events.filter(event=>event.type==='tool/result'&&event.data.message.isError);
    assert.equal(failures.length,1);assert.match(failures[0].data.message.content[0].text,/String\.raw\(\.\.\.\) is not a function/u);
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch').length,0);
    assert.equal((await host.command(agent,'detail')).taskFlow.unresolvedErrors.length,0);
  }finally{await host.close();}
});

test('actual native runtime failure gets the recorded source window and one explicit corrected invocation',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code,description:'Execute the recorded template mistake'})];
    if(n===2){
      const context=options.messages.find(message=>message.source?.taskFlow?.key?.includes('native-program-template'));
      assert.ok(context);assert.match(context.content[0].text,/"line":43/u);assert.match(context.content[0].text,/``inline``/u);
      assert.ok(context.content[0].text.includes('程序已开始执行'));
      assert.ok(!options.messages.some(message=>message.source?.taskFlow?.key?.includes('program-failure')));
      return [tool('run_code',{code:corrected,description:'Explicitly correct only the string representation'})];
    }
    return [text('42')];
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'修正原程序字符串包装并返回结果。');
    assert.equal(host.requests.length,3);
    const failures=host.events.filter(event=>event.type==='tool/result'&&event.data.message.isError);
    assert.equal(failures.length,1);assert.match(failures[0].data.message.content[0].text,/is not a function/u);
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch').length,0);
    assert.equal((await host.command(agent,'detail')).taskFlow.unresolvedErrors.length,0);
  }finally{await host.close();}
});

test('a partial native program exposes the exact template window and preserves the completed read',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'await tools.read({file_path:"source.txt"});\n'+code,description:'Fail only after the original native read'})];
    const context=options.messages.find(message=>message.source?.taskFlow?.key?.includes('native-program-template'));
    assert.ok(context);assert.match(context.content[0].text,/'priorOperations'|"priorOperations"/u);
    assert.match(context.content[0].text,/"tool":"read"/u);
    assert.ok(!context.content[0].text.includes('尚未观察到内部工具分发'));
    assert.ok(!options.messages.some(message=>message.source?.taskFlow?.key?.includes('program-failure')));
    return [text('原读取已完成，后续程序失败。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'actual source');
    const agent=await host.createAgent('max');await host.send(agent,'读取文件后运行程序并报告实际错误。');
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read').length,1);
    assert.ok((await host.command(agent,'detail')).taskFlow.unresolvedErrors.some(error=>error.tool==='run_code'));
  }finally{await host.close();}
});

test('long escaped template prefixes are located without evaluating interpolation or tag functions',()=>{
  const prefix='line\\n\"quoted\" '+('actual source '.repeat(120));
  const literal=prefix.replaceAll('\\','\\\\').replaceAll('"','\\"');
  const source=padding+'const source = `'+literal+'``inline``;';
  const column=source.split('\n').at(-1).indexOf('``')+2;
  const actual=failed(prefix);actual.content[0].text=actual.content[0].text.replace('at eval (<anonymous>:46:2)',
    'at eval (eval at runProgram (file:///runtime/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js:1031:31), <anonymous>:44:'+column+')');
  const location=nativeTemplateCallLocation(source,actual);
  assert.ok(location);assert.equal(location.literalEscapesDecoded,true);assert.equal(location.line,41);
  assert.equal(location.lines.find(row=>row.number===41).textTruncated,true);
  assert.equal(nativeTemplateCallLocation(source+'\nconst other = `'+literal+'``inline``;',actual),null);
  assert.equal(nativeTemplateCallLocation(source,failed(prefix)),null,'a decoded literal also needs the exact native runtime frame');
  const probe='__workEvidenceTemplateProbe';delete globalThis[probe];
  const interpolation=padding+'const source = `'+literal+'${globalThis.'+probe+'=42}``inline``;';
  assert.equal(nativeTemplateCallLocation(interpolation,actual),null);assert.equal(globalThis[probe],undefined);
  const tagged=padding+'const source = tag`'+literal+'``inline``;';
  assert.equal(nativeTemplateCallLocation(tagged,actual),null);
});

test('a completed write before a template failure is neither hidden nor repeated by recovery',async()=>{
  const source='await tools.write({file_path:"done.txt",content:"completed effect"});\n'+code;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:source,description:'Preserve the effect before the template failure'})];
    if(n===2){
      const context=options.messages.find(message=>message.source?.taskFlow?.key?.includes('native-program-template'));
      assert.ok(context);assert.match(context.content[0].text,/"tool":"write"/u);assert.match(context.content[0].text,/"isError":false/u);
      assert.match(context.content[0].text,/保留已经完成的效果/u);
      return [tool('run_code',{code:corrected,description:'Continue only the unfinished string operation'})];
    }
    return [text('42')];
  }});
  try{
    const agent=await host.createAgent();await host.send(agent,'完成两个动作，保留已成功部分，处理真实失败。');
    assert.equal(await fs.readFile(path.join(host.cwd,'done.txt'),'utf8'),'completed effect');
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='write').length,1);
    assert.equal(host.events.filter(event=>event.type==='tool/result'&&event.data.message.isError).length,1);
    assert.equal((await host.command(agent,'detail')).taskFlow.unresolvedErrors.length,0);
  }finally{await host.close();}
});
