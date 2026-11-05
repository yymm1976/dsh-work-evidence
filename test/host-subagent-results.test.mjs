import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './helpers/host.mjs';
import {readRequestAccounting,taskRequestConsumption} from '../experiment-consumption.mjs';
import {summarizeAttempts} from '../experiment-attempts.mjs';
import {nativeChildInventory} from '../experiment-native.mjs';

async function saveObservation(name,value){
  const directory=process.env.DSH_SUBAGENT_RECORD_DIR;if(!directory)return;
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,name+'.json'),JSON.stringify({backend:'scripted',usageScope:'fixture-reported-counts; no network or real billing',...value},null,2)+'\n',{flag:'wx'});
}

const output=result=>(result.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
const json=result=>result.value??JSON.parse(output(result));
let invocation=0;
const invoke=(host,agent,name,args)=>{const callId='owned-'+name+'-'+(++invocation);return host.ctx.tools.execute({name,arguments:args,agent,callId,rootCallId:callId,signal:AbortSignal.timeout(15000)});};
const REPORT='CHILD_SOURCE_RESULT: source.txt contains SOURCE_RETURN_EXACT. Source details stay in the child session.';

test('native child settlement is handed off and parent receipt and child originals remain separately reachable',async()=>{
  let childCalls=0,fullId=null,exportStage=0,closed=false;const deliveries=[],agents=new Map(),files=new Map();
  const host=await startHost({workspace:{toolSurface:'full',contextProtocol:false,historyHygiene:false},
    sessionQueryMount:['dsh-session-query-sqlite',{path:':memory:'}],
    extraMounts:[['dsh-subagent',{}],['dsh-subagent-spawn-in-process',{}],['dsh-tool-session-query',{}]],
    script:async options=>{
      const visible=requestText(options);
      if(visible.includes('CHILD_SOURCE_TASK')){
        if(!files.has(options.sessionId))files.set(options.sessionId,(await host.command(agents.get(options.sessionId),'status')).observability.persistence.file);
        return ++childCalls===1?[tool('read',{file_path:'source.txt'})]:[text(REPORT+(visible.includes('CHILD_FOLLOWUP_TASK')?' Follow-up result is separate.':''))];
      }
      if(visible.includes('Its closing message:')&&exportStage===0){exportStage=1;return [tool('work_state',{mode:'handoff',incremental:true})];}
      const latest=options.messages?.findLast(message=>message.role==='tool');
      if(latest)try{const value=JSON.parse(output(latest));if(value.schema?.startsWith('work-evidence.task-handoff')&&!deliveries.some(item=>JSON.stringify(item)===JSON.stringify(value)))deliveries.push(value);
        if(value.delivery?.kind==='full')fullId=value.delivery.id;}catch{}
      if(visible.includes('Follow-up result is separate.')&&exportStage===1){exportStage=2;return [tool('work_state',{mode:'handoff',baseDeliveryId:fullId})];}
      return [text('Parent received the report; continue the authorized task.')];
    }});
  host.ctx.on('agent/created',({agent})=>agents.set(agent.session.id,agent));
  try{
    await fs.writeFile(path.join(host.cwd,'source.txt'),'SOURCE_RETURN_EXACT\n');
    const parent=await host.createAgent('low');await host.send(parent,'Continue the parent task; received agent reports are background. '+('Preserve this explicit requirement. '.repeat(240)));
    const activation=await host.ctx.subagents.startActivation({provider:'spawn',label:'Read the source',delivery:'parent',
      signal:AbortSignal.timeout(30000),request:{parent,prompt:[{type:'text',text:'CHILD_SOURCE_TASK: read source.txt and return a source report.'}],
        agentOptions:{provider:'scripted',model:'scripted-model',reasoningEffort:'low'}}});
    const result=await activation.result;assert.equal(result.stopReason,'completed');await parent.whenIdle();
    const handoff=await host.command(parent,'handoff'),reports=handoff.observedWork.subagentResults;
    assert.equal(reports.total,1);assert.equal(handoff.userRequests.total,1);
    const item=reports.items[0];assert.equal(item.childSessionId,activation.childId);assert.equal(item.locality,'local');
    assert.equal(item.authority,'agent-claim');assert.equal(handoff.task.completion,'not-determined');
    assert.ok(item.text.includes(REPORT));assert.equal(item.source.sessionId,parent.session.id);
    assert.equal(item.childOriginalEvents,'not-read');assert.equal(item.consumption,'unknown-in-parent-receipt');
    const receipt=json(await invoke(host,parent,'work_recall',{sourceSessionId:parent.session.id,kind:'event',seq:item.source.seq}));
    assert.equal(receipt.status,'observed');assert.equal(receipt.text,item.text);assert.equal(receipt.complete,true);
    const catalog=json(await invoke(host,parent,'work_recall',{sourceSessionId:parent.session.id,kind:'event',seq:item.catalogSource.seq}));
    assert.equal(JSON.parse(catalog.text).childId,activation.childId);
    assert.equal(item.childLookup.tool,'session_event_search');
    const search=await invoke(host,parent,item.childLookup.tool,item.childLookup.arguments);
    assert.equal(search.isError,false,output(search));const seq=Number(output(search).match(/\d+\. seq (\d+) \| assistant\/message/)?.[1]);
    assert.ok(Number.isSafeInteger(seq),JSON.stringify({query:item.childLookup.arguments.query,result:output(search)}));
    const original=await invoke(host,parent,'session_event_read',{session_id:activation.childId,seq});
    assert.equal(original.isError,false);assert.ok(output(original).includes(REPORT));
    assert.equal(deliveries[0]?.delivery?.kind,'full');
    await host.ctx.subagents.sendMessage(parent,activation.childId,[{type:'text',text:'CHILD_FOLLOWUP_TASK: return a separate follow-up result.'}],{signal:AbortSignal.timeout(15000)});
    await host.ctx.subagents.waitForChildren(parent);await parent.whenIdle();
    const updated=await host.command(parent,'handoff'),latestReports=updated.observedWork.subagentResults;
    assert.equal(latestReports.total,2);assert.ok(latestReports.items.every(report=>report.childSessionId===activation.childId));
    assert.notEqual(latestReports.items[0].source.seq,latestReports.items[1].source.seq);
    assert.ok(latestReports.items[1].text.includes('Follow-up result is separate.'));
    assert.equal(deliveries[1]?.schema,'work-evidence.task-handoff-delta.v1');
    assert.ok(JSON.stringify(deliveries[1].patch).includes('Follow-up result is separate.'));
    const cross=json(await invoke(host,parent,'work_recall',{sourceSessionId:activation.childId,kind:'event',seq}));
    assert.equal(cross.reason,'source-session-mismatch');
    const foreign=await host.ctx.agents.create({sessionId:'outside-'+Date.now(),agentOptions:{provider:'scripted',model:'scripted-model',reasoningEffort:'low'},meta:{cwd:path.join(host.cwd,'other-workspace')}});
    const denied=await invoke(host,foreign.agent,'session_event_read',{session_id:activation.childId,seq});
    assert.equal(denied.isError,true);assert.match(output(denied),/outside the caller workspace/);
    await host.command(parent,'off');
    const native=await invoke(host,parent,'session_event_read',{session_id:activation.childId,seq});
    assert.equal(native.isError,false);assert.ok(output(native).includes(REPORT));
    assert.equal(host.auxiliaryRequests.length,0);
    const sources=[];
    files.set(parent.session.id,(await host.command(parent,'status')).observability.persistence.file);
    for(const id of [parent.session.id,activation.childId]){
      const agent=agents.get(id);
      sources.push({sessionId:id,events:structuredClone(agent.session.log),file:files.get(id)});
    }
    await host.close();closed=true;
    const parts=[];
    for(const source of sources){
      const attemptAccounting=summarizeAttempts(source.events),requestAccounting=await readRequestAccounting(source.file,source.events,{sessionId:source.sessionId});
      assert.equal(requestAccounting.complete,true,JSON.stringify(requestAccounting.problems));
      parts.push({sessionId:source.sessionId,attemptAccounting,requestAccounting,requests:{started:attemptAccounting.attempts.length}});
    }
    const consumption=taskRequestConsumption(parts),observed=host.requests.length;
    assert.equal(consumption.unknown,false);assert.equal(consumption.requests,observed);
    assert.equal(consumption.tokens.totalTokens.known,observed*1100);
    await saveObservation('native-local',{handoff,updatedHandoff:updated,deliveries,receipt,childSearch:output(search),childOriginal:output(original),
      crossSessionRecall:cross,denied:output(denied),disabledNativeRead:output(native),sources,accounting:parts,consumption,backendRequests:observed});
  }finally{if(!closed)await host.close();}
});

test('native external result keeps its parent original without inventing a child session or its consumption',async()=>{
  const host=await startHost({workspace:{toolSurface:'full',contextProtocol:false},
    extraMounts:[['dsh-subagent',{}],['dsh-tool-session-query',{}]],script:()=>[text('Received the report.')]});
  let disposed=0;
  try{
    host.ctx.subagents.registerProvider({name:'fixture-external',capabilities:{agentOptions:true,agentPreset:false,outputSchema:false,depthLimit:false},
      inheritsParentContext:false,start:async()=>({id:'external-'+Date.now(),result:Promise.resolve({output:[{type:'text',text:'EXTERNAL_RESULT: investigation claim, not a local transcript.'}],
        stopReason:'completed'}),dispose:async()=>{disposed++;}})});
    const parent=await host.createAgent('low');await host.send(parent,'Receive an external report as background.');
    const activation=await host.ctx.subagents.startActivation({provider:'fixture-external',label:'External report',delivery:'parent',signal:AbortSignal.timeout(15000),
      request:{parent,prompt:[{type:'text',text:'Return a source report.'}],agentOptions:{provider:'scripted',model:'scripted-model',reasoningEffort:'low'}}});
    assert.equal((await activation.result).stopReason,'completed');await parent.whenIdle();assert.equal(disposed,1);
    const handoff=await host.command(parent,'handoff'),report=handoff.observedWork.subagentResults.items[0];
    assert.equal(report.locality,'external');assert.equal(report.childLookup,null);assert.equal(report.consumption,'unknown-in-parent-receipt');
    assert.equal(host.ctx.sessions.get(activation.childId),undefined);
    const receipt=json(await invoke(host,parent,'work_recall',{sourceSessionId:parent.session.id,kind:'event',seq:report.source.seq}));
    assert.equal(receipt.status,'observed');assert.ok(receipt.text.includes('EXTERNAL_RESULT'));
    const inventory=nativeChildInventory(parent.session.log,{source:'native-session-readonly',inherited:parent.session.inheritedEventCount});
    assert.equal(inventory.children[0].mode,'external');
    await saveObservation('native-external',{handoff,receipt,inventory,disposed,backendRequests:host.requests.length});
  }finally{await host.close();}
});
