import path from 'node:path';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
let unzip;
function unzipper(){
  if(unzip)return unzip;
  try{unzip=require('fflate').unzipSync;}
  catch{unzip=createRequire(require.resolve('@deepseek-ai/dsh-tools'))('fflate').unzipSync;}
  return unzip;
}
const MAX_ARCHIVE=128*1024*1024,MAX_ENTRY=8*1024*1024,MAX_SESSION=128*1024*1024,MAX_TOTAL=256*1024*1024;
const sessions=new Map();
const normalize=name=>name.replaceAll('\\','/');
const unavailable=(archive,error)=>({state:'unavailable',archive,code:error.code||'ARCHIVE_READ_UNAVAILABLE',message:String(error.message).slice(0,1200)});
function fail(code,message){const error=new Error(message);error.code=code;throw error;}
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
  const identity=String(before.version??before.bytes),s=session(root,exec),cached=s.files.get(file);
  if(cached?.identity===identity){
    s.files.delete(file);s.files.set(file,cached);
    return {record:cached,cache:{hit:true,observedAt:cached.observedAt,validatedAt:new Date().toISOString(),scope:'session-and-workspace'}};
  }
  s.files.delete(file);
  const pendingKey=file+'\0'+identity;
  let promise=s.pending.get(pendingKey),shared=!!promise;
  if(!promise){
    promise=(async()=>{
      const buffer=(await exec.nativeFiles.readBytes(root,file,exec.signal,MAX_ARCHIVE)).bytes;
      const entries=[],byName=new Map();
      unzipper()(buffer,{filter:item=>{
        if(entries.length>=150000)fail('ARCHIVE_ENTRY_LIMIT','Archive has more than 150000 entries.');
        const entry={name:normalize(item.name),raw:item.name,size:item.size,originalSize:item.originalSize,compression:item.compression};
        entries.push(entry);const existing=byName.get(entry.name)||[];existing.push(entry);byName.set(entry.name,existing);return false;
      }});
      const record={file,identity,buffer,entries,byName,texts:new Map(),bytes:buffer.length+entries.length*180,observedAt:new Date().toISOString(),owner:s};
      s.files.set(file,record);trim(s);return record;
    })();
    s.pending.set(pendingKey,promise);
  }
  let record;try{record=await promise;}finally{if(s.pending.get(pendingKey)===promise)s.pending.delete(pendingKey);}
  exec.signal?.throwIfAborted();
  const current=await exec.nativeFiles.stat(root,file,exec.signal);
  if(!current.exists||String(current.version??current.bytes)!==identity)fail('ARCHIVE_CHANGED','Archive changed before source delivery.');
  return {record,cache:{hit:shared,observedAt:record.observedAt,validatedAt:new Date().toISOString(),scope:'session-and-workspace'}};
}
function entryText(record,name,maxBytes=MAX_ENTRY){
  const matches=record.byName.get(name)||[];
  if(!matches.length)fail('ARCHIVE_ENTRY_NOT_FOUND','Archive entry not found.');
  if(matches.length!==1)fail('ARCHIVE_ENTRY_AMBIGUOUS','Ambiguous archive entry after separator normalization.');
  const entry=matches[0];
  if(!Number.isSafeInteger(entry.originalSize)||entry.originalSize>maxBytes)fail('ARCHIVE_ENTRY_SIZE_LIMIT','Entry exceeds the in-memory text budget.');
  if(![0,8].includes(entry.compression))fail('ARCHIVE_COMPRESSION_UNSUPPORTED','Only stored and deflated entries are supported.');
  if(record.texts.has(name))return record.texts.get(name);
  const files=unzipper()(record.buffer,{filter:item=>item.name===entry.raw});
  if(!Object.hasOwn(files,entry.raw))fail('ARCHIVE_ENTRY_UNAVAILABLE','Entry could not be decoded.');
  const buffer=files[entry.raw];
  if(buffer.length!==entry.originalSize||buffer.length>maxBytes)fail('ARCHIVE_ENTRY_SIZE_MISMATCH','Entry output size differs from archive metadata.');
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
    const {record,cache}=await openArchive(root,archive,exec);let manifestText='',manifestError=null;
    if(record.byName.has('META-INF/MANIFEST.MF'))try{manifestText=entryText(record,'META-INF/MANIFEST.MF',65536).text;}catch(error){manifestError={code:error.code,message:error.message};}
    return {state:'observed',archive:record.file,entries:record.entries.map(entry=>entry.name),manifestText,manifestError,cache,
      ...(mavenMetadata?{mavenMetadata:mavenDescriptors(record)}:{})};
  }catch(error){if(exec.signal?.aborted)throw error;return unavailable(archive,error);}
}
export async function readArchiveEntry(root,archive,entry,exec){
  const name=typeof entry==='string'?normalize(entry):'';
  if(!name||name.length>2000||name.includes('\0')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').includes('..'))return unavailable(archive,{code:'ARCHIVE_ENTRY_INVALID',message:'Entry must be a relative archive path.'});
  try{const {record,cache}=await openArchive(root,archive,exec);const value=entryText(record,name);return {state:'observed',archive:record.file,entry:name,...value,cache};}
  catch(error){if(exec.signal?.aborted)throw error;return {...unavailable(archive,error),entry:name};}
}
