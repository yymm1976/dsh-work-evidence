import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createObservationLedger} from '../observation-ledger.mjs';

// A direct read dispatches at mutation count 0. A write lands before its
// post-execute registration, so the registration observes count 1. The delivered
// body is pre-write, and only the DISPATCH count can show that. A registration-time
// count (the old behaviour) equals the current count and calls the body fresh.
const body='alpha\nbeta\ngamma';

function fixture(root='C:/workspace'){
  const hooks=new Map();
  const state={dir:null,telemetryDir:null,root,step:1,viewEpoch:1,dirty:false,
    config:{ledgerReceipt:false,ledgerUnresolved:true,stateLedger:false,evidenceViews:false},
    metrics:{ledgerObservations:0,ledgerReceipts:0,ledgerReceiptCharsSaved:0,ledgerStale:0},problems:[]};
  const runtime={get:()=>state,isEnabled:()=>true,problem:()=>{},effects:null};
  const agent={session:{id:'sess-freshness',seq:10,surface:{nodes:[]},log:[]}};
  const ctx={on:(name,fn)=>{const list=hooks.get(name)??[];list.push(fn);hooks.set(name,list);},
    workingDirectory:{ensure:async()=>state.root},agents:{get:id=>id===agent.session.id?agent:null}};
  const ledger=createObservationLedger(ctx,runtime,null);ledger.observe();
  const post=(exec,result)=>hooks.get('tools/post-execute')[0](exec,result,async()=>({kind:'accept'}));
  const sessionEvent=event=>hooks.get('session/event')[0](agent.session,event);
  return {agent,state,ledger,post,sessionEvent};
}

test('a write between direct-read dispatch and registration marks the body stale',async()=>{
  const f=fixture();
  // The write completes while the read is in flight, before the read is registered.
  await f.post({agent:f.agent,name:'write',callId:'write-1',arguments:{file_path:'a.txt'},mutationCountAtDispatch:0},
    {isError:false,value:{path:'a.txt'},content:[]});
  // The read was issued before that write. post-execute can no longer prove the
  // delivered body is post-write, so the pending entry must carry the dispatch count.
  await f.post({agent:f.agent,name:'read',callId:'read-1',arguments:{file_path:'a.txt'},mutationCountAtDispatch:0},
    {isError:false,content:[{type:'text',text:body}],value:{path:'a.txt',lines:[
      {line:1,text:'alpha'},{line:2,text:'beta'},{line:3,text:'gamma'}]}});
  f.agent.session.surface.nodes.push(11);
  f.sessionEvent({seq:11,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',
    source:{callId:'read-1'},isError:false,content:[{type:'text',text:body}]}}});

  const [observation]=f.ledger.detail(f.agent).observations;
  assert.equal(observation.stale,true,'a write after dispatch makes the delivered body historical');
  assert.equal(observation.windows[0].stale,true);
  assert.equal(observation.windows[0].staleCause,'known-write');
});

test('a read issued after the last write stays fresh',async()=>{
  const f=fixture();
  await f.post({agent:f.agent,name:'write',callId:'write-1',arguments:{file_path:'a.txt'},mutationCountAtDispatch:0},
    {isError:false,value:{path:'a.txt'},content:[]});
  await f.post({agent:f.agent,name:'read',callId:'read-2',arguments:{file_path:'a.txt'},mutationCountAtDispatch:1},
    {isError:false,content:[{type:'text',text:body}],value:{path:'a.txt',lines:[
      {line:1,text:'alpha'},{line:2,text:'beta'},{line:3,text:'gamma'}]}});
  f.agent.session.surface.nodes.push(11);
  f.sessionEvent({seq:11,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',
    source:{callId:'read-2'},isError:false,content:[{type:'text',text:body}]}}});
  const [observation]=f.ledger.detail(f.agent).observations;
  assert.equal(observation.stale,false,'a read dispatched after the write is current');
});

test('a verified_exec preview does not invalidate an earlier read',async()=>{
  const f=fixture();
  await f.post({agent:f.agent,name:'read',callId:'read-preview',arguments:{file_path:'a.txt'},mutationCountAtDispatch:0},
    {isError:false,content:[{type:'text',text:body}],value:{path:'a.txt',lines:[
      {line:1,text:'alpha'},{line:2,text:'beta'},{line:3,text:'gamma'}]}});
  await f.post({agent:f.agent,name:'verified_exec',callId:'preview-1',mutationCountAtDispatch:0,
    arguments:{summary:'preview only',apply:false,edits:[{file:'a.txt',mode:'replace_exact',old_text:'beta',new_text:'BETA'}]}},
  {isError:false,content:[],value:{status:'previewed',effectState:'none',files:[{path:'a.txt',effectState:'none'}]}});
  f.agent.session.surface.nodes.push(11);
  f.sessionEvent({seq:11,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',
    source:{callId:'read-preview'},isError:false,content:[{type:'text',text:body}]}}});
  const [observation]=f.ledger.detail(f.agent).observations;
  assert.equal(observation.stale,false,'a preview made no file change');
});

test('a verified_exec apply invalidates an earlier read through the producer file field',async()=>{
  const f=fixture();
  await f.post({agent:f.agent,name:'read',callId:'read-applied',arguments:{file_path:'a.txt'},mutationCountAtDispatch:0},
    {isError:false,content:[{type:'text',text:body}],value:{path:'a.txt',lines:[
      {line:1,text:'alpha'},{line:2,text:'beta'},{line:3,text:'gamma'}]}});
  await f.post({agent:f.agent,name:'verified_exec',callId:'applied-1',mutationCountAtDispatch:0,
    arguments:{summary:'replace beta',apply:true,edits:[{file:'a.txt',mode:'replace_exact',old_text:'beta',new_text:'BETA'}]}},
  {isError:false,content:[],value:{status:'applied',effectState:'applied',files:[{file:'a.txt',effectState:'applied'}]}});
  f.agent.session.surface.nodes.push(11);
  f.sessionEvent({seq:11,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',
    source:{callId:'read-applied'},isError:false,content:[{type:'text',text:body}]}}});
  const [observation]=f.ledger.detail(f.agent).observations;
  assert.equal(observation.stale,true,'the applied file field must invalidate the pre-edit read');
});

test('paths that differ only by case are not merged without a host identity proof',async()=>{
  const f=fixture();
  await f.post({agent:f.agent,name:'write',callId:'write-upper',arguments:{file_path:'A.txt'},mutationCountAtDispatch:0},
    {isError:false,value:{path:'A.txt'},content:[]});
  await f.post({agent:f.agent,name:'read',callId:'read-lower',arguments:{file_path:'a.txt'},mutationCountAtDispatch:1},
    {isError:false,content:[{type:'text',text:body}],value:{path:'a.txt',lines:[
      {line:1,text:'alpha'},{line:2,text:'beta'},{line:3,text:'gamma'}]}});
  f.agent.session.surface.nodes.push(11);
  f.sessionEvent({seq:11,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',
    source:{callId:'read-lower'},isError:false,content:[{type:'text',text:body}]}}});
  const [observation]=f.ledger.detail(f.agent).observations;
  assert.equal(observation.stale,false,'a different path spelling cannot inherit another file write');
});

test('a case-distinct sibling file keeps its own observation identity',async()=>{
  const f=fixture();
  await f.post({agent:f.agent,name:'write',callId:'write-parser',arguments:{file_path:'src/Parser.js'},mutationCountAtDispatch:0},
    {isError:false,value:{path:'src/Parser.js'},content:[]});
  await f.post({agent:f.agent,name:'read',callId:'read-lower-parser',arguments:{file_path:'src/parser.js'},mutationCountAtDispatch:1},
    {isError:false,content:[{type:'text',text:body}],value:{path:'src/parser.js',lines:[
      {line:1,text:'alpha'},{line:2,text:'beta'},{line:3,text:'gamma'}]}});
  f.agent.session.surface.nodes.push(11);
  f.sessionEvent({seq:11,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',
    source:{callId:'read-lower-parser'},isError:false,content:[{type:'text',text:body}]}}});
  const [observation]=f.ledger.detail(f.agent).observations;
  assert.equal(observation.path,'src/parser.js');
  assert.equal(observation.stale,false,'Parser.js and parser.js are distinct identities');
});

test('a write through a physical alias invalidates the observed target',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'we-ledger-alias-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const real=path.join(root,'real.txt');
  await fs.writeFile(real,'alpha\nbeta\ngamma');
  let alias=path.join(root,'REAL.txt');
  const caseAlias=await fs.stat(alias).then(()=>true,()=>false);
  if(!caseAlias){
    alias=path.join(root,'alias.txt');
    try{await fs.symlink(real,alias,'file');}
    catch(error){t.skip('The host cannot create a file alias for this check: '+error.code);return;}
  }
  const f=fixture(root);
  await f.post({agent:f.agent,name:'read',callId:'read-real',arguments:{file_path:real},mutationCountAtDispatch:0},
    {isError:false,content:[{type:'text',text:body}],value:{path:real,lines:[
      {line:1,text:'alpha'},{line:2,text:'beta'},{line:3,text:'gamma'}]}});
  await f.post({agent:f.agent,name:'write',callId:'write-alias',arguments:{file_path:alias},mutationCountAtDispatch:0},
    {isError:false,value:{path:alias},content:[]});
  f.agent.session.surface.nodes.push(11);
  f.sessionEvent({seq:11,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',
    source:{callId:'read-real'},isError:false,content:[{type:'text',text:body}]}}});
  const [observation]=f.ledger.detail(f.agent).observations;
  assert.equal(observation.stale,true,'the observed real target must be invalidated by a write through its alias');
});
