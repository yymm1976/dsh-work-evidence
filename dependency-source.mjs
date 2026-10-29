import path from 'node:path';
import {within,finalizeEvidenceWindow,literal} from './evidence.mjs';
import {archiveSource,archiveMemberSource} from './archive-source.mjs';
import {listArchiveEntries} from './archive-store.mjs';
import {loadSourceProject} from './source-project.mjs';
import {npmSource} from './npm-source.mjs';
import {mavenArchiveBinding} from './maven-source.mjs';
import {checkedLineTextLimit,workspaceMemberSource} from './source-members.mjs';

const relative=(root,file)=>path.relative(root,file).replaceAll('\\','/')||'.';
const sourceOffset=args=>args.offset??1;
const sourceLimit=args=>args.limit??80;
const extensions=['java','kt','js','ts','tsx','mjs','cjs','py','go','rs'];
async function globPaths(root,patterns,exec,call){
  const paths=new Set();let complete=true;
  for(const pattern of patterns){
    const result=await call('glob',{path:root,pattern},exec),data=result.value;
    if(result.isError)return {state:'unavailable',paths:[...paths],complete:false,code:result.error?.info?.code||'GLOB_FAILED'};
    if(!Array.isArray(data?.paths))return {state:'unknown',paths:[...paths],complete:false,code:'UNRECOGNIZED_GLOB_RESULT'};
    for(const file of data.paths)if(typeof file==='string')paths.add(file);
    complete&&=data.truncated!==true;
  }
  return {state:complete?'observed':'partial',paths:[...paths],complete};
}
async function workspaceSource(root,args,project,exec,call){
  const className=String(args.query).split(/[.$]/).at(-1),roots=args.scope?[args.scope]:project.sourceRoots;
  const candidates=[];let complete=true;
  for(const scope of roots){
    const glob=await globPaths(within(root,scope),['**/'+className+'.{'+extensions.join(',')+'}'],exec,call);
    complete&&=glob.complete;
    for(const item of glob.paths){
      const file=within(root,item);if(path.basename(file,path.extname(file))!==className)continue;
      try{const stat=await exec.nativeFiles.stat(root,file,exec.signal);if(!stat.exists||stat.type!=='file')continue;}catch{continue;}
      if(!candidates.includes(file))candidates.push(file);
      if(candidates.length>=16)return {state:'partial',candidates,complete:false};
    }
  }
  return {state:complete?'observed':'partial',candidates,complete};
}
async function workspaceRead(root,file,args,exec,call,memberOptions={}){
  if(args.member||args.members)return workspaceMemberSource(file,args,exec,call,memberOptions);
  const offset=sourceOffset(args),limit=sourceLimit(args),lineTextLimit=checkedLineTextLimit(args.lineTextLimit);
  const result=await call('read',{file_path:file,offset,limit},exec);
  if(result.isError)return {state:'unavailable',path:file,code:result.error?.info?.code||result.error?.code||'READ_FAILED'};
  if(!Array.isArray(result.value?.lines))return {state:'unknown',path:file,code:'UNRECOGNIZED_READ_RESULT'};
  let nativeTruncated=false;
  const lines=result.value.lines.map(line=>{
    const text=String(line.text);
    const truncated=text.length>lineTextLimit||line.lineTextTruncated===true||line.truncated===true
      ||/\.\.\. \(line truncated to \d+ chars\)$/.test(text);
    nativeTruncated||=line.lineTextTruncated===true||line.truncated===true||/\.\.\. \(line truncated to \d+ chars\)$/.test(text);
    return {line:line.number,text:text.slice(0,lineTextLimit),...(truncated?{lineTextTruncated:true}:{})};
  });
  const source={state:'observed',path:file,lines,totalLines:result.value.totalLines,
    lineTextTruncated:lines.some(line=>line.lineTextTruncated),lineTextLimit,requestedRange:{offset,limit},
    ...(nativeTruncated||result.value.truncatedByBytes===true?{budgetTruncated:true}:{}),
    retrieveCurrent:{tool:'project_evidence',arguments:{mode:'source',query:args.query,offset,limit,lineTextLimit}}};
  return finalizeEvidenceWindow(source,'read');
}

async function archiveRead(root,args,selected,exec,call,memberOptions={}){
  return args.member||args.members
    ?archiveMemberSource(root,{archive:selected.archive,entry:selected.entry,query:args.query,member:args.member,members:args.members,
      offset:args.offset,limit:args.limit,lineTextLimit:args.lineTextLimit},exec,memberOptions)
    :archiveSource(root,{archive:selected.archive,entry:selected.entry,offset:sourceOffset(args),limit:sourceLimit(args),lineTextLimit:args.lineTextLimit},exec,call);
}
const concreteVersion=value=>typeof value==='string'&&/^[0-9][A-Za-z0-9.+_-]*$/.test(value);
const containsToken=(text,value)=>new RegExp('(^|[^A-Za-z0-9])'+literal(value)+'([^A-Za-z0-9]|$)','i').test(text);
export async function dependencySource(root,args,exec,call,memberOptions={}){
  const parsingOptions={...(exec.evidenceConfig||{}),...memberOptions};
  const project=await loadSourceProject(root,exec,call);
  const mavenBinding=parsingOptions.mavenSourceBinding!==false&&project.buildSystems.maven.state!=='missing';
  const mavenComplete=!mavenBinding||(project.buildSystems.maven.state==='observed'&&!project.buildSystems.maven.truncated
    &&!project.dependenciesTruncated&&!project.problemsTruncated&&!(project.problems||[]).some(problem=>problem.kind.startsWith('maven-')));
  const base={query:args.query,member:args.member||null,members:args.members||null,declaredVersions:project.declaredVersions.slice(0,24),
    declaredVersionsTruncated:project.declaredVersions.length>24,projectProblems:(project.problems||[]).slice(0,6)};
  if(!['observed','missing'].includes(project.sourceMap.state)||project.problems?.some(problem=>String(problem.kind).startsWith('binding-')))return {...base,state:'unavailable',kind:'project-configuration',selectionState:'unavailable',selected:null,candidates:[],source:null,
    missingFacts:['Correct the project source map or unreadable build metadata before selecting a dependency source.']};
  const bindings=project.bindings.filter(binding=>binding.query===args.query);
  if(bindings.length){
    if(bindings.length!==1)return {...base,state:'observed',kind:'project-mapping',selectionState:'ambiguous',selected:null,candidates:bindings,source:null};
    const binding=bindings[0];
    if(binding.state!=='observed')return {...base,state:'unavailable',kind:'project-mapping',selectionState:'unavailable',selected:null,candidates:bindings,source:null,
      missingFacts:['The explicit source binding is missing, unreadable, or outside the workspace; no fallback source was chosen.']};
    const bindingStat=await exec.nativeFiles.stat(root,binding.file||binding.archive,exec.signal);
    if(!bindingStat.exists||bindingStat.type!=='file')throw new Error('The explicit source binding is not a regular file');
    const source=binding.file?await workspaceRead(root,within(root,binding.file),args,exec,call,parsingOptions):await archiveRead(root,args,binding,exec,call,parsingOptions);
    return {...base,state:source.state,kind:'project-mapping',selectionState:source.state==='observed'?'selected':'unavailable',selected:binding,candidates:[],source,
      note:'Explicit project source-map binding; it declares intended source, not an independently resolved build graph.'};
  }
  const npmArgs=Object.fromEntries(Object.entries(args).filter(([key])=>['query','member','members','offset','limit','lineTextLimit','scope','entryKind'].includes(key)));
  const npm=await npmSource(root,npmArgs,{...project,npm:project.buildSystems.npm},exec,call);if(npm)return {...base,...npm};
  const className=String(args.query).trim().split(/[.$]/).at(-1);
  if(!/^[A-Za-z_$][\w$]*$/.test(className||''))return {...base,state:'unavailable',kind:'source',selectionState:'unavailable',selected:null,candidates:[],source:null,
    missingFacts:['Use a class/symbol name, a declared npm package, a project source-map query, or mode read for an exact path.']};
  const workspace=await workspaceSource(root,args,project,exec,call);
  if(workspace.candidates.length){
    const qualified=String(args.query).includes('.')?String(args.query).replaceAll('.','/'):null;
    const qualifiedMatches=qualified?workspace.candidates.filter(file=>relative(root,file).slice(0,-path.extname(file).length).endsWith(qualified)):[];
    const selected=workspace.complete?(qualifiedMatches.length===1?qualifiedMatches[0]:workspace.candidates.length===1?workspace.candidates[0]:null):null;
    const source=selected?await workspaceRead(root,selected,args,exec,call,parsingOptions):null;
    return {...base,state:source?.state||workspace.state,kind:'workspace',selectionState:selected?'selected':'ambiguous',selected:selected?relative(root,selected):null,
      candidates:workspace.candidates.map(file=>({path:relative(root,file),kind:'workspace'})),source,
      note:'Workspace filename selection, not proof of a declaration or complete caller coverage.'};
  }
  if(!workspace.complete)return {...base,state:'partial',kind:'workspace',selectionState:'incomplete-discovery',selected:null,candidates:[],source:null,
    missingFacts:['Workspace source discovery was incomplete; no dependency source was chosen over unexamined workspace candidates.']};
  const glob=await globPaths(root,project.archivePatterns,exec,call),files=[];
  for(const raw of glob.paths){try{const file=within(root,raw);const stat=await exec.nativeFiles.stat(root,file,exec.signal);if(stat.exists&&stat.type==='file'&&!files.includes(file))files.push(file);}catch{}}
  const candidates=[],failures=[];
  for(const file of files.slice(0,12)){
    const listing=await listArchiveEntries(root,file,exec,{mavenMetadata:mavenBinding});
    if(listing.state!=='observed'){failures.push({archive:relative(root,file),code:listing.code||'ARCHIVE_INDEX_UNAVAILABLE'});continue;}
    if(listing.manifestError){failures.push({archive:relative(root,file),code:listing.manifestError.code||'ARCHIVE_MANIFEST_UNAVAILABLE'});continue;}
    const suffix=className+'.java';
    const entries=listing.entries.map(entry=>typeof entry==='string'?entry:entry.name).filter(entry=>typeof entry==='string'&&(entry===suffix||entry.endsWith('/'+suffix)));
    const qualified=String(args.query).includes('.')?String(args.query).replaceAll('.','/')+'.java':null;
    const matches=qualified?entries.filter(entry=>entry===qualified||entry.endsWith('/'+qualified)):entries;
    if(!matches.length)continue;
    const archive=relative(root,file),manifest=listing.manifestText||'';
    const manifestVersion=listing.manifestVersion||/^Implementation-Version:\s*(.+)$/im.exec(manifest)?.[1]?.trim()||null;
    if(mavenBinding){
      const binding=mavenArchiveBinding(archive,manifestVersion,listing.mavenMetadata,project.dependencies||[]);
      candidates.push({archive,entries:matches.slice(0,16),manifestVersion,declaredVersionMatches:[],artifactMatches:binding.matches.slice(0,8),
        strength:binding.strength,selectionEvidence:binding.evidence,mavenBinding:{state:binding.state,
          ...(binding.coordinates?{coordinates:binding.coordinates}:{}),...(binding.descriptor?{descriptor:binding.descriptor}:{}),
          ...(binding.path?{path:binding.path}:{})},mavenMetadata:listing.mavenMetadata});
      continue;
    }
    const versionMatches=(project.declaredVersions||[]).filter(item=>concreteVersion(item.value)&&(manifestVersion?manifestVersion===item.value:containsToken(archive,item.value)));
    const artifactMatches=(project.dependencies||[]).filter(item=>{
      const artifact=item.artifact||item.name?.split(':').at(-1);
      return artifact&&concreteVersion(item.version)&&containsToken(archive,artifact)&&(manifestVersion?manifestVersion===item.version:containsToken(archive,item.version));
    });
    candidates.push({archive,entries:matches.slice(0,16),manifestVersion,declaredVersionMatches:versionMatches.slice(0,8),artifactMatches:artifactMatches.slice(0,8),
      strength:artifactMatches.length?2:versionMatches.length?1:0,
      selectionEvidence:artifactMatches.length?'declared artifact and concrete version match':versionMatches.length?'concrete current declaration matches archive metadata/path':'no current declared-version binding'});
  }
  const complete=glob.complete&&files.length<=12&&!failures.length&&mavenComplete,strength=Math.max(0,...candidates.map(candidate=>candidate.strength));
  const eligible=candidates.filter(candidate=>(mavenBinding?candidate.strength>0:candidate.strength===strength&&strength>0)&&candidate.entries.length===1);
  const selected=complete&&eligible.length===1?eligible[0]:null;
  const locator=selected?{archive:selected.archive,entry:selected.entries[0],manifestVersion:selected.manifestVersion,declaredVersionMatches:selected.declaredVersionMatches,
    ...(selected.mavenBinding?{mavenBinding:selected.mavenBinding,artifactMatches:selected.artifactMatches}:{} )}:null;
  const source=locator?await archiveRead(root,args,locator,exec,call,parsingOptions):null;
  return {...base,state:source?.state||(!complete?'partial':'observed'),kind:'dependency-archive',archivesExamined:Math.min(12,files.length),
    selectionState:source?.state==='observed'?'selected':!complete?'incomplete-discovery':candidates.length?'ambiguous-or-unbound':'not-found',selected:locator,
    candidates:candidates.slice(0,8),source,failures,missingFacts:source?[]:[!complete?'Archive discovery was incomplete.':'A unique current-version source or explicit project source-map binding is required.'],
    note:'Metadata/path association is bounded evidence, not full Gradle/Maven dependency resolution. Unbound unique filenames are not automatically selected.'};
}
