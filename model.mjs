import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalUsage,textTokens} from './context-economics.mjs';

export function parseModelJson(text,onRecovery=()=>{}){
  const source=String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g,'');
  const object=value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected a JSON object');return value;};
  const parse=fragment=>{
    try{return object(JSON.parse(fragment));}catch{}
    let repaired='',quoted=false;
    for(let i=0;i<fragment.length;i++){
      const ch=fragment[i];
      if(quoted&&ch==='\\'){
        const next=fragment[i+1];
        if(next&&('"\\/bfnrt'.includes(next)||next==='u'&&/^[0-9a-fA-F]{4}$/.test(fragment.slice(i+2,i+6)))){repaired+=ch+next;i++;}
        else repaired+='\\\\';
      }else if(quoted&&ch.charCodeAt(0)<32)repaired+=JSON.stringify(ch).slice(1,-1);
      else{repaired+=ch;if(ch==='"')quoted=!quoted;}
    }
    const value=object(JSON.parse(repaired));onRecovery('literal-escape-recovery');return value;
  };
  try{return parse(source);}catch{}
  // Recover an intact object surrounded by prose/fences, respecting braces
  // inside JSON strings. Never invent text to repair incomplete JSON.
  let start=-1,depth=0,quoted=false,escaped=false;
  for(let i=0;i<source.length;i++){
    const ch=source[i];
    if(start<0){if(ch==='{'){start=i;depth=1;}continue;}
    if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"')quoted=true;
    else if(ch==='{')depth++;
    else if(ch==='}'&&--depth===0){try{const value=parse(source.slice(start,i+1));onRecovery('surrounding-text-removed');return value;}catch{start=-1;}}
  }
  throw new Error('Auxiliary response contains no complete JSON object');
}

function budgetOperation(s,operation){
  const next=(s.auxiliaryBudgetQueue??Promise.resolve()).then(operation);
  s.auxiliaryBudgetQueue=next.catch(()=>{});return next;
}
const counters=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Number.isSafeInteger(value.calls)&&Number.isSafeInteger(value.tokens)&&
  value.calls>=0&&value.tokens>=0&&typeof value.failed==='boolean';
// A stop decided before any request is sent is not an upstream call failure. The code and the
// dispatched flag let the caller keep the local reason and leave the rest of the route available.
function budgetStop(message,code,cause){
  const error=new Error(message);error.auxiliaryCode=code;error.auxiliaryDispatched=false;if(cause)error.cause=cause;return error;
}
function budgetMeta(budget){
  budget.meta??={};
  if(!budget.meta||typeof budget.meta!=='object'||Array.isArray(budget.meta))throw budgetStop('Invalid auxiliary budget record','auxiliary-budget-invalid');
  for(const key of ['inFlight','limits','retired']){
    budget.meta[key]??={scopes:{},tasks:{}};
    const value=budget.meta[key];
    if(!value||typeof value!=='object'||Array.isArray(value)||
      !value.scopes||typeof value.scopes!=='object'||Array.isArray(value.scopes)||
      !value.tasks||typeof value.tasks!=='object'||Array.isArray(value.tasks))
      throw budgetStop('Invalid auxiliary budget record','auxiliary-budget-invalid');
  }
  return budget.meta;
}
async function writeBudgetAtomic(file,budget){
  const directory=path.dirname(file),temporary=path.join(directory,'.'+path.basename(file)+'.'+process.pid+'.'+randomUUID()+'.tmp');
  await fs.mkdir(directory,{recursive:true});
  try{
    await fs.writeFile(temporary,JSON.stringify(budget),'utf8');
    await fs.rename(temporary,file);
  }catch(error){
    await fs.rm(temporary,{force:true}).catch(()=>{});
    throw error;
  }
}
async function withBudgetLock(file,operation){
  const lock=file+'.lock',started=Date.now();
  try{await fs.mkdir(path.dirname(file),{recursive:true});}
  catch(error){throw budgetStop('Auxiliary budget record could not be saved: '+error.message,'auxiliary-budget-unavailable',error);}
  for(;;){
    let handle;
    try{handle=await fs.open(lock,'wx');}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      try{
        const info=await fs.stat(lock);
        if(Date.now()-info.mtimeMs>30_000){await fs.rm(lock,{force:true});continue;}
      }catch{}
      if(Date.now()-started>5_000)throw Object.assign(new Error('Auxiliary budget file is locked by another process'),{code:'EBUSY'});
      await new Promise(resolve=>setTimeout(resolve,25));
      continue;
    }
    try{
      await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}),'utf8');
      return await operation();
    }finally{
      await handle.close().catch(()=>{});
      await fs.rm(lock,{force:true}).catch(()=>{});
    }
  }
}
function pruneTerminalBudget(budget,meta,group,inFlight,limits,retired){
  const keys=Object.keys(budget[group]);
  if(keys.length<=32)return;
  const candidates=keys.filter(key=>{
    if(inFlight[key])return false;
    const entry=budget[group][key],limit=limits[key];
    return entry.failed===true||Boolean(limit&&limit.callLimit&&entry.calls>=limit.callLimit);
  });
  for(const key of candidates){
    if(Object.keys(budget[group]).length<=32)break;
    retired[key]={...(retired[key]??{}),...budget[group][key],retiredAt:new Date().toISOString(),
      reason:budget[group][key].failed?'prior-failure':'call-limit-reached'};
    delete budget[group][key];delete inFlight[key];delete limits[key];
  }
}
async function reserveBudget(runtime,agent,estimate,tokenLimit=32000,scope=null,callLimit=2,
  {taskScope=null,taskTokenLimit=null,taskCallLimit=null}={}){
  const s=runtime.get(agent);
  return budgetOperation(s,async()=>{
    if(!s.telemetryDir)throw budgetStop('Auxiliary budget requires persistent session storage','auxiliary-budget-unavailable');
    const file=path.join(s.telemetryDir,s.id+'.auxiliary-budget.json');
    if(!s.auxiliaryBudget)s.auxiliaryBudget={general:{calls:0,tokens:0,failed:false},scopes:{},tasks:{}};
    return withBudgetLock(file,async()=>{
      let budget;
      try{budget=JSON.parse(await fs.readFile(file,'utf8'));}
      catch(error){
        if(error.code==='ENOENT')budget={};
        else if(error instanceof SyntaxError)throw budgetStop('Auxiliary budget record is not readable JSON: '+error.message,'auxiliary-budget-invalid',error);
        else throw budgetStop('Auxiliary budget record could not be read: '+error.message,'auxiliary-budget-unavailable',error);
      }
      if(!budget||typeof budget!=='object'||Array.isArray(budget))throw budgetStop('Invalid auxiliary budget record','auxiliary-budget-invalid');
      if(budget.scopes!==undefined&&(!budget.scopes||typeof budget.scopes!=='object'||Array.isArray(budget.scopes)))throw budgetStop('Invalid auxiliary budget record','auxiliary-budget-invalid');
      budget.scopes??={};
      if(budget.tasks!==undefined&&(!budget.tasks||typeof budget.tasks!=='object'||Array.isArray(budget.tasks)))throw budgetStop('Invalid auxiliary budget record','auxiliary-budget-invalid');
      budget.tasks??={};
      if(budget.general===undefined){
        if(budget.calls!==undefined||budget.tokens!==undefined||budget.failed!==undefined){
          budget.legacyMixedCounters={calls:budget.calls,tokens:budget.tokens,failed:budget.failed,
            note:'totals recorded before budget scopes existed counted every auxiliary call together; unscoped consumption is not reconstructable'};
          delete budget.calls;delete budget.tokens;delete budget.failed;
        }
        budget.general={calls:0,tokens:0,failed:false};
      }
      if(!counters(budget.general)||Object.entries(budget.scopes).some(([key,entry])=>!key||!counters(entry))||
        Object.entries(budget.tasks).some(([key,entry])=>!key||!counters(entry)))throw budgetStop('Invalid auxiliary budget record','auxiliary-budget-invalid');
      const meta=budgetMeta(budget);
      if(scope&&meta.retired.scopes[scope])throw budgetStop('Auxiliary calls for '+scope+' are retired after a terminal state','auxiliary-scope-stopped');
      if(taskScope&&meta.retired.tasks[taskScope])throw budgetStop('Auxiliary calls for task '+taskScope+' are retired after a terminal state','auxiliary-task-stopped');
      const entry=scope?(budget.scopes[scope]??={calls:0,tokens:0,failed:false}):budget.general;
      const task=taskScope?(budget.tasks[taskScope]??={calls:0,tokens:0,failed:false}):null;
      if(entry.failed)throw budgetStop(scope?'Auxiliary calls for '+scope+' stopped after a prior failure':'Auxiliary calls without a budget scope stopped after a prior failure','auxiliary-scope-stopped');
      if(entry.calls>=callLimit||entry.tokens+estimate>tokenLimit)throw budgetStop(scope?'Auxiliary budget exhausted for '+scope+' ('+callLimit+' calls / '+tokenLimit+' tokens)':'Auxiliary budget exhausted for calls without a budget scope ('+callLimit+' calls / '+tokenLimit+' tokens)','auxiliary-budget-exhausted');
      if(task&&task.failed)throw budgetStop('Auxiliary calls for task '+taskScope+' stopped after a prior failure','auxiliary-task-stopped');
      if(task&&(task.calls>=taskCallLimit||task.tokens+estimate>taskTokenLimit))
        throw budgetStop('Auxiliary task budget exhausted for '+taskScope+' ('+taskCallLimit+' calls / '+taskTokenLimit+' tokens)','auxiliary-budget-exhausted');
      entry.calls++;entry.tokens+=estimate;
      if(task){task.calls++;task.tokens+=estimate;}
      if(scope){meta.limits.scopes[scope]={callLimit,tokenLimit};meta.inFlight.scopes[scope]=(meta.inFlight.scopes[scope]??0)+1;}
      if(taskScope){meta.limits.tasks[taskScope]={callLimit:taskCallLimit,tokenLimit:taskTokenLimit};
        meta.inFlight.tasks[taskScope]=(meta.inFlight.tasks[taskScope]??0)+1;}
      pruneTerminalBudget(budget,meta,'scopes',meta.inFlight.scopes,meta.limits.scopes,meta.retired.scopes);
      pruneTerminalBudget(budget,meta,'tasks',meta.inFlight.tasks,meta.limits.tasks,meta.retired.tasks);
      s.auxiliaryBudget=budget;
      try{await writeBudgetAtomic(file,budget);}
      catch(error){entry.calls--;entry.tokens-=estimate;if(task){task.calls--;task.tokens-=estimate;}
        if(scope&&meta.inFlight.scopes[scope])meta.inFlight.scopes[scope]--;
        if(taskScope&&meta.inFlight.tasks[taskScope])meta.inFlight.tasks[taskScope]--;
        throw budgetStop('Auxiliary budget record could not be saved: '+error.message,'auxiliary-budget-unavailable',error);}
      s.auxiliaryBudget=budget;
      return {file,estimate,entry,task,budget,meta,scopeKey:scope,taskKey:taskScope,
        async settle({tokens=null,failed=false,notDispatched=false}={}){
          return budgetOperation(s,async()=>{
            if(notDispatched){
              entry.calls--;entry.tokens-=estimate;
              if(task){task.calls--;task.tokens-=estimate;}
            }else if(tokens!==null){
              entry.tokens+=tokens-estimate;if(task)task.tokens+=tokens-estimate;
            }else{
              entry.failed=true;if(task)task.failed=true;
            }
            if(failed)entry.failed=true;
            if(scope&&meta.inFlight.scopes[scope])meta.inFlight.scopes[scope]--;
            if(taskScope&&meta.inFlight.tasks[taskScope])meta.inFlight.tasks[taskScope]--;
            try{await writeBudgetAtomic(file,budget);}
            catch(error){
              entry.failed=true;if(task)task.failed=true;
              runtime.problem(s,'auxiliary-budget-persist',error.message);
            }
            s.auxiliaryBudget=budget;
            return {notDispatched,complete:tokens!==null};
          });
        }};
    });
  });
}

export async function modelJson(ctx,runtime,agent,signal,system,payload,{maxTokens,timeoutMs,reasoningEffort,strictJson=false,route:explicitRoute,inheritConfiguredEffort=true,tokenLimit=32000,budgetScope=null,budgetCalls=2,taskBudgetScope=null,taskTokenLimit=null,taskCallLimit=null,purpose='work-evidence:auxiliary'}={}){
  const s=runtime.get(agent),route=explicitRoute??(s.config.modelRoute||agent.session.requestHeader()?.config);
  if(!route?.provider||!route?.model||!ctx.llm?.stream)throw new Error('No native model route is available');
  signal.throwIfAborted();
  const input=JSON.stringify(payload),outputLimit=maxTokens||s.config.modelMaxTokens;
  const reservation=await reserveBudget(runtime,agent,textTokens(system)+textTokens(input)+outputLimit+64,tokenLimit,budgetScope,budgetCalls,
    taskBudgetScope?{taskScope:taskBudgetScope,taskTokenLimit:taskTokenLimit??tokenLimit,taskCallLimit:taskCallLimit??budgetCalls}:{});
  const joined=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs||s.config.modelTimeoutMs)]);
  let text='',usage=null,reportedUsage=null,finish=null,failed=false,telemetryBlocked=false,dispatchAttempted=false,notDispatched=false;
  const began=performance.now();
  s.auxiliarySignals.add(joined);
  s.metrics.auxiliaryCalls++;s.dirty=true;
  try{
    const effort=reasoningEffort??(inheritConfiguredEffort?s.config.modelRoute?.reasoningEffort:undefined);
    joined.throwIfAborted();
    const stream=ctx.llm.stream({provider:route.provider,model:route.model,...(effort?{reasoningEffort:effort}:{}),
      system,messages:[{role:'user',content:[{type:'text',text:input}]}],tools:[],maxTokens:outputLimit,
      signal:joined,sessionId:agent.session.id,purpose});
    // Creating the native stream is the last point at which this caller can prove
    // no request left the process. Once iteration starts, an error has an unknown
    // upstream outcome even if no usage chunk arrived.
    dispatchAttempted=true;
    for await(const chunk of stream){
      if(chunk.type==='block-end'&&chunk.block.type==='text')text+=chunk.block.text;
      if(chunk.type==='usage'&&chunk.usage&&typeof chunk.usage==='object'){
        usage??={};
        for(const [key,value] of Object.entries(chunk.usage))if(value!==null&&value!==undefined)usage[key]=value;
      }
      if(chunk.type==='finish')finish=chunk.reason;
    }
    if(finish?.kind!=='stop')throw new Error('Auxiliary call did not finish: '+(finish?.kind||'unknown'));
    const recoveries=[],value=strictJson?JSON.parse(text):parseModelJson(text,kind=>recoveries.push(kind));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected a JSON object');
    if(recoveries.length)s.metrics.auxiliaryJsonRecoveries=(s.metrics.auxiliaryJsonRecoveries??0)+1;
    return {value,usage,jsonRecovery:recoveries,route:{provider:route.provider,model:route.model},id:randomUUID()};
  }catch(cause){
    const e=cause instanceof Error?cause:new Error(String(cause));
    // The native adapter emits initialized zero counters even for an HTTP error
    // whose body contains no usage. Keep those values as diagnostics, not payment facts.
    if(finish?.kind!=='stop'&&usage&&Object.values(usage).every(value=>value===0)){reportedUsage=usage;usage=null;}
    telemetryBlocked=cause?.code==='EFFECT_PERSISTENCE_UNAVAILABLE'&&cause?.effectsDispatched===false;
    notDispatched=telemetryBlocked||!dispatchAttempted;
    failed=!notDispatched;s.metrics.auxiliaryFailures++;runtime.problem(s,'auxiliary-model',e.message);
    e.auxiliaryUsage=usage;e.auxiliaryReportedUsage=reportedUsage;e.auxiliaryFinish=finish;e.auxiliaryTextChars=text.length;
    e.auxiliaryDispatched=!notDispatched;e.auxiliaryDispatchState=notDispatched?'not-dispatched':'dispatched';
    e.auxiliaryElapsedMs=Math.round(performance.now()-began);throw e;
  }
  finally{
    if(usage)for(const [key,value]of Object.entries(usage))if(Number.isSafeInteger(value)&&value>=0)s.metrics.auxiliaryUsage[key]=(s.metrics.auxiliaryUsage[key]||0)+value;
    const canonical=canonicalUsage(usage),tokens=canonical.complete?canonical.usage.totalTokens:null;
    if(!notDispatched&&tokens===null){
      s.metrics.auxiliaryUnknownCalls=(s.metrics.auxiliaryUnknownCalls??0)+1;
      runtime.problem(s,'auxiliary-usage-unavailable','Auxiliary consumption is incomplete; the reservation is retained and further auxiliary calls'+
        (budgetScope?' for '+budgetScope:' without a budget scope')+' are stopped.');
    }
    await reservation.settle({tokens,failed,notDispatched});
    s.auxiliarySignals.delete(joined);s.metrics.auxiliaryMs+=Math.round(performance.now()-began);s.dirty=true;
  }
}
