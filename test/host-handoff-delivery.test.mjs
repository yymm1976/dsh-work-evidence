import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool} from './helpers/host.mjs';
const results=host=>host.events.filter(event=>event.type==='tool/result').map(event=>event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'));

test('handoff includes a current original result and uses a visible full delivery for later patches',async()=>{
  let host,baseId;
  host=await startHost({workspace:{toolSurface:'full',contextProtocol:false,historyHygiene:false},script:(_options,call)=>{
    if(call===1)return [tool('work_state',{mode:'handoff',incremental:true})];
    if(call===2){baseId=JSON.parse(results(host)[0]).delivery.id;return [tool('read',{file_path:'source.txt'})];}
    if(call===3)return [tool('work_state',{mode:'handoff',baseDeliveryId:baseId})];
    return [text('完成。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'EXACT_CURRENT_SOURCE_LINE\n');
    const agent=await host.createAgent('max');await host.send(agent,'读取 source.txt，保留原文来源。'+'本轮要求。'.repeat(700));
    const values=results(host),full=JSON.parse(values[0]),delta=JSON.parse(values[2]);
    assert.equal(full.delivery.kind,'full');
    assert.equal(delta.schema,'work-evidence.task-handoff-delta.v1');
    assert.equal(delta.baseDeliveryId,baseId);
    assert.ok(JSON.stringify(delta.patch).includes('EXACT_CURRENT_SOURCE_LINE'));
    const handoff=await host.command(agent,'handoff');
    assert.ok(handoff.observedWork.recentToolResults.items.some(item=>item.text.includes('EXACT_CURRENT_SOURCE_LINE')&&item.textComplete));
    assert.ok(JSON.stringify(handoff).length<=handoff.coverage.maxChars);
  }finally{await host.close();}
});

test('a handoff returned only inside PTC is not treated as a visible complete base',async()=>{
  let host,baseId;
  host=await startHost({toolMode:'ptc',workspace:{toolSurface:'full',contextProtocol:false,historyHygiene:false},
    extraMounts:[['dsh-ptc-runtime-node',{}],['dsh-agent-tool-presentation',{mode:'ptc'}]],script:(_options,call)=>{
      if(call===1)return [tool('run_code',{code:'const value = await tools.work_state({mode:"handoff",incremental:true}); console.log("delivery-id="+value.delivery.id);'})];
      if(call===2){baseId=results(host)[0].match(/delivery-id=([a-f0-9-]+)/)?.[1];assert.ok(baseId);
        return [tool('run_code',{code:'return await tools.work_state('+JSON.stringify({mode:'handoff',baseDeliveryId:baseId})+');'})];}
      return [text('完成。')];
    }});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'导出任务摘要。'+'保留来源。'.repeat(700));
    const value=JSON.parse(results(host)[1]);
    assert.equal(value.schema,'work-evidence.task-handoff.v1');assert.equal(value.delivery.reason,'base-not-fully-visible');
  }finally{await host.close();}
});
