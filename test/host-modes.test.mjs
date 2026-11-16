import test from 'node:test';
import assert from 'node:assert/strict';
import {startHost,text,tool,systemOf,toolNames} from './helpers/host.mjs';

const answer=()=>[text('完成。')];

test('a fresh native PTC request declares and executes work_exec without a preceding status command',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:(options,n)=>{
    assert.match(systemOf(options),/\bwork_exec: \{/u);
    assert.ok(systemOf(options).includes('Supply code+runtime'));
    return n===1?[tool('run_code',{code:'console.log(JSON.stringify(await tools.work_exec({runtime:"node",code:"console.log(42)"})));',description:'Run the requested fresh-session program'})]:answer();
  }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行当前任务允许的 Node 程序，输出 42。');
    const call=host.events.find(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='work_exec');
    const result=JSON.parse(call.data.content.map(block=>block.text??'').join(''));
    assert.equal(result.exitCode,0);assert.equal(result.stdout.text.trim(),'42');
  }finally{await host.close();}
});

test('fresh and changing compact tasks expose their current allowed surface in the same request',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'只读 README.md，不得修改文件。');assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u);
    await host.send(agent,'现在允许修改项目并运行所需程序。');assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u);
    await host.send(agent,'再次只读 README.md，不得修改文件。');assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u);
  }finally{await host.close();}
});

test('host boots with the plugin and status reports aggressive by default', async()=>{
  const host=await startHost({script:answer});
  try{
    const agent=await host.createAgent('max');
    const status=await host.command(agent,'status');
    assert.equal(status.loaded,true);
    assert.equal(status.effective,true);
    assert.equal(status.mode.selected,'aggressive');
  }finally{await host.close();}
});

test('aggressive guidance reaches the system prompt and Ultra maps to max on the wire', async()=>{
  const host=await startHost({script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'修改 a.txt 写入 1');
    const first=host.requests.at(-1);
    assert.equal(first.reasoningEffort,'max');
    const aggressivePrompt=systemOf(first);
    assert.ok(aggressivePrompt.length>0);

    const ultra=await host.createAgent('ultra');
    await host.send(ultra,'修改 b.txt 写入 2');
    const second=host.requests.at(-1);
    assert.equal(second.reasoningEffort,'max','Ultra must be sent as the native max effort');
    const qualityPrompt=systemOf(second);
    assert.notEqual(qualityPrompt,aggressivePrompt,'quality guidance must differ from aggressive guidance');
  }finally{await host.close();}
});

test('aggressiveMode off hands non-Ultra efforts to the host but keeps work_status', async()=>{
  const host=await startHost({script:answer,workspace:{aggressiveMode:false}});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'修改 a.txt 写入 1');
    const status=await host.command(agent,'status');
    assert.equal(status.effective,false);
    const names=toolNames(host.requests.at(-1));
    assert.ok(names.includes('work_status'),'work_status stays available for re-enabling');
    assert.ok(!names.includes('work_exec'),'plugin tools are hidden while disabled');
  }finally{await host.close();}
});

test('switching aggressive off and on changes effectiveness from the next request', async()=>{
  const host=await startHost({script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'修改 a.txt');
    const off=await host.command(agent,'aggressive off');
    assert.equal(off.aggressiveMode,false);
    assert.equal((await host.command(agent,'status')).effective,false);
    await host.command(agent,'aggressive on');
    assert.equal((await host.command(agent,'status')).effective,true);
  }finally{await host.close();}
});

test('an English denial is scoped to its own sentence',async()=>{
  // "Do not modify a.js. Create b.js." used to split only on 。；; and newline, so
  // both sentences stayed one string: the denial in the first suppressed the write
  // request in the second and the task became read-only, hiding work_exec.
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'Do not modify src/a.js. Create src/b.js.');
    assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'the second sentence asks for a write, so the task is writable');
    await host.send(agent,'Read src/a.js only. Do not modify anything.');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'both sentences are read-only, so the task stays read-only');
  }finally{await host.close();}
});

test('a modal denial still marks the task read-only',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'Read-only: you must not modify src/a.js.');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'must not is a denial, not a write request');
    await host.send(agent,'You may not delete src/a.js.');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'may not is a denial');
    await host.send(agent,'You must not modify src/a.js but create src/b.js.');
    assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'the must of must-not is not an allowance; the later create is');
    await host.send(agent,'不能修改 src/a.js。');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u);
    await host.send(agent,'请勿修改 src/a.js。');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u);
  }finally{await host.close();}
});

test('a write before a denial in the same clause keeps the task writable',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:answer});
  try{
    const agent=await host.createAgent('max');
    for(const request of [
      'Refactor src/a.js. Do not modify src/b.js.',
      'Update src/a.js. Do not delete src/b.js.',
      'Fix src/a.js, do not modify src/b.js.',
      'Edit src/a.js and do not delete src/b.js.',
    ]){
      await host.send(agent,request);
      assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,request);
    }
  }finally{await host.close();}
});

test('a denial in a later English clause does not cancel the requested write',async()=>{
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'Modify src/a.js, but do not delete src/b.js.');
    assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'the first clause authorizes a modification; the second forbids only deletion');
    await host.send(agent,'Do not modify src/a.js, but create src/b.js.');
    assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'an explicit allowance after a denial remains writable');
    await host.send(agent,'Read src/a.js, but do not modify src/b.js.');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'a read followed by a denied modification stays read-only');
    await host.send(agent,'修改 src/a.js，但不要删除 src/b.js。');
    assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'a Chinese conjunction without a space still scopes the denial to its own clause');
  }finally{await host.close();}
});

test('describing an edit inside a read-only request does not make it writable',async()=>{
  // "edits" is the object of "review": the sentence asks for a read. Matching the
  // bare verb made this request writable, keeping work_exec and verified_exec
  // visible on a task the user had explicitly marked read-only.
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'Read-only: review the edits in src/a.js.');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'a review of someone else\u2019s edits is still a read');
    await host.send(agent,'Read-only: review the code. Then modify src/a.js to add the feature.');
    assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'an affirmative request in a later sentence makes the task writable');
  }finally{await host.close();}
});

test('an extensionless filename after a write verb still counts as a write request',async()=>{
  // "create README" names a real target but has no extension; without accepting it
  // the request stayed read-only and hid work_exec despite the explicit creation.
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'Do not modify src/a.js; create README.');
    assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'creating a file is a write request even without an extension');
    await host.send(agent,'Read-only: review the edits in src/a.js.');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'describing edits is still a read');
  }finally{await host.close();}
});

test('an allowance word inside a filename is not permission to write',async()=>{
  // "can-edit" inside src/can-edit.js matched the allowance `can`, so an explicit
  // denial with a filename in it classified the task writable and kept work_exec.
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'Read-only: do not modify src/can-edit.js');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'a denial stays a denial when the filename contains an allowance word');
    await host.send(agent,'Do not modify src/can-edit.js. Then modify src/real.js to add the feature.');
    assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'a real allowance clause in another sentence still permits the write');
  }finally{await host.close();}
});

test('a lowercase word after a write verb is not a target but an ALL-CAPS name is',async()=>{
  // The target list is /iu, so an [A-Z] alternative there also matched lowercase
  // words. "review the edits" must stay a read while "create README" is a request.
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'Read-only: review the edits in src/a.js.');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,'lowercase "edits" is not a target');
    await host.send(agent,'Do not modify src/a.js; create README.');
    assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,'an ALL-CAPS name is a target');
  }finally{await host.close();}
});

test('a read allowance before a denied write does not cancel the denial',async()=>{
  // "you can read a.js, but do not modify b.js" grants a READ and then denies a write.
  // Matching the allowance anywhere in the sentence made the denial into permission.
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],script:answer});
  try{
    const agent=await host.createAgent('max');
    await host.send(agent,'Read-only: you can read a.js, but do not modify b.js.');
    assert.doesNotMatch(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'a read permission does not license the denied write');
    await host.send(agent,'Do not modify b.js. Instead modify a.js to add the check.');
    assert.match(systemOf(host.requests.at(-1)),/\bwork_exec: \{/u,
      'an allowance after the denial still permits the write');
  }finally{await host.close();}
});
