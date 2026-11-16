import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCE_BODY_PATH,planContextPrune} from '../context-pruning.mjs';

// The F2-C failure was a source body cut to head+tail. Two entry points can reduce a body
// (the live prune path and the stage-checkpoint builder), so the "is this source code"
// answer must be one shared definition. This test pins the shared list and the guarantee
// that any path naming source code is refused when the caller retains source.

const SOURCE_SAMPLES=['a.py','mod.mjs','Widget.java','main.go','lib.rs','page.tsx','style.css','index.html',
  'app.js','data.json','conf.yaml','build.gradle','notes.md','run.sh','tool.ps1','schema.proto'];
const NON_SOURCE=['listing.txt','output.log','report.bin','archive.tar','dump.csv'];

test('the shared source-body pattern recognises every language the repair tasks touch',()=>{
  for(const name of SOURCE_SAMPLES)assert.equal(SOURCE_BODY_PATH.test(name),true,name);
  for(const name of NON_SOURCE)assert.equal(SOURCE_BODY_PATH.test(name),false,name);
});

test('a retained source body is never reduced, whichever branch reaches it',()=>{
  const lines=Array.from({length:400},(_,i)=>`${i+1}: value_${i} = ${i}`);
  const message={role:'tool',content:[{type:'text',text:
    `<path>widget.java</path>\n<type>file</type>\n<content>\n${lines.join('\n')}\n\n(End of file - total 400 lines)\n</content>`}]};
  const options={seq:7,thresholdChars:8000,headChars:4096,tailChars:1024,retainSource:file=>SOURCE_BODY_PATH.test(file)};
  assert.equal(planContextPrune(message,[],options),null,'the flat branch refuses a retained source body');
  assert.equal(planContextPrune(message,[{path:'widget.java',lines:[{number:1,text:'x'}]}],options),null,
    'the nested-read branch refuses the same body');
});

test('a non-source body keeps the old reduction',()=>{
  const lines=Array.from({length:400},(_,i)=>`log line ${i} `+'z'.repeat(60));
  const message={role:'tool',content:[{type:'text',text:lines.join('\n')}]};
  const plan=planContextPrune(message,[],{seq:8,thresholdChars:8000,headChars:4096,tailChars:1024,
    retainSource:file=>SOURCE_BODY_PATH.test(file??'')});
  assert.ok(plan,'a listing still shrinks');
  assert.ok(plan.charsAfter<plan.charsBefore);
});
