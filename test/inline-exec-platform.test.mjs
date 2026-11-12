import test from 'node:test';
import assert from 'node:assert/strict';
import {inlineCommand,inlineEnvironment,INLINE_ENV_KEYS} from '../inline-exec.mjs';

const powershellScript={runtime:'node',format:'commonjs',executable:'node.exe',code:'console.log("PowerShell path");'};
const bashScript={runtime:'python',executable:"python's-runtime",code:"print(\"single ' double \\\\ $() `tick` 你好\")"};

test('the default inline shell keeps the existing PowerShell command',()=>{
  assert.equal(inlineCommand(powershellScript,'C:/project path'),inlineCommand(powershellScript,'C:/project path','pwsh'));
  const command=inlineCommand(powershellScript,'C:/project path');
  assert.match(command,/\$workExecInfo = \[Diagnostics\.ProcessStartInfo\]::new\(\)/u);
  assert.match(command,/"Arguments"|\.Arguments = '--input-type=commonjs -'/u);
  assert.match(command,/\[Convert\]::FromBase64String/u);
});

test('the Bash inline shell safely forwards the complete code to stdin',()=>{
  const command=inlineCommand(bashScript,"/project's path",'bash','transfer-test');
  assert.match(command,/^set -o pipefail\n/u);
  assert.match(command,/\|/u);
  assert.ok(command.includes('"${DSH_WORK_EVIDENCE_STDIN_ID-}" = \'transfer-test\''));
  assert.ok(command.includes("exit 125"));
  assert.ok(command.includes("builtin printf '%b'"));
  assert.ok(command.includes('unset '+INLINE_ENV_KEYS.join(' ')));
  assert.ok(command.includes("cd -- '/project'\\''s path' || exit $?"));
  assert.ok(command.includes('PYTHONIOENCODING=utf-8 PYTHONDONTWRITEBYTECODE=1 '));
  assert.ok(command.includes("'python'\\''s-runtime' '-B' '-X' 'utf8' '-'"));
  assert.ok(!command.includes(bashScript.code));
  assert.ok(Buffer.byteLength(command,'utf8')<2048);
});

test('Bash transport bounds individual UTF-8 environment values without losing source characters',()=>{
  for(const code of ['#'+'界'.repeat(63999),'//'+String.fromCodePoint(0x1f4bb).repeat(31999),'#'+'\0'.repeat(63999),'#'+'\\'.repeat(63999)]){
    const values=inlineEnvironment({runtime:'node',code},'bounded-test');
    assert.deepEqual(Object.keys(values),INLINE_ENV_KEYS);
    assert.equal(values.DSH_WORK_EVIDENCE_STDIN_ID,'bounded-test');
    const chunks=INLINE_ENV_KEYS.slice(1).map(key=>values[key]);
    assert.ok(chunks.every(value=>Buffer.byteLength(value,'utf8')<=96000));
    assert.equal(chunks.join(''),code.replaceAll('\\','\\\\').replaceAll('\0','\\000'));
    assert.ok(chunks.every(value=>!value.includes('\0')));
  }
});

test('inline command validation remains shared by both shell renderers',()=>{
  assert.throws(()=>inlineCommand({runtime:'node',format:'module'},'.','bash'),/code must contain/u);
  assert.throws(()=>inlineCommand({runtime:'python',format:'commonjs',code:'print(1)'},'.','bash'),/format applies only to Node/u);
  assert.throws(()=>inlineCommand({runtime:'node',code:'console.log(1)'},'.','sh'),/shell must be pwsh or bash/u);
  assert.throws(()=>inlineCommand({runtime:'python',code:'print(1)'},'.','bash'),/transfer ID/u);
  assert.throws(()=>inlineEnvironment({runtime:'node',code:'console.log(1)'},'bad\nID'),/transfer ID/u);
});
