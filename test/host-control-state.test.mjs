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

test('the session gate hides management tools and restores them without touching native tools',async()=>{
  const seen=[];
  const host=await startHost({workspace:{toolSurface:'full'},script:(options,call)=>{
    seen.push({call,names:(options.tools??[]).map(item=>item.name)});
    if(call===1)return [text('就绪。')];
    if(call===2)return [tool('work_status',{})];
    if(call===3)return [tool('read',{file_path:'a.txt'})];
    return [text('完成。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'a.txt'),'gate-native-marker\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'先说明已就绪');
    const enabled=seen.find(item=>item.call===1).names;
    const management=['project_evidence','work_report','work_state','work_probe','evidence_index','candidate_select','ptc_patterns','ptc_fastpath','verified_exec','fastedit_java','work_compute','work_exec'];
    for(const name of management)assert.ok(enabled.includes(name),`enabled surface keeps ${name}`);
    assert.ok(enabled.includes('read')&&enabled.includes('pwsh'));
    await host.command(agent,'off');
    await host.send(agent,'查看状态后读取 a.txt');
    const disabled=seen.find(item=>item.call===2).names;
    for(const name of management)assert.ok(!disabled.includes(name),`disabled surface hides ${name}`);
    assert.ok(disabled.includes('work_status'));
    assert.ok(disabled.includes('read')&&disabled.includes('pwsh'));
    const results=host.events.filter(event=>event.type==='tool/result').map(event=>event.data.message.content.map(block=>block.text??'').join(''));
    assert.ok(results.some(result=>result.includes('gate-native-marker')));
    await host.command(agent,'on');
    await host.send(agent,'恢复工作证据入口');
    assert.ok(seen.at(-1).names.includes('project_evidence'));
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
