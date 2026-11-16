// What does the fixed CONTENT detector say about the bodies F2-C actually pruned?
// This does not call planContextPrune, so it reports source classification, not a prune
// decision: a named source body is still prunable when a later complete read supersedes it.

import fs from 'node:fs';
import {isSourceBody,isSourceBodyPath} from './context-pruning.mjs';

const arm=process.argv[2];
if(!arm){console.error('usage: node verify-p1p3.mjs <arm-stdout.jsonl>');process.exit(2);}
const lines=fs.readFileSync(arm,'utf8').split(/\r?\n/u).filter(Boolean);
const calls=new Map();let step=0;const bodies=[];
for(const line of lines){
  let e;try{e=JSON.parse(line);}catch{continue}
  if(e.type==='status'&&e.phase==='step_start'){step=e.step;continue}
  if(e.type==='tool_call'){calls.set(e.callId,{step,tool:e.tool,args:e.input});continue}
  if(e.type!=='tool_result')continue;
  const call=calls.get(e.callId);if(!call)continue;
  const text=String(e.result??'');
  if(text.length<8000)continue;
  bodies.push({step:call.step,tool:call.tool,args:call.args,text});
}
console.log('large results in the arm:',bodies.length);
let source=0,log=0;
const sourceByPath=new Set();
for(const body of bodies){
  const isSource=isSourceBody(body.text);
  if(isSource){source++;
    for(const m of body.text.matchAll(/<path>([^<]+)<\/path>/gu))if(isSourceBodyPath(m[1]))sourceByPath.add(m[1].split(/[\/]/u).pop());
  }else log++;
}
console.log('  judged source by content (would be retained if unnamed):',source);
console.log('  judged log by content (no retention from the body):',log);
console.log('  distinct source files named:',sourceByPath.size);

// The decision P1/P3 changes: with the old code the test-output branch and the generic
// digest branch could both reduce a source body. Recount how many of these bodies the
// FIXED code refuses to reduce for a source reason.

