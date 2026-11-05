import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults} from '../runtime.mjs';
import {startHost,load} from './helpers/host.mjs';
const {isAgentLoopRequest,markAgentLoopRequest}=await load('dsh-llm');
const {nativeReasoningReplayView,nativeReasoningReplayRequest}=await import('../native-reasoning-replay.mjs');

function request(){
  const provider='reasoning-probe',model='deepseek-v4.1-flash',reasoning='Previously resolved source fact: FACT_9027.';
  return {provider,model,reasoningEffort:'max',sessionId:'replay-session',tools:[{name:'run_code',description:'existing tool',parameters:{type:'object'}}],messages:[
    {role:'user',content:[{type:'text',text:'Continue the recorded task.'}]},
    {role:'assistant',id:'original-assistant',source:{provider,model,kind:'model',replayState:{response:{kind:'pi-ai',version:2,api:'openai-completions',provider,model,stopReason:'toolUse'},
      blocks:[{type:'reasoning',thinkingSignature:JSON.stringify([{index:0,type:'reasoning.text',text:reasoning}])},{type:'tool-call'}]}},
      content:[{type:'reasoning',text:reasoning},{type:'tool-call',name:'run_code',id:'ready-call',arguments:'{"code":"return 1"}'}]},
    {role:'tool',toolCallId:'ready-call',content:[{type:'text',text:'1'}],isError:false},
  ]};
}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

test('readable native metadata is mapped without modifying canonical text, tool calls, effort or frozen requests',()=>{
  const options=request();markAgentLoopRequest(options);freeze(options);const original=JSON.stringify(options);
  const result=nativeReasoningReplayView(options);
  assert.equal(result.translatedMessages,1);assert.notEqual(result.options,options);assert.ok(Object.isFrozen(result.options));
  assert.equal(isAgentLoopRequest(result.options),true);assert.equal(result.options.reasoningEffort,'max');
  assert.equal(result.options.messages[1].content,options.messages[1].content);assert.equal(result.options.tools,options.tools);
  assert.equal(result.options.messages[0],options.messages[0]);assert.equal(result.options.messages[2],options.messages[2]);
  assert.equal(result.options.messages[1].source.replayState.blocks[0].thinkingSignature,'reasoning_content');
  assert.equal(JSON.stringify(options),original);
  assert.equal(nativeReasoningReplayView(result.options).options,result.options,'an already mapped request is unchanged');
});

test('unknown, encrypted, mismatched and multiple reasoning histories remain exact',()=>{
  const cases=[
    options=>{options.model='other-model';},
    options=>{options.tools=[];},
    options=>{options.messages[1].source.provider='foreign-provider';},
    options=>{options.messages[1].source.replayState.response.version=3;},
    options=>{options.messages[1].source.replayState.response.api='anthropic-messages';},
    options=>{options.messages[1].source.replayState.blocks[0].thinkingSignature='encrypted-signature';},
    options=>{options.messages[1].source.replayState.blocks[0].thinkingSignature='[{"type":"reasoning.encrypted","data":"opaque"}]';},
    options=>{options.messages[1].source.replayState.blocks[0].thinkingSignature='[{"type":"reasoning.text","text":"wrong value"}]';},
    options=>{options.messages[1].source.replayState.blocks[0].thinkingSignature=JSON.stringify([{type:'reasoning.text',text:options.messages[1].content[0].text,id:'unknown-extra-metadata'}]);},
    options=>{options.messages[1].source.replayState.blocks[1].thoughtSignature='opaque';},
    options=>{options.messages[1].source.replayState.blocks[0].redacted=true;},
    options=>{options.messages[1].source.replayState.blocks[0]=null;options.messages[1].content[0]=null;},
    options=>{options.messages[1].source.replayState.blocks.push({type:'reasoning'});options.messages[1].content.push({type:'reasoning',text:'another block'});},
  ];
  for(const change of cases){const options=request();change(options);freeze(options);assert.equal(nativeReasoningReplayView(options).options,options);}
});

test('the candidate is opt-in, follows session effectiveness and records only mapping counts',()=>{
  assert.equal(defaults().nativeReasoningReplay,false);assert.throws(()=>defaults({nativeReasoningReplay:'true'}),/Invalid nativeReasoningReplay/u);
  const options=request(),agent={session:{id:'replay-session'}},state={config:defaults()},ctx={agents:{get:()=>agent}};
  let enabled=true;const runtime={get:()=>state,isEnabled:()=>enabled};
  assert.equal(nativeReasoningReplayRequest(ctx,runtime,options),options);
  state.config.nativeReasoningReplay=true;enabled=false;assert.equal(nativeReasoningReplayRequest(ctx,runtime,options),options);
  enabled=true;const result=nativeReasoningReplayRequest(ctx,runtime,options);
  assert.notEqual(result,options);assert.deepEqual(state.reasoningReplay,{requests:1,translatedMessages:1});
});

test('the installed native adapter emits reasoning_content at its real request boundary',async()=>{
  const savedFetch=globalThis.fetch,envName='WORK_EVIDENCE_NATIVE_REPLAY_TEST_KEY',priorKey=process.env[envName];
  process.env[envName]='local-capture-only';let wire,host;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input.url??String(input));assert.equal(url.origin,'http://127.0.0.1:45998');
    wire=JSON.parse(init.body);
    const end={id:'local-native-replay',object:'chat.completion.chunk',created:0,model:'deepseek-v4.1-flash',choices:[{index:0,delta:{content:'complete'},finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}};
    return new Response('data: '+JSON.stringify(end)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  try{
    const provider={api:'openai-completions',baseURL:'http://127.0.0.1:45998/v1',apiKeyEnv:envName,models:[{id:'deepseek-v4.1-flash',contextWindow:1000000,maxTokens:4096,reasoningEfforts:{max:'max'}}]};
    host=await startHost({extraMounts:[['dsh-llm-pi-ai',{providers:{'reasoning-probe':provider}}]],pluginConfig:{nativeReasoningReplay:true}});
    const agent=await host.createAgent('max');await host.command(agent,'detail');
    const options=request();options.sessionId=agent.session.id;options.maxTokens=64;options.signal=AbortSignal.timeout(10000);
    const canonical=JSON.stringify(options.messages);
    for await(const _chunk of host.ctx.llm.stream(options)){}
    const sent=wire.messages.find(message=>message.role==='assistant');
    assert.equal(sent.reasoning_content,options.messages[1].content[0].text);assert.equal(sent.reasoning_details,undefined);
    assert.equal(wire.reasoning_effort,'max');assert.equal(JSON.stringify(options.messages),canonical);
    const status=await host.command(agent,'detail');assert.ok(status.reasoningReplay.translatedMessages>=1);
    await host.command(agent,'off');wire=null;
    for await(const _chunk of host.ctx.llm.stream(options)){}
    const disabled=wire.messages.find(message=>message.role==='assistant');
    assert.ok(Array.isArray(disabled.reasoning_details));assert.equal(disabled.reasoning_content,undefined);
    assert.equal(host.events.filter(event=>event.type==='tool/ptc-dispatch').length,0);
  }finally{
    globalThis.fetch=savedFetch;if(priorKey===undefined)delete process.env[envName];else process.env[envName]=priorKey;
    if(host)await host.close();
  }
});
