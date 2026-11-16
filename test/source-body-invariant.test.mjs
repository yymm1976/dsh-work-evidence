import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCE_BODY_PATH,isSourceBodyPath,looksLikeSourceBody,planContextPrune} from '../context-pruning.mjs';

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

test('a flat result naming a retained path is not reduced even when another path is named first',()=>{
  // A result can carry an old log entry plus the source body it was run against. Checking
  // only the first <path> would let the retained body lose its middle.
  const log=Array.from({length:200},(_,i)=>`old log line ${i} `+'z'.repeat(60)).join('\n');
  const source=Array.from({length:200},(_,i)=>`source line ${i} `+'q'.repeat(60)).join('\n');
  const message={role:'tool',content:[{type:'text',text:
    `<path>old.log</path>\n${log}\n<path>target.py</path>\n${source}`}]};
  const plan=planContextPrune(message,[],{seq:9,thresholdChars:8000,headChars:4096,tailChars:1024,
    retainSource:file=>SOURCE_BODY_PATH.test(file??'')});
  assert.equal(plan,null,'a retained path anywhere in the result forbids the cut');
});

test('a source body with no <path> markup is still retained',()=>{
  // `bash cat src/widget.py` returns a whole file with no markup at all. With no path to
  // ask about, the body itself is the evidence; a source-shaped body must not be cut.
  const body=['import os','','class Widget:','    def render(self):','        return os.path.basename(__file__)','',
    ...Array.from({length:300},(_,i)=>`    value_${i} = ${i}`)].join('\n');
  const message={role:'tool',content:[{type:'text',text:body}]};
  const plan=planContextPrune(message,[],{seq:11,thresholdChars:8000,headChars:4096,tailChars:1024,
    retainSource:footer=>isSourceBodyPath(footer)});
  assert.equal(plan,null,'a metadata-free source body is retained');
});

test('extensionless build files count as source',()=>{
  for(const name of ['Makefile','Dockerfile','CMakeLists.txt','Gemfile','Rakefile','Jenkinsfile'])assert.equal(isSourceBodyPath(name),true,name);
  for(const name of ['output.log','data.csv','notes.txt'])assert.equal(isSourceBodyPath(name),false,name);
});

test('a source-shaped body is recognised from its content alone',()=>{
  assert.equal(looksLikeSourceBody(['def run():','    return 1','','class A:','    pass',''].join('\n').repeat(60)),true);
  assert.equal(looksLikeSourceBody(Array.from({length:200},(_,i)=>`log line ${i}`).join('\n')),false);
});

test('an assignment-only source body is recognised without any statement shape',()=>{
  // A generated module of nothing but assignments matches none of the statement shapes.
  // `bash cat generated.py` returns it with no <path>, so retention can only use the body.
  const body=Array.from({length:600},(_,i)=>`value_${i} = ${i}`).join('\n');
  assert.equal(looksLikeSourceBody(body),true,'assignment density marks a source body');
  const message={role:'tool',content:[{type:'text',text:body}]};
  assert.equal(planContextPrune(message,[],{seq:12,thresholdChars:8000,headChars:4096,tailChars:1024,
    retainSource:()=>false}),null,'the assignment-only body is retained');
});

test('an unrelated named path does not disable source recognition',()=>{
  // A flat result can name a log and carry an unmarked source body after it. Retention of
  // the log is not requested, so the body itself must decide.
  const source=Array.from({length:400},(_,i)=>`value_${i} = ${i}`).join('\n');
  const text=`<path>run.log</path>\nsome log line\n${source}`;
  assert.equal(looksLikeSourceBody(text),true);
  const message={role:'tool',content:[{type:'text',text}]};
  assert.equal(planContextPrune(message,[],{seq:13,thresholdChars:8000,headChars:4096,tailChars:1024,
    retainSource:file=>SOURCE_BODY_PATH.test(file??'')}),null,'the unmarked source body is retained');
});

test('a native read of a non-source path is cut for a log and kept for source',()=>{
  // The reads branch takes its path from the read dispatch, so `retainSource` (which decides
  // by PATH) answers "cut" for build.log. The body then has to decide. Without this case the
  // branch is untested: a host-level assertion about a .log either went through the flat
  // branch or was already refused upstream, so forcing the detector false changed nothing.
  const dispatch = bodyLines => {
    const text = `<path>build.log</path>\n<type>file</type>\n<content>\n` +
      bodyLines.map((line, index) => `${index + 1}: ${line}`).join('\n') + '\n</content>';
    return {
      name: 'read', arguments: {file_path: 'build.log'}, isError: false, meta: {},
      value: {path: 'build.log', lines: bodyLines.map((line, index) => ({line: index + 1, text: line}))},
      content: [{type: 'text', text}],
    };
  };
  const options = {seq: 9, thresholdChars: 8000, headChars: 4096, tailChars: 1024, retainSource: () => false};
  // The message body must be the SAME text the dispatch renders, or renderedReads refuses to
  // map its windows and the null plan has nothing to do with source detection.
  const plan = bodyLines => {
    const read = dispatch(bodyLines);
    return planContextPrune({role: 'tool', content: read.content}, [read], options);
  };

  const sourceBody = Array.from({length: 300}, (_, index) =>
    `    value_${String(index).padStart(3, '0')} = compute_value(${index}, options=self._options)`);
  assert.equal(plan(sourceBody), null, 'assignment-only source behind a non-source name is not reduced');

  const logBody = Array.from({length: 300}, (_, index) =>
    `build step ${index} completed in ${index}ms`);
  const logPlan = plan(logBody);
  assert.ok(logPlan, 'a real log behind the same name is still reduced');
  assert.ok(logPlan.charsAfter < logPlan.charsBefore);
});
