import test from 'node:test';
import assert from 'node:assert/strict';
import {handoffPatch,createTaskHandoffDelivery} from '../task-handoff.mjs';

function applyPatch(value,patch){
  let result=structuredClone(value);
  for(const operation of patch){
    if(operation.path===''){result=structuredClone(operation.value);continue;}
    const keys=operation.path.slice(1).split('/').map(key=>key.replaceAll('~1','/').replaceAll('~0','~'));
    let parent=result;for(const key of keys.slice(0,-1))parent=parent[key];
    const key=keys.at(-1);
    if(operation.op==='replace'||operation.op==='remove')assert.ok(Object.hasOwn(parent,key),'JSON Patch target must exist: '+operation.path);
    if(operation.op==='remove'){if(Array.isArray(parent))parent.splice(Number(key),1);else delete parent[key];}
    else if(Array.isArray(parent)&&operation.op==='add')parent.splice(key==='-'?parent.length:Number(key),0,structuredClone(operation.value));
    else parent[key]=structuredClone(operation.value);
  }
  return result;
}

test('handoff patches reconstruct additions, removals, changed arrays and escaped keys',()=>{
  for(const [before,after]of [[{a:[1,2,3],old:true},{a:[1,4],fresh:{value:null}}],
    [{a:[]},{a:[{value:1},{value:2}]}],[{'a/b':{'~name':1}},{'a/b':{'~name':2},arr:[]}],
    [{a:{value:1}},{a:null}]])assert.deepEqual(applyPatch(before,handoffPatch(before,after)),after);
});

test('handoff patches apply to the serialized delivery when optional fields appear or disappear',()=>{
  const before={state:'observed',assessment:undefined,nested:{failure:'old',optional:undefined},items:[undefined,{status:undefined}]};
  const after={state:'observed',assessment:{state:'current'},nested:{failure:undefined,optional:null},items:[{status:'observed'},undefined]};
  const patch=JSON.parse(JSON.stringify(handoffPatch(before,after)));
  assert.deepEqual(applyPatch(JSON.parse(JSON.stringify(before)),patch),JSON.parse(JSON.stringify(after)));
  assert.ok(patch.some(operation=>operation.op==='add'&&operation.path==='/assessment'));
  assert.ok(patch.some(operation=>operation.op==='remove'&&operation.path==='/nested/failure'));
});

function fixture(){
  const agent={session:{id:'delivery-source'}},state={cursor:1,workspace:'project',version:'current',maxChars:32000,items:[{value:1}],text:'original source '.repeat(1400)};
  let messages=[];
  const build=delivery=>({schema:'work-evidence.task-handoff.v1',status:'observed',pluginVersion:state.version,policyVersion:'same-policy',
    source:{sessionId:agent.session.id,throughSeq:state.cursor,workspace:state.workspace},userRequests:{text:state.text},
    observedWork:{items:structuredClone(state.items)},coverage:{maxChars:state.maxChars,exportComplete:true},...(delivery?{delivery}:{})});
  const control=createTaskHandoffDelivery();
  const deliver=options=>control.deliver(agent,{messages:()=>messages,build,...options});
  return {agent,state,build,deliver,control,show:value=>{messages=[{role:'tool',content:[{type:'text',text:JSON.stringify(value,null,2)}]}];},
    hide:()=>{messages=[];}};
}

test('a visible full handoff permits a smaller patch with exactly reconstructed data',()=>{
  const host=fixture(),full=host.deliver({incremental:true});host.show(full);
  host.state.cursor=2;host.state.items.push({value:2});
  const delta=host.deliver({baseDeliveryId:full.delivery.id});
  assert.equal(delta.schema,'work-evidence.task-handoff-delta.v1');
  assert.deepEqual(applyPatch(full,delta.patch),host.build({kind:'reconstructed',baseDeliveryId:full.delivery.id}));
  assert.ok(JSON.stringify(delta).length<JSON.stringify(full).length*.6);
  const unchanged=host.deliver({baseDeliveryId:full.delivery.id});
  assert.equal(unchanged.baseDeliveryId,full.delivery.id,'deltas continue to use the visible full delivery');
});

test('visible handoff delivery patches reconstruct optional execution fields on the JSON wire',()=>{
  const host=fixture();host.state.items=[{status:'observed',evidenceAssessment:undefined,failureSignature:'old'}];
  const full=host.deliver({incremental:true});host.show(full);host.state.cursor++;
  host.state.items=[{status:'observed',evidenceAssessment:{state:'current'},failureSignature:undefined}];
  const delta=JSON.parse(JSON.stringify(host.deliver({baseDeliveryId:full.delivery.id})));
  assert.equal(delta.schema,'work-evidence.task-handoff-delta.v1');
  const reconstructed=applyPatch(JSON.parse(JSON.stringify(full)),delta.patch);
  assert.deepEqual(reconstructed,JSON.parse(JSON.stringify(host.build({kind:'reconstructed',baseDeliveryId:full.delivery.id}))));
});

test('missing, hidden, changed or small bases return complete full handoffs',()=>{
  for(const reason of ['unknown','hidden','window','workspace','version','small','cleared']){
    const host=fixture();if(reason==='small')host.state.text='small';
    const full=host.deliver({incremental:true});host.show(full);host.state.cursor++;
    if(reason==='hidden')host.hide();
    if(reason==='window')host.state.maxChars=16000;
    if(reason==='workspace')host.state.workspace='other';
    if(reason==='version')host.state.version='new';
    if(reason==='cleared')host.control.clear(host.agent);
    const result=host.deliver({baseDeliveryId:reason==='unknown'?'missing':full.delivery.id,maxChars:host.state.maxChars});
    assert.equal(result.schema,'work-evidence.task-handoff.v1',reason);
    assert.equal(result.delivery.kind,'full',reason);
    assert.equal(result.source.throughSeq,host.state.cursor,reason);
  }
});
