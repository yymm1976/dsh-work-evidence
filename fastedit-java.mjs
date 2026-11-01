import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const VERSION='0.8.3';
const EDIT_OPS=new Set(['replace_symbol','replace_symbol_full','after_symbol']);
const READ_OPS=new Set(['find_entity','read_entity']);
const MAX_ENTITY_BYTES=64000;

function sha256(value){return createHash('sha256').update(value).digest('hex');}
function textOf(result){return (result?.content||[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');}
function shellValue(value){
  const data=value?.data&&typeof value.data==='object'?value.data:value;
  const stdout=typeof data?.stdout==='string'?data.stdout:data?.stdout?.text;
  const stderr=typeof data?.stderr==='string'?data.stderr:data?.stderr?.text;
  return {status:value?.data?.status||value?.status||null,exitCode:Number.isInteger(data?.exitCode)?data.exitCode:null,
    timedOut:data?.timedOut===true,aborted:data?.aborted===true||data?.cancelled===true,stdout:stdout??'',stderr:stderr??'',error:data?.error||value?.error||null};
}
function shellTool(ctx,agent){return (process.platform==='win32'?['pwsh','ops_bash','bash']:['ops_bash','bash','pwsh']).find(name=>{try{return Boolean(ctx.tools.get(name,agent));}catch{return false;}})||null;}
function quote(value){return "'"+String(value).replaceAll("'","'\\''")+"'";}
function powershellQuote(value){return "'"+String(value).replaceAll("'","''")+"'";}
function parseBridgeReceipt(stdout){
  const lines=String(stdout||'').trim().split(/\r?\n/).reverse();
  for(const line of lines){
    if(!line.trim().startsWith('{'))continue;
    try{
      const value=JSON.parse(line.trim());
      if(value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.ok==='boolean')return value;
    }catch{}
  }
  throw new Error('FastEdit bridge returned no JSON receipt');
}

function validateInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('FastEdit request must be an object');
  const known=new Set(['file','operation','symbol','snippet','apply','validations']);
  if(Object.keys(input).some(key=>!known.has(key)))throw new Error('Unknown fastedit_java field');
  if(typeof input.file!=='string'||!input.file.trim()||!input.file.toLowerCase().endsWith('.java'))throw new Error('Only a workspace .java file is supported');
  if(!EDIT_OPS.has(input.operation)&&!READ_OPS.has(input.operation))throw new Error('Unsupported FastEdit operation');
  if(typeof input.symbol!=='string'||!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(input.symbol))throw new Error('symbol must be a class or Class.member identifier');
  if(input.apply!==undefined&&typeof input.apply!=='boolean')throw new Error('apply must be boolean');
  if(EDIT_OPS.has(input.operation)&&(typeof input.snippet!=='string'||!input.snippet.trim()||Buffer.byteLength(input.snippet)>250000))throw new Error('Edit operations require a nonempty snippet within 250 KB');
  if(READ_OPS.has(input.operation)&&input.snippet!==undefined)throw new Error('Read operations do not accept snippet');
  if(READ_OPS.has(input.operation)&&input.apply===true)throw new Error('Read operations cannot apply changes');
  if(input.validations!==undefined&&(!Array.isArray(input.validations)||input.validations.length>10))throw new Error('validations must be an array of at most ten explicitly requested commands');
  return {file:input.file,operation:input.operation,symbol:input.symbol,snippet:input.snippet,apply:input.apply===true,
    validations:input.validations??[]};
}

export function createFastEditJava(ctx,runtime,call,verifiedExec){
  async function execute(agent,input,signal){
    const s=await runtime.init(agent,signal),request=validateInput(input),id='fastedit-'+randomUUID();
    const reportPath=path.join(s.dir,s.id+'.'+id+'.json');
    const python=s.config.fastEditPython||process.env.FASTEDIT_PYTHON||null;
    const bridge=path.join(import.meta.dirname,'fastedit-bridge.py');
    const record={version:1,id,sessionId:s.id,createdAt:new Date().toISOString(),file:request.file,operation:request.operation,
      symbol:request.symbol,applyRequested:request.apply,status:'preflight',effectState:'none',python,bridge};
    async function save(){await runtime.save(agent,reportPath,record,signal);}
    if(!s.config.fastEditEnabled){
      record.status='deopt';record.reason='fastedit-disabled';s.metrics.fastEditDeopts++;await save();
      return {status:'deopt',reason:record.reason,reportPath};
    }
    if(typeof python!=='string'||!path.isAbsolute(python)){
      record.status='deopt';record.reason='fastedit-python-not-configured';s.metrics.fastEditDeopts++;await save();
      return {status:'deopt',reason:record.reason,reportPath,next:'Set work-evidence fastEditPython to a Python environment with FastEdit core installed.'};
    }
    try{await fs.access(python);await fs.access(bridge);}catch(error){
      record.status='deopt';record.reason='fastedit-runtime-unavailable';record.error=error.message;s.metrics.fastEditDeopts++;await save();
      return {status:'deopt',reason:record.reason,reportPath};
    }
    const tool=shellTool(ctx,agent);
    if(!tool){record.status='deopt';record.reason='no-authorized-shell';s.metrics.fastEditDeopts++;await save();return {status:'deopt',reason:record.reason,reportPath};}
    const source=await verifiedExec.readCurrentText(agent,request.file,signal),full=source.full;
    if(!source.ok){record.status='deopt';record.reason='source-read-unavailable';record.error=source.error;s.metrics.fastEditDeopts++;await save();return {status:'deopt',reason:record.reason,reportPath,error:source.error};}
    const tempDir=path.join(s.dir,'fastedit'),token=randomUUID(),requestFile=path.join(tempDir,token+'.request.json'),resultFile=path.join(tempDir,token+'.result.java');
    try{
      await fs.mkdir(tempDir,{recursive:true});
      const bridgeRequest={workspace_root:s.root,file:full,operation:request.operation,symbol:request.symbol,result_file:resultFile};
      if(request.snippet!==undefined)bridgeRequest.snippet=request.snippet;
      await fs.writeFile(requestFile,JSON.stringify(bridgeRequest),'utf8');
    }catch(error){
      record.status='deopt';record.reason='fastedit-staging-unavailable';record.error=error.message;
      s.metrics.fastEditDeopts++;await save();
      return {status:'deopt',reason:record.reason,reportPath};
    }
    try{
      const command=tool==='pwsh'
        ? `& ${powershellQuote(python)} ${powershellQuote(bridge)} ${powershellQuote(requestFile)}`
        : `${quote(python)} ${quote(bridge)} ${quote(requestFile)}`;
      const result=await call(tool,{command,description:'Run deterministic FastEdit Java edit bridge',timeoutMs:30000},runtime.execFor(agent,signal));
      const shell=shellValue(result.value);
      let receipt;
      try{receipt=parseBridgeReceipt(shell.stdout);}catch{
        record.status='deopt';record.reason='fastedit-bridge-output-invalid';record.shell={...shell,stdout:shell.stdout.slice(0,2000),stderr:shell.stderr.slice(0,4000)};
        s.metrics.fastEditDeopts++;await save();
        return {status:'deopt',reason:record.reason,reportPath,shell:{exitCode:shell.exitCode,stderr:shell.stderr.slice(0,1000)}};
      }
      record.fastEdit=receipt;
      // Native DSH pwsh results carry exitCode without a status field; OPS shells report status.
      if(result.isError||(shell.status!==null&&shell.status!=='completed')||shell.timedOut||shell.aborted||shell.error||shell.exitCode!==0||receipt.ok!==true){
        record.status='deopt';record.reason=receipt.reason||'fastedit-bridge-failed';record.shell={status:shell.status,exitCode:shell.exitCode,stderr:shell.stderr.slice(0,4000)};
        s.metrics.fastEditDeopts++;await save();
        return {status:'deopt',reason:record.reason,reportPath,detail:receipt};
      }
      if(request.operation==='find_entity'){
        record.status='found';record.entities=receipt.matches;record.beforeSha256=receipt.before_sha256;
        s.metrics.fastEditEntityFinds++;s.active=true;s.dirty=true;await save();
        return {status:receipt.total?'found':'not-found',reportPath,file:request.file,symbol:request.symbol,
          total:receipt.total,matches:receipt.matches,truncated:receipt.truncated,available:receipt.available,
          beforeSha256:receipt.before_sha256,effectState:'none',
          note:'Candidate metadata only; read_entity or a range read is still required to inspect source text.'};
      }
      let bridgeOutput;
      try{bridgeOutput=await fs.readFile(resultFile,'utf8');}catch(error){
        record.status='deopt';record.reason='fastedit-result-unavailable';record.error=error.message;
        s.metrics.fastEditDeopts++;await save();
        return {status:'deopt',reason:record.reason,reportPath};
      }
      if(request.operation==='read_entity'){
        if(source.sha256!==receipt.before_sha256||sha256(bridgeOutput)!==receipt.entity_sha256
          ||Buffer.byteLength(bridgeOutput)>MAX_ENTITY_BYTES){
          record.status='deopt';record.reason='fastedit-read-hash-mismatch';s.metrics.fastEditDeopts++;await save();
          return {status:'deopt',reason:record.reason,reportPath};
        }
        record.status='read';record.entity={qualifiedSymbol:receipt.qualified_symbol,kind:receipt.kind,
          lineStart:receipt.line_start,lineEnd:receipt.line_end,beforeSha256:receipt.before_sha256,entitySha256:receipt.entity_sha256,
          bytes:receipt.entity_bytes};
        runtime.recordReadObservation?.(agent,{tool:'fastedit_java:read_entity',file:request.file,revision:receipt.before_sha256,
          lineStart:receipt.line_start,lineEnd:receipt.line_end,callId:id});
        s.metrics.fastEditEntityReads++;s.active=true;s.dirty=true;await save();
        return {status:'read',reportPath,file:request.file,symbol:request.symbol,
          qualifiedSymbol:receipt.qualified_symbol,kind:receipt.kind,lineStart:receipt.line_start,lineEnd:receipt.line_end,
          beforeSha256:receipt.before_sha256,entitySha256:receipt.entity_sha256,bytes:receipt.entity_bytes,text:bridgeOutput,
          effectState:'none',note:'Exact Java entity only. The revision applies to the whole source file.'};
      }
      const merged=bridgeOutput;
      if(source.sha256!==receipt.before_sha256||sha256(merged)!==receipt.after_sha256){
        record.status='deopt';record.reason='fastedit-hash-mismatch';s.metrics.fastEditDeopts++;await save();
        return {status:'deopt',reason:record.reason,reportPath};
      }
      record.preview={beforeSha256:receipt.before_sha256,afterSha256:receipt.after_sha256,beforeBytes:receipt.before_bytes,afterBytes:receipt.after_bytes,
        lineStart:receipt.line_start,lineEnd:receipt.line_end,parseValid:receipt.parse_valid,used:receipt.used};
      if(!request.apply){
        record.status='previewed';record.reason='apply-not-requested';s.metrics.fastEditPreviews++;await save();
        return {status:'previewed',reportPath,file:request.file,symbol:request.symbol,operation:request.operation,
          beforeSha256:receipt.before_sha256,afterSha256:receipt.after_sha256,beforeBytes:receipt.before_bytes,afterBytes:receipt.after_bytes,
          parseValid:true,next:'Repeat fastedit_java with apply=true to apply the intended edit. Supply validations only for commands requested by the current task.'};
      }
      const verified=await verifiedExec.execute(agent,{summary:`Deterministic FastEdit ${request.operation} for ${request.symbol}`,
        apply:true,edits:[{file:request.file,mode:'replace_exact',old_text:source.text,new_text:merged}],validations:request.validations},signal);
      record.verified=verified;record.status=verified.status;record.effectState=verified.effectState;
      if(verified.status==='validated'||verified.status==='applied')s.metrics.fastEditApplies++;
      else if(verified.status==='partial')s.metrics.fastEditPartial++;
      else s.metrics.fastEditDeopts++;
      let saved;
      try{await save();saved={reportSaved:true};}
      catch(error){saved={reportSaved:false,reportError:String(error?.message||error).slice(0,1200)};}
      return {status:verified.status,reportPath,fastEditReportPath:verified.reportPath,effectState:verified.effectState,
        file:request.file,symbol:request.symbol,operation:request.operation,beforeSha256:receipt.before_sha256,afterSha256:receipt.after_sha256,
        files:verified.files||[],...saved,verifiedReportSaved:verified.reportSaved!==false,
        validations:verified.validations||null,reason:verified.reason||null};
    }finally{
      await fs.rm(requestFile,{force:true}).catch(()=>{});
      await fs.rm(resultFile,{force:true}).catch(()=>{});
    }
  }
  return {execute};
}
