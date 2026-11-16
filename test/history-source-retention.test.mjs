import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryHygiene,toolOutputDigest} from '../history-hygiene.mjs';
import {looksLikeSourceBody} from '../context-pruning.mjs';

// The history-hygiene projection is another place a tool body can be reduced. Its generic
// digest branch ran before the source-retention rule, so `bash cat src/widget.py` — a whole
// file with no native read dispatch and no markup — was replaced by a head/tail receipt and
// lost its middle.
//
// The fixture must satisfy every early return in `project()`: `isEnabled`,
// `config.historyHygiene`, a recall source, and a matching tool-call/result pair. It also
// has to use the same message id on the event and on the input, because the digest is looked
// up by that id; a fixture that fails either point returns the input unchanged and would let
// these tests pass whether or not the guard exists.

const MESSAGE_ID='msg-source-1';

function fixture({tool,command,text}){
  const state={step:9,config:{},dirty:false,hiddenResults:new Set(),outputPlans:new Map(),
    retainedSources:new Set(),omittedSources:new Set(),fullOutputRequested:false,pinnedResults:new Set()};
  const callEvent={seq:1,type:'tool/call',data:{callId:'c0',name:tool,arguments:{command}}};
  const resultEvent={seq:2,type:'tool/result',data:{turn:1,step:1,
    message:{id:MESSAGE_ID,role:'tool',content:[{type:'text',text}],source:{callId:'c0'}}}};
  // Enough later steps that the result is "old" (AGE is 2) when the projection runs.
  const stepEvents=[5,6,7,8,9,10].map(seq=>({seq,type:'step/start',data:{step:seq}}));
  const log=[callEvent,resultEvent,...stepEvents];
  const agent={session:{id:'history-source',seq:20,log,surface:{nodes:[1,2]},
    eventAt:seq=>log.find(event=>event.seq===seq),
    requestHeader:()=>({config:{}}),requestContext:()=>({contextWindow:200000})},
    options:{}};
  const runtime={
    get:()=>({...state,root:'C:/ws',dir:'C:/ws/.dsh',config:{historyHygiene:true},step:9}),
    isEnabled:()=>true,
    problem(){},modeStatus:()=>({}),
    effects:{decide(){},rewrite(){},snippet(){},benefit:()=>true},
    isBodyVisible:()=>true,
  };
  const hygiene=createHistoryHygiene(runtime,{phase:()=>({focus:[]}),summary:()=>({})},{canRecall:()=>true});
  return {agent,hygiene};
}

const sourceBody=()=>['import os','','class Widget:','    def render(self):','        return os.path.basename(__file__)','',
  ...Array.from({length:400},(_,i)=>`    value_${i} = ${i}`)].join('\n');

const messageFor=text=>({id:MESSAGE_ID,role:'tool',content:[{type:'text',text}],source:{callId:'c0'}});

test('the projection keeps a source body printed by a shell command',()=>{
  const text=sourceBody();
  assert.equal(looksLikeSourceBody(text),true,'the fixture is source-shaped');
  const {agent,hygiene}=fixture({tool:'pwsh',command:'cat src/widget.py',text});
  const input=[messageFor(text)];
  const out=hygiene.project(agent,input,{record:false});
  assert.ok(JSON.stringify(out).includes('value_200'),'the middle of the source body survives');
});

test('the source guard does not withhold a receipt from a non-source body',()=>{
  // A diagnostic log is what the receipt branch exists for. Whether a particular projection
  // run reduces it depends on the cost gate, so the invariant pinned here is narrower and
  // exact: the digest is producible for the log and is refused for source. That is the
  // difference the retention rule must keep.
  const log=Array.from({length:900},(_,i)=>`build step ${i} completed in ${i}ms`).join('\n')+'\nERROR: one step failed\n';
  assert.equal(looksLikeSourceBody(log),false,'a log is not source-shaped');
  assert.ok(toolOutputDigest('pwsh',log,{seq:2,command:'run-build'}),'a log can still become a receipt');
  const source=sourceBody();
  assert.equal(toolOutputDigest('pwsh',source,{seq:3,command:'cat src/widget.py'}),null,'source is never digested');
});
