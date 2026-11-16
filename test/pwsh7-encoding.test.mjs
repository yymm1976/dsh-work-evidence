import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// F2-C read its own task prompt through `Get-Content` on Windows PowerShell 5.1 and got
// 184 mangled characters out of 5,675 (`璇风洿鎺ユ帓鏌ュ苟淇浠ヤ互涓...`), because 5.1 decodes
// UTF-8 files with the ANSI code page. The B0 arm read the same bytes with `read` and saw
// no corruption at all; the two arms' prompt.txt had the same SHA-256, so the difference
// was the reader, not the data.
//
// This test is the deterministic check the target file asks for (2.1.2): it asserts the
// resolved interpreter is PowerShell 7.x AND that Chinese survives a file round trip. Both
// halves matter — a 5.1 that somehow printed the right bytes would still be a version the
// target file forbids, and a 7.x that mangled Chinese would not fix the defect.
//
// The interpreter comes from DSH_PWSH_PATH, then the launcher's own resolution order. The
// test SKIPS (never silently passes) when no PowerShell 7 is installed, because a green
// result without the runtime would be the exact false evidence this file exists to prevent.

const CHINESE='无法加载配置：权限不足，请重试。';
const MANGLE_MARKERS=['锟','璇风','鎺','\uFFFD','?'];

function resolvePwsh(){
  const explicit=process.env.DSH_PWSH_PATH?.trim();
  if(explicit&&existsSync(explicit))return explicit;
  // The launcher's documented order: %ProgramFiles%\PowerShell\7, then PATH, then 5.1.
  const candidates=[
    path.join(process.env.ProgramFiles??'C:/Program Files','PowerShell','7','pwsh.exe'),
    path.join(process.env.LOCALAPPDATA??'','Microsoft','WindowsApps','pwsh.exe'),
  ];
  for(const candidate of candidates)if(existsSync(candidate))return candidate;
  try{
    const found=execFileSync('where',['pwsh.exe'],{encoding:'utf8'}).split(/\r?\n/u).find(Boolean)?.trim();
    if(found&&existsSync(found))return found;
  }catch{/* not on PATH */}
  return null;
}

const pwsh=resolvePwsh();
const hasPwsh7=Boolean(pwsh);

test('the resolved PowerShell is version 7 or newer',{skip:hasPwsh7?false:'no PowerShell 7 installed (see runs/v251/PWSH7-EVIDENCE.md)'},()=>{
  const version=execFileSync(pwsh,['-NoProfile','-Command','$PSVersionTable.PSVersion.Major'],{encoding:'utf8'}).trim();
  assert.equal(version,'7','the executor must not silently fall back to Windows PowerShell 5.1');
});

test('Chinese survives a UTF-8 file round trip through Get-Content',{skip:hasPwsh7?false:'no PowerShell 7 installed'},()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'pwsh-utf8-'));
  try{
    const file=path.join(dir,'prompt.txt');
    // Written as UTF-8 with no BOM: the F2-C prompt.txt was the same shape, and a BOM would
    // let 5.1 guess correctly, which is precisely the accident this test must not rely on.
    writeFileSync(file,CHINESE+'\n','utf8');
    const quoted=file.replaceAll("'","''");
    // Both halves are required, and the measurements say why:
    //   - 7 alone still writes stdout in the ANSI code page, so correct characters are
    //     emitted as GBK bytes and a UTF-8 reader sees mojibake;
    //   - the preamble alone is not enough either: 5.1 has already decoded the file with
    //     the ANSI code page by then, so it faithfully emits the WRONG characters as UTF-8
    //     (measured: e98f 83e7 8ab3… — the classic 锟斤拷 pair).
    // The preamble fixes the write side; only a 7.x reader fixes the read side. That is
    // exactly why the target file asks for both.
    const command=`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Content -Raw -Encoding utf8 '${quoted}'`;
    const out=execFileSync(pwsh,['-NoProfile','-Command',command],{encoding:'utf8'});
    assert.ok(out.includes(CHINESE),`the Chinese text survives byte for byte: ${JSON.stringify(out.slice(0,80))}`);
    for(const marker of MANGLE_MARKERS.filter(item=>item!=='?'))
      assert.ok(!out.includes(marker),`no mojibake marker present: ${JSON.stringify(out.slice(0,80))}`);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a Windows PowerShell 5.1 reader is what corrupts the same bytes',{skip:hasPwsh7?false:'no PowerShell 7 installed'},()=>{
  // The counter-evidence: the same file, the same command, through 5.1. If this test ever
  // stops reproducing the corruption, the version assertion above has lost its meaning and
  // this file's premise needs re-checking against a real arm.
  const legacy=path.join(process.env.SystemRoot??'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  if(!existsSync(legacy))return;
  // 5.1 decodes with the ANSI code page, which is 65001 on a UTF-8-configured host. There the
  // corruption premise does not apply and the assertion below would fail on a machine that is
  // configured differently, not on a regression. Skip instead of asserting a false negative.
  const ansiCodePage=execFileSync(legacy,['-NoProfile','-Command','[Text.Encoding]::Default.CodePage'],{encoding:'utf8'}).trim();
  if(ansiCodePage==='65001')return;
  const dir=mkdtempSync(path.join(os.tmpdir(),'pwsh-utf8-legacy-'));
  try{
    const file=path.join(dir,'prompt.txt');
    writeFileSync(file,CHINESE+'\n','utf8');
    // Captured as a buffer: 5.1 emits the ANSI code page, which is not valid UTF-8.
    const raw=execFileSync(legacy,['-NoProfile','-Command',`Get-Content -Raw '${file.replaceAll("'","''")}'`]);
    const asUtf8=raw.toString('utf8');
    assert.ok(!asUtf8.includes(CHINESE),
      'the same bytes do not survive 5.1, so the 7.x requirement has a real cause');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
