import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {startHost,text,tool} from './helpers/host.mjs';
import {createStructuredJson} from '../structured-json.mjs';
import {defaults} from '../runtime.mjs';

const signal=()=>AbortSignal.timeout(20000);
const runtime=host=>({get:()=>({root:host.cwd,config:{structuredJson:true}})});
test('native JSON selection reads long single-line data intact with source identity',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    const source='\uFEFF'+JSON.stringify({padding:'x'.repeat(10000),wanted:{code:'ok'}});await fs.writeFile(path.join(host.cwd,'source.json'),source);
    const result=await createStructuredJson(host.ctx,runtime(host)).query({}, {path:'source.json',selectors:[{pointer:'/wanted/code',op:'value'}]},signal());
    assert.equal(result.status,'observed',JSON.stringify(result));assert.equal(result.results[0].value,'ok');assert.equal(result.bom,true);
    assert.equal(result.sha256,createHash('sha256').update(source).digest('hex'));assert.equal(result.versionKind,'native-opaque');assert.ok(result.version);
  }finally{await host.close();}
});
test('the real host renders a deep root selection as an explicit serialized preview',async()=>{
  const host=await startHost({workspace:{structuredJson:true},script:()=>[text('done')]});
  try{
    const source='['.repeat(7000)+'0'+']'.repeat(7000);await fs.writeFile(path.join(host.cwd,'deep.json'),source);
    const agent=await host.createAgent(),result=await host.ctx.tools.execute({name:'structured_json',arguments:{path:'deep.json',maxValueChars:16000,
      selectors:[{pointer:'',op:'value'}]},callId:'deep-root',rootCallId:'deep-root',agent,signal:signal()});
    assert.equal(result.isError,false,JSON.stringify(result));const view=result.value.results[0];
    assert.equal(view.complete,false);assert.equal(view.valueOmittedReason,'nesting-depth-limit');assert.equal(view.serializedPreview,source);
  }finally{await host.close();}
});
test('native JSON rejects concurrent changes, invalid encoding and unsafe numbers without false results',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    const filename=path.join(host.cwd,'source.json');await fs.writeFile(filename,'{"x":1}');const backend=host.ctx.get('fs');
    const modified=new Proxy(backend,{get(target,key){
      if(key==='readBytes')return async(...args)=>{const bytes=await backend.readBytes(...args);await fs.writeFile(filename,'{"x":200}');return bytes;};
      return Reflect.get(target,key);
    }});
    const input={path:'source.json',selectors:[{pointer:'/x',op:'value'}]};
    assert.equal((await createStructuredJson({get:()=>modified},runtime(host)).query({},input,signal())).reason,'SOURCE_CHANGED');
    await fs.writeFile(filename,Buffer.from([0xFF,0xFE]));
    assert.equal((await createStructuredJson(host.ctx,runtime(host)).query({},input,signal())).reason,'JSON_NOT_UTF8');
    await fs.writeFile(filename,'{"x":9007199254740993}');
    const unsafe=await createStructuredJson(host.ctx,runtime(host)).query({},input,signal());assert.equal(unsafe.reason,'JSON_NUMBER_UNSAFE');assert.equal(unsafe.results,undefined);
  }finally{await host.close();}
});
test('disabled JSON selection cannot read and settings require booleans',async()=>{
  const ctx={get:()=>{throw new Error('Read is not allowed');}};
  assert.equal((await createStructuredJson(ctx,{get:()=>({config:{structuredJson:false}})}).query({}, {},signal())).status,'disabled');
  for(const key of ['structuredJson','fileProfiling']){assert.equal(defaults()[key],false);assert.throws(()=>defaults({[key]:'yes'}));}
  for(const patch of [{format:null},{maxValueChars:null}])assert.equal((await createStructuredJson(ctx,{get:()=>({config:{structuredJson:true}})}).query({}, {path:'file.json',selectors:[{pointer:'',op:'value'}],...patch},signal())).reason,'INVALID_JSON_OPTIONS');
});

test('a native provider short read cannot certify a complete JSON source',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    await fs.writeFile(path.join(host.cwd,'source.json'),'{"x":1}    ');const backend=host.ctx.get('fs');
    const shortened=new Proxy(backend,{get(target,key){if(key==='readBytes')return async()=>Buffer.from('{"x":1}');return Reflect.get(target,key);}});
    const result=await createStructuredJson({get:()=>shortened},runtime(host)).query({}, {path:'source.json',selectors:[{pointer:'/x',op:'value'}]},signal());
    assert.equal(result.status,'unavailable');assert.equal(result.reason,'FS_READ_INCOMPLETE');assert.equal(result.results,undefined);
  }finally{await host.close();}
});
test('a versioned JSONL provider without a known byte size cannot certify a short prefix',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    await fs.writeFile(path.join(host.cwd,'source.jsonl'),'{"x":1}\n{"x":2}\n');const backend=host.ctx.get('fs');let reads=0;
    const unknown=new Proxy(backend,{get(target,key){
      if(key==='stat')return async(...args)=>({...await backend.stat(...args),size:undefined});
      if(key==='readBytes')return async()=>{reads++;return Buffer.from('{"x":1}\n');};
      return Reflect.get(target,key);
    }});
    const result=await createStructuredJson({get:()=>unknown},runtime(host)).query({}, {path:'source.jsonl',format:'jsonl',selectors:[{pointer:'',op:'count'}]},signal());
    assert.equal(result.status,'unavailable');assert.equal(result.reason,'FS_SIZE_UNKNOWN');assert.equal(result.results,undefined);assert.equal(reads,0);
  }finally{await host.close();}
});
test('native PTC exposes selected read tools in compact mode and records their real effects',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],workspace:{fileProfiling:true,structuredJson:true},
    script:(_options,n)=>n===1?[tool('run_code',{code:'const a=await tools.file_profile({files:[{path:"input.csv",format:"csv"}],scan:"complete"});const b=await tools.structured_json({path:"input.json",selectors:[{pointer:"/ok",op:"value"}]});console.log(JSON.stringify({a,b}));',description:'Read declared data'})]:[text('Read the actual data.')]});
  try{
    await fs.writeFile(path.join(host.cwd,'input.csv'),'a,b\n1,2\n');await fs.writeFile(path.join(host.cwd,'input.json'),'{"ok":true}');
    const agent=await host.createAgent();await host.send(agent,'Inspect input.csv and input.json without changing files.');
    const events=host.events;
    const dispatch=events.filter(event=>['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type));
    for(const name of ['file_profile','structured_json']){
      const event=dispatch.find(event=>event.data.name===name);assert.ok(event,name);assert.equal(event.data.isError,false);
      const value=JSON.parse(event.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'));
      assert.equal(value.status,'observed',JSON.stringify(value));
      if(name==='file_profile')assert.equal(value.files[0].analysis.csv.records,2);
      else assert.equal(value.results[0].value,true);
    }
    const status=await host.command(agent,'features');
    for(const key of ['fileProfiling','structuredJson']){
      const item=status.features.find(item=>item.key===key);assert.ok(item,key);assert.ok(item.effect.applied>0,JSON.stringify(item));
    }
  }finally{await host.close();}
});
