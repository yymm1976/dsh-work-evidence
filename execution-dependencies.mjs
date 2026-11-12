import path from 'node:path';

const SCHEMA='work-evidence.declared-files.v1';
const SCOPE='caller-declared-files-only';
const key=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const versioned=value=>value?.exists===true&&value.type==='file'&&typeof value.version==='string'&&value.version.length>0&&value.version.length<=1024;

export function declaredFileSources(sources=[]){
  if(!Array.isArray(sources)||sources.length>16||sources.some(source=>typeof source!=='string'||!source.trim()||source.length>2000))
    throw new Error('sources must be at most 16 explicit source paths or URLs');
  return sources.slice();
}

/** File applicability has a narrower meaning than process success or task correctness. */
export function dependencyExecutionComplete(result){
  const raw=result?.value??result,value=raw?.data??raw;
  const statuses=[value?.status,value?.state,value?.job?.status].filter(status=>status!=null).map(status=>String(status).toLowerCase());
  const completed=statuses.includes('completed');
  return !result?.isError&&!result?.error&&!raw?.isError&&!value?.isError&&!raw?.error&&!value?.error&&value?.success!==false&&value?.ok!==false&&
    (value?.exitCode===0||value?.exit_code===0||completed)&&
    (value?.exitCode==null||value.exitCode===0)&&(value?.exit_code==null||value.exit_code===0)&&
    !['background','promoted'].includes(value?.kind??value?.job?.kind)&&
    statuses.every(status=>!['background','promoted','running','pending','queued','stopping','partial','unknown','unavailable','deopt','disabled','failed','error','killed','cancelled','rejected'].includes(status))&&
    value?.timedOut!==true&&value?.aborted!==true&&value?.cancelled!==true&&value?.signal==null&&value?.stopped===undefined&&
    value?.complete!==false&&value?.completed!==false&&value?.executionCompleted!==false&&value?.partial!==true&&value?.outputPartial!==true&&
    value?.truncated!==true&&value?.lossy!==true&&value?.stdout?.truncated!==true&&value?.stderr?.truncated!==true&&
    value?.stdout?.complete!==false&&value?.stderr?.complete!==false;
}

function compare(before,after){
  if(!versioned(before)||typeof after?.exists!=='boolean')return null;
  if(!after.exists||after.type!=='file')return false;
  return versioned(after)?before.version===after.version:null;
}

export function dependencyView(record){
  const assessment=record?.evidenceAssessment;
  return {evidenceValidity:assessment?.validity??'unknown',evidenceAssessment:assessment??{
    validity:'unknown',scope:SCOPE,assessedAt:null,reason:'no-declared-file-observation',declaredCount:0,files:[]}};
}

export function createExecutionDependencies(nativeFiles){
  async function sample(root,source,signal,cache=new Map()){
    signal?.throwIfAborted();
    if(/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)&&!(/^[A-Za-z]:[\\/]/u.test(source)))
      return {reason:'non-file-source'};
    const id=JSON.stringify([key(root),source]);
    if(!cache.has(id))cache.set(id,(async()=>{
      try{
        if(!nativeFiles)throw Object.assign(new Error('Native filesystem unavailable'),{code:'NATIVE_FS_UNAVAILABLE'});
        const info=await nativeFiles.stat(root,source,signal);
        return {path:info.path,exists:info.exists,type:info.type,version:typeof info.version==='string'&&info.version.length<=1024?info.version:null};
      }catch(error){
        signal?.throwIfAborted();
        if(['ENOENT','FS_NOT_FOUND'].includes(error.code))return {exists:false,type:null,version:null};
        return {reason:'file-metadata-unavailable',code:String(error.code??'FS_UNAVAILABLE').slice(0,96)};
      }
    })());
    return cache.get(id);
  }

  async function capture(root,sources,signal){
    const declared=declaredFileSources(sources),cache=new Map();
    const files=await Promise.all(declared.map(async source=>({source,before:await sample(root,source,signal,cache)})));
    return {schema:SCHEMA,scope:SCOPE,workspace:path.resolve(root),startedAt:new Date().toISOString(),declaredCount:declared.length,files};
  }

  function validRecord(root,record){
    const data=record?.fileDependencies;
    return data?.schema===SCHEMA&&typeof data.workspace==='string'&&key(data.workspace)===key(root)&&
      Array.isArray(data.files)&&data.files.length<=16&&data.declaredCount===data.files.length&&
      data.files.every(file=>typeof file?.source==='string'&&file.source.trim()&&file.source.length<=2000)&&data;
  }

  function assess(data,executionCompleted,current,assessedAt,previous){
    const files=(data?.files??[]).map((file,index)=>{
      const during=compare(file.before,file.after),now=current?.[index];
      const later=now?compare(file.after,now):null;
      const prior=previous?.files?.find(item=>item.source===file.source);
      if(prior?.status?.startsWith('changed-'))return {...prior};
      const state=during===false?'changed-during-execution':later===false?'changed-since-execution':
        during===true&&later===true?'unchanged':'unknown';
      const reason=state==='unknown'?(file.before?.reason??file.after?.reason??now?.reason??
        (!versioned(file.before)||!versioned(file.after)?'recorded-file-metadata-incomplete':'current-file-metadata-incomplete')):undefined;
      return {source:file.source,path:file.after?.path??file.before?.path??null,status:state,...(reason?{reason}:{}),
        ...(now?.code?{code:now.code}:{})};
    });
    const changed=files.some(file=>file.status.startsWith('changed-'));
    const validity=!executionCompleted||!files.length?'unknown':changed?'affected':files.every(file=>file.status==='unchanged')?'current-for-declared-files':'unknown';
    return {evidenceValidity:validity,evidenceAssessment:{validity,scope:SCOPE,assessedAt,
      reason:!data?'no-declared-file-observation':!executionCompleted?'execution-incomplete':!files.length?'no-declared-files':
        changed?'declared-file-changed':validity==='unknown'?'file-observation-incomplete':'declared-file-metadata-unchanged',
      declaredCount:files.length,files}};
  }

  async function finish(before,executionCompleted,signal){
    const cache=new Map(),files=await Promise.all(before.files.map(async file=>({...file,after:await sample(before.workspace,file.source,signal,cache)})));
    const finishedAt=new Date().toISOString(),fileDependencies={...before,finishedAt,executionCompleted,files};
    return {fileDependencies,...assess(fileDependencies,executionCompleted,files.map(file=>file.after),finishedAt)};
  }

  async function refresh(root,records,signal,cache=new Map()){
    await Promise.all(records.map(async record=>{
      const data=validRecord(root,record),completed=data?.executionCompleted===true&&record.executionCompleted===true&&record.partial!==true;
      const current=data&&completed?await Promise.all(data.files.map(file=>sample(root,file.source,signal,cache))):null;
      Object.assign(record,assess(data||null,completed,current,new Date().toISOString(),record.evidenceAssessment));
    }));
  }

  function invalidate(root,records,mutation){
    for(const record of records){
      const data=validRecord(root,record);
      if(!data||record.seq>=mutation.seq)continue;
      const assessment=record.evidenceAssessment;
      if(!assessment)continue;
      const files=assessment.files.map(file=>{
        const captured=data.files.find(item=>item.source===file.source);
        if(!file.path||key(file.path)!==key(path.resolve(root,mutation.path))||!versioned(captured?.before)||!versioned(captured?.after)||file.status.startsWith('changed-'))return file;
        const {reason,code,...previous}=file;
        return {...previous,status:mutation.effectState==='applied'?'changed-by-file-tool':'unknown',mutationSeq:mutation.seq,
          ...(mutation.effectState==='applied'?{}:{reason:'file-effect-unresolved'})};
      });
      if(files.every((file,index)=>file===assessment.files[index]))continue;
      const complete=data.executionCompleted===true&&record.executionCompleted===true&&record.partial!==true;
      const validity=complete&&files.some(file=>file.status.startsWith('changed-'))?'affected':'unknown';
      Object.assign(record,{evidenceValidity:validity,evidenceAssessment:{...assessment,validity,files,
        reason:validity==='affected'?'declared-file-changed':complete?'file-effect-unresolved':'execution-incomplete'}});
    }
  }

  return {capture,finish,refresh,invalidate};
}
