import {randomUUID,createHash} from 'node:crypto';
import {createNativeFiles} from './native-files.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const normalize=text=>text.replaceAll('\r\n','\n');

/** Conditional writes still pass through the native write tool's permission resolution. */
export function createNativeCas(ctx,runtime,registeredWrite=ctx.tools.get('write'),registeredExecute=registeredWrite?.execute){
  const pending=new Map(),files=createNativeFiles(ctx);
  ctx.on('fs/write-intent',async(target,actor,next)=>{
    const state=pending.get(actor?.callId);
    if(!state)return next();
    if(actor.agent!==state.agent||target.targetKey!==state.target.targetKey)throw new Error('Conditional write target or actor changed.');
    const policy=ctx.get('sandboxPolicy')?.resolve({session:state.agent.session});
    if(!policy||!['workspace-write','danger-full-access'].includes(policy.mode)){
      state.denied=true;throw new Error('Conditional edit requires the current session to permit file writes.');
    }
    if(policy.mode==='workspace-write'){
      const workspace=await ctx.fs.resolve(policy.workspaceRoot,{cwd:policy.workspaceRoot,signal:actor.signal});
      if(!ctx.fs.contains(workspace,target)){state.denied=true;throw new Error('Conditional edit is outside the session workspace.');}
    }
    const inherited=await next();
    if(inherited&&(inherited.kind!==state.intent.kind||inherited.version!==state.intent.version))
      throw new Error('Native file policy disagrees with the recorded conditional write.');
    state.guarded=true;return state.intent;
  },{prepend:true});
  async function available(agent){
    try{
      const [{default:{version}},{ToolsService},{LocalFileSystem},{default:local},{default:toolFs}]=await Promise.all([
        import('@deepseek-ai/dsh-tools/package.json',{with:{type:'json'}}),import('@deepseek-ai/dsh-tools'),
        import('@deepseek-ai/dsh-fs-local'),import('@deepseek-ai/dsh-fs-local/package.json',{with:{type:'json'}}),
        import('@deepseek-ai/dsh-tool-fs/package.json',{with:{type:'json'}})]);
      const filesystem=ctx.get('fs');let supported=Object.getPrototypeOf(filesystem)===LocalFileSystem.prototype;
      if(!supported){
        const [{SandboxedFileSystem},{default:metadata}]=await Promise.all([
          import('@deepseek-ai/dsh-fs-sandbox'),import('@deepseek-ai/dsh-fs-sandbox/package.json',{with:{type:'json'}})]);
        supported=metadata.version==='0.2.2-rc.2'&&Object.getPrototypeOf(filesystem)===SandboxedFileSystem.prototype;
      }
      return [version,local.version,toolFs.version].every(value=>value==='0.2.2-rc.2')&&ctx.tools instanceof ToolsService
        &&supported&&!!registeredWrite&&ctx.tools.get('write')===registeredWrite
        &&ctx.tools.get('write',agent)===registeredWrite&&registeredWrite.execute===registeredExecute;
    }catch{return false;}
  }
  async function stat(agent,file,signal){
    const root=runtime.get(agent).root;
    try{
      const value=await files.stat(root,file,signal);
      return {ok:true,exists:value.exists,revision:value.version,bytes:value.bytes,target:value.target,type:value.type};
    }catch(error){signal.throwIfAborted();return {ok:false,error:{code:error.code,message:error.message}};}
  }
  async function read(agent,file,revision,signal){
    try{
      const value=await files.readBytes(runtime.get(agent).root,file,signal,2_000_000);
      if(!value.versioned||value.version!==revision)throw new Error('File changed while reading the conditional-edit source.');
      const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value.bytes);
      if(text.length>500000)throw new Error('Source exceeds verified_exec read budget.');
      return {ok:true,text,sha256:sha(text),totalLines:text.split(/\r\n|\r|\n/u).length};
    }catch(error){signal.throwIfAborted();return {ok:false,error:{code:error.code,message:error.message}};}
  }
  async function apply(agent,group,observation,signal){
    const active=runtime.execFor(agent,signal),callId='work-evidence:native-cas:'+randomUUID();
    const file=group.full??group.file;
    const intent=group.mode==='create'?{kind:'createIfAbsent'}:{kind:'replaceIfVersion',version:observation.revision};
    const state={agent,target:observation.target,intent,guarded:false};
    pending.set(callId,state);
    let result;
    try{
      result=await ctx.tools.execute({name:'write',arguments:{file_path:file,content:group.expectedText},
        agent,callId,rootCallId:active.rootCallId??callId,parent:active.token,signal});
    }catch(error){
      return {ok:false,status:'error',effectState:state.guarded?'unknown':'none',...(state.denied?{permissionDenied:true}:{}),error:{message:String(error.message??error).slice(0,1200)}};
    }finally{pending.delete(callId);}
    if(result.isError){
      const prepublication=result.error?.info?.name==='FsError'&&['FS_STALE_VERSION','FS_NOT_OBSERVED'].includes(result.error.info.code);
      return {ok:false,status:'error',effectState:state.denied||!state.guarded||prepublication?'none':result.error?.info?.effectState??'unknown',
        ...(state.denied?{permissionDenied:true}:{}),error:result.error??{message:'Native write failed.'}};
    }
    const value=result.value;
    if(!state.guarded||!value||value.after!==normalize(group.expectedText))return {ok:false,status:'unknown',effectState:'unknown',
      error:{message:!state.guarded?'Native write did not consume the conditional intent.':'Native write returned content different from the planned edit.'}};
    try{
      const after=await stat(agent,file,signal);
      if(!after.ok||!after.exists)return {ok:false,status:'partial',effectState:'applied',error:after.error??{message:'Applied file is unavailable.'}};
      const observed=await read(agent,file,after.revision,signal);
      if(!observed.ok||observed.sha256!==sha(group.expectedText))return {ok:false,status:'partial',effectState:'applied',
        error:observed.error??{message:'Post-write content does not match the conditional edit.'}};
      return {ok:true,status:'completed',effectState:'applied',revision:after.revision,contentHash:observed.sha256,
        bytes:after.bytes,lineCount:observed.totalLines,changed:group.mode==='create'||group.beforeHash!==observed.sha256,versionKind:'native-opaque',guarded:true};
    }catch(error){return {ok:false,status:'partial',effectState:'applied',error:{message:'Native write completed; readback failed: '+String(error.message??error).slice(0,1100)}};}
  }
  return {available,stat,read,apply};
}
