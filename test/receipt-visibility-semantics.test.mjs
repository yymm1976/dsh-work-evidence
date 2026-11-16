import test from 'node:test';
import assert from 'node:assert/strict';
import {createObservationLedger} from '../observation-ledger.mjs';

// F2-C step 235/236, the only plugin defect in that arm with a complete causal chain.
//
//   step 235  read group_sender_concurrency.py offset 843 limit 55  -> ledger receipt
//   step 235  read group_sender_concurrency.py offset 1016 limit 55 -> ledger receipt
//   step 236  thinking: "Need actual content of 843-897 ... from earlier memory;
//             we can read 853-875 and 1030-1046 (small) to avoid ledger receipt?"
//   step 236  read offset 856 limit 20  -> ledger receipt (obs#54)
//   step 236  read offset 1030 limit 20 -> ledger receipt (obs#54)
//
// The model understood the trap and deliberately narrowed its window to escape it, and
// the ledger still answered with a receipt, because bestCanonical matches any prior window
// that CONTAINS the requested one. So a receipt is not merely misleading text: it is a
// closure. Once a range has been receipted, no re-read of any part of it can return the
// body, and the only remaining route is work_recall — which the model then has to guess
// it needs.
//
// The invariant: a receipt may only replace a body that is STILL DELIVERED in this
// request. A window that the model is actively re-asking for is, by that act, not
// redundant.

// Rows must look like real source: MIN_RECEIPT_BODY is 480 chars, so a 12-line window of
// short rows never reaches the receipt branch at all and a regression here would pass by
// accident. These rows are ~75 chars, the width of the AstrNa lines in the arm.
const ROWS=Array.from({length:200},(_,i)=>
  `${String(i+1).padStart(4,' ')}:     self._value_${i} = compute_value(${i}, options=self._options)`);
const body=ROWS.join('\n');
// Two windows inside one file; the second is a strict subset of the first, which is exactly
// the step-235/236 shape (843-897 then 856-875).
const wide={offset:40,limit:40};
const narrow={offset:48,limit:12};

function fixture({receipt=true}={}){
  const hooks=new Map();
  const state={dir:null,telemetryDir:null,root:'C:/workspace',step:2,viewEpoch:1,dirty:false,
    config:{ledgerReceipt:receipt,ledgerUnresolved:true,stateLedger:false,evidenceViews:true,defaultResponseView:'auto'},
    metrics:{ledgerObservations:0,ledgerReceipts:0,ledgerReceiptCharsSaved:0,ledgerStale:0},problems:[]};
  const runtime={get:()=>state,isEnabled:()=>true,problem:()=>{},effects:null,canRecall:()=>true};
  const log=[];
  const agent={session:{id:'sess-vis',seq:1,surface:{nodes:[]},log,
    eventAt:seq=>log.find(event=>event.seq===seq)}};
  const ctx={on:(name,fn)=>{const list=hooks.get(name)??[];list.push(fn);hooks.set(name,list);},
    workingDirectory:{ensure:async()=>state.root},agents:{get:id=>id===agent.session.id?agent:null}};
  const ledger=createObservationLedger(ctx,runtime,null);ledger.observe();
  const post=(exec,result)=>hooks.get('tools/post-execute')[0](exec,result,async()=>({kind:'accept'}));
  const sessionEvent=event=>{log.push(event);hooks.get('session/event')[0](agent.session,event);};
  return {agent,state,ledger,post,sessionEvent,log};
}

/** A read result whose value carries line records, the shape `collectReadWindows` needs. */
const readValue=(file,offset,limit)=>({path:file,lines:ROWS.slice(offset-1,offset-1+limit).map((text,i)=>({line:offset+i,text}))});

async function readWindow(f,{seq,callId,offset,limit}){
  const file='pkg/module.py';
  const value=readValue(file,offset,limit);
  const text=`<path>${file}</path>\n<type>file</type>\n<content>\n${ROWS.slice(offset-1,offset-1+limit).map((row,i)=>`${offset+i}: ${row}`).join('\n')}\n</content>`;
  // post-execute returns the decision that carries the content the model will see: it may
  // have replaced `result.content` with a receipt, and that replacement is the thing under
  // test. Asserting on the raw read text would assert on what the tool produced instead of
  // on what was delivered.
  const decision=await f.post({agent:f.agent,name:'read',callId,arguments:{file_path:file,offset,limit},mutationCountAtDispatch:0},
    {isError:false,content:[{type:'text',text}],value});
  const delivered=(decision?.content??[{type:'text',text}]).map(block=>block.text??'').join('');
  f.agent.session.surface.nodes.push(seq);
  f.sessionEvent({seq,type:'tool/result',data:{turn:1,step:1,message:{role:'tool',
    source:{callId},isError:false,content:[{type:'text',text:delivered}]}}});
  return delivered;
}

test('a narrower re-read inside a receipted range still delivers the body',async()=>{
  const f=fixture();
  await readWindow(f,{seq:11,callId:'read-wide',...wide});
  const [first]=f.ledger.detail(f.agent).observations;
  assert.ok(first,'the wide read was recorded');
  // The model now asks for a small window inside the range it was just handed.
  const narrowText=await readWindow(f,{seq:13,callId:'read-narrow',...narrow});
  const observations=f.ledger.detail(f.agent).observations;
  const second=observations.at(-1);
  assert.ok(second,'the narrow read was recorded');
  // Re-reading a live range is a request for the body. Answering it with a receipt closes
  // every remaining route to content the model has already told us it needs.
  assert.equal(second.receiptChars??0,0,'a narrower re-read is not answered by a receipt');
  assert.ok(narrowText.includes('self._value_'+(narrow.offset-1)+' ='),'the body is still available to deliver');
});

test('an identical repeat of a still-delivered range may still be receipted',async()=>{
  // The control. A receipt exists to remove a DUPLICATE body, and an identical repeat is
  // the case it was built for. Removing the receipt entirely would be a capability loss,
  // so the fix must keep this behaviour.
  const f=fixture();
  await readWindow(f,{seq:11,callId:'read-a',...wide});
  const before=f.state.metrics.ledgerReceipts;
  await readWindow(f,{seq:13,callId:'read-b',...wide});
  assert.ok(f.state.metrics.ledgerReceipts>before,'an identical repeat is still receipted');
});

test('the receipt says the rows were not delivered and names the lookup',async()=>{
  // The text itself is the defect in 092: `visible=yes` was read as "already in hand".
  // A receipt must say the opposite — these rows were NOT sent this turn — and must name
  // the call that returns them, because a model that has to guess a recovery path does not
  // take it. Both facts are asserted on the DELIVERED text, which is the only thing the
  // model sees.
  const f=fixture();
  await readWindow(f,{seq:11,callId:'read-a',...wide});
  const delivered=await readWindow(f,{seq:13,callId:'read-b',...wide});
  assert.ok(f.state.metrics.ledgerReceipts>0,'the repeat produced a receipt');
  // The old field must be gone: it is the string that was misread.
  assert.ok(!/visible=yes/u.test(delivered),'the ambiguous field is not emitted');
  assert.ok(/delivered=no/u.test(delivered),'the receipt states the rows were not delivered');
  assert.ok(/work_recall kind=output seq=\d+/u.test(delivered),'and names the call that returns them');
  assert.ok(/Do not edit or reason about these lines from memory/u.test(delivered),
    'and forbids editing from memory, which is what 092 actually did');
});
