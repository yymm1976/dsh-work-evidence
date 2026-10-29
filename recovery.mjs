const forms={
  ops_read_files:'{files:[{path:"file",offset:1,limit:80}]} -> items[].items[] has line/text; some hosts wrap the native value in data',
  ops_glob:'{path:"src",pattern:["**/*.java"]} -> items[] contains paths; some hosts wrap the native value in data',
  ops_grep:'{path:"src",pattern:"symbol",outputMode:"content",limit:40} -> items[] has path/line/text; some hosts wrap the native value in data',
  ops_stat:'{path:"file"} -> path/exists/revision, possibly inside data. One path per call; use separate native calls for several paths, without inventing data.items',
  project_evidence:'source: {mode:"source",query:"ClassName",members:["method"]} or batch queries:[{query,members},...]; archive: {mode:"archive",archive:"lib.jar",entry:"pkg/Class.java",members:["method"]}; read: {mode:"read",files:[{path:"file",offset:1,limit:80}]}'
};
const readTools=new Set(['ops_read_files','ops_glob','ops_grep','ops_stat','project_evidence']);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
export function correctedReadArguments(name,args){
  if(!readTools.has(name)||!object(args))return null;
  const next={...args};let changed=false;
  if(name==='ops_stat'&&!Object.hasOwn(next,'path')&&Array.isArray(next.paths)&&next.paths.length===1&&text(next.paths[0])){
    next.path=next.paths[0];delete next.paths;changed=true;
  }
  if(name==='ops_glob'&&text(next.pattern)){next.pattern=[next.pattern];changed=true;}
  // An identical redundant alias carries no additional query intent. Conflicts stay errors.
  if(name==='ops_glob'&&Object.hasOwn(next,'glob')){
    const alias=text(next.glob)?[next.glob]:next.glob;
    if(!Array.isArray(alias)||!alias.length||alias.some(value=>!text(value)))return null;
    if(Object.hasOwn(next,'pattern')&&JSON.stringify(next.pattern)!==JSON.stringify(alias))return null;
    next.pattern=alias;delete next.glob;changed=true;
  }
  if(name==='ops_grep'){
    if(next.outputMode==='files'){next.outputMode='files_with_matches';changed=true;}
    const modes=['files_with_matches','content','count','summary'];
    for(const alias of ['mode','output_mode']){
      if(!Object.hasOwn(next,alias))continue;
      const value=next[alias]==='files'?'files_with_matches':next[alias];
      if(!modes.includes(value))continue;
      if(Object.hasOwn(next,'outputMode')&&next.outputMode!==value)return null;
      next.outputMode=value;delete next[alias];changed=true;
    }
    if(typeof next.case_insensitive==='boolean'){
      if(Object.hasOwn(next,'caseInsensitive')&&next.caseInsensitive!==next.case_insensitive)return null;
      next.caseInsensitive=next.case_insensitive;delete next.case_insensitive;changed=true;
    }
    // Keep meaningful whitespace and bound inline regex flags to each alternative.
    if(Array.isArray(next.pattern)&&next.pattern.length>=1&&next.pattern.every(value=>typeof value==='string'&&value.length>0)){
      next.pattern=next.pattern.length===1?next.pattern[0]:next.pattern.map(value=>'(?:'+value+')').join('|');changed=true;
    }
    if(next.files_only===true){
      if(Object.hasOwn(next,'outputMode')&&next.outputMode!=='files_with_matches')return null;
      next.outputMode='files_with_matches';delete next.files_only;changed=true;
    }
    // maxMatches is the common ripgrep-style synonym for grep's limit; seen in edit-019.
    if(next.maxMatches!==undefined){
      if(!Number.isInteger(next.maxMatches)||next.maxMatches<1||Object.hasOwn(next,'limit'))return null;
      next.limit=next.maxMatches;delete next.maxMatches;changed=true;
    }
  }
  if(name==='ops_read_files'&&!Object.hasOwn(next,'files')&&text(next.path)&&Object.keys(next).every(key=>['path','offset','limit'].includes(key))){
    return {files:[next]};
  }
  if(name==='project_evidence'){
    if(next.mode!=='read'&&Array.isArray(next.files)&&next.files.length>=1&&!text(next.archive)&&!text(next.entry)&&!text(next.query)&&!Array.isArray(next.queries)){
      next.mode='read';changed=true;
    }
    if(next.mode==='source'&&text(next.archive)&&text(next.entry)&&!text(next.query)&&!Array.isArray(next.queries)){
      next.mode='archive';changed=true;
    }
  }
  return changed?next:null;
}
export function recoveryFor(name,args,result){
  const value=result?.value;
  const error=value?.error||result?.error;
  const code=String(error?.info?.code||error?.code||value?.code||'');
  const message=String(error?.message||value?.nextFactNeeded||'');
  if(!error&&!['unavailable','unknown'].includes(value?.state))return null;
  const prohibited=/DENIED|APPROVAL|SANDBOX|ABORT|CANCEL|CONFLICT|UNKNOWN|PARTIAL|OUTPUT_LIMIT|EXECUTOR_UNAVAILABLE/i.test(code);
  const invalid=!prohibited&&(/ARGUMENT|ARGS|SCHEMA|MODE_FIELDS|LOCATOR_REQUIRED/i.test(code)||/invalid arguments|missing required property|unknown (?:field|property)|must match exactly one oneOf branch|returned invalid output/i.test(message));
  const correctedArguments=invalid?correctedReadArguments(name,args):null;
  return {shape:forms[name]||'Use this tool\'s current parameter declaration.',
    correctedCall:correctedArguments?{tool:name,arguments:correctedArguments}:null,
    retry:correctedArguments?'one-read-only-correction':prohibited?'do-not-repeat-unchanged':'after-input-change',
    automaticAllowed:!!correctedArguments,
    note:correctedArguments?'Only an unambiguous read-only parameter alias is changed; all other input is retained.':'Missing facts, mode choices, permission failures and write effects are never guessed.'};
}
export function evidenceArgumentError(args,message,code='EVIDENCE_INVALID_ARGUMENT'){
  const result={state:'unavailable',mode:typeof args?.mode==='string'?args.mode:'unknown',code,sources:[],nextFactNeeded:message,
    error:{code,message,effectState:'none',retry:'after-input-change'}};
  result.recovery=recoveryFor('project_evidence',args,{value:result});return result;
}
export function recoveryOf(result){
  const value=result?.value;
  const recovery=value?.data?.workEvidenceRecovery??value?.recovery??result?.error?.recovery;
  return object(recovery)?recovery:null;
}
export function withRecovery(result,recovery){
  if(!recovery)return result;
  if(object(result.value)){
    const original=result.value;
    // OPS PTC envelopes forbid new top-level fields. Their data object permits
    // extension; preserve status, error, coverage and the existing data fields.
    const envelope=['completed','partial','rejected','conflict','error','unknown'].includes(original.status)
      &&(object(original.data)||object(original.error));
    const value=envelope
      ?{...original,data:{...original.data,workEvidenceRecovery:recovery}}
      :{...original,recovery};
    return {...result,value,content:[{type:'text',text:JSON.stringify(value)}]};
  }
  return {...result,error:{...result.error,recovery},content:[...(result.content||[]),{type:'text',text:'Recovery: '+JSON.stringify(recovery)}]};
}
export function recoveredResult(result,{tool,originalArguments,correctedArguments,originalError}){
  const followup=recoveryFor(tool,correctedArguments,result);
  const recovery={applied:true,tool,originalArguments,correctedArguments,originalError,
    stage:'after-error',attempts:2,followup:followup?{...followup,automaticAllowed:false}:null,
    note:'One deterministic read-only argument correction; this does not assert complete coverage.'};
  return withRecovery(result,recovery);
}

export function normalizedReadResult(result,{tool,originalArguments,correctedArguments}){
  const followup=recoveryFor(tool,correctedArguments,result);
  return withRecovery(result,{applied:true,stage:'before-dispatch',tool,originalArguments,correctedArguments,
    attempts:1,followup:followup?{...followup,automaticAllowed:false}:null,
    note:'One read-only call with normalized arguments through the native tool entry. The original arguments were not executed; no prior failure is claimed.'});
}
