import {createHash} from 'node:crypto';
import {createNativeFiles} from './native-files.mjs';
import {createFileProfile} from './file-profile-core.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=(code,message)=>Object.assign(new Error(message),{code});
const same=(before,after)=>after.exists&&after.type==='file'&&before.target.targetKey===after.target.targetKey&&before.version===after.version&&before.bytes===after.bytes;

function checkInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['files','scan','maxBytes'].includes(key)))throw new Error('Invalid file profile request');
  if(!Array.isArray(input.files)||input.files.length<1||input.files.length>8)throw new Error('Provide 1 to 8 files');
  const scan=input.scan??'sample',maxBytes=input.maxBytes??128_000_000;
  if(!['sample','complete'].includes(scan)||!Number.isSafeInteger(maxBytes)||maxBytes<4096||maxBytes>512_000_000)throw new Error('Invalid profile scan or byte budget');
  for(const item of input.files){
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['path','format','delimiter'].includes(key))||
      typeof item.path!=='string'||!item.path.trim()||item.path.length>4096||!['text','csv'].includes(item.format??'text'))throw new Error('Invalid profile file');
    createFileProfile({format:item.format??'text',delimiter:item.delimiter??','});
  }
  return {files:input.files,scan,maxBytes};
}

function decodeSample(bytes,stream=false){
  try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes,{stream});}
  catch(error){if(error instanceof TypeError)throw failure('PROFILE_NOT_UTF8_TEXT','The sampled source must be valid UTF-8.');throw error;}
}
function sampleText(bytes,{offset,end}){
  let start=0;
  if(offset)while(start<Math.min(3,bytes.length)&&(bytes[start]&0xC0)===0x80)start++;
  const text=decodeSample(bytes.subarray(start),!end);
  if(text.includes('\0'))throw failure('PROFILE_NOT_UTF8_TEXT','The sampled bytes contain NUL; use a binary or image reader.');
  const view=createFileProfile({sampleLines:4,maxSampleLineChars:200});view.push(text);
  const value=view.finish();
  return {offset,bytes:bytes.length,sha256:sha(bytes),decodedOffset:offset+start,
    startsAtFileBoundary:offset===0,endsAtFileBoundary:end,preview:offset===0?value.head:value.tail};
}

/** Read-only profiles keep sampled observations distinct from stable complete scans. */
export function createFileProfiler(ctx,runtime){
  const files=createNativeFiles(ctx);
  async function observe(agent,input,signal){
    const state=runtime.get(agent);
    if(state.config.fileProfiling!==true)return {status:'disabled',reason:'file-profiling-disabled',files:[]};
    let plan;
    try{plan=checkInput(input);}catch(error){return {status:'deopt',reason:'invalid-profile-request',error:{message:error.message},files:[]};}
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(30000)]),budget={remaining:plan.maxBytes},results=[];
    for(const item of plan.files){
      signal.throwIfAborted();
      try{
        const before=await files.stat(state.root,item.path,bounded),backend=ctx.get('fs');
        if(!before.exists||before.type!=='file')throw failure('PROFILE_NOT_REGULAR_FILE','The profile source must be an existing regular file.');
        if(typeof before.version!=='string'||!before.version)throw failure('PROFILE_UNVERSIONED_SOURCE','A native version is required to detect concurrent changes.');
        const metadata={path:before.path,bytes:before.bytes,version:before.version,versionKind:'native-opaque'};
        let analysis,scope,samples,decodedTextSha256,scannedBytes=0;
        async function range(offset,length){
          bounded.throwIfAborted();
          if(length>budget.remaining)throw failure('PROFILE_BYTE_BUDGET','The requested range exceeds the remaining byte budget.');
          const bytes=Buffer.from(await backend.readByteRange(before.target,{offset,length},bounded));
          scannedBytes+=bytes.length;budget.remaining-=bytes.length;
          if(budget.remaining<0)throw failure('PROFILE_BYTE_BUDGET','The native provider returned bytes beyond the remaining budget.');
          if(bytes.length!==length)throw failure('PROFILE_SAMPLE_INCOMPLETE','The provider did not return the requested byte range.');
          return bytes;
        }
        if(plan.scan==='complete'){
          if(typeof backend.readByteRange!=='function')throw failure('PROFILE_RANGE_UNAVAILABLE','The native provider has no bounded byte-range reader.');
          if(!Number.isSafeInteger(before.bytes)||before.bytes<0)throw failure('PROFILE_SIZE_UNAVAILABLE','Complete profiles require a known native file size.');
          if(before.bytes>budget.remaining)throw failure('PROFILE_BYTE_BUDGET','The complete file exceeds the remaining byte budget.');
          const profile=createFileProfile({format:item.format??'text',delimiter:item.delimiter??','}),digest=createHash('sha256');
          // Native streamText strips BOM. Decode bounded raw ranges to preserve storage identity.
          const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
          for(let offset=0;offset<before.bytes;offset+=65536){
            bounded.throwIfAborted();
            const bytes=await range(offset,Math.min(65536,before.bytes-offset));digest.update(bytes);
            if(bytes.includes(0))throw failure('PROFILE_NOT_UTF8_TEXT','The source contains NUL; use a binary or image reader.');
            try{profile.push(decoder.decode(bytes,{stream:true}));}
            catch(error){if(error instanceof TypeError)throw failure('PROFILE_NOT_UTF8_TEXT','The source must be valid UTF-8.');throw error;}
          }
          try{profile.push(decoder.decode());}
          catch(error){if(error instanceof TypeError)throw failure('PROFILE_NOT_UTF8_TEXT','The source must be valid UTF-8.');throw error;}
          analysis=profile.finish();scope='complete';decodedTextSha256=digest.digest('hex');
        }else{
          if(typeof backend.readByteRange!=='function')throw failure('PROFILE_RANGE_UNAVAILABLE','The native provider has no bounded byte-range reader.');
          if(!Number.isSafeInteger(before.bytes)||before.bytes<0)throw failure('PROFILE_SIZE_UNAVAILABLE','Sampled profiles require a known native file size.');
          const headLength=Math.min(before.bytes,8192),tailOffset=Math.max(headLength,before.bytes-8192),tailLength=before.bytes-tailOffset;
          if(headLength+tailLength>budget.remaining)throw failure('PROFILE_BYTE_BUDGET','The requested samples exceed the remaining byte budget.');
          const head=await range(0,headLength);
          const tail=tailLength?await range(tailOffset,tailLength):Buffer.alloc(0);
          samples=[sampleText(head,{offset:0,end:headLength===before.bytes})];
          if(tail.length)samples.push(sampleText(tail,{offset:tailOffset,end:true}));
          if(tailOffset===headLength){
            const bytes=Buffer.concat([head,tail]),text=decodeSample(bytes);
            const profile=createFileProfile({format:item.format??'text',delimiter:item.delimiter??','});profile.push(text);
            analysis=profile.finish();scope='complete';decodedTextSha256=sha(bytes);
          }else scope='sampled';
        }
        const after=await files.stat(state.root,item.path,bounded);
        if(!same(before,after))throw failure('SOURCE_CHANGED','The profile source changed during the read; no profile is certified.');
        const valid=analysis?.csv?.valid!==false;
        results.push({status:valid?'observed':'partial',...metadata,scope,scanComplete:scope==='complete',scannedBytes,
          ...(analysis?{analysis,decodedTextSha256}:{}),...(samples?{samples}:{}),...(!valid?{reason:'csv-parse-error'}:{})});
      }catch(error){
        signal.throwIfAborted();
        results.push({status:'unavailable',path:item.path,scanComplete:false,error:{code:error.code??'PROFILE_READ_FAILED',message:String(error.message??error).slice(0,800)}});
      }
    }
    return {status:results.every(item=>item.status==='observed')?'observed':'partial',requestedScan:plan.scan,
      byteBudget:plan.maxBytes,bytesRead:plan.maxBytes-budget.remaining,files:results};
  }
  return {observe};
}
