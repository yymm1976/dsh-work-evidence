import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {startHost,text} from './helpers/host.mjs';
import {createFileProfiler} from '../file-profile.mjs';

const signal=()=>AbortSignal.timeout(20000);
const runtime=host=>({get:()=>({root:host.cwd,config:{fileProfiling:true}})});

test('a real native complete CSV scan reports exact independent counts and decoded text identity',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    const source='id,value\r\n1,"a\nb"\r\n2,z\r\n';await fs.writeFile(path.join(host.cwd,'input.csv'),source);
    const result=await createFileProfiler(host.ctx,runtime(host)).observe({}, {files:[{path:'input.csv',format:'csv'}],scan:'complete'},signal());
    assert.equal(result.status,'observed',JSON.stringify(result));const value=result.files[0];
    assert.equal(value.scope,'complete');assert.equal(value.versionKind,'native-opaque');assert.ok(value.version);
    assert.equal(value.analysis.csv.records,3);assert.equal(value.analysis.physicalLines,4);
    assert.deepEqual(value.analysis.newlines,{crlf:3,lf:1,cr:0});assert.deepEqual(value.analysis.csv.fieldCounts,[{fields:2,count:3}]);
    assert.equal(value.decodedTextSha256,createHash('sha256').update(source).digest('hex'));assert.equal(value.scannedBytes,Buffer.byteLength(source));
  }finally{await host.close();}
});

test('large-file samples do not claim global CSV counts while small files can be read completely',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    await fs.writeFile(path.join(host.cwd,'large.csv'),'a,b\n'.repeat(10000)+'LAST,ROW\n');await fs.writeFile(path.join(host.cwd,'small.csv'),'\uFEFFa,b\r\n1,2');
    const result=await createFileProfiler(host.ctx,runtime(host)).observe({}, {files:[{path:'large.csv',format:'csv'},{path:'small.csv',format:'csv'}]},signal());
    assert.equal(result.status,'observed',JSON.stringify(result));const [large,small]=result.files;
    assert.equal(large.scope,'sampled');assert.equal(large.scanComplete,false);assert.equal(large.analysis,undefined);
    assert.equal(large.scannedBytes,16390);assert.equal(large.samples.at(-1).endsAtFileBoundary,true);
    assert.ok(large.samples.at(-1).preview.some(line=>line.text==='LAST,ROW'),'the tail preview includes the actual final line');
    assert.equal(small.scope,'complete');assert.equal(small.analysis.csv.records,2);assert.equal(small.analysis.csv.valid,true);
  }finally{await host.close();}
});

test('invalid UTF-8 sampled bytes have the same explicit text error as a complete scan',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    await fs.writeFile(path.join(host.cwd,'invalid.txt'),Buffer.from([0xFF]));
    const result=await createFileProfiler(host.ctx,runtime(host)).observe({}, {files:[{path:'invalid.txt'}]},signal());
    assert.equal(result.files[0].error.code,'PROFILE_NOT_UTF8_TEXT');
  }finally{await host.close();}
});
test('sampled UTF-8 boundaries reject malformed bytes instead of dropping them',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    for(const [offset,byte] of [[40000-8192,0x80],[8191,0xC2]]){
      const bytes=Buffer.alloc(40000,0x61);bytes[offset]=byte;await fs.writeFile(path.join(host.cwd,'invalid-boundary.txt'),bytes);
      const result=await createFileProfiler(host.ctx,runtime(host)).observe({}, {files:[{path:'invalid-boundary.txt'}]},signal());
      assert.equal(result.files[0].status,'unavailable');assert.equal(result.files[0].error.code,'PROFILE_NOT_UTF8_TEXT');
    }
  }finally{await host.close();}
});
test('sampled UTF-8 boundaries accept valid characters spanning the original ranges',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    const bytes=Buffer.alloc(40000,0x61);Buffer.from('😀').copy(bytes,8191);Buffer.from('😀').copy(bytes,40000-8192-1);
    await fs.writeFile(path.join(host.cwd,'valid-boundary.txt'),bytes);
    const result=await createFileProfiler(host.ctx,runtime(host)).observe({}, {files:[{path:'valid-boundary.txt'}]},signal());
    assert.equal(result.status,'observed',JSON.stringify(result));assert.equal(result.files[0].scope,'sampled');
    const contiguous=Buffer.alloc(9000,0x61);Buffer.from('😀').copy(contiguous,8191);await fs.writeFile(path.join(host.cwd,'contiguous.txt'),contiguous);
    const complete=await createFileProfiler(host.ctx,runtime(host)).observe({}, {files:[{path:'contiguous.txt'}]},signal());
    assert.equal(complete.status,'observed',JSON.stringify(complete));assert.equal(complete.files[0].scope,'complete');assert.equal(complete.files[0].scannedBytes,9000);
  }finally{await host.close();}
});

test('a source mutation during the native ranges rejects its counts',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    const filename=path.join(host.cwd,'input.csv');await fs.writeFile(filename,'a,b\n');const backend=host.ctx.get('fs');
    const modified=new Proxy(backend,{get(target,key){
      if(key==='readByteRange')return async(...args)=>{
        const before=await backend.stat(args[0],args[2]),bytes=await backend.readByteRange(...args);
        await fs.writeFile(filename+'.new','z,z\n');await fs.rename(filename+'.new',filename);
        const after=await backend.stat(args[0],args[2]);assert.equal(before.size,after.size);assert.notEqual(before.version,after.version);
        return bytes;
      };
      return Reflect.get(target,key);
    }});
    const ctx={get:name=>name==='fs'?modified:host.ctx.get(name)};
    const result=await createFileProfiler(ctx,runtime(host)).observe({}, {files:[{path:'input.csv',format:'csv'}],scan:'complete'},signal());
    assert.equal(result.status,'partial');assert.equal(result.files[0].error.code,'SOURCE_CHANGED');assert.equal(result.files[0].analysis,undefined);
  }finally{await host.close();}
});

test('complete native scans preserve BOM and decode UTF-8 across range boundaries',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    const source='\uFEFF'+ 'x'.repeat(65532)+'😀\r\nnext\r\n';await fs.writeFile(path.join(host.cwd,'boundary.txt'),source);
    const result=await createFileProfiler(host.ctx,runtime(host)).observe({}, {files:[{path:'boundary.txt'}],scan:'complete'},signal());
    assert.equal(result.status,'observed',JSON.stringify(result));const value=result.files[0];
    assert.equal(value.scannedBytes,Buffer.byteLength(source));assert.equal(value.analysis.physicalLines,2);
    assert.equal(value.decodedTextSha256,createHash('sha256').update(source).digest('hex'));
    assert.deepEqual(value.analysis.newlines,{crlf:2,lf:0,cr:0});
    for(const bytes of [Buffer.from([0xE1,0x80]),Buffer.from('text\0data')]){
      await fs.writeFile(path.join(host.cwd,'boundary.txt'),bytes);
      const invalid=await createFileProfiler(host.ctx,runtime(host)).observe({}, {files:[{path:'boundary.txt'}],scan:'complete'},signal());
      assert.equal(invalid.files[0].status,'unavailable');assert.equal(invalid.files[0].error.code,'PROFILE_NOT_UTF8_TEXT');assert.equal(invalid.files[0].analysis,undefined);
    }
  }finally{await host.close();}
});

test('native canonical containment rejects a directory junction to another workspace',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]}),outside=await fs.mkdtemp(path.join(os.tmpdir(),'we-profile-outside-'));
  try{
    await fs.writeFile(path.join(outside,'private.csv'),'private,source\n');await fs.symlink(outside,path.join(host.cwd,'alias'),'junction');
    const result=await createFileProfiler(host.ctx,runtime(host)).observe({}, {files:[{path:'alias/private.csv',format:'csv'}]},signal());
    assert.equal(result.status,'partial');assert.equal(result.files[0].error.code,'FS_OUTSIDE_WORKSPACE');assert.equal(result.files[0].analysis,undefined);
  }finally{
    await host.close();assert.equal(path.dirname(outside),path.resolve(os.tmpdir()));assert.ok(path.basename(outside).startsWith('we-profile-outside-'));
    await fs.rm(outside,{recursive:true,force:true});
  }
});

test('complete scans respect the aggregate byte budget before reading and report invalid CSV honestly',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    await fs.writeFile(path.join(host.cwd,'large.txt'),'x'.repeat(5000));await fs.writeFile(path.join(host.cwd,'bad.csv'),'"unterminated');
    const profiler=createFileProfiler(host.ctx,runtime(host));
    const bounded=await profiler.observe({}, {files:[{path:'large.txt'}],scan:'complete',maxBytes:4096},signal());
    assert.equal(bounded.files[0].error.code,'PROFILE_BYTE_BUDGET');assert.equal(bounded.bytesRead,0);
    const invalid=await profiler.observe({}, {files:[{path:'bad.csv',format:'csv'}],scan:'complete'},signal());
    assert.equal(invalid.status,'partial');assert.equal(invalid.files[0].analysis.csv.valid,false);assert.equal(invalid.files[0].scanComplete,true);
  }finally{await host.close();}
});

test('disabled profiles do not access a filesystem and invalid plans do not claim observations',async()=>{
  const ctx={get:()=>{throw new Error('No read is allowed');}},runtime={get:()=>({config:{fileProfiling:false}})};
  assert.equal((await createFileProfiler(ctx,runtime).observe({}, {files:[{path:'x'}]},signal())).status,'disabled');
  runtime.get=()=>({config:{fileProfiling:true}});
  for(const input of [{files:[]},{files:[{path:'x'}],scan:'unknown'},{files:[{path:'x',format:'csv',delimiter:'::'}]}])
    assert.equal((await createFileProfiler(ctx,runtime).observe({},input,signal())).status,'deopt');
});

test('a failed tail read still charges its successful head against later files',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('done')]});
  try{
    await fs.writeFile(path.join(host.cwd,'first.txt'),'a'.repeat(10000));await fs.writeFile(path.join(host.cwd,'second.txt'),'b'.repeat(8192));
    const backend=host.ctx.get('fs');let calls=0;
    const modified=new Proxy(backend,{get(target,key){
      if(key==='readByteRange')return async(...args)=>{calls++;if(calls===2)throw new Error('The tail failed');return backend.readByteRange(...args);};
      return Reflect.get(target,key);
    }});
    const result=await createFileProfiler({get:()=>modified},runtime(host)).observe({}, {files:[{path:'first.txt'},{path:'second.txt'}],maxBytes:10000},signal());
    assert.equal(calls,2);assert.equal(result.bytesRead,8192);assert.equal(result.files[0].status,'unavailable');
    assert.equal(result.files[1].error.code,'PROFILE_BYTE_BUDGET');
  }finally{await host.close();}
});
