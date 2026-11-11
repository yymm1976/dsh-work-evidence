import {createHash} from 'node:crypto';
import {createNativeFiles} from './native-files.mjs';
import {queryStructuredJson} from './structured-json-core.mjs';

/** Native bounded reads establish the source version for the selected JSON values. */
export function createStructuredJson(ctx,runtime){
  const files=createNativeFiles(ctx);
  return {async query(agent,input,signal){
    const state=runtime.get(agent);
    if(state.config.structuredJson!==true)return {status:'disabled',reason:'structured-json-disabled'};
    try{
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['path','selectors','format','maxValueChars'].includes(key))||
        typeof input.path!=='string'||!input.path.trim()||input.path.length>4096)throw Object.assign(new Error('Invalid JSON query request.'),{code:'INVALID_JSON_REQUEST'});
      const bounded=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
      const source=await files.readBytes(state.root,input.path,bounded,2_097_152);
      if(!source.versioned)throw Object.assign(new Error('A native version is required for JSON selection.'),{code:'JSON_UNVERSIONED_SOURCE'});
      let text;
      try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(source.bytes);}
      catch{throw Object.assign(new Error('The JSON source must be valid UTF-8.'),{code:'JSON_NOT_UTF8'});}
      const value=queryStructuredJson(text,input.selectors,{format:input.format??'json',maxValueChars:input.maxValueChars??8000});
      return {status:'observed',path:source.path,bytes:source.bytesLength,version:source.version,versionKind:'native-opaque',
        sha256:createHash('sha256').update(source.bytes).digest('hex'),...value};
    }catch(error){
      signal.throwIfAborted();
      return {status:'unavailable',reason:error.code??'JSON_QUERY_FAILED',error:{code:error.code??'JSON_QUERY_FAILED',message:String(error.message??error).slice(0,800),
        ...(Number.isSafeInteger(error.physicalLine)?{physicalLine:error.physicalLine}:{})}};
    }
  }};
}
