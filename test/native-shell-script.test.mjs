import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeShellScript} from '../native-shell-script.mjs';
import {resolveInlineScript,inlineCommand} from '../inline-exec.mjs';
import {defaults} from '../runtime.mjs';

const command="python3 -u -B -X utf8 - <<'PY'\nprint('$literal `body` \\\\n')\nPY\n";
const session={log:[{seq:1,type:'tool/call',data:{callId:'shell-original',name:'bash',arguments:{command}}}]};

test('literal shell program reuse is opt-in and preserves the complete stdin bytes and arguments',()=>{
  assert.equal(defaults().nativeShellScriptReuse,false);
  assert.throws(()=>defaults({nativeShellScriptReuse:1}),/Invalid nativeShellScriptReuse/u);
  const parsed=nativeShellScript('bash',{command,description:'run'});
  assert.equal(parsed.runtime,'python');assert.equal(parsed.executable,'python3');
  assert.equal(parsed.code,"print('$literal `body` \\\\n')\n");
  assert.deepEqual(parsed.nativeArguments,['-u','-B','-X','utf8','-']);
  assert.equal(nativeShellScript('bash',{command:"node <<'JS'\nconsole.log(require('fs').existsSync('.'));\nJS"}).nativeArguments.length,0);
});

test('unsupported shell effects and expansion never produce a reusable program',()=>{
  for(const rejected of [command.replace("'PY'",'PY'),command.replace("'PY'",'"PY"'),
    command.replace('<<','<<-'),'cd /tmp\n'+command,'true; '+command,
    'X=1 '+command,command+'echo changed',command.replace('python3','/usr/bin/python3'),
    command.replace('-u','-c code'),command.replace("<<'PY'",">out <<'PY'"),
    command.replace("<<'PY'","<<'PY' | cat"),command.replace('-u','$ARGS'),
    command.replace('PY\n','PY # trailing command\n'),command.replaceAll('\n','\r\n')]){
    assert.equal(nativeShellScript('bash',{command:rejected}),null,rejected);
  }
  assert.equal(nativeShellScript('pwsh',{command}),null);
  for(const extra of [{workdir:'.'},{cwd:'.'},{run_in_background:true},{timeoutMs:0},{sandbox_permissions:'require_escalated'}])
    assert.equal(nativeShellScript('bash',{command,...extra}),null);
});

test('an exact shell ref keeps executable and argv through successive version edits',()=>{
  assert.throws(()=>resolveInlineScript({scriptRef:'event:1'},session),/does not identify/u);
  const input={scriptRef:'event:1',edits:[{before:'print(',after:'print(42,'}]};
  const resolved=resolveInlineScript(input,session,undefined,{nativeShellScriptReuse:true});
  assert.equal(resolved.executable,'python3');assert.deepEqual(resolved.nativeArguments,['-u','-B','-X','utf8','-']);
  assert.equal(resolved.shellSource.callId,'shell-original');assert.equal(resolved.shellSource.seq,1);
  const chained={log:[...session.log,{seq:2,type:'tool/call',data:{callId:'edited',name:'work_exec',arguments:input}}]};
  const next=resolveInlineScript({scriptRef:'edited',edits:[{before:'42',after:'63'}]},chained,undefined,{nativeShellScriptReuse:true});
  assert.match(next.code,/print\(63,/u);assert.deepEqual(next.nativeArguments,resolved.nativeArguments);
  assert.deepEqual(next.sourceCallIds,['edited','shell-original']);
  const bash=inlineCommand(next,'/app','bash','transfer-one');
  assert.match(bash,/'python3' '-u' '-B' '-X' 'utf8' '-'/u);
  assert.ok(!bash.includes('PYTHONDONTWRITEBYTECODE='),'original native environment rules are retained');
});

test('a shell ref never inherits execution success and rejects unsupported commands or foreign sessions',()=>{
  const events={log:[...session.log,{seq:3,type:'tool/result',data:{message:{toolCallId:'shell-original',content:[{type:'text',text:'failed'}]}}}]};
  const script=resolveInlineScript({scriptRef:'shell-original'},events,undefined,{nativeShellScriptReuse:true});
  assert.equal(script.exitCode,undefined);assert.equal(script.executionOccurred,undefined);
  assert.throws(()=>resolveInlineScript({scriptRef:'shell-original'},{log:[]},undefined,{nativeShellScriptReuse:true}),/does not identify/u);
  const invalid={log:[{seq:1,type:'tool/call',data:{callId:'shell-original',name:'bash',arguments:{command:'echo unsafe; '+command}}}]};
  assert.throws(()=>resolveInlineScript({scriptRef:'event:1'},invalid,undefined,{nativeShellScriptReuse:true}),error=>error.code==='WORK_EXEC_SHELL_REF_UNSUPPORTED');
});

test('explicit Node format replaces the recorded stdin arguments and records that choice',()=>{
  const node={log:[{seq:1,type:'tool/call',data:{callId:'node-shell',name:'bash',arguments:{command:"node --no-warnings --input-type=commonjs - <<'JS'\nconsole.log(42);\nJS\n"}}}]};
  const script=resolveInlineScript({scriptRef:'event:1',format:'module'},node,undefined,{nativeShellScriptReuse:true});
  assert.equal(script.format,'module');assert.deepEqual(script.nativeArguments,['--no-warnings','--input-type=module','-']);
  assert.equal(script.shellSource.argumentsOverridden,true);
  assert.match(inlineCommand(script,'/app','bash','transfer-one'),/'--input-type=module' '-'/u);
  assert.match(inlineCommand(script,'/app','bash','transfer-one'),/'--no-warnings'/u);
});
