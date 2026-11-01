import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool} from './helpers/host.mjs';

test('status stays readable while disabled but cannot enable or rewrite workspace choices',async()=>{
  const host=await startHost({workspace:{toolSurface:'full',aggressiveMode:true},script:(_options,call)=>
    call===1?[tool('work_status',{session_enabled:true,config:{aggressiveMode:false}})]:call===2?[tool('read',{file_path:'a.txt'})]:[text('完成。')]});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'native read remains available\n');
    const agent=await host.createAgent('max');await host.command(agent,'off');await host.send(agent,'读取 a.txt');
    const results=host.events.filter(event=>event.type==='tool/result').map(event=>event.data.message);
    assert.equal(results[0].isError,true);
    assert.ok(JSON.stringify(results[0]).includes('user to enable'));
    assert.ok(JSON.stringify(results[1]).includes('native read remains available'));
    const status=await host.command(agent,'status');assert.equal(status.enabled,false);assert.equal(status.mode.aggressiveMode,true);
    assert.equal(status.session.override,false);
  }finally{await host.close();}
});

test('missing settings files retain the loaded session choice and report the missing files',async()=>{
  const host=await startHost({workspace:{historyHygiene:false},script:()=>[text('完成。')]});
  try{
    const agent=await host.createAgent('max');await host.command(agent,'off');
    const previous=await host.command(agent,'status');
    await fs.unlink(path.join(host.cwd,'.dsh/work-evidence/config.json'));
    await fs.unlink(previous.session.policyPath);
    const status=await host.command(agent,'status');
    assert.equal(status.enabled,false);assert.equal(status.features.historyHygiene,false);
    assert.equal(status.session.settingsRetainedInMemory,true);assert.equal(status.workspaceSettingsRetainedInMemory,true);
    await host.command(agent,'on');const enabled=await host.command(agent,'status');
    assert.equal(enabled.enabled,true);assert.equal(enabled.features.historyHygiene,false);
  }finally{await host.close();}
});
