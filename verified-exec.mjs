import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {within,assertExistingFileWithin,readUtf8File} from './evidence.mjs';
import {createNativeCas} from './native-cas.mjs';
import {reportedExecutionChecks} from './recovery.mjs';
import {dependencyExecutionComplete} from './execution-dependencies.mjs';
import {createNativeFiles} from './native-files.mjs';

export const VERSION='0.8.3';

const HEX_REVISION=/^[a-f0-9]{64}$/;
const MAX_EDIT_TEXT=250000;
const MAX_TOTAL_EDIT_TEXT=1000000;
const MAX_SOURCE_BYTES=2_000_000;

function hash(value){return createHash('sha256').update(value).digest('hex');}
function textOf(result){return (result?.content||[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');}
function wrapped(value){return value&&typeof value==='object'&&value.data&&typeof value.data==='object'?value.data:value;}
function outcomeStatus(value){
  const outer=value?.status;
  const inner=value?.data?.status;
  return inner||outer||null;
}
function outcomeError(value){
  return value?.data?.error||value?.error||null;
}
function boundedOutput(value,max=8000){
  const text=typeof value==='string'?value:JSON.stringify(value??null);
  return text.length<=max?text:text.slice(0,max)+'…';
}

function validatePlan(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Plan must be an object');
  const known=new Set(['summary','apply','edits','validations']);
  if(Object.keys(input).some(key=>!known.has(key)))throw new Error('Unknown verified_exec field');
  if(typeof input.summary!=='string'||!input.summary.trim()||input.summary.length>2000)throw new Error('summary must contain 1 to 2000 characters');
  if(input.apply!==undefined&&typeof input.apply!=='boolean')throw new Error('apply must be boolean');
  if(!Array.isArray(input.edits)||input.edits.length<1||input.edits.length>50)throw new Error('edits must contain 1 to 50 operations');
  if(input.validations!==undefined&&(!Array.isArray(input.validations)||input.validations.length>10))throw new Error('validations must be an array of at most ten explicitly requested commands');
  let total=0;
  const edits=input.edits.map((edit,index)=>{
    if(!edit||typeof edit!=='object'||Array.isArray(edit))throw new Error('Edit '+index+' must be an object');
    if(typeof edit.file!=='string'||!edit.file.trim())throw new Error('Edit '+index+' requires file');
    if(!['replace_exact','create'].includes(edit.mode))throw new Error('Edit '+index+' mode must be replace_exact or create');
    if(edit.mode==='replace_exact'){
      if(typeof edit.old_text!=='string'||!edit.old_text||edit.old_text.length>MAX_EDIT_TEXT)throw new Error('Edit '+index+' requires bounded old_text');
      if(typeof edit.new_text!=='string'||edit.new_text.length>MAX_EDIT_TEXT||edit.new_text===edit.old_text)throw new Error('Edit '+index+' requires changed bounded new_text');
      total+=edit.old_text.length+edit.new_text.length;
    }else{
      if(typeof edit.content!=='string'||edit.content.length>MAX_EDIT_TEXT)throw new Error('Create edit '+index+' requires bounded content');
      total+=edit.content.length;
    }
    return {...edit};
  });
  if(total>MAX_TOTAL_EDIT_TEXT)throw new Error('Plan exceeds the total edit-text budget');
  const validations=(input.validations??[]).map((validation,index)=>{
    if(!validation||typeof validation!=='object'||Array.isArray(validation))throw new Error('Validation '+index+' must be an object');
    if(typeof validation.command!=='string'||!validation.command.trim()||validation.command.length>12000)throw new Error('Validation '+index+' requires a bounded command');
    if(typeof validation.description!=='string'||!validation.description.trim()||validation.description.length>300)throw new Error('Validation '+index+' requires a description');
    const timeoutMs=validation.timeout_ms??120000;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw new Error('Validation '+index+' timeout_ms must be from 1000 to 600000');
    if(validation.tool!==undefined&&!['ops_bash','bash','pwsh'].includes(validation.tool))throw new Error('Validation '+index+' tool must be ops_bash, bash or pwsh');
    return {command:validation.command,description:validation.description,timeoutMs,tool:validation.tool||null};
  });
  return {summary:input.summary,apply:input.apply===true,edits,validations};
}

function countExact(text,needle){
  const positions=[];let offset=0;
  while((offset=text.indexOf(needle,offset))>=0){positions.push(offset);offset++;if(positions.length>1)break;}
  return positions;
}

function canonicalTargetName(name){
  return name.normalize('NFC').toLowerCase().normalize('NFC');
}

function caseAlternateName(name){
  return name.replace(/[a-zA-Z]/u,char=>char===char.toLowerCase()?char.toUpperCase():char.toLowerCase());
}

function normalizationAlternateName(name){
  const nfc=name.normalize('NFC'),nfd=name.normalize('NFD');
  return nfc!==name?nfc:nfd!==name?nfd:name;
}

async function directorySensitivity(directory){
  try{
    const entries=await fs.opendir(directory,{bufferSize:16}),names=[];
    let complete=true;
    for await(const entry of entries){
      if(names.length===32){complete=false;break;}
      names.push(entry.name);
    }
    async function probe(alternateName){
      for(const name of names){
        const alternate=alternateName(name);
        if(alternate===name)continue;
        // Two exact directory entries prove distinct names even if they are hard links.
        if(names.includes(alternate))return true;
        const source=path.join(directory,name),other=path.join(directory,alternate);
        let before;
        try{before=await fs.lstat(source,{bigint:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
        try{
          const aliased=await fs.lstat(other,{bigint:true});
          const current=await fs.lstat(source,{bigint:true});
          if(before.dev!==current.dev||before.ino!==current.ino)continue;
          if(before.ino!==0n&&aliased.ino!==0n&&(before.dev!==aliased.dev||before.ino!==aliased.ino))return true;
          if(complete)return false;
        }catch(error){
          if(error.code!=='ENOENT')throw error;
          const current=await fs.lstat(source,{bigint:true});
          if(before.dev===current.dev&&before.ino===current.ino)return true;
        }
      }
      return null;
    }
    return {caseSensitive:await probe(caseAlternateName),normalizationSensitive:await probe(normalizationAlternateName)};
  }catch{}
  return {caseSensitive:null,normalizationSensitive:null};
}

function sameMissingTarget(left,right,caseSensitive,normalizationSensitive){
  if(left.length!==right.length)return false;
  for(let index=0;index<left.length;index++){
    let leftName=left[index],rightName=right[index];
    if(!normalizationSensitive){
      leftName=leftName.normalize('NFC');rightName=rightName.normalize('NFC');
    }
    if(!caseSensitive){
      leftName=leftName.toLowerCase();rightName=rightName.toLowerCase();
    }
    if(!normalizationSensitive){
      leftName=leftName.normalize('NFC');rightName=rightName.normalize('NFC');
    }
    if(leftName!==rightName)return false;
  }
  return true;
}

function missingTargetRelation(left,right,sensitivity){
  if(left.length!==right.length)return false;
  if(left.every((name,index)=>name===right[index]))return true;
  const caseModes=sensitivity.caseSensitive==null?[false,true]:[sensitivity.caseSensitive];
  const normalizationModes=sensitivity.normalizationSensitive==null?[false,true]:[sensitivity.normalizationSensitive];
  const aliases=[];
  for(const caseSensitive of caseModes)for(const normalizationSensitive of normalizationModes)
    aliases.push(sameMissingTarget(left,right,caseSensitive,normalizationSensitive));
  return aliases.every(Boolean)?true:aliases.every(value=>!value)?false:null;
}

async function groupEdits(edits,root){
  const groups=new Map(),candidateTargets=new Map(),sensitivity=new Map(),realRoot=await fs.realpath(root);
  for(const edit of edits){
    const full=within(root,edit.file),file=path.relative(root,full).replaceAll('\\','/');
    let parent=full,identity,groupKey;
    const missing=[];
    for(;;){
      try{parent=await fs.realpath(parent);identity=path.join(parent,...missing);break;}
      catch(error){
        if(error.code!=='ENOENT'||path.dirname(parent)===parent)throw error;
        missing.unshift(path.basename(parent));parent=path.dirname(parent);
      }
    }
    within(realRoot,identity);
    if(missing.length){
      const info=await fs.stat(parent,{bigint:true});
      const directoryKey=info.ino!==0n?`${info.dev}:${info.ino}`:parent;
      identity=directoryKey+':'+JSON.stringify(missing);
      groupKey=identity;
      const candidateKey=directoryKey+':'+JSON.stringify(missing.map(canonicalTargetName));
      const candidates=candidateTargets.get(candidateKey)??[];
      for(const candidate of candidates){
        let relation;
        if(candidate.missing.length===missing.length&&candidate.missing.every((name,index)=>name===missing[index]))relation=true;
        else{
          if(!sensitivity.has(directoryKey))sensitivity.set(directoryKey,await directorySensitivity(parent));
          relation=missingTargetRelation(candidate.missing,missing,sensitivity.get(directoryKey));
          if(relation===null)throw new Error('Cannot establish whether case- or normalization-different missing targets are distinct in '+parent);
        }
        if(relation){
          if(groupKey===identity)groupKey=candidate.groupKey;
          else if(groupKey!==candidate.groupKey)throw new Error('Missing targets resolve to conflicting directory aliases');
        }
      }
      candidates.push({missing,groupKey});candidateTargets.set(candidateKey,candidates);
    }else groupKey=identity;
    const group=groups.get(groupKey)||{file,full,mode:edit.mode,edits:[],content:null};
    if(group.mode!==edit.mode)throw new Error(`Conflicting create/replace modes for ${file}`);
    if(edit.mode==='create'){
      if(group.content!==null)throw new Error(`More than one create operation for ${file}`);
      group.content=edit.content;
    }else group.edits.push({oldText:edit.old_text,newText:edit.new_text});
    groups.set(groupKey,group);
  }
  return [...groups.values()];
}

async function readFullText(root,full,expectedRevision){
  try{
    const verifiedPath=await assertExistingFileWithin(root,full),source=await readUtf8File(verifiedPath.real,{maxBytes:MAX_SOURCE_BYTES});
    if(source.text.length>MAX_EDIT_TEXT*2)return {ok:false,error:{message:'Source exceeds verified_exec read budget'}};
    if(HEX_REVISION.test(String(expectedRevision||''))&&source.sha256!==expectedRevision){
      return {ok:false,error:{message:'File changed while its source was being read'}};
    }
    return {ok:true,text:source.text,sha256:source.sha256,totalLines:source.text.split(/\r\n|\r|\n/).length};
  }catch(error){
    return {ok:false,error:{message:error.message}};
  }
}

async function statFile(call,runtime,agent,file,signal){
  const result=await call('ops_stat',{path:file},runtime.execFor(agent,signal));
  const value=result.value,status=outcomeStatus(value),data=wrapped(value);
  if(result.isError||status==='error'||status==='rejected'||!data||typeof data.exists!=='boolean'){
    return {ok:false,error:outcomeError(value)||result.error||{message:textOf(result)||'ops_stat returned no usable observation'}};
  }
  return {ok:true,exists:data.exists,revision:data.revision,bytes:data.bytes,lineCount:data.lineCount};
}

async function applyEditGroup(call,runtime,agent,group,revision,signal){
  if(group.mode==='create'){
    const result=await call('ops_write_file',{path:group.file,content:group.content,expectedRevision:'absent'},runtime.execFor(agent,signal));
    return normalizeEffect(result);
  }
  const result=await call('ops_edit_file',{path:group.file,expectedRevision:revision,edits:group.edits},runtime.execFor(agent,signal));
  return normalizeEffect(result);
}

function normalizeEffect(result){
  const value=result.value,status=outcomeStatus(value),data=wrapped(value),error=outcomeError(value)||result.error;
  const completed=!result.isError&&status==='completed'&&!error;
  return {ok:completed,status:status||(result.isError?'error':'unknown'),
    effectState:completed?'applied':data?.effectState||value?.effectState||error?.effectState||'unknown',
    revision:data?.revision||null,bytes:data?.bytes??null,lineCount:data?.lineCount??null,
    changed:data?.changed??null,error:completed?null:error||{message:textOf(result)||'OPS write returned an ambiguous result'}};
}

function failedEffect(error){
  const observed=error?.effectState||error?.info?.effectState;
  return {ok:false,status:'error',effectState:['none','applied','partial','unknown'].includes(observed)?observed:'unknown',
    revision:null,changed:null,error:{message:String(error?.message||error).slice(0,1200)}};
}

function shellTool(ctx,agent){return (process.platform==='win32'?['pwsh','ops_bash','bash']:['ops_bash','bash','pwsh']).find(name=>{try{return Boolean(ctx.tools.get(name,agent));}catch{return false;}})||null;}

function shellPayload(value){
  const data=wrapped(value);
  return data&&typeof data==='object'?data:{};
}

async function runValidation(ctx,call,runtime,agent,validation,signal){
  const requested=validation.tool;
  if(requested&&(()=>{try{return !ctx.tools.get(requested,agent);}catch{return true;}})())return {passed:false,deopt:'requested-shell-unavailable',tool:requested,description:validation.description};
  const tool=requested||shellTool(ctx,agent);
  if(!tool)return {passed:false,deopt:'no-authorized-shell',tool:null,description:validation.description};
  const result=await call(tool,{command:validation.command,description:validation.description,timeoutMs:validation.timeoutMs},runtime.execFor(agent,signal));
  const outerPayload=result.value,hasInner=outerPayload&&typeof outerPayload==='object'&&outerPayload.data!=null;
  const payload=shellPayload(outerPayload),exitCode=Number.isInteger(payload.exitCode)?payload.exitCode:Number.isInteger(payload.exit_code)?payload.exit_code:null;
  const outerStatus=outerPayload?.status??null,innerStatus=hasInner?outerPayload.data?.status??null:null;
  const status=outerStatus??innerStatus??(result.isError?'error':'completed');
  const statusOk=[outerStatus,innerStatus].every(value=>value==null||String(value).toLowerCase()==='completed');
  let outerWithoutInner=outerPayload;
  if(outerPayload&&typeof outerPayload==='object'){
    const {data,...outerFields}=outerPayload;outerWithoutInner=outerFields;
  }
  const outerCompletion=hasInner?{...outerWithoutInner,exitCode:outerWithoutInner?.exitCode??exitCode}:outerWithoutInner;
  const executionComplete=dependencyExecutionComplete({...result,value:outerCompletion})&&
    (!hasInner||dependencyExecutionComplete({value:outerPayload.data}));
  const conclusive=exitCode!==null||result.isError;
  const reportedChecks=reportedExecutionChecks(result);
  const passed=statusOk&&exitCode===0&&executionComplete&&!reportedChecks;
  const stdout=typeof payload.stdout==='string'?payload.stdout:payload.stdout?.text;
  const stderr=typeof payload.stderr==='string'?payload.stderr:payload.stderr?.text;
  return {passed,tool,description:validation.description,status:status||(result.isError?'error':'completed'),exitCode,
    ...(reportedChecks?{reportedChecks}:{}),
    ...(!passed&&!conclusive?{deopt:'ambiguous-shell-result'}:{}),
    timedOut:payload.timedOut===true,stdout:boundedOutput(stdout??payload.stdoutText??textOf(result)),
    stderr:boundedOutput(stderr??payload.stderrText??''),
    error:passed?null:payload.error||outerPayload?.error||result.error||null};
}

export function createVerifiedExec(ctx,runtime,call){
  let native;
  let registeredNativeWrite=ctx.tools.get('write')??null;
  let registeredNativeExecute=registeredNativeWrite?.execute;
  // Headless compositions can activate this plugin before the file tools.
  // Capture the first registered write, then keep rejecting later replacements.
  ctx.on('tools/change',()=>{
    if(registeredNativeWrite)return;
    const write=ctx.tools.get('write');
    if(write){registeredNativeWrite=write;registeredNativeExecute=write.execute;}
  });
  async function execute(agent,input,signal){
    const s=await runtime.init(agent,signal),id='verified-'+randomUUID();
    const reportPath=path.join(s.dir,s.id+'.'+id+'.json');
    let plan;
    try{
      plan=validatePlan(input);
    }catch(error){
      const record={version:1,id,sessionId:s.id,createdAt:new Date().toISOString(),summary:typeof input?.summary==='string'?input.summary.slice(0,2000):'',
        applyRequested:input?.apply===true,status:'deopt',reason:'invalid-plan',error:error.message,effectState:'none',
        files:[],validations:[],validationResults:[],atomicity:'per-file; cross-file writes are not transactional'};
      s.metrics.verifiedExecDeopts++;s.dirty=true;
      try{await runtime.save(agent,reportPath,record,signal);}catch{}
      return {status:'deopt',reason:record.reason,error:error.message,reportPath,effectState:'none'};
    }
    const record={version:1,id,sessionId:s.id,createdAt:new Date().toISOString(),summary:plan.summary,applyRequested:plan.apply,
      status:'preflight',effectState:'none',files:[],validations:[],validationResults:[],atomicity:'per-file; cross-file writes are not transactional'};
    const useNative=s.config.nativeVerifiedEdits===true;
    if(useNative&&registeredNativeWrite)native??=createNativeCas(ctx,runtime,registeredNativeWrite,registeredNativeExecute);
    record.backend=useNative?'dsh-native-cas':'ops-cas';
    record.versionKind=useNative?'native-opaque':'sha256';
    const observe=file=>useNative?native.stat(agent,file,signal):statFile(call,runtime,agent,file,signal);
    async function save(){await runtime.save(agent,reportPath,record,signal);}
    function fileEffects(){return record.files.map(file=>({file:file.file,mode:file.mode,
      status:file.effect?.status||'not-attempted',effectState:file.effect?.effectState||'none',
      beforeRevision:file.beforeRevision,afterRevision:file.afterRevision||file.effect?.revision||null,
      versionKind:record.versionKind,contentHash:file.effect?.contentHash??(record.versionKind==='sha256'?file.effect?.revision??null:null),
      expectedAfterHash:file.expectedAfterHash,
      changed:file.effect?.changed??null,...(file.effect?.error?{error:file.effect.error}:{})}));}
    function effectState(){
      const effects=record.files.filter(file=>file.effect).map(file=>file.effect);
      if(effects.some(effect=>!['none','applied','partial'].includes(effect.effectState)))return 'unknown';
      return effects.some(effect=>effect.ok||['applied','partial'].includes(effect.effectState))?'applied':'none';
    }
    async function saveOutcome(){
      try{
        // File effects must remain inspectable after the caller cancels. This
        // detached write is restricted by runtime.save to plugin-owned storage.
        if(signal.aborted)await runtime.save(agent,reportPath,record,AbortSignal.timeout(5000),{background:true});
        else await save();
        return {reportSaved:true};
      }
      catch(error){
        if(signal.aborted)try{
          await runtime.save(agent,reportPath,record,AbortSignal.timeout(5000),{background:true});return {reportSaved:true};
        }catch(retry){error=retry;}
        // The native write can commit before cancellation or a policy change
        // rejects its response. Observe exact bytes without issuing another write.
        try{
          const expected=Buffer.from(JSON.stringify(record,null,2)+'\n');
          if(expected.length<=2_000_000){
            const observed=await createNativeFiles(ctx).readBytes(s.root,reportPath,AbortSignal.timeout(5000),expected.length,{requireKnownSize:true});
            if(observed.versioned&&typeof observed.version==='string'&&observed.version&&observed.bytes.equals(expected))
              return {reportSaved:true,reportObservedAfterWriteError:true,reportWriteError:String(error?.message||error).slice(0,1200)};
          }
        }catch{}
        return {reportSaved:false,reportError:String(error?.message||error).slice(0,1200)};
      }
    }
    let groups;
    try{groups=await groupEdits(plan.edits,s.root);}catch(error){
      record.status='deopt';record.reason='invalid-plan';record.error=error.message;s.metrics.verifiedExecDeopts++;await save();
      return {status:'deopt',reason:record.reason,error:error.message,reportPath,effectState:'none'};
    }
    const required=useNative?[]:['ops_stat'];
    if(!useNative&&plan.apply&&groups.some(group=>group.mode==='create'))required.push('ops_write_file');
    if(!useNative&&plan.apply&&groups.some(group=>group.mode==='replace_exact'))required.push('ops_edit_file');
    const missing=required.filter(name=>{try{return !ctx.tools.get(name,agent);}catch{return true;}});
    if(useNative&&(!native||!await native.available(agent)))missing.push('rc2-native-conditional-write');
    if(missing.length){
      record.status='deopt';record.reason='cas-file-tools-unavailable';record.missing=missing;s.metrics.verifiedExecDeopts++;await save();
      return {status:'deopt',reason:record.reason,missing,reportPath,effectState:'none'};
    }
    if(plan.apply){
      const fallback=shellTool(ctx,agent);
      const unavailable=new Set();
      for(const validation of plan.validations){
        const tool=validation.tool||fallback;
        if(!tool){unavailable.add('no-authorized-shell');continue;}
        try{if(!ctx.tools.get(tool,agent))unavailable.add(tool);}catch{unavailable.add(tool);}
      }
      if(unavailable.size){
        const missing=[...unavailable];
        record.status='deopt';record.reason='validation-shell-unavailable';record.missing=missing;
        s.metrics.verifiedExecDeopts++;await save();
        return {status:'deopt',reason:record.reason,missing,reportPath,effectState:'none'};
      }
    }
    for(const group of groups){
      signal.throwIfAborted();
      const observation=await observe(group.file);
      if(!observation.ok){
        record.status='deopt';record.reason='file-observation-unavailable';record.error=observation.error;
        s.metrics.verifiedExecDeopts++;await save();return {status:'deopt',reason:record.reason,file:group.file,error:observation.error,reportPath,effectState:'none'};
      }
      if(group.mode==='create'){
        if(observation.exists){
          record.status='deopt';record.reason='create-target-exists';record.file=group.file;s.metrics.verifiedExecDeopts++;await save();
          return {status:'deopt',reason:record.reason,file:group.file,reportPath,effectState:'none'};
        }
        record.files.push({file:group.file,mode:'create',beforeRevision:'absent',bytesBefore:0,bytesAfter:Buffer.byteLength(group.content),
          expectedAfterHash:hash(group.content),hunks:0});
        group.expectedText=group.content;
        continue;
      }
      if(!observation.exists||(useNative?observation.type!=='file'||typeof observation.revision!=='string'||!observation.revision:!HEX_REVISION.test(String(observation.revision||'')))){
        record.status='deopt';record.reason='existing-file-revision-unavailable';record.file=group.file;
        s.metrics.verifiedExecDeopts++;await save();return {status:'deopt',reason:record.reason,file:group.file,reportPath,effectState:'none'};
      }
      const source=useNative?await native.read(agent,group.file,observation.revision,signal):await readFullText(s.root,group.full,observation.revision);
      if(!source.ok){
        record.status='deopt';record.reason='source-read-unavailable';record.error=source.error;record.file=group.file;
        s.metrics.verifiedExecDeopts++;await save();return {status:'deopt',reason:record.reason,file:group.file,error:source.error,reportPath,effectState:'none'};
      }
      const ranges=[];
      for(const edit of group.edits){
        const preserveCrlf=useNative&&source.text.includes('\r\n')&&!/(?<!\r)\n/u.test(source.text);
        const oldText=preserveCrlf?edit.oldText.replaceAll('\r\n','\n').replaceAll('\n','\r\n'):edit.oldText;
        const newText=preserveCrlf?edit.newText.replaceAll('\r\n','\n').replaceAll('\n','\r\n'):edit.newText;
        const found=countExact(source.text,oldText);
        if(found.length!==1){
          record.status='deopt';record.reason=found.length?'edit-target-not-unique':'edit-target-not-found';record.file=group.file;
          s.metrics.verifiedExecDeopts++;await save();return {status:'deopt',reason:record.reason,file:group.file,reportPath,effectState:'none'};
        }
        ranges.push({start:found[0],end:found[0]+oldText.length,newText});
      }
      ranges.sort((a,b)=>a.start-b.start);
      for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end){
        record.status='deopt';record.reason='overlapping-edits';record.file=group.file;s.metrics.verifiedExecDeopts++;await save();
        return {status:'deopt',reason:record.reason,file:group.file,reportPath,effectState:'none'};
      }
      let expectedText=source.text;
      for(const edit of ranges.toReversed())expectedText=expectedText.slice(0,edit.start)+edit.newText+expectedText.slice(edit.end);
      if(useNative&&(expectedText.length>500000||Buffer.byteLength(expectedText)>2_000_000)){
        record.status='deopt';record.reason='native-readback-budget-exceeded';record.file=group.file;
        s.metrics.verifiedExecDeopts++;await save();return {status:'deopt',reason:record.reason,file:group.file,reportPath,effectState:'none'};
      }
      group.expectedText=expectedText;
      group.beforeHash=source.sha256;
      record.files.push({file:group.file,mode:'replace_exact',beforeRevision:observation.revision,bytesBefore:observation.bytes,
        expectedAfterHash:hash(expectedText),
        hunks:group.edits.length});
    }
    if(!plan.apply){
      for(const group of groups){
        const fresh=await observe(group.file),original=record.files.find(file=>file.file===group.file);
        const actual=fresh.ok&&fresh.exists?fresh.revision:'absent',expected=group.mode==='create'?'absent':original.beforeRevision;
        if(!fresh.ok||actual!==expected){
          record.status='deopt';record.reason='revision-changed-before-preview';record.file=group.file;
          s.metrics.verifiedExecDeopts++;await save();
          return {status:'deopt',reason:record.reason,file:group.file,reportPath,effectState:'none'};
        }
      }
      record.status='previewed';record.reason='apply-not-requested';s.metrics.verifiedExecPreviews++;await save();
      return {status:'previewed',reason:record.reason,reportPath,effectState:'none',files:record.files.map(file=>({file:file.file,mode:file.mode,hunks:file.hunks,beforeRevision:file.beforeRevision,versionKind:record.versionKind,expectedAfterHash:file.expectedAfterHash})),validations:plan.validations.map(item=>item.description)};
    }
    await save();
    const beforeApply=[];
    for(const group of groups){
      const fresh=await observe(group.file);
      const original=record.files.find(file=>file.file===group.file);
      const expected=group.mode==='create'?'absent':original.beforeRevision;
      const actual=fresh.ok&&fresh.exists?fresh.revision:'absent';
      if(!fresh.ok||actual!==expected){
        record.status='deopt';record.reason='revision-changed-before-apply';record.file=group.file;
        s.metrics.verifiedExecDeopts++;await save();return {status:'deopt',reason:record.reason,file:group.file,reportPath,effectState:'none'};
      }
      beforeApply.push({group,revision:fresh.revision,observation:fresh});
    }
    record.status='applying';
    for(const item of beforeApply){
      let effect;
      try{effect=useNative?await native.available(agent)?await native.apply(agent,item.group,item.observation,signal):
        {ok:false,status:'deopt',effectState:'none',error:{message:'The native conditional-write composition changed before application.'}}:
        await applyEditGroup(call,runtime,agent,item.group,item.revision,signal);}
      catch(error){effect=failedEffect(error);}
      const file=record.files.find(entry=>entry.file===item.group.file);
      file.effect=effect;
      record.effectState=effectState();
      if(effect.ok||['applied','partial','unknown'].includes(effect.effectState)){
        runtime.recordMutation?.(agent,{tool:useNative?'write':item.group.mode==='create'?'ops_write_file':'ops_edit_file',
          file:item.group.file,revision:effect.ok||effect.effectState==='applied'?(useNative?effect.contentHash:effect.revision):null,callId:`verified:${record.id}`,seq:null});
      }
      if(!effect.ok){
        record.status='partial';record.reason='file-apply-failed';
        s.metrics.verifiedExecPartial++;const saved=await saveOutcome();
        return {status:'partial',reason:record.reason,file:item.group.file,effectState:record.effectState,error:effect.error,
          ...(effect.permissionDenied?{permissionDenied:true}:{}),reportPath,...saved,
          files:fileEffects(),note:'Per-file effects are listed. Inspect applied and unknown files before deciding the next edit.'};
      }
      if(!HEX_REVISION.test(String(useNative?effect.contentHash:effect.revision||''))||(useNative?effect.contentHash:effect.revision)!==file.expectedAfterHash){
        record.status='partial';record.reason='post-write-revision-mismatch';record.effectState='applied';
        s.metrics.verifiedExecPartial++;const saved=await saveOutcome();
        return {status:'partial',reason:record.reason,file:item.group.file,effectState:'applied',reportPath,...saved,files:fileEffects(),
          expectedAfterHash:file.expectedAfterHash,actualRevision:effect.revision||null,
          note:'The file changed, but the returned content identity did not match the precomputed content. Declared validations were not run.'};
      }
      file.afterRevision=effect.revision;file.bytesAfter=effect.bytes;file.lineCount=effect.lineCount;file.resultStatus=effect.status;
    }
    record.status='validating';record.effectState='applied';
    for(const validation of plan.validations){
      let result;
      try{result=await runValidation(ctx,call,runtime,agent,validation,signal);}
      catch(error){result={passed:false,deopt:'validation-execution-failed',tool:validation.tool,description:validation.description,
        error:{message:String(error?.message||error).slice(0,1200)}};}
      record.validationResults.push(result);
      if(!result.passed){
        record.status='partial';record.reason=result.deopt||'validation-failed';const saved=await saveOutcome();
        s.metrics.verifiedExecApplies++;s.metrics.verifiedExecPartial++;s.metrics.verifiedExecValidationFailures++;
        return {status:'partial',reason:record.reason,effectState:'applied',reportPath,...saved,files:fileEffects(),
          validation:result,note:'Edits were applied, but explicit validation failed. This is not task completion.'};
      }
    }
    record.status=plan.validations.length?'validated':'applied';record.reason=plan.validations.length?'validations-passed':'edit-applied';const saved=await saveOutcome();
    s.metrics.verifiedExecApplies++;s.active=true;s.dirty=true;
    return {status:record.status,reportPath,...saved,effectState:'applied',files:fileEffects(),
      validations:record.validationResults.map(result=>({description:result.description,tool:result.tool,exitCode:result.exitCode})),
      note:plan.validations.length?'Only the declared commands passed. This does not prove unlisted requirements.':'The requested edits were applied. No external command was requested or run.'};
  }
  async function readCurrentText(agent,file,signal){
    const s=await runtime.init(agent,signal);
    let full;
    try{full=within(s.root,file);}catch(error){return {ok:false,error:{message:error.message}};}
    const observation=await statFile(call,runtime,agent,full,signal);
    if(!observation.ok||!observation.exists||!HEX_REVISION.test(String(observation.revision||''))){
      return {ok:false,error:observation.error||{message:'Existing file revision is unavailable'}};
    }
    const source=await readFullText(s.root,full,observation.revision);
    if(!source.ok)return source;
    const after=await statFile(call,runtime,agent,full,signal);
    if(!after.ok||!after.exists||after.revision!==observation.revision){
      return {ok:false,error:{message:'File changed while its exact source was being read'}};
    }
    return {ok:true,full,text:source.text,sha256:source.sha256,revision:observation.revision,bytes:observation.bytes,lineCount:observation.lineCount};
  }
  return {execute,readCurrentText,
    nativeAvailable(agent){if(!registeredNativeWrite)return false;native??=createNativeCas(ctx,runtime,registeredNativeWrite,registeredNativeExecute);return native.available(agent);}};
}
