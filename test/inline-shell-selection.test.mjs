import test from 'node:test';
import assert from 'node:assert/strict';
import {selectShell,preferredShell,NATIVE_SHELLS} from '../inline-exec.mjs';

const mount=names=>name=>names.includes(name);

test('the preferred shell wins when the host publishes both',()=>{
  assert.equal(selectShell(mount(['pwsh','bash']),'win32'),'pwsh');
  assert.equal(selectShell(mount(['pwsh','bash']),'linux'),'bash');
  assert.equal(selectShell(mount(['bash','pwsh']),'darwin'),'bash');
});

test('a host that publishes only one shell reaches that shell on every platform',()=>{
  // The gap this closes: Windows hosts publishing only bash were previously
  // reported unavailable because the shell name was hardcoded to pwsh.
  assert.equal(selectShell(mount(['bash']),'win32'),'bash');
  assert.equal(selectShell(mount(['pwsh']),'linux'),'pwsh');
  assert.equal(selectShell(mount(['pwsh']),'darwin'),'pwsh');
});

test('neither shell published yields null and reports the platform preference',()=>{
  assert.equal(selectShell(mount([]),'win32'),null);
  assert.equal(selectShell(mount([]),'linux'),null);
  assert.equal(preferredShell('win32'),'pwsh');
  assert.equal(preferredShell('linux'),'bash');
  assert.equal(preferredShell('darwin'),'bash');
});

test('a throwing capability probe is treated as unavailable, not fatal',()=>{
  const throwing=name=>{if(name==='pwsh')throw new Error('capability probe failed');return name==='bash';};
  assert.equal(selectShell(throwing,'win32'),'bash');
  const alwaysThrows=()=>{throw new Error('capability probe failed');};
  assert.equal(selectShell(alwaysThrows,'win32'),null);
});

test('truthiness, not strict presence, decides availability',()=>{
  assert.equal(selectShell(name=>name==='bash'?{}:undefined,'win32'),'bash');
  assert.equal(selectShell(name=>name==='pwsh'?false:true,'win32'),'bash');
  assert.equal(selectShell(()=>true,'win32'),'pwsh');
});

test('the selectable set stays the two transported shells',()=>{
  assert.deepEqual([...NATIVE_SHELLS],['pwsh','bash']);
  for(const platform of ['win32','linux','darwin'])assert.ok(NATIVE_SHELLS.includes(preferredShell(platform)));
});
