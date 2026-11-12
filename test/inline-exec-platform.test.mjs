import test from 'node:test';
import assert from 'node:assert/strict';
import {inlineCommand} from '../inline-exec.mjs';

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
  const command=inlineCommand(bashScript,"/project's path",'bash');
  assert.match(command,/^set -o pipefail\n/u);
  assert.ok(command.includes("cd -- '/project'\\''s path' || exit $?"));
  assert.ok(command.includes('PYTHONIOENCODING=utf-8 PYTHONDONTWRITEBYTECODE=1 '));
  assert.ok(command.includes("'python'\\''s-runtime' '-B' '-X' 'utf8' '-'"));
  assert.ok(command.includes("printf '%s' '"));
  assert.ok(command.includes("'\\''"));
  assert.ok(command.includes('$() `tick` 你好'));
  assert.match(command,/ | 'python'\\''s-runtime' '-B' '-X' 'utf8' '-'$/u);
});

test('inline command validation remains shared by both shell renderers',()=>{
  assert.throws(()=>inlineCommand({runtime:'node',format:'module'},'.','bash'),/code must contain/u);
  assert.throws(()=>inlineCommand({runtime:'python',format:'commonjs',code:'print(1)'},'.','bash'),/format applies only to Node/u);
  assert.throws(()=>inlineCommand({runtime:'node',code:'console.log(1)'},'.','sh'),/shell must be pwsh or bash/u);
});
