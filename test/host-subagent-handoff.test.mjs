import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';
import {stubCheckpoint} from '../compaction-handoff.mjs';

const output=result=>(result.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
const textOfReceipt=event=>event.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
const REPORT='CHILD_REPORT_EXACT_7319\n'+'r'.repeat(18000);

const fixture=(events,inheritedEventCount=0)=>({session:{id:'parent-session',log:events,inheritedEventCount}});
const receipt=(seq,childSessionId,body)=>({seq,type:'user/message',data:{role:'user',content:[{type:'text',text:body}],
  source:{kind:'subagent-settled',form:'notice',senderSessionId:childSessionId}}});

test('stub omits the report section when no parent report exists',()=>{
  const stub=stubCheckpoint(fixture([{seq:1,type:'assistant/message',data:{role:'assistant',content:[{type:'text',text:'No delegated report.'}]}}]));
  assert.equal(stub.text.includes('subagent reports'),false);
  assert.equal(stub.text.includes('No delegated report.'),true);
});

test('stub bounds escaped long report identifiers, keeps recent addresses and excludes inherited receipts',()=>{
  const inherited=receipt(1,'inherited-child','INHERITED_REPORT_MUST_NOT_APPEAR');
  const events=[inherited,...Array.from({length:8},(_,index)=>receipt(index+2,'child-'+index+'-'+'\\"'.repeat(500),
    'REPORT_'+index+' '+String.fromCodePoint(0x1f600)+' '+JSON.stringify({quote:'"',slash:'\\'})))];
  const stub=stubCheckpoint(fixture(events,1));
  assert.equal(stub.text.length<=20000,true,String(stub.text.length));
  assert.equal(stub.text.includes('INHERITED_REPORT_MUST_NOT_APPEAR'),false);
  const summary=JSON.parse(stub.text.match(/subagent reports[^\n]*\n([^\n]+)/u)[1]);
  assert.equal(summary.total,8);assert.equal(summary.scopeComplete,true);
  const rows=[...stub.text.matchAll(/^- (\{"childSessionId":[^\n]+\})$/gmu)].map(match=>JSON.parse(match[1]));
  assert.ok(rows.length>0&&rows.length<8);assert.equal(summary.omitted,8-rows.length);
  assert.equal(stub.rows,rows.length);
  assert.equal(rows.at(-1).source.seq,9);
  assert.equal(rows.every(row=>row.source.seq>=3),true);
  assert.equal(rows.every(row=>row.authority==='agent-claim'&&row.childOriginalEvents==='not-read'),true);
  assert.ok(rows.every(row=>stub.text.includes('recall: work_recall('+JSON.stringify({sourceSessionId:'parent-session',seq:row.source.seq,kind:'event',offset:0})+')')));
});

test('report pointers share the stub budget with human requests, failures and the omitted-event notice',()=>{
  const humans=Array.from({length:32},(_,index)=>({seq:index+1,type:'user/message',data:{role:'user',source:{kind:'user'},content:[{type:'text',text:'requirement '+index}]}}));
  const failures=Array.from({length:8},(_,index)=>({seq:index+33,type:'tool/result',data:{name:'read',message:{role:'tool',isError:true,
    content:[{type:'text',text:'problem-'+index+' '+JSON.stringify({path:'C:\\project\\source.json',error:'"missing"'}).repeat(20)}]}}}));
  const agent=fixture([...humans,...failures,...Array.from({length:20},(_,index)=>receipt(index+41,'child-'+index+'-'+'\\"'.repeat(500),
    'REPORT_'+index+' '+JSON.stringify({path:'C:\\project\\report.json',quote:'"'}).repeat(20)))]);
  agent.session.id='session-01234567-0123-0123-0123-0123456789ab';
  const stub=stubCheckpoint(agent);
  assert.ok(stub.text.length<=20000,String(stub.text.length));
  assert.ok(stub.text.includes('"seq":32,"kind":"user"'));
  assert.ok(stub.text.includes('problem-7'));
  const coverage=JSON.parse(stub.text.match(/subagent reports[^\n]*\n([^\n]+)/u)[1]);
  const reports=[...stub.text.matchAll(/^- (\{"childSessionId":[^\n]+\})$/gmu)].map(match=>JSON.parse(match[1]));
  assert.equal(coverage.total,20);assert.equal(coverage.omitted,20-reports.length);
  assert.ok(reports.length>0&&reports.length<8);
  assert.equal(reports.at(-1).source.seq,60);
});

test('native stub compaction exposes a parent subagent receipt for exact recall after disable',async()=>{
  let reads=0,reportReceived=false,recallArguments=null;
  const host=await startHost({
    workspace:{stubSummary:true,contextProtocol:false,historyHygiene:false},
    extraMounts:[['dsh-subagent',{}],['dsh-subagent-spawn-in-process',{}],
      ['dsh-compaction-basic',{thresholdRatio:.9,retainTokens:4000,maxTokens:10000,headroomTokens:4000}]],
    script:options=>{
      const visible=requestText(options);
      if(visible.includes('CHILD_REPORT_TASK'))return [text(REPORT)];
      if(visible.includes('Its closing message:')&&!visible.includes('取回子代理报告'))reportReceived=true;
      if(reportReceived&&reads===0){reads=1;return [tool('read',{file_path:'source0.txt'})];}
      if(reportReceived&&reads>0&&reads<10)return [tool('read',{file_path:`source${reads++}.txt`})];
      if(visible.includes('取回子代理报告')){
        if(!recallArguments){
          const match=/subagent reports[\s\S]*?recall: work_recall\((\{[^\n]+\})\)/u.exec(visible);
          assert.ok(match,'the committed stub must expose the parent report address');
          recallArguments=JSON.parse(match[1]);
          return [tool('work_recall',{...recallArguments,maxChars:64000})];
        }
        return [text('REPORT_RECALL_COMPLETE')];
      }
      return [text('Parent task continues.')];
    }});
  try{
    for(let index=0;index<10;index++)await fs.writeFile(path.join(host.cwd,`source${index}.txt`),
      Array.from({length:120},(_,line)=>`source${index} line ${line} `+'q'.repeat(100)).join('\n'));
    const parent=await host.createAgent('low');
    await host.send(parent,'Continue the parent task. Received agent reports are background, not user requirements.');
    const activation=await host.ctx.subagents.startActivation({provider:'spawn',label:'Return a report',delivery:'parent',
      signal:AbortSignal.timeout(30000),request:{parent,prompt:[{type:'text',text:'CHILD_REPORT_TASK'}],
        agentOptions:{provider:'scripted',model:'scripted-model',reasoningEffort:'low'}}});
    assert.equal((await activation.result).stopReason,'completed');await parent.whenIdle();
    assert.equal(reads,10);
    const parentReceipt=parent.session.log.find(event=>event.type==='user/message'&&event.data?.source?.kind==='subagent-settled');
    assert.ok(parentReceipt);
    await host.ctx.compaction.compactNow(parent,AbortSignal.timeout(30000));
    const detail=(await host.command(parent,'detail')).detail.compression.nativeHandoff;
    assert.equal(detail.stubSummaries,1);assert.equal(detail.committed,1);assert.equal(detail.nativeSummaryCalls,0);
    assert.equal(host.auxiliaryRequests.length,0);
    const summary=host.events.findLast(event=>event.type==='compaction/summary');
    const checkpoint=output({content:summary.data.summary});
    assert.ok(checkpoint.includes('subagent reports'));
    assert.ok(checkpoint.includes(`"seq":${parentReceipt.seq}`));
    assert.ok(checkpoint.includes('agent claims, not user requirements, current source or completion proof'));
    await host.command(parent,'off');
    assert.ok(host.ctx.tools.get('work_recall',parent));
    await host.send(parent,'取回子代理报告，不读取子会话。');
    assert.ok(recallArguments,JSON.stringify({request:requestText(host.requests.at(-1)).slice(-1000),
      events:host.events.slice(-8).map(event=>({seq:event.seq,type:event.type,data:event.data}))}));
    assert.equal(recallArguments.sourceSessionId,parent.session.id);
    assert.equal(recallArguments.kind,'event');assert.equal(recallArguments.seq,parentReceipt.seq);
    const recall=host.events.findLast(event=>event.type==='tool/result'&&event.data.message?.source?.callId&&
      event.data.message.content?.some(block=>block.text?.includes('"kind":"event"')));
    assert.ok(recall,JSON.stringify(host.events.slice(-6)));
    const recalled=JSON.parse(output(recall.data.message));
    assert.equal(recalled.status,'observed');assert.equal(recalled.text,textOfReceipt(parentReceipt));
    assert.equal(recalled.complete,true);assert.equal(recalled.textComplete,true);
    assert.equal(host.auxiliaryRequests.length,0);
    console.log('subagent-stub',JSON.stringify({parentReceiptSeq:parentReceipt.seq,stubSummaries:detail.stubSummaries,
      nativeSummaryCalls:detail.nativeSummaryCalls,recalledChars:recalled.text.length,recallAfterDisable:true}));
  }finally{await host.close();}
});
