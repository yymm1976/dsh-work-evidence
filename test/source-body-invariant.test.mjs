import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCE_BODY_PATH,isSourceBodyPath,looksLikeSourceBody,isSourceBody,planContextPrune,stripLineNumbers} from '../context-pruning.mjs';

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
  //
  // The body must clear `thresholdChars`, or planContextPrune returns before it ever calls
  // the detector and the assertion holds with content recognition disabled. The first
  // version of this fixture was 5,869 characters against an 8,000 threshold: measured,
  // `retainSource:()=>false` returned null on it, which means the planner was comparing
  // lengths and never asking the question this test claims to pin.
  const body=['import os','','class Widget:','    def render(self):','        return os.path.basename(__file__)','',
    ...Array.from({length:400},(_,i)=>`    value_${String(i).padStart(3,'0')} = compute_value(${i}, options=self._options)`)].join('\n');
  assert.ok(body.length>=8000,'the fixture clears thresholdChars: ' + body.length);
  const options={seq:11,thresholdChars:8000,headChars:4096,tailChars:1024,retainSource:footer=>isSourceBodyPath(footer??'')};
  // The control that makes this a real question: a non-source body of the same size must
  // still shrink, so the refusal below is content recognition rather than the length gate.
  const log=Array.from({length:400},(_,i)=>`build step ${i} completed in ${i}ms`).join('\n');
  assert.ok(log.length>=8000,'the control clears thresholdChars');
  assert.ok(planContextPrune({role:'tool',content:[{type:'text',text:log}]},[],options),
    'a log of the same size is still prunable');
  const message={role:'tool',content:[{type:'text',text:body}]};
  assert.equal(planContextPrune(message,[],options),null,'a metadata-free source body is retained');
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
  // Asserted, not assumed: at 9,379 characters this fixture clears thresholdChars, but a
  // shorter row format would quietly drop it under the gate and turn the plan assertion
  // below into a length check.
  assert.ok(body.length>=8000,'the fixture clears thresholdChars: ' + body.length);
  assert.equal(looksLikeSourceBody(body),true,'assignment density marks a source body');
  const message={role:'tool',content:[{type:'text',text:body}]};
  assert.equal(planContextPrune(message,[],{seq:12,thresholdChars:8000,headChars:4096,tailChars:1024,
    retainSource:()=>false}),null,'the assignment-only body is retained');
});

test('an unrelated named path does not disable source recognition',()=>{
  // A flat result can name a log and carry an unmarked source body after it. Retention of
  // the log is not requested, so the body itself must decide.
  // 600 rows, not 400: the 400-row version was 6,214 characters against thresholdChars:8000,
  // so planContextPrune returned at the length gate and the assertion held with content
  // detection disabled. An adversarial review caught it.
  const source=Array.from({length:600},(_,i)=>`value_${i} = ${i}`).join('\n');
  const text=`<path>run.log</path>\nsome log line\n${source}`;
  assert.ok(text.length>=8000,'the fixture clears thresholdChars: '+text.length);
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

test('every line-number prefix renderedReads accepts is stripped before classification',()=>{
  // renderedReads accepts `N: `, `N | ` and `N\t`. Handling only the colon form made a
  // run_code result rendered with a pipe pass window matching and then fail source
  // recognition, sending a real source body down the prune path.
  assert.equal(stripLineNumbers('1: value = 1'),'value = 1');
  assert.equal(stripLineNumbers('1 | value = 1'),'value = 1');
  assert.equal(stripLineNumbers('1\tvalue = 1'),'value = 1');
  assert.equal(stripLineNumbers('  12: x = 1'),'x = 1');
  // A row that merely starts with a number is untouched when there is no prefix separator.
  assert.equal(stripLineNumbers('1234 = count'),'1234 = count');
});

test('a serialized shell envelope carrying source is not pruned in the flat branch',()=>{
  // A shell result puts its text in `stdout.text` with the newlines escaped, so both
  // detectors see one long line and a whole source file reads as a log. The control below
  // (a log in the same envelope) proves the refusal is the content rule and not the shape.
  const source=Array.from({length:300},(_,i)=>
    `    value_${String(i).padStart(3,'0')} = compute_value(${i}, options=self._options)`).join('\n');
  const envelope=body=>JSON.stringify({stdout:{text:body},stderr:{text:''}});
  const options={seq:9,thresholdChars:8000,headChars:4096,tailChars:1024,retainSource:()=>false};
  const plan=body=>planContextPrune({role:'tool',content:[{type:'text',text:envelope(body)}]},[],options);
  assert.ok(envelope(source).length>=8000,'the fixture clears thresholdChars');
  assert.equal(plan(source),null,'escaped source is retained');
  const log=Array.from({length:400},(_,i)=>`build step ${i} completed in ${i}ms`).join('\n');
  assert.ok(plan(log),'a log in the same envelope is still reduced');
});

test('a rendered line-number prefix cannot hide a source body from the classifier',()=>{
  // Found by adversarial review. `isSourceBody` did not strip line-number prefixes, and every
  // shape detector anchors on a line start, so a real module rendered as `N | row` read as a
  // log. The reads branch stripped the prefix for its own decision and the flat branch did
  // not, so the same body got two answers depending on which branch reached it.
  //   measured before the fix: 13,782 -> 5,320 (pruned), while the same body without
  //   prefixes was refused.
  const py=['import os','','def run(x):','    return x+1','',
    ...Array.from({length:400},(_,i)=>`    value_${i} = compute(${i})`)].join('\n');
  const options={seq:9,thresholdChars:8000,headChars:4096,tailChars:1024,retainSource:()=>false};
  const prefixed=(text,sep)=>'<path>out.txt</path>\n<content>\n'+
    text.split('\n').map((row,i)=>`${i+1}${sep}${row}`).join('\n')+'\n</content>';
  for(const [sep,label] of [[': ','colon'],[' | ','pipe'],['\t','tab']]){
    const text=prefixed(py,sep);
    assert.ok(text.length>=8000,`the ${label} fixture clears thresholdChars`);
    assert.equal(isSourceBody(text),true,`${label}-prefixed source is recognised`);
    assert.equal(planContextPrune({role:'tool',content:[{type:'text',text}]},[],options),null,
      `${label}-prefixed source is not reduced`);
  }
  // The control: a log with the same prefixes must still shrink, or the fix disabled pruning.
  const log=Array.from({length:600},(_,i)=>`build step ${i} completed in ${i}ms`).join('\n');
  const logText=prefixed(log,' | ');
  assert.equal(isSourceBody(logText),false,'a prefixed log is not source');
  assert.ok(planContextPrune({role:'tool',content:[{type:'text',text:logText}]},[],options),
    'and it is still reduced');
});

test('a mid-file window with no statement shape is still source',()=>{
  // Found by adversarial review. A window that starts inside a function has no def/class/
  // import line, and three ordinary shapes matched zero of the seven patterns and zero
  // assignments, so 10-20 K characters of real Python were classified as logs:
  //   method calls only / if-else blocks / dict literals
  // The signal is deep consistent indentation AND code punctuation at line ends; either one
  // alone has a false positive, which the negative controls below pin.
  const shapes={
    'method calls':Array.from({length:300},(_,i)=>`        self._helper_${i}(payload, retry=True)`),
    'if-else':Array.from({length:300},(_,i)=>`        if value_${i} is not None:\n            return value_${i}`),
    'dict literals':Array.from({length:300},(_,i)=>`        "key_${i}": compute_${i}(),`),
  };
  for(const [label,rows] of Object.entries(shapes)){
    const text=rows.join('\n');
    assert.ok(text.length>=8000,`the ${label} fixture clears thresholdChars`);
    assert.equal(looksLikeSourceBody(text),true,`${label} is source`);
  }
  // Negative controls: indented text that is NOT code must stay a log.
  const logs={
    'indented log':Array.from({length:400},(_,i)=>`    [info] event ${i}: done`),
    'indented yaml':Array.from({length:400},(_,i)=>`    key_${i}: value_${i}`),
    'indented prose':Array.from({length:200},(_,i)=>`        This sentence explains step ${i}.`),
  };
  for(const [label,rows] of Object.entries(logs)){
    const text=rows.join('\n');
    assert.ok(text.length>=2000,`the ${label} fixture clears the minimum length`);
    assert.equal(looksLikeSourceBody(text),false,`${label} stays a log`);
  }
});

test('a compact JSON document is source, and a shell envelope is not',()=>{
  // Review found that a large pretty-printed JSON has no statement lines and no assignments,
  // so `bash cat package.json` could have its middle replaced by a receipt. A COMPACT document
  // is worse: one 13,390-character line, which the line-count gate rejected outright.
  const compact=JSON.stringify({deps:Object.fromEntries(Array.from({length:800},(_,i)=>[`dep${i}`,`1.${i}`]))});
  assert.ok(compact.length>=8000,'the fixture clears thresholdChars');
  assert.equal(looksLikeSourceBody(compact),true,'a compact JSON document is source');
  assert.equal(isSourceBody(compact),true);
  assert.equal(isSourceBody(`<path>build.log</path>\n<content>\n${compact}\n</content>`),true,
    'and a non-source name does not change that');
  // The negative control that matters: a shell envelope is also valid JSON, so a bare parse
  // would have classified every shell result as configuration and disabled the receipt branch.
  const envelope=JSON.stringify({stdout:{text:'build step 1 ok'},stderr:{text:''}});
  assert.equal(isSourceBody(envelope),false,'the transport envelope is not configuration');
  // And prose wrapped in braces must not parse.
  assert.equal(looksLikeSourceBody('{'+'this is prose, not json. '.repeat(500)+'}'),false);
});

test('prefix stripping preserves the content indentation',()=>{
  // Review finding: one trailing `[ \t]?` consumed a CONTENT space for the tab and pipe
  // forms, so a four-space-indented row became three and CODE_INDENT stopped matching. A body
  // of only indented calls then read as a log and its middle was prunable.
  assert.equal(stripLineNumbers('1\t    x = 1'),'    x = 1','tab prefix keeps the content spaces');
  assert.equal(stripLineNumbers('1 |     x = 1'),'    x = 1','pipe prefix keeps them too');
  assert.equal(stripLineNumbers('1:     x = 1'),'    x = 1','colon prefix consumes only its own space');
  // A row that merely starts with a number and an equals sign is untouched.
  assert.equal(stripLineNumbers('1234 = count'),'1234 = count');
});
