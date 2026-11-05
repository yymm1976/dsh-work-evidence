import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {executionFailureFrames,recordedSourceExcerpt} from '../recovery.mjs';
import {startHost,tool,text,requestText} from './helpers/host.mjs';

const root=path.resolve('fixture-project'),file=path.join(root,'lib','broken.cjs');
const failure=stderr=>({isError:false,value:{exitCode:1,stderr:{text:stderr,truncated:false},stdout:{text:'',truncated:false}}});

test('failed execution frames distinguish project files from success, pending and incomplete output',()=>{
  const stderr=file+':2\nthrow new Error("actual failure");\n      ^\nError: actual failure\n    at Object.<anonymous> ('+file+':2:7)';
  const frames=executionFailureFrames(failure(stderr),root);
  assert.equal(frames[0].path,file);assert.equal(frames[0].line,2);
  assert.equal(frames[0].printedLine,'throw new Error("actual failure");');
  for(const change of [{exitCode:0},{kind:'background'},{timedOut:true},{signal:'SIGTERM'},{partial:true},
    {stderr:{text:stderr,truncated:true}},{stderr:{text:stderr,complete:false}},{exitCode:null}])
    assert.deepEqual(executionFailureFrames({value:{...failure(stderr).value,...change}},root),[]);
  assert.deepEqual(executionFailureFrames(failure(path.join(root,'..','outside.cjs')+':2\nthrow 1;'),root),[]);
  assert.deepEqual(executionFailureFrames({isError:true,content:[{type:'text',text:'Operation denied: '+stderr}]},root),[]);
  assert.equal(executionFailureFrames(failure('Error: issue\n at '+pathToFileURL(file).href+':2:7'),root)[0].line,2);
  const python=path.join(root,'broken.py');
  assert.equal(executionFailureFrames(failure('Traceback (most recent call last):\n  File "'+python+'", line 3, in <module>\n    raise ValueError("actual")\nValueError: actual'),root)[0].path,python);
});

test('recorded excerpts keep replacement-relative line numbers and decline ambiguous fragments',()=>{
  const frame={path:file,line:201,column:null,printedLine:'* const example = ["**", "!**/node_modules/**"];'};
  const replacement='/**\n * prior source context\n '+frame.printedLine+'\n */\nconst run = true;';
  const event={seq:42,type:'tool/ptc-dispatch',data:{name:'edit',arguments:{file_path:'lib/broken.cjs',new_string:replacement}}};
  const excerpt=recordedSourceExcerpt(event,frame);
  assert.equal(excerpt.scope,'recorded-replacement-window');assert.equal(excerpt.frame.line,201);
  assert.equal(excerpt.lines[2].recordLine,3);assert.match(excerpt.lines[1].text,/prior source context/);
  assert.equal(excerpt.currentFileState,'not-observed');
  assert.equal(recordedSourceExcerpt({...event,data:{...event.data,arguments:{new_string:replacement+'\n '+frame.printedLine}}},frame),null);
  const whole={seq:43,data:{name:'write',arguments:{content:'// original source\nthrow new Error("actual failure");\n'}}};
  assert.equal(recordedSourceExcerpt(whole,{...frame,line:2,printedLine:null}).lines[0].text,'// original source');
  assert.equal(recordedSourceExcerpt(event,{...frame,printedLine:null}),null);
});

test('native PTC carries recorded source through the next-step context without changing a failed process result',async()=>{
  const body='// source context sentinel\nthrow new Error("actual execution failure");\n';
  let processResult,context;
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{aggressiveMode:true,stepPacing:false},
    script:(options,n)=>{
      if(n===1)return [tool('run_code',{code:'return await tools.write('+JSON.stringify({file_path:'broken.cjs',content:body})+');',description:'Write requested source'})];
      if(n===2)return [tool('run_code',{code:'const r=await tools.pwsh({command:"node broken.cjs",description:"Run requested program"});console.log(r.stderr.text);',description:'Observe actual failure'})];
      context=options.messages.find(message=>message.source?.taskFlow?.key?.includes('file-failure-source'));
      assert.ok(context,'native nested-tool context reaches the next model request');
      assert.match(requestText(options),/source context sentinel/);
      return [text('已取得实际失败位置。')];
    }});
  host.ctx.on('tools/result',(exec,result)=>{if(exec.name==='pwsh')processResult=result;});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'创建 broken.cjs 并运行，说明实际执行失败。');
    assert.ok(context);assert.equal(host.requests.length,3);
    assert.equal(processResult.isError,false);assert.equal(processResult.value.exitCode,1);
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='read').length,0);
    const status=await host.command(agent,'detail');
    assert.ok(status.taskFlow.unresolvedErrors.some(error=>error.tool==='pwsh'));
  }finally{await host.close();}
});
