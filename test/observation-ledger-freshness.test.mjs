import test from 'node:test';
import assert from 'node:assert/strict';
import {createObservationLedger} from '../observation-ledger.mjs';

// A direct read dispatches at mutation count 0. A write lands before its
// post-execute registration, so the registration observes count 1. The delivered
// body is pre-write, and only the DISPATCH count can show that. A registration-time
// count (the old behaviour) equals the current count and calls the body fresh.
const body='alpha\nbeta\ngamma';

function fixture(){
  const hooks=new Map();
  const state={dir:null,telemetryDir:null,root:'C:/workspace',step:1,viewEpoch:1,dirty:false,
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
