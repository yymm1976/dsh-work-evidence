import {parseResult,resultText} from './visible-results.mjs';

const READ_TOOLS=new Set(['read','glob','grep','work_recall','ops_read_files','ops_inspect_local_file','ops_glob','ops_grep']);

/** Reuse the kernel's owner-isolated REPL without replacing its run_code provider. */
export function createRetainedCompute(ctx,runtime,taskFlow,call){
  const owners=new Map();let providerPromise=null,provider=null,providerFiber=null,loadFailure=null,closed=false;
  const invalidate=(state,reason)=>{
    state.invalidated=reason;
    state.controller?.abort(new Error(reason));
    if(provider&&!state.releasing)state.releasing=provider.release(state.owner)
      .catch(error=>{state.releaseError=String(error.message??error);})
      .finally(()=>{state.releasing=null;});
  };
  async function releaseState(state){
    invalidate(state,'retained-state-release');
    if(state.releasing)await state.releasing;
    if(state.releaseError){const error=new Error('Could not release retained computation: '+state.releaseError);state.releaseError=null;throw error;}
  }
  ctx.on('session/event',(session,event)=>{
    if(event.type==='sandbox/mode'){
      const state=owners.get(session.id);
      if(state)invalidate(state,'permission-change');
    }
  });
  ctx.on('session/disposed',session=>{
    const state=owners.get(session.id);
    if(state)void release(state.agent).catch(()=>{});
  });
  async function ensureProvider(){
    if(closed)throw new Error('Retained computation is disposed');
    if(!providerPromise)providerPromise=(async()=>{
      for(const name of ['fs','subprocess','sandbox','sandboxPolicy'])if(!ctx.get(name))throw new Error('Native '+name+' is unavailable');
      const {NodePtcRuntime}=await import('@deepseek-ai/dsh-ptc-runtime-node');
      if(closed)throw new Error('Retained computation is disposed');
      class WorkEvidenceComputeRuntime extends NodePtcRuntime{}
      const scope=ctx.isolate('ptcRuntime');
      const fiber=scope.plugin(WorkEvidenceComputeRuntime,{executionMode:'persistent-in-memory',launch:{kind:'node-script',executable:process.execPath}});
      // Cordis fibers are thenable; .ready is not a loading-completion API.
      await fiber;
      const loaded=scope.get('ptcRuntime');
      if(!loaded||loaded.programFormat!=='repl'){await fiber.dispose();throw new Error('Native retained Node runtime did not load');}
      if(closed){await fiber.dispose();throw new Error('Retained computation is disposed');}
      providerFiber=fiber;provider=loaded;return loaded;
    })().catch(error=>{loadFailure=String(error.message??error);throw error;});
    return providerPromise;
  }
  async function release(agent){
    const sessionId=agent?.session?.id,state=owners.get(sessionId);
    if(!state||state.agent!==agent)return;
    try{await releaseState(state);}
    finally{if(owners.get(sessionId)===state)owners.delete(sessionId);}
  }
  return {
    async execute(args,exec){
      if(!runtime.get(exec.agent).config.retainedCompute){await release(exec.agent);return {status:'disabled',reason:'retained-compute-disabled',executionOccurred:false};}
      if(typeof args.code!=='string'||!args.code.trim()||args.code.length>64000)throw new Error('code must contain 1–64000 characters');
      if(args.reset!==undefined&&typeof args.reset!=='boolean')throw new Error('reset must be boolean');
      if(args.timeoutMs!==undefined&&(!Number.isInteger(args.timeoutMs)||args.timeoutMs<1||args.timeoutMs>600000))throw new Error('timeoutMs must be an integer from 1 to 600000');
      let native;try{native=await ensureProvider();}catch(error){exec.signal.throwIfAborted();return {status:'unavailable',reason:'native-retained-runtime-unavailable',detail:String(error.message??error),executionOccurred:false};}
      exec.signal.throwIfAborted();
      const cwd=await ctx.workingDirectory.ensure(exec.agent,exec.signal);
      const mutation=taskFlow.summary(exec.agent).mutationVersion??0;
      const functions=Object.create(null);
      for(const schema of ctx.tools.schemas(exec.agent))if(READ_TOOLS.has(schema.name))functions[schema.name]=async input=>{
        const result=await call(schema.name,input,exec);
        if(result.isError){const error=new Error(result.error?.message??resultText(result.content));error.toolName=schema.name;throw error;}
        return result.value!==undefined?result.value:parseResult(resultText(result.content))??resultText(result.content);
      };
      const toolNames=Object.keys(functions).sort().join(',');
      const sessionId=exec.agent.session.id;
      let state=owners.get(sessionId);
      if(state&&state.agent!==exec.agent){
        try{await releaseState(state);}finally{if(owners.get(sessionId)===state)owners.delete(sessionId);}
        state=null;
      }
      if(!state){state={agent:exec.agent,owner:{},resets:0,mutation,cwd,toolNames,invalidated:null,controller:null};owners.set(sessionId,state);}
      if(state.releasing)await state.releasing;
      if(state.releaseError){const error=new Error('Could not release retained computation: '+state.releaseError);state.releaseError=null;throw error;}
      const changed=mutation>state.mutation||cwd!==state.cwd||toolNames!==state.toolNames;
      const resetReason=args.reset?'explicit-reset':state.invalidated??(changed?'observed-workspace-change':null);
      if(resetReason){
        await releaseState(state);
        state.owner={};state.resets++;state.mutation=Math.max(state.mutation,mutation);state.cwd=cwd;
        state.toolNames=toolNames;state.invalidated=null;
      }
      const policy=ctx.sandboxPolicy.resolve({session:exec.agent.session,mode:'read-only'});
      const controller=new AbortController();state.controller=controller;
      const signal=AbortSignal.any([exec.signal,controller.signal]);
      let result;
      try{result=await native.run(native.resolve({program:args.code,cwd,stateOwner:state.owner,
          bindings:[{global:'tools',functions,errorClass:{name:'ToolCallError',memberNameProperty:'toolName'}}],
          sandboxPolicy:policy,signal,...(args.timeoutMs!==undefined?{timeoutMs:args.timeoutMs}:{})}));
      }catch(error){state.invalidated='interrupted-execution';throw error;}
      finally{if(state.controller===controller)state.controller=null;}
      if(result.error&&result.error.kind!=='exception')state.invalidated='native-'+result.error.kind;
      if(result.error?.kind==='exception'){
        const message=String(result.error.message??'');
        const redeclared=/Identifier ['"]([^'"]+)['"] has already been declared/u.exec(message)?.[1];
        if(redeclared)result={...result,error:{...result.error,repair:'The retained environment still owns '+JSON.stringify(redeclared)+
          '. Use the existing binding or a new name for an incremental cell; pass reset:true only when the next cell is self-contained.'}};
        else if(/\brequire is not defined\b/u.test(message))result={...result,error:{...result.error,
          repair:'This retained Node cell runs without CommonJS require. Use await import("node:fs") or another await import(...) instead; keep the same retained data for the next cell.'}};
      }
      return {status:result.error?'failed':'completed',resetCount:state.resets,...(resetReason?{resetReason}:{}),
        logs:result.logs??[],...(result.value!==undefined?{value:result.value}:{}),...(result.error?{error:result.error}:{}),
        ...(result.sandbox?{sandbox:result.sandbox}:{})};
    },
    summary(agent){const state=owners.get(agent?.session?.id);return {configured:runtime.get(agent).config.retainedCompute,loaded:!!provider,
      available:loadFailure?false:provider?true:null,loadFailure,resetCount:state?.resets??0,memory:'best-effort',filesystemMode:'read-only'};},
    async prepare(agent){if(owners.has(agent?.session?.id)&&(!runtime.isEnabled(agent)||!runtime.get(agent).config.retainedCompute))await release(agent);},
    disposeAgent:release,
    async dispose(){closed=true;const results=await Promise.allSettled([...owners.values()].map(releaseState));
      owners.clear();
      if(providerFiber){try{await providerFiber.dispose();}catch(error){results.push({status:'rejected',reason:error});}}
      providerFiber=null;provider=null;providerPromise=null;
      for(const result of results)if(result.status==='rejected')throw result.reason;
    },
  };
}
