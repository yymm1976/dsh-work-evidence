import {within} from './evidence.mjs';

function codeOf(error){return error?.info?.code||error?.code||'FS_UNAVAILABLE';}
function failure(error){return Object.assign(new Error(String(error?.message||error).slice(0,1000)),{code:codeOf(error)});}

/** Shared native filesystem access for auxiliary source and archive observations. */
export function createNativeFiles(ctx){
  function backend(){
    const value=ctx.get('fs');
    if(!value)throw Object.assign(new Error('The DSH filesystem provider is unavailable.'),{code:'NATIVE_FS_UNAVAILABLE'});
    return value;
  }
  async function stat(root,file,signal){
    signal?.throwIfAborted();
    const fs=backend(),lexical=within(root,file);
    try{
      const workspace=await fs.resolve(root,{cwd:root,signal});
      const target=await fs.resolve(lexical,{cwd:root,signal});
      if(!fs.contains(workspace,target))throw Object.assign(new Error('Path resolves outside the current workspace'),{code:'FS_OUTSIDE_WORKSPACE'});
      const info=await fs.stat(target,signal);
      return {path:lexical,target,exists:info!==undefined,type:info?.type??null,version:info?.version??null,bytes:info?.size??null,info};
    }catch(error){throw failure(error);}
  }
  async function readBytes(root,file,signal,maxBytes,{requireKnownSize=false}={}){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('A positive native byte-read budget is required');
    const before=await stat(root,file,signal);
    if(!before.exists)throw Object.assign(new Error('Source file is unavailable'),{code:'FS_NOT_FOUND'});
    if(before.type!=='file')throw Object.assign(new Error('Source is not a regular file'),{code:'FS_NOT_REGULAR_FILE'});
    if(requireKnownSize&&(!Number.isSafeInteger(before.bytes)||before.bytes<0))
      throw Object.assign(new Error('A known native source size is required for a complete read.'),{code:'FS_SIZE_UNKNOWN'});
    if(before.bytes!==null&&before.bytes>maxBytes)throw Object.assign(new Error(`File exceeds the ${maxBytes}-byte read budget`),{code:'FS_READ_BUDGET'});
    const bytes=Buffer.from(await backend().readBytes(before.target,signal,maxBytes));
    if(bytes.length>maxBytes)throw Object.assign(new Error(`File exceeds the ${maxBytes}-byte read budget`),{code:'FS_READ_BUDGET'});
    if(Number.isSafeInteger(before.bytes)&&before.bytes>=0&&bytes.length!==before.bytes)
      throw Object.assign(new Error('Native byte read did not return the complete recorded file size.'),{code:'FS_READ_INCOMPLETE'});
    const after=await stat(root,file,signal);
    if(!after.exists||after.type!=='file'||(before.version!==null&&before.version!==after.version)||before.bytes!==after.bytes)
      throw Object.assign(new Error('Source changed during the native read; request it again.'),{code:'SOURCE_CHANGED'});
    return {path:before.path,bytes,version:before.version,bytesLength:bytes.length,versioned:before.version!==null&&before.version===after.version};
  }
  return {stat,readBytes,processPath:target=>backend().processPath(target)};
}
