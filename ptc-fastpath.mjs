import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const VERSION='0.8.2';
export const STORE_SCHEMA='work-evidence.ptc-fastpaths.v1';
export const RUN_SCHEMA='work-evidence.ptc-fastpath-run.v1';

const SAFE_NAME=/^[a-z][a-z0-9-]{1,63}$/;
const TOOL_ALIASES=Object.freeze({
  read:'read',grep:'grep',glob:'glob',
  ops_glob:'glob',
  ops_grep:'grep',
  ops_read_files:'read',
  ops_inspect_local_file:'inspect',
  ops_stat:'stat',
  ops_diff:'diff',
  ops_result:'result',
});
const READ_ONLY=new Set(Object.keys(TOOL_ALIASES));
const queues=new Map();
function serial(key,fn){const prior=queues.get(key)||Promise.resolve();const current=prior.catch(()=>{}).then(fn);queues.set(key,current);return current.finally(()=>{if(queues.get(key)===current)queues.delete(key);});}
function cap(value,max){const text=typeof value==='string'?value:JSON.stringify(value??null);return text.length<=max?text:text.slice(0,max)+'…';}
function getPath(value,parts){
  let current=value;
  for(const part of parts){if(current===null||current===undefined||typeof current!=='object'||!Object.hasOwn(current,part))return undefined;current=current[part];}
  return current;
}
function refPath(value){
  if(typeof value!=='string')return null;
  const match=/^\$(input|steps)\.([A-Za-z0-9_$-]+)(?:\.([A-Za-z0-9_$.[\]-]+))?$/.exec(value);
  if(!match)return null;
  const tail=match[3]?match[3].split('.'):[];
  return {root:match[1],name:match[2],path:tail};
}
function resolveValue(template,input,steps,itemMarker){
  if(typeof template==='string'){
    if(template==='$item')return itemMarker;
    const ref=refPath(template);
    if(!ref)return template;
    if(ref.root==='input')return getPath(input,[ref.name,...ref.path]);
    return getPath(steps[ref.name],ref.path);
  }
  if(Array.isArray(template))return template.map(entry=>resolveValue(entry,input,steps,itemMarker));
  if(template&&typeof template==='object'){
    if(Object.hasOwn(template,'$map')){
      const source=resolveValue(template.$map,input,steps,itemMarker);
      if(!Array.isArray(source))throw new Error('$map source must resolve to an array');
      const take=template.$take===undefined?source.length:template.$take;
      if(!Number.isInteger(take)||take<0||take>100)throw new Error('$take must be an integer from 0 to 100');
      const as=template.$as===undefined?'$item':template.$as;
      return source.slice(0,take).map(item=>resolveValue(as,input,steps,item));
    }
    const out={};
    for(const [key,value] of Object.entries(template)){
      if(['__proto__','constructor','prototype'].includes(key))continue;
      const resolved=resolveValue(value,input,steps,itemMarker);
      if(resolved===undefined)throw new Error(`Template reference for ${key} did not resolve`);
      out[key]=resolved;
    }
    return out;
  }
  return template;
}
function boundedJson(value,max=65536){const json=JSON.stringify(value);if(json.length>max)throw new Error('Definition exceeds JSON budget');return JSON.parse(json);}

function validateInputs(def,input={}){
  if(input===null||typeof input!=='object'||Array.isArray(input))throw new Error('inputs must be an object');
  const declared=new Map(def.inputs.map(item=>[item.name,item]));
  for(const key of Object.keys(input))if(!declared.has(key))throw new Error('Unknown input '+key);
  const out={};
  for(const item of def.inputs){
    if(!Object.hasOwn(input,item.name)){
      if(item.required)throw new Error('Missing required input '+item.name);
      continue;
    }
    const value=input[item.name];
    const valid=item.type==='string'?typeof value==='string':item.type==='integer'?Number.isInteger(value):
      item.type==='boolean'?typeof value==='boolean':item.type==='array'?Array.isArray(value):
      item.type==='object'?Boolean(value)&&typeof value==='object'&&!Array.isArray(value):true;
    if(!valid)throw new Error(`Input ${item.name} must be ${item.type}`);
    out[item.name]=value;
  }
  return out;
}

function validateDefinition(definition){
  if(!definition||typeof definition!=='object'||Array.isArray(definition))throw new Error('definition must be an object');
  if(Object.keys(definition).some(key=>!['name','description','candidate_id','inputs','steps'].includes(key)))throw new Error('Unknown definition field');
  if(typeof definition.name!=='string'||!SAFE_NAME.test(definition.name))throw new Error('Definition name must be a lowercase kebab-case identifier');
  if(typeof definition.description!=='string'||!definition.description.trim()||definition.description.length>1000)throw new Error('Definition description is required');
  if(definition.candidate_id!==undefined&&definition.candidate_id!==null&&(typeof definition.candidate_id!=='string'||!/^ptc-[a-f0-9]{12}$/.test(definition.candidate_id)))throw new Error('Invalid candidate_id');
  if(!Array.isArray(definition.inputs)||definition.inputs.length>16)throw new Error('inputs must be an array of at most 16 entries');
  const inputNames=new Set();
  const inputs=definition.inputs.map((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Input '+index+' must be an object');
    if(Object.keys(item).some(key=>!['name','type','required','description'].includes(key)))throw new Error('Input '+index+' has an unknown field');
    if(typeof item.name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item.name)||inputNames.has(item.name))throw new Error('Input names must be unique identifiers');
    inputNames.add(item.name);
    if(!['string','integer','boolean','array','object'].includes(item.type))throw new Error('Input '+item.name+' has unsupported type');
    if(typeof item.description!=='string'||!item.description.trim()||item.description.length>300)throw new Error('Input '+item.name+' requires a description');
    if(item.required!==undefined&&typeof item.required!=='boolean')throw new Error('Input '+item.name+' required must be boolean');
    return {name:item.name,type:item.type,required:item.required===true,description:item.description};
  });
  if(!Array.isArray(definition.steps)||definition.steps.length<1||definition.steps.length>8)throw new Error('steps must contain 1 to 8 entries');
  const stepIds=new Set();
  const steps=definition.steps.map((step,index)=>{
    if(!step||typeof step!=='object'||Array.isArray(step))throw new Error('Step '+index+' must be an object');
    if(Object.keys(step).some(key=>!['id','tool','arguments'].includes(key)))throw new Error('Step '+index+' has an unknown field');
    if(typeof step.id!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(step.id)||stepIds.has(step.id))throw new Error('Step IDs must be unique identifiers');
    stepIds.add(step.id);
    if(!READ_ONLY.has(step.tool))throw new Error('Step '+step.id+' must use an allowed read-only tool');
    if(!step.arguments||typeof step.arguments!=='object'||Array.isArray(step.arguments))throw new Error('Step '+step.id+' arguments must be an object');
    return {id:step.id,tool:step.tool,arguments:boundedJson(step.arguments)};
  });
  return {name:definition.name,description:definition.description,candidate_id:definition.candidate_id||null,
    inputs,steps,boundedDefinition:boundedJson({name:definition.name,description:definition.description,
      candidate_id:definition.candidate_id||null,inputs,steps})};
}
function validateStoredDefinition(definition,index){
  if(!definition||typeof definition!=='object'||Array.isArray(definition))throw new Error('Stored fast-path '+index+' is not an object');
  try{
    const validated=validateDefinition({name:definition.name,description:definition.description,candidate_id:definition.candidate_id,
      inputs:definition.inputs,steps:definition.steps});
    return {...definition,...validated.boundedDefinition};
  }catch(error){
    throw new Error(`Stored fast-path ${definition.name||index} is invalid: ${error.message}`);
  }
}

function resultStatus(result,tool){
  const status=result?.value?.data?.status||result?.value?.status;
  if(status)return status;
  const value=result?.value;
  if(result?.isError||!value)return null;
  if(value.truncated===true||value.truncatedByBytes===true)return 'partial';
  if(tool==='read'&&Array.isArray(value.lines)&&Number.isInteger(value.totalLines))return 'completed';
  if(tool==='glob'&&Array.isArray(value.paths))return 'completed';
  if(tool==='grep'&&Array.isArray(value.matches))return 'completed';
  return null;
}
function resultData(result){const value=result?.value;return value?.data&&typeof value.data==='object'?value.data:value;}
function resultError(result){return result?.value?.data?.error||result?.value?.error||result?.error||null;}
function summarizeStep(tool,value){
  const data=value?.data&&typeof value.data==='object'?value.data:value;
  if(tool==='glob')return {paths:data.paths.slice(0,40),returnedPaths:data.paths.length,previewTruncated:data.paths.length>40};
  if(tool==='grep')return {matches:data.matches.slice(0,20),returnedMatches:data.matches.length,previewTruncated:data.matches.length>20};
  if(tool==='read')return {path:data.path,offset:data.offset,totalLines:data.totalLines,truncatedByBytes:data.truncatedByBytes===true,
    preview:(data.lines??[]).slice(0,12).map(line=>({...line,text:String(line.text??'').slice(0,500)})),
    previewTruncated:(data.lines?.length??0)>12||(data.lines??[]).some(line=>String(line.text??'').length>500)};
  if(tool==='ops_glob')return {paths:(data?.paths||[]).slice(0,40),complete:data?.complete,nextOffset:data?.nextOffset};
  if(tool==='ops_grep')return {matches:(data?.matches||[]).slice(0,20),complete:data?.complete,nextOffset:data?.nextOffset,scanComplete:data?.scanComplete,pageComplete:data?.pageComplete};
  if(tool==='ops_read_files')return {items:(data?.items||[]).slice(0,12).map(item=>({path:item.path,status:item.status,revision:item.revision,bytes:item.bytes,lineCount:item.lineCount,complete:item.complete,nextOffset:item.nextOffset}))};
  if(tool==='ops_inspect_local_file')return {path:data?.path,revision:data?.revision,totalLines:data?.totalLines,complete:data?.complete,nextOffset:data?.nextOffset,preview:(data?.lines||[]).slice(0,12)};
  return data;
}

async function candidateSequence(runtime,agent,candidateId,signal){
  if(!candidateId)return null;
  const s=runtime.get(agent),loaded=await runtime.loadJson(agent,path.join(s.dir,'ptc-patterns.json'),signal);
  if(!loaded.ok)throw new Error('Candidate report is unavailable; run ptc_patterns first');
  const candidate=loaded.value?.candidates?.find(item=>item.id===candidateId);
  if(!candidate)throw new Error('Candidate ID is not in the current ptc-patterns report');
  return candidate.toolSequence.flat().map(name=>({glob:'glob',grep:'grep',read:'read',inspect:'inspect',stat:'stat',diff:'diff',result:'result'})[name]||name);
}

export function createPtcFastpath(ctx,runtime,call){
  async function load(agent,signal){
    const s=runtime.get(agent),file=path.join(s.dir,'ptc-fastpaths.json');
    const loaded=await runtime.loadJson(agent,file,signal);
    if(!loaded.ok){
      if(loaded.error?.info?.code==='FS_NOT_FOUND')return {s,file,store:{schema:STORE_SCHEMA,version:1,definitions:[]}};
      throw new Error('Fast-path store is unavailable');
    }
    if(loaded.value?.schema!==STORE_SCHEMA||loaded.value?.version!==1||!Array.isArray(loaded.value.definitions))throw new Error('Unrecognized fast-path store');
    return {s,file,store:{...loaded.value,definitions:loaded.value.definitions.map(validateStoredDefinition)}};
  }
  async function save(agent,file,store,signal){await runtime.save(agent,file,store,signal);}
  async function define(agent,args,signal){
    const s=await runtime.init(agent,signal),name=args?.name;
    if(typeof name!=='string'||!SAFE_NAME.test(name))throw new Error('name must be lowercase kebab-case');
    const candidate=args.definition;
    if(!candidate||typeof candidate!=='object')throw new Error('definition is required');
    const validated=validateDefinition({...candidate,name});
    const expected=await candidateSequence(runtime,agent,validated.candidate_id,signal);
    if(expected){
      const actual=validated.steps.map(step=>TOOL_ALIASES[step.tool]);
      if(expected.length!==actual.length||expected.some((tool,index)=>tool!==actual[index]))throw new Error('Definition tools do not match the referenced candidate sequence');
    }
    return serial(path.join(s.dir,'ptc-fastpaths.json'),async()=>{
      const {file,store}=await load(agent,signal);
      const definition={...validated.boundedDefinition,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
        uses:0,successes:0,lastUsedAt:null,lastOutcome:null};
      const index=store.definitions.findIndex(item=>item.name===name);
      if(index>=0)store.definitions[index]={...definition,createdAt:store.definitions[index].createdAt,uses:store.definitions[index].uses||0,
        successes:store.definitions[index].successes||0,lastUsedAt:store.definitions[index].lastUsedAt||null,lastOutcome:store.definitions[index].lastOutcome||null};
      else store.definitions.push(definition);
      await save(agent,file,store,signal);
      return {status:'defined',name,candidate_id:validated.candidate_id,steps:validated.steps.map(step=>({id:step.id,tool:step.tool}))};
    });
  }
  async function list(agent,signal){
    await runtime.init(agent,signal);const {file,store}=await load(agent,signal);
    return {storePath:file,definitions:store.definitions.map(item=>({name:item.name,description:item.description,candidate_id:item.candidate_id,
      tools:item.steps.map(step=>step.tool),uses:item.uses||0,successes:item.successes||0,lastUsedAt:item.lastUsedAt,lastOutcome:item.lastOutcome}))};
  }
  async function remove(agent,name,signal){
    const s=await runtime.init(agent,signal);if(typeof name!=='string'||!SAFE_NAME.test(name))throw new Error('Invalid name');
    return serial(path.join(s.dir,'ptc-fastpaths.json'),async()=>{
      const {file,store}=await load(agent,signal);const before=store.definitions.length;
      store.definitions=store.definitions.filter(item=>item.name!==name);
      if(store.definitions.length===before)return {status:'not-found',name,storePath:file};
      await save(agent,file,store,signal);return {status:'removed',name,storePath:file};
    });
  }
  async function run(agent,args,signal){
    const s=await runtime.init(agent,signal),name=args?.name;
    if(typeof name!=='string'||!SAFE_NAME.test(name))throw new Error('Invalid fast-path name');
    const {store}=await load(agent,signal),definition=store.definitions.find(item=>item.name===name);
    if(!definition)throw new Error('Fast-path not found');
    const input=validateInputs(definition,args.inputs||{});
    const missing=definition.steps.map(step=>step.tool).filter(tool=>{try{return !ctx.tools.get(tool,agent);}catch{return true;}});
    const runId='fastpath-'+randomUUID(),runPath=path.join(s.dir,s.id+'.'+runId+'.json');
    const record={schema:RUN_SCHEMA,version:1,id:runId,name,sessionId:s.id,startedAt:new Date().toISOString(),
      status:'running',effectState:'none',inputs:input,steps:[],deopt:null};
    if(missing.length){
      record.status='deopt';record.deopt={reason:'required-tools-unavailable',missing};
      await runtime.save(agent,runPath,record,signal);s.metrics.ptcFastpathDeopts++;return {status:'deopt',reason:record.deopt.reason,missing,runPath};
    }
    const stepValues={};
    for(const step of definition.steps){
      signal.throwIfAborted();
      let resolved;
      try{resolved=resolveValue(step.arguments,input,stepValues);}catch(error){
        record.status='deopt';record.deopt={reason:'binding-unresolved',step:step.id,error:error.message};
        await runtime.save(agent,runPath,record,signal);s.metrics.ptcFastpathDeopts++;return {status:'deopt',reason:record.deopt.reason,step:step.id,error:error.message,runPath};
      }
      const result=await call(step.tool,resolved,runtime.execFor(agent,signal));
      const status=resultStatus(result,step.tool),error=resultError(result);
      const complete=!result.isError&&status==='completed'&&!error;
      record.steps.push({id:step.id,tool:step.tool,status:status||(result.isError?'error':'unknown'),complete,
        // A failed native step has no structured value to summarize; keep its error instead.
        summary:complete?summarizeStep(step.tool,result.value):null,error:complete?null:error||{message:'Fast-path step returned no completed observation'}});
      if(!complete){
        record.status='deopt';record.deopt={reason:'step-not-completed',step:step.id,tool:step.tool,status:status||'unknown'};
        await runtime.save(agent,runPath,record,signal);s.metrics.ptcFastpathDeopts++;return {status:'deopt',reason:record.deopt.reason,step:step.id,runPath};
      }
      const value=result.value,data=resultData(result);
      stepValues[step.id]=data&&typeof data==='object'
        ? {...(value&&typeof value==='object'?value:{}),...data,...(value?.data?{data:value.data}:{})}
        : value;
    }
    record.status='completed';record.endedAt=new Date().toISOString();
    await serial(path.join(s.dir,'ptc-fastpaths.json'),async()=>{
      const loaded=await load(agent,signal),target=loaded.store.definitions.find(item=>item.name===name);
      if(target){target.uses=(target.uses||0)+1;target.successes=(target.successes||0)+1;target.lastUsedAt=record.endedAt;target.lastOutcome='completed';
        await save(agent,loaded.file,loaded.store,signal);}
    });
    await runtime.save(agent,runPath,record,signal);
    s.metrics.ptcFastpathRuns++;s.metrics.ptcFastpathSuccesses++;s.active=true;s.dirty=true;
    return {status:'completed',runPath,steps:record.steps.map(step=>({id:step.id,tool:step.tool,status:step.status,summary:step.summary})),
      note:'All declared read-only steps completed. Coverage, continuation and the meaning of returned evidence still require inspection.'};
  }
  return {define,list,remove,run};
}
