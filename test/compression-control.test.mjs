import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompressionControl} from '../compression-control.mjs';
function harness(){
  const hooks={},state={step:1,turn:1,config:{compressionControl:true}},events=new Map([[1,{data:{message:{content:[{type:'text',text:'source text '.repeat(100)}]}}}]]);
  const agent={session:{id:'external-compression',seq:2,surface:{nodes:[1],contentGeneration:0},eventAt:seq=>events.get(seq)}};
  const ctx={on:(name,fn)=>{hooks[name]=fn;},tools:{get:()=>true},agents:{get:()=>agent}};
  const economics={pressure:()=>({emergency:false}),remember:(_a,d)=>d,assess:()=>({allowed:true})};
  const control=createCompressionControl(ctx,{isEnabled:()=>true,get:()=>state},economics);
  let executions=0;
  const next=async()=>{executions++;return {isError:false,content:[{type:'text',text:'unchanged'}]};};
  const execute=arguments_=>hooks['tools/execute']({name:'compress',agent,arguments:arguments_},next);
  return {agent,state,control,hooks,execute,executions:()=>executions};
}
test('external compression cooperation blocks non-shrinking summaries only while enabled',async()=>{
  const h=harness(),args={content:[{startSeq:1,endSeq:1,summary:'x'.repeat(2000)}]};
  assert.equal((await h.execute(args)).isError,true);assert.equal(h.executions(),0);
  h.state.config.compressionControl=false;assert.equal((await h.execute(args)).isError,false);assert.equal(h.executions(),1);
});
test('external compression cooperation blocks an unchanged repeated proposal and bypasses it after overflow',async()=>{
  const h=harness(),args={content:[{startSeq:1,endSeq:1,summary:'short'}]};
  assert.equal((await h.execute(args)).isError,false);assert.equal((await h.execute(args)).isError,true);
  assert.equal(h.executions(),1);
  await h.hooks['agent/request-error']({agent:h.agent,failure:{code:'CONTEXT_WINDOW_EXCEEDED'}},async()=>({kind:'continue'}));
  assert.equal((await h.execute(args)).isError,false);assert.equal(h.executions(),2);
  assert.equal(h.control.metrics(h.agent).emergencyPasses,1);
});
