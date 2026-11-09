import test from 'node:test';
import assert from 'node:assert/strict';
import {fullOutputRequest} from '../history-hygiene.mjs';

const userEvent=(text,kind='user')=>({type:'user/message',data:{role:'user',source:{kind},content:[{type:'text',text}]}});

test('only genuine user messages can request full canonical output',()=>{
  assert.deepEqual(fullOutputRequest(userEvent('请给出完整输出')),{applies:true,requested:true});
  assert.deepEqual(fullOutputRequest(userEvent('show full output')),{applies:true,requested:true});
  assert.deepEqual(fullOutputRequest(userEvent('implement the fix')),{applies:true,requested:false});
  assert.deepEqual(fullOutputRequest(userEvent('本次程序已结束，退出码为 1，原始输出报告了失败','work-evidence-task-flow')),{applies:false,requested:false});
  assert.deepEqual(fullOutputRequest(userEvent('原始输出保留在 canonical 历史','work-evidence-state')),{applies:false,requested:false});
  assert.deepEqual(fullOutputRequest(userEvent('Current runtime context','runtime-context')),{applies:false,requested:false});
  assert.deepEqual(fullOutputRequest({type:'tool/result',data:{role:'tool',content:[]}}),{applies:false,requested:false});
  assert.deepEqual(fullOutputRequest(null),{applies:false,requested:false});
  assert.deepEqual(fullOutputRequest({type:'user/message',data:{role:'user',content:[{type:'text',text:'完整输出'}]}}),{applies:true,requested:true});
});

test('plugin diagnostic replay keeps receipts enabled',()=>{
  const events=[
    userEvent('Fix dotenv run --no-override expansion'),
    {type:'user/message',data:{role:'user',source:{kind:'work-evidence-task-flow'},content:[{type:'text',text:'[work-evidence] 本次程序已结束，退出码为 1，原始输出报告了失败。'}]}},
    {type:'user/message',data:{role:'user',source:{kind:'work-evidence-state'},content:[{type:'text',text:'工程状态已失效'}]}},
  ];
  let requested=false;
  for(const event of events){const decision=fullOutputRequest(event);if(decision.applies)requested=decision.requested;}
  assert.equal(requested,false);
  requested=fullOutputRequest(userEvent('请给出全部输出')).requested;
  assert.equal(requested,true);
  for(const event of events.slice(1)){const decision=fullOutputRequest(event);if(decision.applies)requested=decision.requested;}
  assert.equal(requested,true,'a later plugin message must not clear a real user request');
});
