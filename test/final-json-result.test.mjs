import test from 'node:test';
import assert from 'node:assert/strict';
import {createFinalJsonGuard,finalJsonResultIssue} from '../final-json.mjs';
import {defaults} from '../runtime.mjs';
import {startHost,text,tool} from './helpers/host.mjs';

const prompt='最终只返回 JSON：{"exitCode":整数,"stdout":"完整实际输出","stderr":"完整实际错误输出"}。';
const fields={exitCode:0,stdout:'actual\r\n',stderr:''};
const message=(seq,type,value)=>({seq,type,data:{turn:1,message:{role:type==='assistant/message'?'assistant':'tool',content:[{type:'text',text:value}]}}});
function fixture(){
  const request=message(0,'user/message',prompt);request.data.message.role='user';request.data.message.source={kind:'user'};
  const source=message(3,'tool/result',JSON.stringify(fields));source.data.message.source={kind:'tool',callId:'root'};
  const assistant=message(4,'assistant/message',JSON.stringify({...fields,stdout:'actual'}));
  const dispatch={seq:2,type:'tool/ptc-dispatch',data:{rootCallId:'root',subCallId:'native',name:'pwsh',isError:false}};
  return {events:[request,dispatch,source,assistant],request,assistant,observation:{requestSeq:0,rootCallId:'root',callId:'native',tool:'pwsh',fields},visibleSeqs:[0,2,3,4]};
}

test('literal process output comparison identifies only omitted terminal line endings',()=>{
  const input=fixture();
  assert.deepEqual(finalJsonResultIssue(input)?.fields,['stdout']);
  for(const newline of ['\n','\r\n','\r','\n\n']){
    const row=fixture();row.observation.fields={...fields,stdout:'actual'+newline};
    row.events[2].data.message.content[0].text=JSON.stringify(row.observation.fields);
    assert.ok(finalJsonResultIssue(row));
  }
  const row=fixture();row.assistant.data.message.content[0].text=JSON.stringify(fields);
  assert.equal(finalJsonResultIssue(row),null);
});

test('ambiguous, changed, unavailable or transformed results do not request correction',()=>{
  const cases={
    'no literal-copy intent':row=>{row.request.data.message.content[0].text='最终只返回 JSON，包含 exitCode stdout stderr。';},
    'summary request':row=>{row.request.data.message.content[0].text+='输出摘要。';},
    'normalization request':row=>{row.request.data.message.content[0].text+='normalize stdout。';},
    'line endings explicitly removed':row=>{row.request.data.message.content[0].text+='去掉末尾换行。';},
    'hidden source':row=>{row.visibleSeqs=[0,4];},
    'unknown surface representation':row=>{row.visibleSeqs=new Set([3]);},
    'earlier request':row=>{row.observation.requestSeq=-1;},
    'unrelated root':row=>{row.observation.rootCallId='other';},
    'unrelated native call':row=>{row.observation.callId='other';},
    'multiple native dispatches':row=>{row.events.splice(2,0,{...row.events[1],seq:2.5});},
    'failed outer result':row=>{row.events[2].data.message.isError=true;},
    'failed native dispatch':row=>{row.events[1].data.isError=true;},
    'transformed outer result':row=>{row.events[2].data.message.content[0].text=JSON.stringify({...fields,stdout:'different\r\n'});},
    'extra source fields':row=>{row.events[2].data.message.content[0].text=JSON.stringify({...fields,extra:1});},
    'different exit code':row=>{row.assistant.data.message.content[0].text=JSON.stringify({...fields,exitCode:1,stdout:'actual'});},
    'different answer body':row=>{row.assistant.data.message.content[0].text=JSON.stringify({...fields,stdout:'another'});},
    'changed line ending':row=>{row.assistant.data.message.content[0].text=JSON.stringify({...fields,stdout:'actual\n'});},
    'omitted field':row=>{row.assistant.data.message.content[0].text=JSON.stringify({exitCode:0,stderr:''});},
    'multiple JSON answers':row=>{row.assistant.data.message.content[0].text='```json\n'+JSON.stringify({...fields,stdout:'actual'})+'\n```\n```json\n{}\n```';},
    'later unrelated tool result':row=>{row.events.splice(-1,0,message(3.5,'tool/result','unrelated'));},
  };
  for(const [name,modify]of Object.entries(cases)){const row=fixture();modify(row);assert.equal(finalJsonResultIssue(row),null,name);}
});

function harness({config:overrides={},nativeChange={}}={}){
  const row=fixture(),events=row.events,hooks=new Map(),notices=[],decisions=[];
  const config={finalJsonGuard:true,finalJsonResultGuard:true,...overrides};let guard;
  const agent={session:{id:'result-guard',log:events,surface:{nodes:row.visibleSeqs}},steer:value=>{
    notices.push(value);events.push({seq:events.at(-1).seq+1,type:'user/message',data:value});
  }};
  const runtime={isEnabled:()=>true,get:()=>({config}),receipt:async()=>{},effects:{decide:(...args)=>decisions.push(args)}};
  const control=createFinalJsonGuard({on:(name,fn)=>hooks.set(name,fn),tools:{guard:fn=>{guard=fn;}}},runtime);
  hooks.get('tools/result')({agent,name:'pwsh',callId:'native',rootCallId:'root',signal:new AbortController().signal},
    {isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'actual\r\n',truncated:false},stderr:{text:'',truncated:false},...nativeChange}});
  const append=text=>events.push(message(events.at(-1).seq+1,'assistant/message',text));
  return {agent,config,events,notices,decisions,control,hooks,append,guard:()=>guard({agent}),
    stop:()=>hooks.get('agent/turn-stopping')({agent,turn:1,signal:new AbortController().signal})};
}

test('result candidate is default off and validates its setting',()=>{
  assert.equal(defaults().finalJsonResultGuard,false);
  assert.equal(defaults({finalJsonResultGuard:true}).finalJsonResultGuard,true);
  assert.throws(()=>defaults({finalJsonResultGuard:'true'}),/Invalid finalJsonResultGuard/);
});

test('incomplete native observations and disabled controls never trigger a result notice',async()=>{
  for(const nativeChange of [{kind:'background'},{aborted:true},{timedOut:true},{partial:true},{status:'running'},{signal:'SIGTERM'},
    {stdout:{text:'actual\r\n',truncated:true}},{stdout:{text:'actual\r\n',complete:false,truncated:false}},{exitCode:null}]){
    const host=harness({nativeChange});await host.stop();assert.equal(host.notices.length,0,JSON.stringify(nativeChange));
  }
  for(const config of [{finalJsonGuard:false},{finalJsonResultGuard:false}]){
    const host=harness({config});await host.stop();assert.equal(host.notices.length,0);
  }
});

test('one source-bound notice preserves the original answer and does not loop',async()=>{
  const host=harness(),original=host.events.at(-1).data.message.content[0].text;
  await host.stop();await host.stop();assert.equal(host.notices.length,1);
  assert.equal(host.decisions[0][1],'finalJsonResult');assert.equal(host.decisions[0][2],'applied');
  assert.match(host.guard(),/without tool calls/);
  assert.equal(host.events.find(event=>event.seq===4).data.message.content[0].text,original);
  assert.match(host.notices[0].content[0].text,/'sourceSeq'|"sourceSeq":3/u);
  host.append(JSON.stringify({...fields,stdout:'actual'}));await host.stop();
  assert.equal(host.notices.length,1);assert.equal(host.guard(),undefined);
  assert.deepEqual(host.control.summary(host.agent).unresolvedResult?.fields,['stdout']);
});

test('a corrected answer, disabled candidate or fresh request releases the tool restriction',async()=>{
  for(const reason of ['corrected','disabled','new-request','turn-end','disposed']){
    const host=harness();await host.stop();assert.equal(typeof host.guard(),'string');
    if(reason==='corrected'){host.append(JSON.stringify(fields));await host.stop();}
    if(reason==='disabled'){host.config.finalJsonResultGuard=false;}
    if(reason==='new-request')host.hooks.get('session/event')(host.agent.session,{type:'user/message',data:host.events[0].data});
    if(reason==='turn-end')host.hooks.get('session/event')(host.agent.session,{type:'turn/end'});
    if(reason==='disposed')host.hooks.get('agent/disposed')({agent:host.agent});
    assert.equal(host.guard(),undefined,reason);
  }
});

test('result-repair steering failures are attributed to the result guard',async()=>{
  for(const mode of ['missing','throws']){
    const host=harness();
    if(mode==='missing')delete host.agent.steer;
    else host.agent.steer=()=>{throw new Error('steering unavailable');};
    await host.stop();
    assert.equal(host.notices.length,0);
    assert.equal(host.decisions.length,1);
    assert.deepEqual(host.decisions[0].slice(1,4),['finalJsonResult','unavailable',mode==='missing'?'native-steering-unavailable':'native-steering-failed']);
  }
});

test('changing invalid JSON cannot exceed two repairs for one request',async()=>{
  const host=harness();
  for(let n=0;n<5;n++){host.append('{"value":'+n+',}');await host.stop();}
  assert.equal(host.notices.length,2);assert.equal(host.guard(),undefined);
  assert.ok(host.decisions.some(row=>row[3]==='final-json-repair-limit'));
  assert.ok(host.control.summary(host.agent).unresolvedSyntax);
});

test('native PTC result copying adds one model correction and no repeated command',async()=>{
  for(const enabled of [false,true]){
    const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{finalJsonResultGuard:enabled},script:(options,n)=>{
      if(n===1)return [tool('run_code',{code:'const r=await tools.pwsh({command:\'[Console]::Out.Write("actual`r`n")\',description:"Return the requested output"});return {exitCode:r.exitCode,stdout:r.stdout.text,stderr:r.stderr.text};',description:'Return original process fields'})];
      if(n===2)return [text(JSON.stringify({...fields,stdout:'actual'}))];
      assert.ok(enabled);assert.ok(options.messages.some(message=>message.source?.finalJson?.kind==='observed-result-repair'));
      return [text(JSON.stringify(fields))];
    }});
    try{
      const agent=await host.createAgent();await host.send(agent,prompt);
      assert.equal(host.requests.length,enabled?3:2);
      const executions=host.events.filter(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='pwsh');
      assert.equal(executions.length,1);assert.equal(executions[0].data.isError,false);
      const answers=host.events.filter(event=>event.type==='assistant/message').map(event=>event.data.message.content.find(block=>block.type==='text')?.text).filter(Boolean);
      assert.equal(JSON.parse(answers[0]).stdout,'actual');
      assert.equal(JSON.parse(answers.at(-1)).stdout,enabled?'actual\r\n':'actual');
    }finally{await host.close();}
  }
});
