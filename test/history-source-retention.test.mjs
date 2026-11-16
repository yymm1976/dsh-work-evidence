import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryHygiene} from '../history-hygiene.mjs';
import {looksLikeSourceBody} from '../context-pruning.mjs';

// The history-hygiene projection is the fourth place a tool body can be reduced. Its
// generic digest branch ran before the source-retention rule, so `bash cat src/widget.py`
// — a whole file with no native read dispatch and no markup — was replaced by a head/tail
// receipt and lost its middle. The unit for that behaviour is `project()`, not
// `toolOutputDigest`, because the decision is made by the caller of the digest.

function fixture(entries){
  const state={step:5,config:{},dirty:false,hiddenResults:new Set(),outputPlans:new Map(),retainedSources:new Set(),
    omittedSources:new Set(),fullOutputRequested:false,pinnedResults:new Set(),step2:0};
  const events=entries.map((entry,index)=>({seq:index+1,type:'tool/result',data:{message:entry.message,turn:1,step:1}}));
  const calls=entries.map((entry,index)=>({seq:index+2,type:'tool/call',data:{callId:'c'+index,name:entry.tool,arguments:entry.arguments??{}}}));
  const agent={session:{id:'s',seq:99,log:[...calls],surface:{nodes:events.map(e=>e.seq)},
    eventAt:seq=>events.find(event=>event.seq===seq),
    requestHeader:()=>({config:{}}),requestContext:()=>({contextWindow:200000})},
    options:{}};
  const runtime={get:()=>({...state,root:'C:/ws',dir:'C:/ws/.dsh',config:{},step:5}),
    problem(){},modeStatus:()=>({}),effects:{decide(){},rewrite(){},snippet(){},benefit:()=>true},
    isBodyVisible:()=>true,canRecall:()=>true};
  return {agent,runtime,hygiene:createHistoryHygiene(runtime,{phase:()=>({focus:[]}),summary:()=>({})},{})};
}

const sourceBody=()=>['import os','','class Widget:','    def render(self):','        return os.path.basename(__file__)','',
  ...Array.from({length:400},(_,i)=>`    value_${i} = ${i}`)].join('\n');

test('the projection keeps a source body printed by a shell command',()=>{
  const body=sourceBody();
  const {agent,hygiene}=fixture([{tool:'pwsh',arguments:{command:'cat src/widget.py'},
    message:{role:'tool',content:[{type:'text',text:body}],source:{callId:'c0'}}}]);
  const out=hygiene.project(agent,[{role:'tool',id:'m1',content:[{type:'text',text:body}],source:{callId:'c0'}}],{record:false});
  const text=JSON.stringify(out);
  assert.ok(text.includes('value_200'),'the middle of the source body survives the projection');
});

test('the source-body rule does not consume a long non-source listing',()=>{
  // This asserts the retention rule itself: a listing must still reach the ordinary
  // reduction decision. The fixture has no toolDigest record, so whether the projection
  // then reduces it depends on the digest table; what matters here is that the source rule
  // did not short-circuit it.
  const body=Array.from({length:600},(_,i)=>`C:\\project\\file${i}.log   12345`).join('\n');
  assert.equal(looksLikeSourceBody(body),false,'a listing is not source-shaped');
  const {agent,hygiene}=fixture([{tool:'pwsh',arguments:{command:'ls -l'},
    message:{role:'tool',content:[{type:'text',text:body}],source:{callId:'c0'}}}]);
  const out=hygiene.project(agent,[{role:'tool',id:'m1',content:[{type:'text',text:body}],source:{callId:'c0'}}],{record:false});
  assert.ok(Array.isArray(out),'the projection returns a message list');
});
