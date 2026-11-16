// Does the fixed build actually change the prune decision on a real trajectory's shape?
// Replays the prune decision for the exact bodies F2-C pruned, using the FIXED code.
import fs from 'node:fs';
import {planContextPrune,isSourceBody,isSourceBodyPath} from './context-pruning.mjs';

const arm='C:/Users/杨铭/Desktop/DSH/runs/v251/bench-run/F2-C-1116/stdout.jsonl';
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
console.log('  judged source (kept whole):',source);
console.log('  judged log   (prunable):   ',log);
console.log('  distinct source files named:',sourceByPath.size);

// The decision P1/P3 changes: with the old code the test-output branch and the generic
// digest branch could both reduce a source body. Recount how many of these bodies the
// FIXED code refuses to reduce for a source reason.
const pre={};
for(const body of bodies){
  const rows=(body.text.match(/^\s*\d+: /gmu)??[]).length;
  const key=isSourceBody(body.text)?'source':'log';
  pre[key]=(pre[key]??0)+1;
}
console.log('  by verdict:',JSON.stringify(pre));
