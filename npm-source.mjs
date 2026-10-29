import path from 'node:path';
import {within,finalizeEvidenceWindow} from './evidence.mjs';
import {loadSourceProject} from './source-project.mjs';

const LIMITS=Object.freeze({
  packageJsonBytes:512_000,
  sourceBytes:2_000_000,
  lineChars:500,
  memberChars:500,
  limit:160,
  members:8,
  memberMatches:4,
  memberLines:64,
  candidates:32,
  problems:16,
  exportNodes:64,
});
const SUPPORTED_SOURCE=/\.(?:d\.ts|js|ts|mjs|cjs)$/i;
const posix=value=>String(value).replaceAll('\\','/');
const relativePath=(root,file)=>posix(path.relative(root,file))||'.';
const safeMessage=error=>String(error?.message||error||'Unknown error').slice(0,500);

async function readBoundedUtf8(file,maxBytes,exec){
  const source=await exec.nativeFiles.readBytes(exec.root,file,exec.signal,maxBytes);
  const text=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes);
  if(text.includes('\0'))throw new Error('Source contains NUL bytes.');
  return {text,bytes:source.bytesLength};
}

function createContext(root,exec){
  const problems=[];
  return {
    root,
    problems,exec,
    problem(kind,message,extra={}){
      if(problems.length>=LIMITS.problems)return;
      problems.push({kind,message:safeMessage(message),...extra});
    },
  };
}

async function inspectTarget(context,requested,{expect='file',base=context.root}={}){
  let lexical;
  try{lexical=within(context.root,requested);}
  catch(error){context.problem('path-outside-workspace',error.message,{path:safeMessage(requested)});return {state:'invalid'};}
  let stat;
  try{stat=await context.exec.nativeFiles.stat(context.root,lexical,context.exec.signal);}
  catch(error){
    context.problem('stat-failed',error.message,{path:relativePath(context.root,lexical)});
    return {state:'unavailable',path:relativePath(context.root,lexical)};
  }
  if(!stat.exists)return {state:'missing',path:relativePath(context.root,lexical)};
  const real=context.exec.nativeFiles.processPath(stat.target);
  const packageBoundary=context.exec.nativeFiles.processPath((await context.exec.nativeFiles.stat(context.root,base,context.exec.signal)).target);
  const relative=path.relative(packageBoundary,real);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)){
    context.problem('symlink-outside-package','Resolved path escapes the package.',{path:relativePath(context.root,lexical)});
    return {state:'invalid',path:relativePath(context.root,lexical)};
  }
  const actual=stat.type;
  if(actual!==expect){
    context.problem('path-type-mismatch',`Expected ${expect}, observed ${actual}.`,{path:relativePath(context.root,real)});
    return {state:'invalid',path:relativePath(context.root,real),actual};
  }
  return {state:'observed',path:relativePath(context.root,real),lexical,real,stat};
}

function splitQuery(value){
  if(typeof value!=='string'||!value.trim()||value.length>500||value.includes('\0')||value.includes('\\'))return null;
  const trimmed=value.trim(),scoped=trimmed.startsWith('@');
  const parts=trimmed.split('/'),minimum=scoped?2:1;
  const name=scoped?parts.slice(0,2).join('/'):parts[0];
  const subpath=parts.slice(scoped?2:1).join('/');
  if((!scoped&&parts.length>1&&!subpath)||(scoped&&parts.length===3&&!parts[2]))return null;
  if(!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(name)&&!/^[a-z0-9][a-z0-9._-]*$/i.test(name))return null;
  if(subpath&&subpath.split('/').some(segment=>!segment||segment==='.'||segment==='..'))return null;
  if(parts.length<minimum)return null;
  return {name,subpath,query:trimmed};
}

function declarationsFor(project,name){
  const values=Array.isArray(project?.npm?.declarations)
    ?project.npm.declarations
    :Array.isArray(project?.dependencies)?project.dependencies.filter(item=>item?.ecosystem==='npm').map(item=>({
      name:item.name,declaredRange:item.declaredRange??item.declaredRanges?.[0]??null,section:item.sections?.join(',')||'dependency',
      installedVersion:item.version??null,
    })):[];
  const declared=values.filter(item=>item?.name===name);
  if(declared.length)return declared;
  if(Array.isArray(project?.npm?.declaredNames)&&project.npm.declaredNames.includes(name)){
    return [{name,declaredRange:null,section:'declaration-list-truncated',installedVersion:null}];
  }
  return [];
}

function lockEvidence(project,name){
  const topLevel=Array.isArray(project?.npm?.topLevel)?project.npm.topLevel:[];
  const exact=topLevel.filter(item=>item?.name===name&&item?.path==='node_modules/'+name);
  let versions=[...new Set(exact.map(item=>item.version).filter(value=>typeof value==='string'&&value.trim()))];
  if(!versions.length){
    const declarations=declarationsFor(project,name);
    versions=[...new Set(declarations.map(item=>item.installedVersion).filter(value=>typeof value==='string'&&value.trim()))];
  }
  const lockfileState=project?.npm?.lockfile?.state;
  return {
    state:versions.length===1?'exact':versions.length>1?'conflict':['missing','invalid','unsupported','unavailable'].includes(lockfileState)?lockfileState:'unresolved',
    version:versions.length===1?versions[0]:null,
    versions,
    source:versions.length?'package-lock.json':null,
    packages:exact,
  };
}

function matchExportKey(exportsValue,subpath){
  if(!exportsValue||typeof exportsValue!=='object'||Array.isArray(exportsValue))return {state:'conditions',value:exportsValue};
  const keys=Object.keys(exportsValue);
  const hasSubpaths=keys.some(key=>key.startsWith('.'));
  const hasConditions=keys.some(key=>!key.startsWith('.'));
  if(hasSubpaths&&hasConditions)return {state:'invalid',reason:'exports mixes subpath and condition keys'};
  if(!hasSubpaths)return subpath?{state:'missing'}:{state:'conditions',value:exportsValue};
  const requested=subpath?`./${subpath}`:'.';
  if(Object.hasOwn(exportsValue,requested))return {state:'matched',value:exportsValue[requested]};
  const patternMatches=keys.filter(key=>key.includes('*')&&key.startsWith('./')).map(key=>({
    key,
    regex:new RegExp('^'+key.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('(.+)')+'$'),
  })).filter(item=>item.regex.test(requested));
  if(patternMatches.length===1){
    const wildcard=patternMatches[0].regex.exec(requested).slice(1);
    return {state:'matched',value:exportsValue[patternMatches[0].key],wildcard};
  }
  return patternMatches.length>1?{state:'ambiguous'}:{state:'missing'};
}

function branchTargets(value,condition=null,state={nodes:0,unknownConditions:false,candidates:[]}){
  if(state.nodes++>=LIMITS.exportNodes){state.unknownConditions=true;return state;}
  if(typeof value==='string'){
    state.candidates.push({target:value,kind:'exports',condition});
    return state;
  }
  if(Array.isArray(value)){
    for(const item of value)branchTargets(item,condition,state);
    return state;
  }
  if(value&&typeof value==='object'){
    const allowed=new Set(['default','import','require','types']);
    for(const [key,target] of Object.entries(value)){
      if(!allowed.has(key)){state.unknownConditions=true;continue;}
      branchTargets(target,key,state);
    }
  }else if(value!==null&&value!==undefined){
    state.unknownConditions=true;
  }
  return state;
}

function collectRawCandidates(manifest,packageInfo){
  const raw=[],subpath=packageInfo.subpath;
  if(Object.hasOwn(manifest,'exports')){
    const matched=matchExportKey(manifest.exports,subpath);
    if(manifest.exports===null)raw.push({uncertain:true,source:'exports',reason:'exports is explicitly null'});
    if(matched.state==='conditions'){
      const branch=branchTargets(matched.value);
      if(branch.unknownConditions)raw.push({uncertain:true,source:'exports',reason:'unsupported or excessive export conditions'});
      raw.push(...branch.candidates.map(item=>({...item,source:'exports',wildcard:null})));
    }else if(matched.state==='matched'){
      const branch=branchTargets(matched.value);
      if(branch.unknownConditions)raw.push({uncertain:true,source:'exports',reason:'unsupported or excessive export conditions'});
      raw.push(...branch.candidates.map(item=>({...item,source:'exports',wildcard:matched.wildcard})));
    }else if(matched.state==='ambiguous')raw.push({uncertain:true,source:'exports',reason:'multiple export patterns match'});
    else if(matched.state==='invalid')raw.push({uncertain:true,source:'exports',reason:matched.reason});
  }
  if(!subpath){
    for(const [field,kind] of [['types','types'],['typings','types'],['module','module'],['main','main']]){
      if(typeof manifest[field]==='string'&&manifest[field].trim())raw.push({target:manifest[field],kind:field==='typings'?'types':kind,condition:null,source:field,wildcard:null});
      else if(Object.hasOwn(manifest,field)&&manifest[field]!==null)raw.push({uncertain:true,source:field,reason:`${field} is not a string`});
    }
  }
  return raw;
}

function targetPath(packageDir,target,wildcard){
  if(typeof target!=='string'||!target.trim()||target.includes('\0')||target.length>1024)return null;
  let value=target.trim();
  if(wildcard?.length&&value.includes('*')){
    if(wildcard.length===1)value=value.replaceAll('*',wildcard[0]);
    else for(const part of wildcard)value=value.replace('*',part);
  }
  if(value.includes('*'))return null;
  value=value.replaceAll('\\','/');
  if(value.startsWith('/')||/^[A-Za-z]:\//.test(value)||value.split('/').includes('..'))return null;
  value=value.replace(/^\.\/+/,'');
  return path.resolve(packageDir,value);
}

async function resolveCandidates(context,rootReal,packageDir,raw){
  const grouped=new Map();
  let uncertain=false,uncertainReason=null;
  for(const item of raw){
    if(item.uncertain){uncertain=true;uncertainReason=uncertainReason||item.reason;continue;}
    const full=targetPath(packageDir,item.target,item.wildcard);
    if(!full){uncertain=true;uncertainReason=uncertainReason||'an export target is not package-relative';continue;}
    const normalized=path.resolve(full),relative=path.relative(packageDir,normalized);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)){
      uncertain=true;uncertainReason=uncertainReason||'an export target escapes the package directory';continue;
    }
    const file=relativePath(rootReal,normalized);
    if(file.length>2000){
      uncertain=true;uncertainReason=uncertainReason||'a declared entry path exceeds the output bound';continue;
    }
    const existing=grouped.get(file)||{path:file,declarations:[]};
    existing.declarations.push({kind:item.kind,condition:item.condition||null,source:item.source});
    grouped.set(file,existing);
  }
  const candidates=[...grouped.values()].slice(0,LIMITS.candidates);
  if(grouped.size>candidates.length)uncertain=true;
  for(const candidate of candidates){
    if(!SUPPORTED_SOURCE.test(candidate.path)){
      candidate.state='unsupported-extension';
      uncertain=true;uncertainReason=uncertainReason||'a declared entry does not use a supported source extension';
    }
  }
  return {candidates,uncertain,uncertainReason};
}

function lineSplit(text){
  if(!text)return [];
  const values=text.split(/\r\n|\n|\r/);
  if(/[\r\n]$/.test(text)&&values.at(-1)==='')values.pop();
  return values;
}

async function loadSourceText(file,maxBytes,exec){
  const source=await readBoundedUtf8(file,maxBytes,exec);
  const text=source.text.charCodeAt(0)===0xfeff?source.text.slice(1):source.text;
  return {text,bytes:source.bytes,lines:lineSplit(text)};
}

function memberRecord(lines,name,lineTextLimit=LIMITS.memberChars){
  const matches=[];
  for(let index=0;index<lines.length&&matches.length<LIMITS.memberMatches;index++){
    if(lines[index].includes(name))matches.push(index+1);
  }
  if(!matches.length)return {member:name,memberState:'not-found-in-bounded-text',matches:[]};
  const selected=new Set();
  for(const line of matches){
    const start=Math.max(1,line-6),end=Math.min(lines.length,line+6);
    for(let current=start;current<=end&&selected.size<LIMITS.memberLines;current++)selected.add(current);
  }
  const output=[...selected].sort((a,b)=>a-b).slice(0,LIMITS.memberLines).map(number=>{
    const text=lines[number-1];
    return {line:number,text:String(text).slice(0,lineTextLimit),...(String(text).length>lineTextLimit?{lineTextTruncated:true}:{})};
  });
  return {
    member:name,
    memberState:'observed',
    matches:[{kind:'text-reference',complete:false,lines:output}],
    observedRange:output.length?{first:output[0].line,last:output.at(-1).line}:null,
    matchedLineCount:matches.length,
    truncated:output.length>=LIMITS.memberLines||matches.length>=LIMITS.memberMatches,
    note:'Literal text-reference windows only; these are not syntax-complete declarations.',
  };
}

function normalizedMemberArgs(args){
  if(args.member!==undefined&&args.members!==undefined)throw new Error('Use either member or members, not both');
  const values=args.members!==undefined?args.members:args.member!==undefined?[args.member]:[];
  if(args.members!==undefined&&(!Array.isArray(args.members)||args.members.length<1||args.members.length>LIMITS.members))throw new Error('members must contain 1-8 entries');
  if(values.some(value=>typeof value!=='string'||!value.trim()||value.length>300))throw new Error('member names must contain 1-300 characters');
  return {values:[...new Set(values.map(value=>value.trim()))],single:args.member!==undefined};
}

export async function npmSource(root,args,project,exec,call){
  exec?.signal?.throwIfAborted();
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('npmSource arguments must be an object');
  const allowed=new Set(['query','member','members','offset','limit','scope','entryKind','lineTextLimit']);
  if(Object.keys(args).some(key=>!allowed.has(key)))throw new Error('Unknown npm source field');
  const packageInfo=splitQuery(args.query);
  if(!packageInfo)return null;
  if(!project)project=await loadSourceProject(root,exec,call);
  const declarations=declarationsFor(project,packageInfo.name);
  if(!declarations.length){
    if(project?.npm?.declaredNamesTruncated)return {
      state:'unknown',kind:'npm',query:packageInfo.query,package:packageInfo.name,subpath:packageInfo.subpath||null,
      selectionState:'unknown',selected:null,candidates:[],source:null,
      problem:{code:'NPM_DECLARATION_LIST_TRUNCATED'},
      note:'The bounded dependency inventory was truncated, so this query cannot be classified as undeclared. No package path was accessed.',
    };
    return null;
  }
  const offset=args.offset??1,limit=args.limit??80;
  const lineTextLimit=args.lineTextLimit??LIMITS.lineChars;
  if(!Number.isInteger(lineTextLimit)||lineTextLimit<1||lineTextLimit>12000)throw new Error('lineTextLimit must be an integer from 1 to 12000');
  if(!Number.isInteger(offset)||offset<1)throw new Error('offset must be a positive integer');
  if(!Number.isInteger(limit)||limit<1||limit>LIMITS.limit)throw new Error(`limit must be an integer from 1 to ${LIMITS.limit}`);
  const memberArgs=normalizedMemberArgs(args);
  if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('An absolute workspace root is required');
  const nativeExec={...exec,root};
  const rootInfo=await nativeExec.nativeFiles.stat(root,'.',exec?.signal);
  if(!rootInfo.exists||rootInfo.type!=='directory')throw new Error('Workspace root is not a directory');
  const rootReal=nativeExec.nativeFiles.processPath(rootInfo.target),context=createContext(rootReal,nativeExec);
  const ranges=[...new Set(declarations.map(item=>item.declaredRange).filter(value=>typeof value==='string'&&value.trim()))];
  const lock=lockEvidence(project,packageInfo.name);
  const packageJson=await inspectTarget(context,path.join(rootReal,'node_modules',...packageInfo.name.split('/'),'package.json'),{expect:'file'});
  if(packageJson.state!=='observed'){
    return {
      state:'unavailable',kind:'npm',query:packageInfo.query,package:packageInfo.name,subpath:packageInfo.subpath||null,
      selectionState:'unavailable',selected:null,candidates:[],source:null,
      versions:{declaredRanges:ranges,installedVersion:lock.version,lockVersion:lock.version,lockVersions:lock.versions,lockState:lock.state,packageVersion:null},
      problem:{code:'PACKAGE_JSON_'+packageJson.state.toUpperCase(),path:packageJson.path||null},
      problems:context.problems,
      note:'The explicitly declared package was not resolved to a readable package.json inside this workspace node_modules tree.',
    };
  }
  const packageDir=path.dirname(packageJson.real);
  let manifest,manifestState='observed';
  try{
    const source=await loadSourceText(packageJson.lexical,LIMITS.packageJsonBytes,context.exec);
    manifest=JSON.parse(source.text);
    if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw new Error('package.json must contain an object');
  }catch(error){
    context.problem('package-json-invalid',error.message,{path:packageJson.path});
    manifest=null;manifestState='invalid';
  }
  const packageVersion=typeof manifest?.version==='string'&&manifest.version.trim()&&manifest.version.length<=500?manifest.version:null;
  if(typeof manifest?.version==='string'&&manifest.version.length>500)context.problem('package-version-too-long','package.json version exceeds the bounded output field.',{path:packageJson.path});
  const conflict=lock.state==='conflict'?'multiple-lock-versions':
    ranges.length>1?'multiple-declared-ranges':
    lock.version&&packageVersion&&lock.version!==packageVersion?'package-version-lock-version-mismatch':null;
  if(manifestState!=='observed'){
    return {
      state:'unavailable',kind:'npm',query:packageInfo.query,package:packageInfo.name,subpath:packageInfo.subpath||null,
      selectionState:'unavailable',selected:null,candidates:[],source:null,
      versions:{declaredRanges:ranges,installedVersion:lock.version,lockVersion:lock.version,lockVersions:lock.versions,lockState:lock.state,packageVersion:null},
      problems:context.problems,
      problem:{code:'PACKAGE_JSON_INVALID',path:packageJson.path},
      note:'The package manifest was observed outside the workspace gate or could not be parsed as a JSON object.',
    };
  }
  let raw=collectRawCandidates(manifest,packageInfo);
  if(args.entryKind!==undefined){
    if(!['types','runtime'].includes(args.entryKind))throw new Error('entryKind must be types or runtime');
    raw=raw.filter(item=>item.uncertain||(args.entryKind==='types'?(item.kind==='types'||item.condition==='types'):item.kind!=='types'&&item.condition!=='types'));
  }
  const resolved=await resolveCandidates(context,rootReal,packageDir,raw);
  const candidates=resolved.candidates;
  const versionEvidence={declaredRanges:ranges,installedVersion:lock.version,lockVersion:lock.version,lockVersions:lock.versions,packageVersion,
    lockState:lock.state,source:lock.source,distinctFields:true};
  if(conflict){
    return {
      state:'unavailable',kind:'npm',query:packageInfo.query,package:packageInfo.name,subpath:packageInfo.subpath||null,
      selectionState:'ambiguous',selected:null,candidates,source:null,versions:versionEvidence,conflict,
      problems:context.problems,
      note:'Conflicting declared, package-manifest, or lock versions were kept visible; no version or source entry was selected.',
    };
  }
  if(candidates.length!==1||resolved.uncertain||candidates.some(item=>item.state==='unsupported-extension')){
    return {
      state:'observed',kind:'npm',query:packageInfo.query,package:packageInfo.name,subpath:packageInfo.subpath||null,
      selectionState:candidates.length||resolved.uncertain?'ambiguous':'not-found',selected:null,candidates,source:null,versions:versionEvidence,
      ...(resolved.uncertainReason?{reason:resolved.uncertainReason}:{}),
      problems:context.problems,
      note:'Only explicit exports, types, module, and main declarations are considered. Use entryKind types/runtime or read an exact candidate path when appropriate. Unknown conditions remain unselected.',
    };
  }
  const selected=candidates[0];
  const localized=path.resolve(rootReal,...selected.path.split('/'));
  const inspected=await inspectTarget(context,localized,{expect:'file',base:packageDir});
  if(inspected.state!=='observed'){
    selected.state=inspected.state==='missing'?'missing':'unreadable';
    return {
      state:'unavailable',kind:'npm',query:packageInfo.query,package:packageInfo.name,subpath:packageInfo.subpath||null,
      selectionState:'unavailable',selected:null,candidates,source:null,versions:versionEvidence,
      problems:context.problems,problem:{code:'ENTRY_'+inspected.state.toUpperCase(),path:selected.path},
      note:'The declared source entry does not resolve to a regular UTF-8 source file inside this package and workspace.',
    };
  }
  let loaded;
  try{loaded=await loadSourceText(inspected.lexical,LIMITS.sourceBytes,context.exec);}
  catch(error){
    context.problem('source-read-failed',error.message,{path:selected.path});
    return {
      state:'unavailable',kind:'npm',query:packageInfo.query,package:packageInfo.name,subpath:packageInfo.subpath||null,
      selectionState:'unavailable',selected:null,candidates,source:null,versions:versionEvidence,
      problems:context.problems,problem:{code:'SOURCE_READ_FAILED',path:selected.path},
      note:'The selected entry was not a bounded valid UTF-8 source file.',
    };
  }
  const currentPath=relativePath(rootReal,inspected.real);
  if(memberArgs.values.length){
    const records=memberArgs.values.map(name=>memberRecord(loaded.lines,name,lineTextLimit));
    const lineTextTruncated=records.some(record=>record.matches.some(match=>match.lines.some(line=>line.lineTextTruncated)));
    const source=memberArgs.single?{
      state:'observed',path:currentPath,totalLines:loaded.lines.length,...records[0],
      rangeComplete:false,lineTextTruncated,contentLimitation:'literal-text-reference-window-not-syntax-complete',
      retrieveCurrent:{tool:'project_evidence',arguments:{mode:'source',query:args.query,member:records[0].member}},
    }:{
      state:'observed',path:currentPath,totalLines:loaded.lines.length,members:records,
      rangeComplete:false,lineTextTruncated,contentLimitation:'literal-text-reference-windows-not-syntax-complete',
      retrieveCurrent:{tool:'project_evidence',arguments:{mode:'source',query:args.query,members:memberArgs.values}},
    };
    return {
      state:'observed',kind:'npm',query:packageInfo.query,package:packageInfo.name,subpath:packageInfo.subpath||null,
      member:args.member??null,members:args.members??null,
      selectionState:'selected',selected,candidates,versions:versionEvidence,source,problems:context.problems,
      note:'Member results are bounded literal text windows in the selected workspace package entry; they are not complete syntax trees or declaration guarantees.',
    };
  }
  const totalLines=loaded.lines.length;
  const selectedLines=loaded.lines.slice(offset-1,offset-1+limit).map((text,index)=>({
    line:offset+index,
    text:String(text).slice(0,lineTextLimit),
    ...(String(text).length>lineTextLimit?{lineTextTruncated:true}:{}),
  }));
  const source=finalizeEvidenceWindow({
    state:'observed',path:currentPath,lines:selectedLines,totalLines,
    lineTextTruncated:selectedLines.some(line=>line.lineTextTruncated),
    requestedRange:{offset,limit},
    retrieveCurrent:{tool:'project_evidence',arguments:{mode:'source',query:args.query,offset,limit,lineTextLimit}},
  },'read');
  return {
    state:'observed',kind:'npm',query:packageInfo.query,package:packageInfo.name,subpath:packageInfo.subpath||null,
    member:null,members:null,
    selectionState:'selected',selected,candidates,versions:versionEvidence,source,
    problems:context.problems,
    note:'The selected source is a declared package entry inside this workspace node_modules tree. Package code was not imported or executed.',
  };
}
