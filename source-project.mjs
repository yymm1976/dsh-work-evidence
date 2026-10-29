import path from 'node:path';
import {within} from './evidence.mjs';

const SOURCE_MAP_PATH='.dsh/work-evidence/source-map.json';
const SOURCE_MAP_SCHEMA='work-evidence.sources.v1';
const LIMITS=Object.freeze({
  sourceMapBytes:256_000,
  gradleFileBytes:512_000,
  pomBytes:768_000,
  packageJsonBytes:1_000_000,
  packageLockBytes:8_000_000,
  sourceRoots:24,
  archivePatterns:32,
  versionProperties:64,
  bindings:128,
  gradleProperties:512,
  declaredVersions:160,
  dependencies:256,
  mavenModules:16,
  npmDeclarations:512,
  npmDeclaredNames:4096,
  npmLockPackages:512,
  metadataFiles:40,
  problems:32,
});
const NPM_SECTIONS=['dependencies','devDependencies','optionalDependencies','peerDependencies'];

const posix=value=>String(value).replaceAll('\\','/');
const relativePath=(root,file)=>posix(path.relative(root,file))||'.';
const lineNumber=(text,index)=>text.slice(0,index).split(/\r\n|\n|\r/).length;
const isMissing=error=>['ENOENT','ENOTDIR','FS_NOT_FOUND'].includes(error?.code);
const safeMessage=error=>String(error?.message||error||'Unknown error').slice(0,500);

async function readBoundedUtf8(file,maxBytes,exec){
  const source=await exec.nativeFiles.readBytes(exec.root,file,exec.signal,maxBytes);
  const text=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes);
  if(text.includes('\0'))throw new Error('Source contains NUL bytes.');
  return {text,bytes:source.bytesLength,version:source.version,versioned:source.versioned};
}

function validWorkspaceRelative(value){
  if(typeof value!=='string'||!value.trim()||value.includes('\0')||value.length>1024)return false;
  const normalized=value.replaceAll('\\','/');
  return !normalized.startsWith('/')&&!/^[A-Za-z]:\//.test(normalized)&&!normalized.split('/').includes('..')&&
    !/^(?:~(?:\/|$)|\$HOME(?:\/|$)|\$\{HOME\}|%USERPROFILE%|env:)/i.test(normalized);
}

function validArchivePattern(value){
  if(typeof value!=='string'||!value.trim()||value.includes('\0')||value.length>500)return false;
  const normalized=value.replaceAll('\\','/').replace(/^\.\/+/,'');
  const scanned=normalized.replace(/^!+/,'');
  return scanned&&!scanned.startsWith('/')&&!/^[A-Za-z]:\//.test(scanned)&&!scanned.split('/').includes('..')&&
    !/^(?:~(?:\/|$)|\$HOME(?:\/|$)|\$\{HOME\}|%USERPROFILE%|env:)/i.test(scanned);
}

function createProjectContext(rootReal,exec){
  const problems=[],metadata=new Map(),metadataOrder=[];
  let problemsTruncated=false;
  function problem(kind,message,extra={}){
    const item={kind,message:safeMessage(message),at:new Date().toISOString(),...extra};
    if(problems.length>=LIMITS.problems){problemsTruncated=true;return;}
    problems.push(item);
  }
  function stamp(display,real,stat){
    if(!stat)return;
    const key=process.platform==='win32'?String(real).toLowerCase():real;
    if(!metadata.has(key))metadataOrder.push(key);
    metadata.set(key,{
      path:posix(display),
      realPath:posix(real),
      size:stat.size??stat.bytes,
      version:stat.version,
    });
  }
  function stampObject(){
    const files=metadataOrder.slice(0,LIMITS.metadataFiles).map(key=>metadata.get(key));
    return {files,truncated:metadataOrder.length>files.length};
  }
  return {root:rootReal,exec,problems,problem,stamp,stampObject,get problemsTruncated(){return problemsTruncated;}};
}

async function inspectWithin(project,requested,{expect='file',missingIsNormal=true}={}){
  let lexical;
  try{lexical=within(project.root,requested);}
  catch(error){
    project.problem('path-outside-workspace',error.message,{path:safeMessage(requested)});
    return {state:'invalid'};
  }
  let stat;
  try{stat=await project.exec.nativeFiles.stat(project.root,lexical,project.exec.signal);}catch(error){
    if(isMissing(error)&&missingIsNormal)return {state:'missing',path:relativePath(project.root,lexical)};
    project.problem('stat-failed',error.message,{path:relativePath(project.root,lexical)});
    return {state:'unavailable',path:relativePath(project.root,lexical)};
  }
  const real=project.exec.nativeFiles.processPath(stat.target);
  if(stat.exists)project.stamp(relativePath(project.root,real),real,stat);
  if(!stat.exists&&missingIsNormal)return {state:'missing',path:relativePath(project.root,lexical)};
  const actual=!stat.exists?'missing':stat.type;
  if(expect&&actual!==expect){
    project.problem('path-type-mismatch',`Expected ${expect}, observed ${actual}.`,{path:relativePath(project.root,real)});
    return {state:'invalid',path:relativePath(project.root,real),actual};
  }
  return {state:'observed',path:relativePath(project.root,real),lexical,real,stat,actual};
}

async function readText(project,file,maxBytes,{missingIsNormal=true}={}){
  const inspected=await inspectWithin(project,file,{expect:'file',missingIsNormal});
  if(inspected.state!=='observed')return inspected;
  try{
    const source=await readBoundedUtf8(inspected.lexical,maxBytes,project.exec);
    project.stamp(inspected.path,inspected.real,source);
    const text=source.text.charCodeAt(0)===0xfeff?source.text.slice(1):source.text;
    return {...inspected,text,bytes:source.bytes};
  }catch(error){
    const kind=/UTF-8|valid UTF-8/i.test(String(error?.message))?'utf8-read-failed':
      /read budget|exceeds/i.test(String(error?.message))?'file-read-budget':'file-read-failed';
    project.problem(kind,error.message,{path:inspected.path});
    return {state:'unavailable',path:inspected.path};
  }
}

function checkedStringArray(value,name,maxItems,maxChars,validate){
  if(!Array.isArray(value)||value.length>maxItems)throw new Error(`${name} must be an array with at most ${maxItems} entries`);
  const result=[];
  for(const [index,item] of value.entries()){
    if(typeof item!=='string'||!item.trim()||item.length>maxChars||(validate&&!validate(item.trim()))){
      throw new Error(`${name}[${index}] is invalid or escapes the workspace`);
    }
    const normalized=item.trim().replaceAll('\\','/');
    if(!result.includes(normalized))result.push(normalized);
  }
  return result;
}

function checkSourceMap(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('source-map.json must contain an object');
  const allowed=new Set(['schema','sourceRoots','archivePatterns','versionProperties','sources']);
  for(const key of Object.keys(value))if(!allowed.has(key))throw new Error('Unsupported source-map field: '+key);
  if(value.schema!==undefined&&value.schema!==SOURCE_MAP_SCHEMA)throw new Error(`Unsupported source-map schema; expected ${SOURCE_MAP_SCHEMA}`);
  const sourceRoots=value.sourceRoots===undefined?[]:checkedStringArray(value.sourceRoots,'sourceRoots',LIMITS.sourceRoots,1024,validWorkspaceRelative);
  const archivePatterns=value.archivePatterns===undefined?[]:checkedStringArray(value.archivePatterns,'archivePatterns',LIMITS.archivePatterns,500,validArchivePattern);
  const versionProperties=value.versionProperties===undefined?[]:checkedStringArray(value.versionProperties,'versionProperties',LIMITS.versionProperties,200,item=>/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(item));
  let sources=[];
  if(value.sources!==undefined){
    if(!Array.isArray(value.sources)||value.sources.length>LIMITS.bindings)throw new Error(`sources must be an array with at most ${LIMITS.bindings} entries`);
    sources=value.sources;
  }
  return {schema:value.schema||null,sourceRoots,archivePatterns,versionProperties,sources};
}

async function loadSourceMap(project){
  const loaded=await readText(project,SOURCE_MAP_PATH,LIMITS.sourceMapBytes);
  if(loaded.state==='missing')return {state:'missing',path:SOURCE_MAP_PATH};
  if(loaded.state!=='observed')return {state:loaded.state,path:SOURCE_MAP_PATH};
  try{
    const value=checkSourceMap(JSON.parse(loaded.text));
    return {state:'observed',path:SOURCE_MAP_PATH,...value};
  }catch(error){
    project.problem('source-map-invalid',error.message,{path:SOURCE_MAP_PATH});
    return {state:'invalid',path:SOURCE_MAP_PATH};
  }
}

async function resolveBindings(project,sources){
  const bindings=[],seen=new Map();
  for(let index=0;index<sources.length;index++){
    const value=sources[index];
    if(!value||typeof value!=='object'||Array.isArray(value)){
      project.problem('binding-invalid',`sources[${index}] must be an object`,{index});
      continue;
    }
    const allowed=new Set(['query','file','archive','entry']);
    if(Object.keys(value).some(key=>!allowed.has(key))){
      project.problem('binding-invalid',`sources[${index}] contains an unsupported field`,{index});
      continue;
    }
    if(typeof value.query!=='string'||!value.query.trim()||value.query.length>500){
      project.problem('binding-invalid',`sources[${index}].query must contain 1-500 characters`,{index});
      continue;
    }
    const query=value.query.trim();
    const hasFile=Object.hasOwn(value,'file'),hasArchive=Object.hasOwn(value,'archive'),hasEntry=Object.hasOwn(value,'entry');
    if((hasFile&&(hasArchive||hasEntry))||(!hasFile&&(!hasArchive||!hasEntry))){
      project.problem('binding-invalid',`sources[${index}] must provide file or archive+entry`,{index,query});
      continue;
    }
    const lower=query.toLowerCase();
    if(seen.has(lower))project.problem('binding-duplicate',`Multiple explicit bindings use query ${query}.`,{index,query,firstIndex:seen.get(lower)});
    else seen.set(lower,index);
    if(hasFile){
      if(!validWorkspaceRelative(value.file)){
        project.problem('binding-path-invalid',`sources[${index}].file must remain inside the workspace`,{index,query});
        continue;
      }
      const inspected=await inspectWithin(project,value.file,{expect:'file',missingIsNormal:true});
      bindings.push({query,file:inspected.path||posix(value.file),targetKind:'workspace-file',state:inspected.state});
      continue;
    }
    if(!validWorkspaceRelative(value.archive)||typeof value.entry!=='string'||!value.entry.trim()||value.entry.length>2000||value.entry.includes('\0')){
      project.problem('binding-path-invalid',`sources[${index}] archive and entry are invalid`,{index,query});
      continue;
    }
    const rawEntry=posix(value.entry);
    if(rawEntry.startsWith('/')||/^[A-Za-z]:\//.test(rawEntry)){
      project.problem('binding-path-invalid',`sources[${index}].entry must be a relative archive entry`,{index,query});
      continue;
    }
    const entry=rawEntry;
    if(entry.split('/').includes('..')||!entry){
      project.problem('binding-path-invalid',`sources[${index}].entry must be a relative archive entry`,{index,query});
      continue;
    }
    if(!/\.(?:jar|zip)$/i.test(value.archive)){
      project.problem('binding-archive-type-invalid',`sources[${index}].archive must be a .jar or .zip file`,{index,query});
      continue;
    }
    const inspected=await inspectWithin(project,value.archive,{expect:'file',missingIsNormal:true});
    bindings.push({query,archive:inspected.path||posix(value.archive),entry,targetKind:'archive-entry',state:inspected.state});
  }
  return bindings;
}

async function resolveSourceRoots(project,configured){
  const requested=configured.length?configured:['src','lib'];
  const result=[];
  for(const value of requested){
    const inspected=await inspectWithin(project,value,{expect:'directory',missingIsNormal:true});
    if(inspected.state==='observed'&&!result.includes(inspected.path))result.push(inspected.path);
  }
  return result;
}

function stripLineComment(value){
  let quote=null,escaped=false;
  for(let index=0;index<value.length;index++){
    const char=value[index];
    if(escaped){escaped=false;continue;}
    if(char==='\\'&&quote){escaped=true;continue;}
    if(quote){if(char===quote)quote=null;continue;}
    if(char==='"'||char==="'"){quote=char;continue;}
    if(char==='#'&&(index===0||/\s/.test(value[index-1])))return value.slice(0,index);
  }
  return value;
}

function stripTomlComment(value){
  let quote=null,escaped=false;
  for(let index=0;index<value.length;index++){
    const char=value[index];
    if(escaped){escaped=false;continue;}
    if(quote){
      if(char==='\\'&&quote==='"')escaped=true;
      else if(char===quote)quote=null;
      continue;
    }
    if(char==='"'||char==="'"){quote=char;continue;}
    if(char==='#')return value.slice(0,index);
  }
  return value;
}

function unquote(value){
  const trimmed=String(value||'').trim().replace(/;+\s*$/,'');
  if((trimmed.startsWith('"')&&trimmed.endsWith('"'))||(trimmed.startsWith("'")&&trimmed.endsWith("'"))){
    return trimmed.slice(1,-1);
  }
  return trimmed;
}

function expandProperties(value,properties,stack=[]){
  if(typeof value!=='string')return null;
  if(stack.length>16)return null;
  let unresolved=false;
  const expanded=value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}|\$([A-Za-z_][A-Za-z0-9_.-]*)/g,(_match,braced,plain)=>{
    const name=braced||plain;
    if(stack.includes(name)||!properties.has(name)){unresolved=true;return _match;}
    const resolved=expandProperties(properties.get(name).raw,properties,[...stack,name]);
    if(resolved===null){unresolved=true;return _match;}
    return resolved;
  });
  if(unresolved||expanded.includes('$'))return null;
  return expanded.trim();
}

function literalVersion(value){
  if(typeof value!=='string')return null;
  const trimmed=value.trim();
  if(!trimmed||trimmed.length>500||/\s|[{}$]/.test(trimmed))return null;
  return trimmed;
}

function versionSelector(value){
  return typeof value==='string'&&(/^(?:latest\.|[\[(<>=~^])/i.test(value)||/^(?:\+|[0-9][0-9A-Za-z._-]*(?:\.\+|\.\*|\.x))$/i.test(value)||/\|\|/.test(value));
}

function addVersion(list,item){
  if(!item||typeof item.name!=='string'||!item.name.trim()||item.name.trim().length>500)return;
  const normalized={...item,name:item.name.trim(),value:item.value??null,source:posix(item.source),kind:item.kind};
  if(typeof normalized.value==='string'&&normalized.value.length>500){
    normalized.rawValue=normalized.rawValue??normalized.value.slice(0,500);
    normalized.value=null;normalized.versionState='unresolved';
  }
  if(typeof normalized.rawValue==='string'&&normalized.rawValue.length>500){
    normalized.rawValue=normalized.rawValue.slice(0,500);normalized.rawValueTruncated=true;
  }
  for(const key of ['group','artifact'])if(typeof normalized[key]==='string'&&normalized[key].length>500){
    normalized[key]=normalized[key].slice(0,500);normalized[key+'Truncated']=true;
  }
  if(normalized.value===null){
    if(normalized.versionState!=='missing')normalized.versionState='unresolved';
    normalized.concrete=false;
  }
  if(normalized.value!==null&&versionSelector(normalized.value)){
    normalized.versionState='selector';normalized.concrete=false;
  }else if(normalized.value!==null){
    normalized.concrete=true;
  }
  const key=JSON.stringify([normalized.name,normalized.value,normalized.rawValue||null,normalized.source,normalized.kind,normalized.group||null,normalized.artifact||null]);
  if(list.seen.has(key))return;
  if(list.items.length>=LIMITS.declaredVersions){list.truncated=true;return;}
  list.seen.add(key);list.items.push(normalized);
}

function addDependency(list,item){
  if(!item||typeof item.name!=='string'||!item.name.trim()||item.name.trim().length>500)return;
  const normalized={...item,name:item.name.trim(),source:posix(item.source),version:item.version??null};
  if(typeof normalized.version==='string'&&normalized.version.length>500){
    normalized.rawValue=normalized.rawValue??normalized.version.slice(0,500);
    normalized.version=null;normalized.versionState='unresolved';
  }
  if(typeof normalized.rawValue==='string'&&normalized.rawValue.length>500){
    normalized.rawValue=normalized.rawValue.slice(0,500);normalized.rawValueTruncated=true;
  }
  for(const key of ['group','artifact'])if(typeof normalized[key]==='string'&&normalized[key].length>500){
    normalized[key]=normalized[key].slice(0,500);normalized[key+'Truncated']=true;
  }
  if(normalized.version===null){
    if(normalized.versionState!=='missing')normalized.versionState='unresolved';
    normalized.concrete=false;
  }
  if(normalized.version!==null&&versionSelector(normalized.version)){
    normalized.versionState='selector';normalized.concrete=false;
  }else if(normalized.version!==null){
    normalized.concrete=true;
  }
  const key=JSON.stringify([normalized.ecosystem,normalized.group||null,normalized.name,normalized.version,normalized.rawValue||null,
    normalized.declaredRange||null,normalized.scope||null,normalized.type||null,normalized.artifactExtension||null,normalized.source]);
  if(list.seen.has(key))return;
  if(list.items.length>=LIMITS.dependencies){list.truncated=true;return;}
  list.seen.add(key);list.items.push(normalized);
}

function parseGradleProperties(text,source){
  const properties=new Map();let truncated=false;
  for(const [index,line] of text.split(/\r\n|\n|\r/).entries()){
    if(properties.size>=LIMITS.gradleProperties){truncated=true;break;}
    const stripped=stripLineComment(line).trim();
    if(!stripped||stripped.startsWith('!'))continue;
    const match=/^([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/.exec(stripped);
    if(!match)continue;
    properties.set(match[1],{raw:unquote(match[2]),source,line:index+1});
  }
  return {properties,truncated};
}

function maskGradleComments(text){
  const chars=[...text];
  let quote=null,escaped=false,lineComment=false,blockComment=false;
  for(let index=0;index<chars.length;index++){
    const char=chars[index],next=chars[index+1];
    if(lineComment){if(char==='\n'||char==='\r')lineComment=false;else chars[index]=' ';continue;}
    if(blockComment){
      if(char==='*'&&next==='/'){chars[index]=chars[index+1]=' ';index++;blockComment=false;}
      else if(char!=='\n'&&char!=='\r')chars[index]=' ';
      continue;
    }
    if(escaped){escaped=false;continue;}
    if(quote){
      if(char==='\\'){escaped=true;continue;}
      if(char===quote)quote=null;
      continue;
    }
    if(char==='"'||char==="'"){quote=char;continue;}
    if(char==='/'&&next==='/'){chars[index]=chars[index+1]=' ';index++;lineComment=true;continue;}
    if(char==='/'&&next==='*'){chars[index]=chars[index+1]=' ';index++;blockComment=true;}
  }
  return chars.join('');
}

function parseGradleCatalog(text,source,properties,versions,dependencies){
  let section='';
  for(const [index,rawLine] of text.split(/\r\n|\n|\r/).entries()){
    const line=stripTomlComment(rawLine).trim();
    if(!line)continue;
    const heading=/^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if(heading){section=heading[1];continue;}
    if(section!=='versions')continue;
    const match=/^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(["'])(.*?)\2\s*$/.exec(line);
    if(!match)continue;
    const raw=match[3],value=expandProperties(raw,properties);
    properties.set(match[1],{raw,source,line:index+1,catalog:true});
    addVersion(versions,{name:match[1],value:literalVersion(value),...(value===null?{rawValue:raw,versionState:'unresolved'}:{versionState:'resolved'}),source,kind:'gradle-version-catalog',line:index+1});
  }
}

function parseGradleBuild(text,source,properties,versions,dependencies){
  const masked=maskGradleComments(text);
  const projectVersion=/^\s*version\s*=\s*(["'])(.*?)\1/m.exec(masked);
  if(projectVersion){
    const raw=projectVersion[2],value=expandProperties(raw,properties);
    addVersion(versions,{name:'project.version',value:literalVersion(value),...(value===null?{rawValue:raw,versionState:'unresolved'}:{versionState:'resolved'}),source,kind:'gradle-project-version',line:lineNumber(masked,projectVersion.index)});
  }
  for(const match of masked.matchAll(/(["'])([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([^"'\r\n]+)\1/g)){
    const group=match[2],artifact=match[3],coordinateVersion=match[4].trim(),extensionAt=coordinateVersion.lastIndexOf('@');
    const raw=(extensionAt>0?coordinateVersion.slice(0,extensionAt):coordinateVersion).trim();
    if(raw.includes(':')||!raw)continue;
    const value=expandProperties(raw,properties),resolved=literalVersion(value);
    const dependency={ecosystem:'gradle',name:artifact,group,version:resolved,versionState:resolved?'resolved':'unresolved',
      ...(resolved?{}:{rawValue:raw}),...(extensionAt>0?{artifactExtension:coordinateVersion.slice(extensionAt+1).trim()}:{}),
      source,kind:'gradle-coordinate',line:lineNumber(masked,match.index)};
    addDependency(dependencies,dependency);
    addVersion(versions,{name:`${group}:${artifact}`,value:resolved,...(resolved?{}:{rawValue:raw,versionState:'unresolved'}),group,artifact,
      source,kind:'gradle-dependency-version',line:dependency.line});
  }
}

async function loadGradle(project,versionPropertyNames,versions,dependencies){
  const files=['gradle.properties','build.gradle','build.gradle.kts','gradle/libs.versions.toml'];
  const loaded={},properties=new Map(),state={files:{},state:'missing'};
  for(const file of files){
    const value=await readText(project,file,LIMITS.gradleFileBytes);
    loaded[file]=value;
    state.files[file]=value.state;
  }
  if(loaded['gradle.properties'].state==='observed'){
    const parsed=parseGradleProperties(loaded['gradle.properties'].text,'gradle.properties');
    if(parsed.truncated)project.problem('gradle-properties-truncated',`Only the first ${LIMITS.gradleProperties} Gradle properties were parsed.`,{path:'gradle.properties'});
    for(const [name,property] of parsed.properties)properties.set(name,property);
  }
  if(loaded['gradle/libs.versions.toml'].state==='observed'){
    parseGradleCatalog(loaded['gradle/libs.versions.toml'].text,'gradle/libs.versions.toml',properties,versions,dependencies);
  }
  for(const file of ['build.gradle','build.gradle.kts']){
    if(loaded[file].state==='observed')parseGradleBuild(loaded[file].text,file,properties,versions,dependencies);
  }
  const selectedNames=versionPropertyNames.length?new Set(versionPropertyNames):new Set();
  for(const [name,property] of properties){
    if(property.catalog||(!/version/i.test(name)&&!selectedNames.has(name)))continue;
    const value=expandProperties(property.raw,properties);
    addVersion(versions,{name,value:literalVersion(value),...(value===null?{rawValue:property.raw,versionState:'unresolved'}:{versionState:'resolved'}),
      source:property.source,kind:'gradle-property',line:property.line});
  }
  if(Object.values(loaded).some(value=>value.state==='observed')){
    state.state=Object.values(loaded).some(value=>value.state==='observed')?'observed':'partial';
  }
  return state;
}

function localName(name){return String(name).split(':').at(-1);}
function xmlChild(node,name){return node?.children.find(child=>localName(child.name)===name);}
function xmlChildren(node,name){return node?.children.filter(child=>localName(child.name)===name)||[];}
function xmlText(node){
  if(!node)return '';
  return node.text+node.children.map(xmlText).join('');
}

function decodeXmlEntities(value){
  return value.replace(/&([^;]+);/g,(_match,entity)=>{
    if(entity==='amp')return '&';
    if(entity==='lt')return '<';
    if(entity==='gt')return '>';
    if(entity==='quot')return '"';
    if(entity==='apos')return "'";
    if(/^#x[0-9A-Fa-f]+$/.test(entity)){
      const code=Number.parseInt(entity.slice(2),16);
      if(code<=0x10ffff)return String.fromCodePoint(code);
    }
    if(/^#[0-9]+$/.test(entity)){
      const code=Number.parseInt(entity.slice(1),10);
      if(code<=0x10ffff)return String.fromCodePoint(code);
    }
    throw new Error('Unsupported XML entity '+entity);
  });
}

function parseBoundedXml(text){
  if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('DOCTYPE and ENTITY declarations are not supported');
  const document={name:'#document',children:[],text:''},stack=[document];
  const tokens=text.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g)||[];
  let consumed=0;
  for(const token of tokens){
    if(text.slice(consumed,text.indexOf(token,consumed)).trim())throw new Error('Malformed XML outside tags');
    consumed=text.indexOf(token,consumed)+token.length;
    if(token.startsWith('<!--')||token.startsWith('<?'))continue;
    if(token.startsWith('<![CDATA[')){
      stack.at(-1).text+=token.slice(9,-3);
      continue;
    }
    if(token.startsWith('<!'))throw new Error('Unsupported XML declaration');
    const end=/^<\s*\/\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*>$/.exec(token);
    if(end){
      const open=stack.pop();
      if(!open||open.name!==end[1])throw new Error('Mismatched XML closing tag '+end[1]);
      continue;
    }
    const start=/^<\s*([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[^<>]*?)?\s*(\/?)>$/.exec(token);
    if(start){
      const node={name:start[1],children:[],text:''};
      stack.at(-1).children.push(node);
      if(!start[2]){
        if(stack.length>=64)throw new Error('XML nesting exceeds the 64-element depth limit');
        stack.push(node);
      }
      continue;
    }
    stack.at(-1).text+=decodeXmlEntities(token);
  }
  if(consumed<text.length&&text.slice(consumed).trim())throw new Error('Malformed XML tail');
  if(stack.length!==1)throw new Error('Unclosed XML element');
  if(document.children.length!==1)throw new Error('XML must contain one root element');
  return document.children[0];
}

function mavenPropertyValue(raw,map,stack=[]){
  if(typeof raw!=='string')return null;
  if(stack.length>16)return null;
  let unresolved=false;
  const expanded=raw.replace(/\$\{([^}]+)\}/g,(_match,name)=>{
    if(stack.includes(name)||!map.has(name)){unresolved=true;return _match;}
    const resolved=mavenPropertyValue(map.get(name).raw,map,[...stack,name]);
    if(resolved===null){unresolved=true;return _match;}
    return resolved;
  });
  return unresolved?null:expanded.trim();
}

function mavenCoordinate(raw,map){
  const value=mavenPropertyValue(raw,map);
  return {value:value??raw,state:value===null?'unresolved':'resolved'};
}

function parseMavenPom(text,source,versionPropertyNames,versions,dependencies){
  const root=parseBoundedXml(text),projectNode=localName(root.name)==='project'?root:xmlChild(root,'project');
  if(!projectNode)throw new Error('No project element was found');
  const propertiesNode=xmlChild(projectNode,'properties'),propertyMap=new Map();
  if(propertiesNode){
    for(const node of propertiesNode.children){
      const name=localName(node.name),raw=xmlText(node).trim();
      if(name&&name!=='#text')propertyMap.set(name,{raw,name});
    }
  }
  const selectedNames=versionPropertyNames.length?new Set(versionPropertyNames):new Set();
  for(const [name,property] of propertyMap){
    if(!/version/i.test(name)&&!selectedNames.has(name))continue;
    const value=mavenPropertyValue(property.raw,propertyMap);
    addVersion(versions,{name,value:literalVersion(value),...(value===null?{rawValue:property.raw,versionState:'unresolved'}:{versionState:'resolved'}),
      source,kind:'maven-property'});
  }
  const groupRaw=xmlText(xmlChild(projectNode,'groupId')).trim(),artifactRaw=xmlText(xmlChild(projectNode,'artifactId')).trim();
  const groupParts=groupRaw?mavenCoordinate(groupRaw,propertyMap):null,artifactParts=artifactRaw?mavenCoordinate(artifactRaw,propertyMap):null;
  const group=groupParts?.value||null,artifact=artifactParts?.value||null;
  const projectVersionRaw=xmlText(xmlChild(projectNode,'version')).trim();
  const projectVersion=projectVersionRaw?mavenPropertyValue(projectVersionRaw,propertyMap):null;
  if(projectVersion!==null)propertyMap.set('project.version',{raw:projectVersionRaw,name:'project.version'});
  if(group!==null)propertyMap.set('project.groupId',{raw:groupRaw,name:'project.groupId'});
  if(artifact!==null)propertyMap.set('project.artifactId',{raw:artifactRaw,name:'project.artifactId'});
  if(projectVersionRaw){
    addVersion(versions,{name:[group,artifact].filter(Boolean).join(':')||'project.version',value:literalVersion(projectVersion),
      ...(projectVersion===null?{rawValue:projectVersionRaw,versionState:'unresolved'}:{versionState:'resolved'}),source,kind:'maven-project-version',
      ...(group?{group}:{}),...(artifact?{artifact}:{})});
  }
  const dependenciesNode=xmlChild(projectNode,'dependencies');
  for(const node of xmlChildren(dependenciesNode,'dependency')){
    const depGroupRaw=xmlText(xmlChild(node,'groupId')).trim(),depArtifactRaw=xmlText(xmlChild(node,'artifactId')).trim();
    const depGroupParts=depGroupRaw?mavenCoordinate(depGroupRaw,propertyMap):null,depArtifactParts=depArtifactRaw?mavenCoordinate(depArtifactRaw,propertyMap):null;
    const depGroup=depGroupParts?.value||null,depArtifact=depArtifactParts?.value||'';
    if(!depArtifact)continue;
    const raw=xmlText(xmlChild(node,'version')).trim(),value=raw?mavenPropertyValue(raw,propertyMap):null;
    const resolved=literalVersion(value);
    const scope=xmlText(xmlChild(node,'scope')).trim()||null;
    const type=xmlText(xmlChild(node,'type')).trim()||null;
    const classifier=xmlText(xmlChild(node,'classifier')).trim()||null;
    addDependency(dependencies,{ecosystem:'maven',name:depArtifact,group:depGroup,version:resolved,versionState:raw?(resolved?'resolved':'unresolved'):'missing',
      ...(depGroupParts?.state==='unresolved'?{groupRaw:depGroupRaw,groupState:'unresolved'}:{}),
      ...(depArtifactParts?.state==='unresolved'?{artifactRaw:depArtifactRaw,artifactState:'unresolved'}:{}),
      ...(raw&&!resolved?{rawValue:raw}:{}),source,kind:'maven-direct-dependency',...(scope?{scope}:{}),...(type?{type}:{}),...(classifier?{classifier}:{})});
    if(raw)addVersion(versions,{name:[depGroup,depArtifact].filter(Boolean).join(':'),value:resolved,...(resolved?{}:{rawValue:raw,versionState:'unresolved'}),
      ...(depGroup?{group:depGroup}:{}),artifact:depArtifact,source,kind:'maven-dependency-version'});
  }
  const moduleNames=[],unresolvedModules=[];const modulesNode=xmlChild(projectNode,'modules');
  for(const node of xmlChildren(modulesNode,'module')){
    const raw=xmlText(node).trim(),value=raw?mavenPropertyValue(raw,propertyMap):null,modulePath=value;
    if(raw&&value===null){unresolvedModules.push(raw);continue;}
    if(modulePath&&!moduleNames.includes(modulePath))moduleNames.push(modulePath);
  }
  return {moduleNames,unresolvedModules,group,artifact};
}

async function loadMaven(project,versionPropertyNames,versions,dependencies){
  const rootPom=await readText(project,'pom.xml',LIMITS.pomBytes);
  const state={root:'pom.xml',state:rootPom.state,files:{'pom.xml':rootPom.state},moduleCount:0,truncated:false};
  if(rootPom.state!=='observed')return state;
  let rootResult;
  try{rootResult=parseMavenPom(rootPom.text,'pom.xml',versionPropertyNames,versions,dependencies);}
  catch(error){
    project.problem('maven-pom-invalid',error.message,{path:'pom.xml'});
    state.state='invalid';return state;
  }
  for(const value of rootResult.unresolvedModules.slice(0,4)){
    project.problem('maven-module-path-unresolved','A declared Maven module path uses an unresolved property expression.',{path:'pom.xml',value:String(value).slice(0,500)});
  }
  const seen=new Set(),moduleInputs=rootResult.moduleNames.slice(0,LIMITS.mavenModules);
  state.truncated=rootResult.moduleNames.length>moduleInputs.length;
  for(const moduleName of moduleInputs){
    if(!validWorkspaceRelative(moduleName)){
      project.problem('maven-module-path-invalid','Declared Maven module must remain inside the workspace.',{path:moduleName});
      continue;
    }
    const file=moduleName.endsWith('/pom.xml')||/^pom\.xml$/i.test(moduleName)?moduleName:posix(path.join(moduleName,'pom.xml'));
    const loaded=await readText(project,file,LIMITS.pomBytes);
    if(loaded.state==='missing'){
      state.files[file]='missing';
      continue;
    }
    state.files[file]=loaded.state;
    if(loaded.state!=='observed')continue;
    const key=process.platform==='win32'?loaded.real.toLowerCase():loaded.real;
    if(seen.has(key))continue;
    seen.add(key);
    try{
      parseMavenPom(loaded.text,loaded.path,versionPropertyNames,versions,dependencies);
      state.moduleCount++;
    }catch(error){
      project.problem('maven-module-pom-invalid',error.message,{path:loaded.path});
    }
  }
  if(Object.values(state.files).some(value=>value!=='observed'))state.state='partial';
  return state;
}

function validPackageName(value){
  return typeof value==='string'&&value.length<=214&&(/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(value)||/^[a-z0-9][a-z0-9._-]*$/i.test(value));
}

function lockPackageName(key){
  if(typeof key!=='string'||!key.startsWith('node_modules/'))return null;
  const parts=key.split('/');
  const marker=parts.lastIndexOf('node_modules');
  if(marker<0||marker===parts.length-1)return null;
  if(parts[marker+1]?.startsWith('@')){
    if(parts.length<=marker+2)return null;
    return parts.slice(marker+1,marker+3).join('/');
  }
  return parts[marker+1]||null;
}

async function loadNpm(project,versions,dependencies){
  const manifest=await readText(project,'package.json',LIMITS.packageJsonBytes);
  const state={packageJson:{path:'package.json',state:manifest.state},lockfile:{path:'package-lock.json',state:'missing'},declarations:[],topLevel:[],installedPackages:[],
    declaredNames:[],declaredNamesTruncated:false,packageCount:0,truncated:false};
  if(manifest.state!=='observed')return state;
  let packageValue;
  try{packageValue=JSON.parse(manifest.text);}
  catch(error){
    project.problem('package-json-invalid',error.message,{path:'package.json'});
    state.packageJson.state='invalid';return state;
  }
  if(!packageValue||typeof packageValue!=='object'||Array.isArray(packageValue)){
    project.problem('package-json-invalid','package.json must contain an object',{path:'package.json'});
    state.packageJson.state='invalid';return state;
  }
  state.packageJson.name=typeof packageValue.name==='string'&&packageValue.name.length<=214?packageValue.name:null;
  state.packageJson.version=typeof packageValue.version==='string'&&packageValue.version.length<=500?packageValue.version:null;
  if(typeof packageValue.version==='string'&&packageValue.version.length>500)project.problem('npm-package-version-too-long','package.json version exceeds the bounded output field.',{path:'package.json'});
  if(state.packageJson.version){
    addVersion(versions,{name:state.packageJson.name||'package.version',value:state.packageJson.version,versionState:'resolved',
      source:'package.json',kind:'npm-package-version'});
  }
  const declarationSeen=new Set();
  for(const section of NPM_SECTIONS){
    const values=packageValue[section];
    if(values===undefined)continue;
    if(!values||typeof values!=='object'||Array.isArray(values)){
      project.problem('npm-dependency-section-invalid',`${section} must contain an object`,{path:'package.json'});
      continue;
    }
    for(const [name,range] of Object.entries(values)){
      if(!validPackageName(name)){
        project.problem('npm-package-name-invalid',`Ignored invalid dependency name in ${section}.`,{path:'package.json',name:safeMessage(name)});
        continue;
      }
      const declaredRange=typeof range==='string'&&range.trim()?range.slice(0,1000):null;
      if(typeof range==='string'&&range.length>1000)project.problem('npm-range-truncated',`${name} has a declared range longer than 1000 characters.`,{path:'package.json',name});
      if(declaredRange===null)project.problem('npm-range-invalid',`${name} has a non-string declared range.`,{path:'package.json',name});
      if(!state.declaredNames.includes(name)){
        if(state.declaredNames.length<LIMITS.npmDeclaredNames)state.declaredNames.push(name);
        else state.declaredNamesTruncated=true;
      }
      const key=JSON.stringify([name,section,declaredRange]);
      if(declarationSeen.has(key))continue;
      declarationSeen.add(key);
      if(state.declarations.length>=LIMITS.npmDeclarations){state.truncated=true;continue;}
      state.declarations.push({name,declaredRange,section,source:'package.json'});
    }
  }
  const lockfile=await readText(project,'package-lock.json',LIMITS.packageLockBytes);
  state.lockfile.state=lockfile.state;
  const topLevel=[];
  if(lockfile.state==='observed'){
    let lock;
    try{lock=JSON.parse(lockfile.text);}
    catch(error){
      project.problem('package-lock-invalid',error.message,{path:'package-lock.json'});
      state.lockfile.state='invalid';
    }
    if(lock&&typeof lock==='object'&&[2,3].includes(lock.lockfileVersion)&&lock.packages&&typeof lock.packages==='object'&&!Array.isArray(lock.packages)){
      state.lockfile.lockfileVersion=lock.lockfileVersion;
      for(const [location,value] of Object.entries(lock.packages)){
        if(!value||typeof value!=='object')continue;
        const name=lockPackageName(location);
        if(!name)continue;
        state.packageCount++;
        if(typeof value.version!=='string'||!value.version.trim()||value.version.length>500){
          project.problem('npm-lock-version-invalid',`${name} has an unusable lock version field.`,{path:'package-lock.json',name});
          continue;
        }
        const item={name,path:posix(location).slice(0,1024),version:value.version,source:'package-lock.json'};
        if(state.installedPackages.length<LIMITS.npmLockPackages)state.installedPackages.push(item);
        else state.truncated=true;
        if(location==='node_modules/'+name)topLevel.push(item);
      }
    }else if(state.lockfile.state==='observed'){
      if(lock&&typeof lock==='object'&&lock.lockfileVersion!==undefined&&![2,3].includes(lock.lockfileVersion)){
        project.problem('package-lock-version',`Only package-lock v2 and v3 package maps are supported; observed ${String(lock.lockfileVersion)}.`,{path:'package-lock.json'});
        state.lockfile.state='unsupported';
      }else{
        project.problem('package-lock-packages-invalid','package-lock.json does not contain a packages object.',{path:'package-lock.json'});
        state.lockfile.state='invalid';
      }
    }
  }
  const declaredNameSet=new Set(state.declaredNames),relevantTopLevel=topLevel.filter(item=>declaredNameSet.has(item.name));
  state.topLevel=relevantTopLevel.slice(0,LIMITS.npmLockPackages);
  if(relevantTopLevel.length>state.topLevel.length)state.truncated=true;
  const lockByDeclaration=new Map();
  for(const item of state.topLevel){
    const list=lockByDeclaration.get(item.name)||[];
    list.push(item);lockByDeclaration.set(item.name,list);
  }
  const grouped=new Map();
  for(const declaration of state.declarations){
    const group=grouped.get(declaration.name)||{name:declaration.name,ranges:[],sections:[],source:'package.json'};
    if(declaration.declaredRange&&!group.ranges.includes(declaration.declaredRange))group.ranges.push(declaration.declaredRange);
    if(!group.sections.includes(declaration.section))group.sections.push(declaration.section);
    grouped.set(declaration.name,group);
  }
  for(const group of grouped.values()){
    const locks=lockByDeclaration.get(group.name)||[],versionsFound=[...new Set(locks.map(item=>item.version))];
    const installedVersion=versionsFound.length===1?versionsFound[0]:null;
    state.declarations.filter(item=>item.name===group.name).forEach(item=>{
      item.installedVersion=installedVersion;
      if(installedVersion)item.installedVersionSource='package-lock.json';
      if(versionsFound.length>1)item.versionConflict='multiple-top-level-lock-versions';
    });
    addDependency(dependencies,{ecosystem:'npm',name:group.name,group:null,version:installedVersion,
      declaredRange:group.ranges.length===1?group.ranges[0]:null,declaredRanges:group.ranges,sections:group.sections,
      source:'package.json',versionState:typeof installedVersion==='string'?'lock-exact':group.ranges.length?'declared-range-only':'missing',
      ...(versionsFound.length>1?{versionConflict:'multiple-top-level-lock-versions'}:{})});
  }
  return state;
}

export async function loadSourceProject(root,exec,call){
  exec?.signal?.throwIfAborted();
  if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('An absolute workspace root is required');
  const nativeExec={...exec,root};
  const rootInfo=await nativeExec.nativeFiles.stat(root,'.',exec?.signal);
  if(!rootInfo.exists||rootInfo.type!=='directory')throw new Error('Workspace root is not a directory');
  const rootReal=nativeExec.nativeFiles.processPath(rootInfo.target),project=createProjectContext(rootReal,nativeExec);
  project.stamp('.',rootReal,rootInfo);
  const sourceMap=await loadSourceMap(project);
  exec?.signal?.throwIfAborted();
  const sourceRoots=await resolveSourceRoots(project,sourceMap.state==='observed'?sourceMap.sourceRoots:[]);
  const configuredArchivePatterns=sourceMap.state==='observed'?sourceMap.archivePatterns:[];
  const combinedArchivePatterns=[...new Set(['**/*sources*.jar',...configuredArchivePatterns])];
  const archivePatterns=combinedArchivePatterns.slice(0,LIMITS.archivePatterns);
  const versionProperties=sourceMap.state==='observed'?sourceMap.versionProperties:[];
  const bindings=sourceMap.state==='observed'?await resolveBindings(project,sourceMap.sources):[];
  const versions={items:[],seen:new Set(),truncated:false},dependencies={items:[],seen:new Set(),truncated:false};
  exec?.signal?.throwIfAborted();
  const gradle=await loadGradle(project,versionProperties,versions,dependencies);
  exec?.signal?.throwIfAborted();
  const maven=await loadMaven(project,versionProperties,versions,dependencies);
  exec?.signal?.throwIfAborted();
  const npm=await loadNpm(project,versions,dependencies);
  const activeSystems=[gradle.state==='observed'||gradle.state==='partial'?'gradle':null,maven.state==='observed'||maven.state==='partial'?'maven':null,
    npm.packageJson.state==='observed'?'npm':null].filter(Boolean);
  const hasProjectEvidence=activeSystems.length||sourceRoots.length||bindings.length||sourceMap.state==='observed';
  return {
    schema:'work-evidence.source-project.v1',
    state:project.problems.length?'partial':hasProjectEvidence?'observed':'unavailable',
    sourceRoots,
    archivePatterns,
    archivePatternsTruncated:combinedArchivePatterns.length>archivePatterns.length,
    bindings,
    declaredVersions:versions.items,
    dependencies:dependencies.items,
    metadataStamp:{generatedAt:new Date().toISOString(),...project.stampObject()},
    problems:project.problems,
    problemsTruncated:project.problemsTruncated,
    declaredVersionsTruncated:versions.truncated,
    dependenciesTruncated:dependencies.truncated,
    sourceMap:{state:sourceMap.state,path:SOURCE_MAP_PATH,schema:sourceMap.state==='observed'?(sourceMap.schema||null):null,
      configuredSourceRoots:sourceMap.state==='observed'?sourceMap.sourceRoots:[],versionProperties},
    buildSystems:{gradle,maven,npm},
    limits:{...LIMITS,sourceArchivePatterns:archivePatterns.slice(0,LIMITS.archivePatterns)},
    limitations:[
      'Gradle parsing covers root gradle.properties, scalar [versions] entries, and quoted group:artifact:version strings. Property references are substituted only from known properties; arbitrary Groovy/Kotlin, platform/BOM logic and version-catalog library aliases are not evaluated.',
      'Maven reads the root pom and at most 16 directly declared module poms. Parent inheritance, profiles, BOM resolution, dependency management and transitive graphs are not evaluated; DOCTYPE and ENTITY declarations are rejected.',
      'Npm reads direct dependency declarations plus package-lock v2/v3 package maps. Declared ranges remain separate from exact lock versions, and package source entries are limited to explicit exports, types, module and main fields.',
      'No home, user cache, external repository or whole-directory scan is used.',
    ],
  };
}
