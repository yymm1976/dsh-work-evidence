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
async function reserveBudget(runtime,agent,estimate,tokenLimit=32000,scope=null,callLimit=2){
  const s=runtime.get(agent);
  return budgetOperation(s,async()=>{
    if(!s.telemetryDir)throw new Error('Auxiliary budget requires persistent session storage');
    const file=path.join(s.telemetryDir,s.id+'.auxiliary-budget.json');
    if(!s.auxiliaryBudget){
      try{s.auxiliaryBudget=JSON.parse(await fs.readFile(file,'utf8'));}
      catch(error){if(error.code!=='ENOENT')throw error;s.auxiliaryBudget={calls:0,tokens:0,failed:false};}
    }
    const budget=s.auxiliaryBudget;
    if(!Number.isSafeInteger(budget.calls)||!Number.isSafeInteger(budget.tokens)||budget.calls<0||budget.tokens<0||typeof budget.failed!=='boolean')throw new Error('Invalid auxiliary budget record');
    if(budget.scopes!==undefined&&(!budget.scopes||typeof budget.scopes!=='object'||Array.isArray(budget.scopes)))throw new Error('Invalid auxiliary budget record');
    if(scope){
      // Per-request features (final quality review) get their own allowance so a
      // long session is not limited to two reviews in total.
      budget.scopes??={};
      const entry=budget.scopes[scope]??={calls:0,tokens:0,failed:false};
      if(entry.failed)throw new Error('Auxiliary calls for '+scope+' stopped after a prior failure');
      if(entry.calls>=callLimit||entry.tokens+estimate>tokenLimit)throw new Error('Auxiliary budget exhausted for '+scope+' ('+callLimit+' calls / '+tokenLimit+' tokens)');
      entry.calls++;entry.tokens+=estimate;
      const keys=Object.keys(budget.scopes);if(keys.length>32)delete budget.scopes[keys[0]];
      await fs.mkdir(s.telemetryDir,{recursive:true});await fs.writeFile(file,JSON.stringify(budget),'utf8');
      return {file,estimate,entry};
    }
    budget.calls=Math.max(budget.calls,runtime.effects?.snapshot(agent)?.requests?.auxiliary??0,s.metrics.auxiliaryCalls);
    if(budget.failed||s.metrics.auxiliaryFailures>0)throw new Error('Auxiliary calls stopped after a prior failure');
    if(budget.calls>=2||budget.tokens+estimate>tokenLimit)throw new Error('Auxiliary session budget exhausted (2 calls / '+tokenLimit+' tokens)');
    budget.calls++;budget.tokens+=estimate;
    await fs.mkdir(s.telemetryDir,{recursive:true});await fs.writeFile(file,JSON.stringify(budget),'utf8');
    return {file,estimate,entry:budget};
  });
}

export async function modelJson(ctx,runtime,agent,signal,system,payload,{maxTokens,timeoutMs,reasoningEffort,strictJson=false,route:explicitRoute,inheritConfiguredEffort=true,tokenLimit=32000,budgetScope=null,budgetCalls=2}={}){
  const s=runtime.get(agent),route=explicitRoute??(s.config.modelRoute||agent.session.requestHeader()?.config);
  if(!route?.provider||!route?.model||!ctx.llm?.stream)throw new Error('No native model route is available');
  signal.throwIfAborted();
  const input=JSON.stringify(payload),outputLimit=maxTokens||s.config.modelMaxTokens;
  const reservation=await reserveBudget(runtime,agent,textTokens(system)+textTokens(input)+outputLimit+64,tokenLimit,budgetScope,budgetCalls);
  const joined=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs||s.config.modelTimeoutMs)]);
  let text='',usage=null,finish=null,failed=false;
  const began=performance.now();
  s.auxiliarySignals.add(joined);
  s.metrics.auxiliaryCalls++;s.dirty=true;
  try{
    const effort=reasoningEffort??(inheritConfiguredEffort?s.config.modelRoute?.reasoningEffort:undefined);
    for await(const chunk of ctx.llm.stream({provider:route.provider,model:route.model,...(effort?{reasoningEffort:effort}:{}),
      system,messages:[{role:'user',content:[{type:'text',text:input}]}],tools:[],maxTokens:outputLimit,
      signal:joined,sessionId:agent.session.id})){
      if(chunk.type==='block-end'&&chunk.block.type==='text')text+=chunk.block.text;
      if(chunk.type==='usage'&&chunk.usage&&typeof chunk.usage==='object'){
        usage??={};
        for(const [key,value] of Object.entries(chunk.usage))if(Number.isFinite(value)&&value>=0)usage[key]=value;
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
    failed=true;s.metrics.auxiliaryFailures++;runtime.problem(s,'auxiliary-model',e.message);
    e.auxiliaryUsage=usage;e.auxiliaryFinish=finish;e.auxiliaryTextChars=text.length;
    e.auxiliaryElapsedMs=Math.round(performance.now()-began);throw e;
  }
  finally{
    if(usage)for(const [key,value]of Object.entries(usage))if(Number.isFinite(value))s.metrics.auxiliaryUsage[key]=(s.metrics.auxiliaryUsage[key]||0)+value;
    await budgetOperation(s,async()=>{
      const canonical=canonicalUsage(usage),tokens=canonical.complete?canonical.usage.totalTokens:null;
      const entry=reservation.entry;
      if(tokens!==null)entry.tokens+=tokens-reservation.estimate;
      else{
        entry.failed=true;s.metrics.auxiliaryUnknownCalls=(s.metrics.auxiliaryUnknownCalls??0)+1;
        runtime.problem(s,'auxiliary-usage-unavailable','Auxiliary consumption is incomplete; the reservation is retained and further auxiliary calls are stopped.');
      }
      if(failed)entry.failed=true;
      try{await fs.writeFile(reservation.file,JSON.stringify(s.auxiliaryBudget),'utf8');}
      catch(error){entry.failed=true;runtime.problem(s,'auxiliary-budget-persist',error.message);}
    });
    s.auxiliarySignals.delete(joined);s.metrics.auxiliaryMs+=Math.round(performance.now()-began);s.dirty=true;
  }
}
