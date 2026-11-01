import test from 'node:test';
import assert from 'node:assert/strict';
import {startHost,text,systemOf,toolNames} from './helpers/host.mjs';

const answer=()=>[text('完成。')];

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
