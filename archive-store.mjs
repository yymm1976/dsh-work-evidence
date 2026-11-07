import path from 'node:path';
import {createRequire} from 'node:module';
import {crc32,inflateRawSync} from 'node:zlib';

const require=createRequire(import.meta.url);
let unzip;
function unzipper(){
  if(unzip)return unzip;
  try{unzip=require('fflate').unzipSync;}
  catch(cause){
    try{unzip=createRequire(require.resolve('@deepseek-ai/dsh-tools'))('fflate').unzipSync;}
    catch{throw Object.assign(new Error('Archive decoding requires the fflate dependency declared by Work Evidence; it could not be loaded from the plugin or host.'),{code:'ARCHIVE_DECODER_UNAVAILABLE',cause});}
  }
  if(typeof unzip!=='function'){unzip=undefined;throw Object.assign(new Error('The loaded fflate package has no unzipSync decoder.'),{code:'ARCHIVE_DECODER_UNAVAILABLE'});}
  return unzip;
}
export function archiveDecoderStatus(){
  try{unzipper();return {available:true,package:'fflate'};}
  catch(error){return {available:false,package:'fflate',code:error.code,message:error.message};}
}
const MAX_ARCHIVE=128*1024*1024,MAX_ENTRY=8*1024*1024,MAX_SESSION=128*1024*1024,MAX_TOTAL=256*1024*1024;
const sessions=new Map();
let activeArchives=0;
const archiveWaiters=[];
async function withArchiveSlot(signal,operation){
  signal?.throwIfAborted();
  if(activeArchives<2)activeArchives++;
  else await new Promise((resolve,reject)=>{
    const waiter={resolve,signal,abort:null};
    waiter.abort=()=>{
      const index=archiveWaiters.indexOf(waiter);
      if(index>=0)archiveWaiters.splice(index,1);
      reject(signal.reason);
    };
    archiveWaiters.push(waiter);
    signal?.addEventListener('abort',waiter.abort,{once:true});
  });
  try{signal?.throwIfAborted();return await operation();}
  finally{
    const next=archiveWaiters.shift();
    if(next){next.signal?.removeEventListener('abort',next.abort);next.resolve();}
    else activeArchives--;
  }
}
const normalize=name=>name.replaceAll('\\','/');
const unavailable=(archive,error)=>({state:'unavailable',archive,code:error.code||'ARCHIVE_READ_UNAVAILABLE',message:String(error.message).slice(0,1200)});
function fail(code,message){const error=new Error(message);error.code=code;throw error;}
function entryName(bytes,flags){
  try{return flags&0x800?new TextDecoder('utf-8',{fatal:true}).decode(bytes):bytes.toString('latin1');}
  catch{fail('ARCHIVE_NAME_INVALID','Archive entry name is not valid UTF-8.');}
}
function archiveDirectory(buffer){
  const data=Buffer.from(buffer.buffer,buffer.byteOffset,buffer.byteLength);
  const invalid=()=>fail('ARCHIVE_DIRECTORY_INVALID','Archive directory is incomplete or inconsistent.');
  const ambiguous=()=>fail('ARCHIVE_DIRECTORY_AMBIGUOUS','Archive contains more than one end-of-central-directory record.');
  const inRange=(offset,length)=>Number.isSafeInteger(offset)&&Number.isSafeInteger(length)&&offset>=0&&length>=0&&offset+length<=data.length;
  const u64=offset=>{if(!inRange(offset,8))invalid();const value=data.readBigUInt64LE(offset);if(value>BigInt(Number.MAX_SAFE_INTEGER))invalid();return Number(value);};
  const first=data.length-22,minimum=Math.max(0,data.length-65557);
  let end=first;
  for(;end>=minimum;end--)if(end+4<=data.length&&data.readUInt32LE(end)===0x06054b50)break;
  if(end<minimum||end+22+data.readUInt16LE(end+20)!==data.length)invalid();
  for(let cursor=end+1;cursor+4<=data.length;cursor++)if(data.readUInt32LE(cursor)===0x06054b50)ambiguous();
  let count=data.readUInt16LE(end+10),offset=data.readUInt32LE(end+16);
  if(end>=20&&data.readUInt32LE(end-20)===0x07064b50){
    const zip64=u64(end-12);
    if(!inRange(zip64,56)||data.readUInt32LE(zip64)!==0x06064b50)invalid();
    count=u64(zip64+32);offset=u64(zip64+48);
  }else if(offset===0xffffffff||data.readUInt32LE(end+12)===0xffffffff)invalid();
  if(count>150000)fail('ARCHIVE_ENTRY_LIMIT','Archive has more than 150000 entries.');
  const entries=[];
  for(let index=0;index<count;index++){
    if(!inRange(offset,46)||data.readUInt32LE(offset)!==0x02014b50)invalid();
    const nameLength=data.readUInt16LE(offset+28),extraLength=data.readUInt16LE(offset+30),commentLength=data.readUInt16LE(offset+32);
    const next=offset+46+nameLength+extraLength+commentLength;
    if(!inRange(offset,next-offset))invalid();
    let size=data.readUInt32LE(offset+20),originalSize=data.readUInt32LE(offset+24),localOffset=data.readUInt32LE(offset+42);
    if(size===0xffffffff||originalSize===0xffffffff||localOffset===0xffffffff){
      let extra=offset+46+nameLength,found=false;
      const extraEnd=extra+extraLength;
      while(extra+4<=extraEnd){
        const kind=data.readUInt16LE(extra),length=data.readUInt16LE(extra+2),payload=extra+4;
        if(payload+length>extraEnd)invalid();
        if(kind===1){
          let cursor=payload;
          const field=()=>{if(cursor+8>payload+length)invalid();const value=u64(cursor);cursor+=8;return value;};
          if(originalSize===0xffffffff)originalSize=field();
          if(size===0xffffffff)size=field();
          if(localOffset===0xffffffff)localOffset=field();
          found=true;break;
        }
        extra=payload+length;
      }
      if(!found)invalid();
    }
    const flags=data.readUInt16LE(offset+8),nameBytes=data.subarray(offset+46,offset+46+nameLength);
    entries.push({size,originalSize,localOffset,crc:data.readUInt32LE(offset+16),flags,
      compression:data.readUInt16LE(offset+10),nameBytes,name:entryName(nameBytes,flags)});
    offset=next;
  }
  return entries;
}
function session(root,exec){
  const key=String(exec.agent?.sessionId||exec.agent?.id||'unscoped')+'\0'+path.resolve(root);
  let s=sessions.get(key);if(!s){s={files:new Map(),pending:new Map()};sessions.set(key,s);}
  else{sessions.delete(key);sessions.set(key,s);}
  while(sessions.size>8)sessions.delete(sessions.keys().next().value);
  return s;
}
const bytes=s=>[...s.files.values()].reduce((n,x)=>n+x.bytes,0);
function trim(s){
  while(s.files.size>4||bytes(s)>MAX_SESSION)s.files.delete(s.files.keys().next().value);
  while([...sessions.values()].reduce((n,x)=>n+bytes(x),0)>MAX_TOTAL){
    const first=[...sessions.values()].find(x=>x.files.size);if(!first)break;first.files.delete(first.files.keys().next().value);
  }
}
async function openArchive(root,archive,exec){
  exec.signal?.throwIfAborted();
  if(typeof archive!=='string'||!/\.(jar|zip)$/i.test(archive))fail('ARCHIVE_PATH_INVALID','Expected a workspace jar/zip path.');
  const file=path.resolve(root,archive),before=await exec.nativeFiles.stat(root,file,exec.signal);
  if(!before.exists||before.type!=='file')fail('ARCHIVE_UNAVAILABLE','Archive is not a regular file.');
  if(before.bytes>MAX_ARCHIVE)fail('ARCHIVE_SIZE_LIMIT','Archive exceeds the 128 MiB in-memory limit.');
  const cacheable=typeof before.version==='string'&&before.version.length>0;
  const identity=cacheable?before.version:null,s=session(root,exec),cached=s.files.get(file);
  if(cacheable&&cached?.identity===identity){
    s.files.delete(file);s.files.set(file,cached);
    return {record:cached,cache:{hit:true,observedAt:cached.observedAt,validatedAt:new Date().toISOString(),scope:'session-and-workspace'}};
  }
  s.files.delete(file);
  const pendingKey=cacheable?file+'\0'+identity:null;
  let promise=cacheable?s.pending.get(pendingKey):null,shared=!!promise;
  if(!promise){
    promise=(async()=>{
      const buffer=(await exec.nativeFiles.readBytes(root,file,exec.signal,MAX_ARCHIVE)).bytes;
      const entries=[],byName=new Map(),directory=archiveDirectory(buffer);
      unzipper()(buffer,{filter:item=>{
        if(entries.length>=150000)fail('ARCHIVE_ENTRY_LIMIT','Archive has more than 150000 entries.');
        const metadata=directory[entries.length];
        if(!metadata||metadata.name!==item.name||metadata.size!==item.size||metadata.originalSize!==item.originalSize||metadata.compression!==item.compression)
          fail('ARCHIVE_DIRECTORY_INVALID','Archive decoder and directory metadata disagree.');
        const entry=Object.assign(metadata,{name:normalize(item.name),raw:item.name});
        entries.push(entry);const existing=byName.get(entry.name)||[];existing.push(entry);byName.set(entry.name,existing);return false;
      }});
      if(entries.length!==directory.length)fail('ARCHIVE_DIRECTORY_INVALID','Archive decoder omitted directory entries.');
      const record={file,identity,buffer,entries,byName,texts:new Map(),
        bytes:buffer.length+entries.reduce((total,entry)=>total+400+(entry.name.length+entry.raw.length)*2,0),observedAt:new Date().toISOString(),owner:s};
      if(cacheable){s.files.set(file,record);trim(s);}return record;
    })();
    if(cacheable)s.pending.set(pendingKey,promise);
  }
  let record;try{record=await promise;}finally{if(s.pending.get(pendingKey)===promise)s.pending.delete(pendingKey);}
  exec.signal?.throwIfAborted();
  const current=await exec.nativeFiles.stat(root,file,exec.signal);
  if(!current.exists||current.type!=='file'||(cacheable?current.version!==identity:current.bytes!==before.bytes))fail('ARCHIVE_CHANGED','Archive changed before source delivery.');
  return {record,cache:{hit:shared,observedAt:record.observedAt,validatedAt:cacheable?new Date().toISOString():null,
    scope:cacheable?'session-and-workspace':'uncached-unversioned'}};
}
function entryText(record,name,maxBytes=MAX_ENTRY){
  const matches=record.byName.get(name)||[];
  if(!matches.length)fail('ARCHIVE_ENTRY_NOT_FOUND','Archive entry not found.');
  if(matches.length!==1)fail('ARCHIVE_ENTRY_AMBIGUOUS','Ambiguous archive entry after separator normalization.');
  const entry=matches[0];
  if(!Number.isSafeInteger(entry.originalSize)||entry.originalSize>maxBytes)fail('ARCHIVE_ENTRY_SIZE_LIMIT','Entry exceeds the in-memory text budget.');
  if(![0,8].includes(entry.compression))fail('ARCHIVE_COMPRESSION_UNSUPPORTED','Only stored and deflated entries are supported.');
  if(record.texts.has(name))return record.texts.get(name);
  const archive=Buffer.from(record.buffer.buffer,record.buffer.byteOffset,record.buffer.byteLength),offset=entry.localOffset;
  if(entry.flags&1||offset<0||offset+30>archive.length||archive.readUInt32LE(offset)!==0x04034b50)
    fail('ARCHIVE_ENTRY_UNAVAILABLE','Entry local header is unavailable or encrypted.');
  const nameLength=archive.readUInt16LE(offset+26),extraLength=archive.readUInt16LE(offset+28),start=offset+30+nameLength+extraLength,end=start+entry.size;
  if(!Number.isSafeInteger(end)||end>archive.length||!archive.subarray(offset+30,offset+30+nameLength).equals(entry.nameBytes)||
    archive.readUInt16LE(offset+6)!==entry.flags||archive.readUInt16LE(offset+8)!==entry.compression)
    fail('ARCHIVE_ENTRY_UNAVAILABLE','Entry local header differs from its directory.');
  if(!(entry.flags&8)){
    let size=archive.readUInt32LE(offset+18),originalSize=archive.readUInt32LE(offset+22);
    if(size===0xffffffff||originalSize===0xffffffff){
      let cursor=offset+30+nameLength,found=false;
      const extraEnd=cursor+extraLength;
      while(cursor+4<=extraEnd){
        const kind=archive.readUInt16LE(cursor),length=archive.readUInt16LE(cursor+2),payload=cursor+4;
        if(payload+length>extraEnd)break;
        if(kind===1){
          let position=payload;
          const field=()=>{
            if(position+8>payload+length)fail('ARCHIVE_ENTRY_UNAVAILABLE','Entry ZIP64 local header is incomplete.');
            const value=archive.readBigUInt64LE(position);position+=8;
            if(value>BigInt(Number.MAX_SAFE_INTEGER))fail('ARCHIVE_ENTRY_UNAVAILABLE','Entry ZIP64 local header is invalid.');
            return Number(value);
          };
          if(originalSize===0xffffffff)originalSize=field();
          if(size===0xffffffff)size=field();
          found=true;break;
        }
        cursor=payload+length;
      }
      if(!found)fail('ARCHIVE_ENTRY_UNAVAILABLE','Entry ZIP64 local header is missing.');
    }
    if(archive.readUInt32LE(offset+14)!==entry.crc||size!==entry.size||originalSize!==entry.originalSize)
      fail('ARCHIVE_ENTRY_UNAVAILABLE','Entry local header differs from its directory.');
  }
  let buffer;
  if(entry.compression===0)buffer=archive.subarray(start,end);
  else try{
    const output=inflateRawSync(archive.subarray(start,end),{maxOutputLength:Math.min(maxBytes,entry.originalSize)+1,info:true});
    if(output.engine.bytesWritten!==entry.size)fail('ARCHIVE_ENTRY_SIZE_MISMATCH','Entry compressed size differs from archive metadata.');
    buffer=output.buffer;
  }catch(error){
    if(error.code==='ARCHIVE_ENTRY_SIZE_MISMATCH')throw error;
    fail('ARCHIVE_ENTRY_UNAVAILABLE','Entry could not be decoded within the text budget.');
  }
  if(buffer.length!==entry.originalSize||buffer.length>maxBytes)fail('ARCHIVE_ENTRY_SIZE_MISMATCH','Entry output size differs from archive metadata.');
  if(crc32(buffer)!==entry.crc)fail('ARCHIVE_ENTRY_CHECKSUM_MISMATCH','Entry checksum differs from archive metadata.');
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{fail('ARCHIVE_ENCODING_UNSUPPORTED','Source entry is not valid UTF-8.');}
  if(text.includes('\0'))fail('ARCHIVE_NOT_TEXT','Source entry contains NUL bytes.');
  const lines=text.split(/\r\n|\r|\n/);if(lines.at(-1)==='')lines.pop();
  const value={text,lines};record.texts.set(name,value);record.bytes+=text.length*2+lines.length*12;
  while(record.texts.size>16){const key=record.texts.keys().next().value,old=record.texts.get(key);record.texts.delete(key);record.bytes-=old.text.length*2+old.lines.length*12;}
  trim(record.owner);return value;
}
function mavenDescriptors(record){
  const entries=record.entries.filter(entry=>/^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/.test(entry.name));
  const descriptors=entries.slice(0,16).map(entry=>{
    try{
      const values=new Map();
      for(const line of entryText(record,entry.name,65536).text.split(/\r\n|\r|\n/)){
        if(!line.trim()||/^\s*[#!]/.test(line))continue;
        const match=/^\s*([^\s:=]+)\s*(?:[=:]\s*|\s+)(.*?)\s*$/.exec(line);
        if(!match||line.includes('\\'))fail('ARCHIVE_MAVEN_PROPERTIES_UNSUPPORTED','Escaped or non-literal Maven properties are not interpreted.');
        if(!['groupId','artifactId','version'].includes(match[1]))continue;
        if(values.has(match[1]))fail('ARCHIVE_MAVEN_PROPERTIES_AMBIGUOUS','Duplicate Maven coordinate property.');
        values.set(match[1],match[2]);
      }
      const group=values.get('groupId'),artifact=values.get('artifactId'),version=values.get('version');
      if(![group,artifact,version].every(value=>typeof value==='string'&&value.length>0&&value.length<=300&&/^[A-Za-z0-9_.+-]+$/.test(value)))
        fail('ARCHIVE_MAVEN_COORDINATE_INVALID','Maven descriptor does not contain three supported literal coordinates.');
      if(entry.name!==`META-INF/maven/${group}/${artifact}/pom.properties`)
        fail('ARCHIVE_MAVEN_DESCRIPTOR_MISMATCH','Maven descriptor path and declared coordinates disagree.');
      return {state:'observed',entry:entry.name,group,artifact,version};
    }catch(error){return {state:'unavailable',entry:entry.name,code:error.code||'ARCHIVE_MAVEN_METADATA_UNAVAILABLE'};}
  });
  return {state:entries.length>16?'partial':descriptors.some(item=>item.state!=='observed')?'unavailable':entries.length?'observed':'missing',
    descriptors,truncated:entries.length>16};
}
export async function listArchiveEntries(root,archive,exec,{mavenMetadata=false}={}){
  try{
    return await withArchiveSlot(exec.signal,async()=>{
      const {record,cache}=await openArchive(root,archive,exec);let manifestText='',manifestError=null;
      if(record.byName.has('META-INF/MANIFEST.MF'))try{manifestText=entryText(record,'META-INF/MANIFEST.MF',65536).text;}catch(error){manifestError={code:error.code,message:error.message};}
      return {state:'observed',archive:record.file,entries:record.entries.map(entry=>entry.name),manifestText,manifestError,cache,
        ...(mavenMetadata?{mavenMetadata:mavenDescriptors(record)}:{})};
    });
  }catch(error){if(exec.signal?.aborted)throw error;return unavailable(archive,error);}
}
export async function readArchiveEntry(root,archive,entry,exec){
  const name=typeof entry==='string'?normalize(entry):'';
  if(!name||name.length>2000||name.includes('\0')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').includes('..'))return unavailable(archive,{code:'ARCHIVE_ENTRY_INVALID',message:'Entry must be a relative archive path.'});
  try{return await withArchiveSlot(exec.signal,async()=>{const {record,cache}=await openArchive(root,archive,exec);const value=entryText(record,name);return {state:'observed',archive:record.file,entry:name,...value,cache};});}
  catch(error){if(exec.signal?.aborted)throw error;return {...unavailable(archive,error),entry:name};}
}
