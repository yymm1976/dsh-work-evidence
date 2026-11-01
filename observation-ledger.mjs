import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {parseResult,resultHasProblem,resultReference} from './visible-results.mjs';

const READ_TOOLS=new Set(['read','ops_read_files','ops_inspect_local_file','project_evidence','fastedit_java']);
const WRITE_TOOLS=new Set(['edit','write','str_replace_editor','ops_edit_file','ops_write_file']);
const SEARCH_TOOLS=new Set(['grep','ops_grep','glob','ops_glob']);
const MAX_OBSERVATIONS=256;
const MAX_BODY_CHARS=131072;
const MAX_PENDING=512;
const MIN_RECEIPT_BODY=480;
const MIN_RECEIPT_SAVING=240;
const MAX_RECEIPT_CHARS=8192;
const MAX_CARD_CHARS=1600;
const REASONING_MARKER=/(?:结论|已确认|已决定|最终选择|因此采用|decided to|confirmed that|conclusion)\s*[：:]\s*([^\n]{8,220})/i;

const textBlocks=content=>(content??[]).filter(block=>block?.type==='text').map(block=>block.text??'').join('\n');
const reasoningText=content=>(content??[]).filter(block=>block?.type==='reasoning').map(block=>block.text??'').join('\n');
const argText=value=>typeof value==='string'?value:(()=>{try{return JSON.stringify(value??{});}catch{return '';}})();
const hashOf=value=>createHash('sha256').update(String(value)).digest('hex');
const shortHash=value=>hashOf(value).slice(0,24);
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const lineNumber=row=>Number.isInteger(row?.line)?row.line:Number.isInteger(row?.number)?row.number:null;
const fileKey=value=>process.platform==='win32'?value.toLowerCase():value;

function relativePath(root,value){
  if(typeof value!=='string'||!value.trim()||!root)return null;
  const separator=value.search(/![\\/]/),raw=separator<0?value:value.slice(0,separator);
  const full=path.resolve(root,raw);
  const relative=path.relative(root,full);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return null;
  const entry=separator<0?'':value.slice(separator+1).replaceAll('\\','/').replace(/^\/+/,''),
    display=(relative.replaceAll('\\','/')||'.')+(entry?'!/'+entry:'');
  return {full,display,key:fileKey(display)};
}

function pathsFromArguments(args={}){
  const values=[];
  for(const key of ['file_path','path','file']){
    if(typeof args[key]==='string')values.push(args[key]);
  }
  if(Array.isArray(args.files))for(const item of args.files)values.push(typeof item==='string'?item:item?.path);
  return [...new Set(values.filter(value=>typeof value==='string'&&value.trim()))].slice(0,8);
}

function lineRowsOf(node){
  if(Array.isArray(node?.lines)&&node.lines.length&&node.lines.every(row=>typeof row?.text==='string'&&lineNumber(row)!==null))return node.lines;
  if(Array.isArray(node?.items)&&node.items.length&&node.items.every(row=>typeof row?.text==='string'&&lineNumber(row)!==null))return node.items;
  return null;
}

export function collectReadWindows(value,fallbackPath=null,fallbackRevision=null){
  const windows=[],seen=new Set(),visited=new WeakSet();
  const add=(rawPath,rows,source,revision=null,complete=null)=>{
    const records=rows.filter(row=>typeof row?.text==='string').map(row=>({line:lineNumber(row),text:row.text}))
      .filter(row=>Number.isInteger(row.line)).sort((a,b)=>a.line-b.line);
    if(!rawPath||!records.length||records.some((row,index)=>row.line!==records[0].line+index))return;
    const start=records[0].line,end=records.at(-1).line,text=records.map(row=>row.text).join('\n');
    if(text.length>MAX_BODY_CHARS)return;
    const key=JSON.stringify([rawPath,start,end,hashOf(text).slice(0,16),revision??null]);
    if(seen.has(key))return;
    seen.add(key);
    windows.push({path:rawPath,start,end,revision:revision||fallbackRevision||null,text,
      chars:text.length,hash:shortHash(text),complete,source,bodyField:Array.isArray(source.lines)?'lines':Array.isArray(source.items)?'items':'text'});
  };
  const visit=(node,inheritedPath,inheritedRevision,depth)=>{
    if(depth>12)return;
    if(Array.isArray(node)){
      for(const item of node.slice(0,256))visit(item,inheritedPath,inheritedRevision,depth+1);
      return;
    }
    if(!isObject(node))return;
    if(node.isError||node.error||['error','failed','cancelled','unavailable','disabled'].includes(node.status))return;
    if(visited.has(node))return;
    visited.add(node);
    const ownPath=typeof node.archive==='string'&&typeof node.entry==='string'?node.archive+'!/'+node.entry:typeof node.path==='string'?node.path:typeof node.file==='string'?node.file:inheritedPath;
    const ownRevision=typeof node.revision==='string'?node.revision:typeof node.beforeSha256==='string'?node.beforeSha256:inheritedRevision;
    const rows=lineRowsOf(node);
    if(rows){add(ownPath,rows,node,ownRevision,typeof node.complete==='boolean'?node.complete:null);return;}
    if(typeof node.text==='string'&&Number.isInteger(node.lineStart)&&Number.isInteger(node.lineEnd)){
      const lines=node.text.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n');
      if(lines.length===node.lineEnd-node.lineStart+1){add(ownPath,lines.map((text,index)=>({line:node.lineStart+index,text})),node,ownRevision,true);return;}
    }
    for(const [key,child] of Object.entries(node))if(!['text','content','arguments','responseView','workEvidenceReference'].includes(key)&&child&&typeof child==='object')visit(child,ownPath,ownRevision,depth+1);
  };
  visit(value,fallbackPath,fallbackRevision,0);
  return windows.slice(0,32);
}

function hasUnmappedReadContent(value,windows){
  const mapped=new WeakSet(windows.map(window=>window.source).filter(isObject));
  let unmapped=false;
  const visit=(node,depth=0)=>{
    if(unmapped)return;
    if(depth>12){unmapped=true;return;}
    if(Array.isArray(node)){
      if(node.length>256){unmapped=true;return;}
      for(const item of node)visit(item,depth+1);
      return;
    }
    if(!isObject(node))return;
    if(mapped.has(node))return;
    const rows=lineRowsOf(node);
    if(rows||Array.isArray(node.lines)&&node.lines.some(row=>typeof row?.text==='string')||
      Array.isArray(node.items)&&node.items.some(row=>typeof row?.text==='string')||
      typeof node.text==='string'&&node.text.length&&
        (Object.hasOwn(node,'lineStart')||Object.hasOwn(node,'lineEnd'))||
      typeof node.content==='string'&&node.content.trim()||
      Array.isArray(node.content)&&node.content.some(block=>block?.type==='text'&&String(block.text??'').trim())){
      unmapped=true;
      return;
    }
    for(const child of Object.values(node))if(child&&typeof child==='object')visit(child,depth+1);
  };
  visit(value);
  return unmapped;
}

function sameJson(left,right){
  try{return JSON.stringify(JSON.parse(left))===JSON.stringify(right);}catch{return false;}
}

function canonicalArgsKey(name,args){
  try{return JSON.stringify([name,args??{}],(_key,value)=>isObject(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);}catch{return name+':unserializable';}
}

function distinctNestedReads(nested){
  const seen=new Set(),reads=[];
  for(const item of nested){
    if(!READ_TOOLS.has(item.name)||item.isError)continue;
    const key=item.callId;
    if(seen.has(key))continue;
    seen.add(key);reads.push(item);
  }
  return reads;
}
function nestedReadValues(nested){
  // A PTC outer result can faithfully carry several nested read values. Any
  // transformation, aggregation, or non-read output keeps the old conservative
  // skip so a program's own output is never mistaken for file bodies.
  const reads=distinctNestedReads(nested);
  if(!reads.length)return {reads,projected:null};
  const projected=reads.length===1?reads[0].value:
    reads.every(read=>isObject(read.value))&&reads.length<=8?{items:reads.map(read=>read.value)}:null;
  return {reads,projected};
}
function readWindowsFromDispatch(read){
  return read.value?collectReadWindows(read.value,pathsFromArguments(read.arguments)[0]??null):
    collectReadWindows(read.meta);
}

export function renderedReads(reads,outer){
  // The outer run_code result is model-authored text, but each dispatch still
  // has native line metadata. Match every numbered line in order so headings,
  // totals and other program output can remain intact without weakening the
  // all-or-nothing duplicate-body replacement below.
  if(!reads.length||reads.length>32)return null;
  const windows=reads.flatMap(readWindowsFromDispatch);
  if(!windows.length)return null;
  const rows=outer.replace(/\r\n/g,'\n').split('\n');
  let rowIndex=0;const spans=[];
  for(const window of windows){
    const lines=window.text.split('\n');
    let found=-1;
    for(let index=rowIndex;index<=rows.length-lines.length;index++){
      let matches=true;
      for(let offset=0;offset<lines.length;offset++){
        const row=rows[index+offset],prefix=new RegExp('^[ \\t]*'+(window.start+offset)+'(?::[ \\t]?|\\t|[ \\t]*\\|[ \\t]?)');
        if(row===lines[offset]||prefix.test(row)&&row.replace(prefix,'')===lines[offset])continue;
        matches=false;break;
      }
      if(matches){found=index;break;}
    }
    if(found<0)return null;
    rowIndex=found+lines.length;
    spans.push({start:found,end:rowIndex});
  }
  return {name:'read',arguments:{files:reads.map(read=>read.arguments)},renderedRows:rows,value:{items:windows.map((window,index)=>({
    path:window.path,lines:window.text.split('\n').map((text,index)=>({number:window.start+index,text})),totalLines:window.end,renderedSpan:spans[index],
  }))}};
}

function isSuccessfulWrite(name,result){
  if(!WRITE_TOOLS.has(name)||result?.isError)return false;
  return true;
}

function mutationPathsFromValue(name,args,value){
  const out=[];
  if(WRITE_TOOLS.has(name)){
    if(value?.status==='partial'&&Array.isArray(value?.data?.items)){
      for(const item of value.data.items)if(item.status==='completed'&&typeof item.path==='string')out.push(item.path);
    }else if(!resultHasProblem(value))for(const item of pathsFromArguments(args))out.push(item);
  }
  if(name==='ops_batch'&&Array.isArray(value?.data?.items)){
    for(const item of value.data.items){
      if(item?.status==='completed'&&typeof item.path==='string')out.push(item.path);
    }
  }
  return [...new Set(out)];
}

export function createObservationLedger(ctx,runtime,nativeFiles=null){
  const ledgers=new Map();
  const stateFor=agent=>{
    const id=agent.session.id;
    let state=ledgers.get(id);
    if(state&&state.policyEpoch===(runtime.get(agent).viewEpoch||0))return state;
    state={
      sessionId:id,policyEpoch:runtime.get(agent).viewEpoch||0,root:null,observations:[],pending:new Map(),nested:new Map(),calls:new Map(),
      negative:new Map(),reasoning:[],changes:[],version:0,injectedVersion:0,injectedUnresolvedSignature:'',
      problems:[],lastStep:0,lastTurn:0,droppedReceipts:0,ordinal:0,
      receiptHits:0,receiptCharsSaved:0,staleMarks:0,
      receiptSkips:{},
    };
    ledgers.set(id,state);
    return state;
  };
  const config=agent=>runtime.get(agent).config;
  const enabled=agent=>runtime.isEnabled(agent);
  const ledgerActive=agent=>{
    const value=config(agent);
    return value.ledgerReceipt||value.ledgerUnresolved;
  };
  const addProblem=(state,message)=>{
    state.problems.push({at:new Date().toISOString(),message:String(message).slice(0,280)});
    if(state.problems.length>20)state.problems.shift();
  };
  const addChange=(state,change)=>{
    state.changes.push({...change,version:++state.version,at:new Date().toISOString()});
    if(state.changes.length>24)state.changes.shift();
  };
  const visible=(agent,observation)=>{
    try{return observation.visible&&agent.session.surface.nodes.includes(observation.seq)&&(runtime.isBodyVisible?.(agent,observation.seq)??true);}catch{return false;}
  };

  async function refreshRoot(agent){
    const state=stateFor(agent);
    state.root??=runtime.get(agent).root||null;
    if(!state.root)try{state.root=await ctx.workingDirectory.ensure(agent);}catch{return null;}
    if(!state.root)state.root=runtime.get(agent).root||null;
    return state.root;
  }

  async function fingerprints(root,paths){
    const results=await Promise.all([...new Set(paths)].map(async raw=>{
      const file=relativePath(root,raw);
      if(!file)return [raw,null];
      try{
        if(!nativeFiles)return [raw,null];
        const stat=await nativeFiles.stat(root,file.full);
        return [raw,stat.exists?`${stat.version??'unversioned'}:${stat.bytes}`:null];
      }catch{return [raw,null];}
    }));
    return new Map(results);
  }

  function markStale(agent,rawPath,seq,tool){
    const state=stateFor(agent);
    const file=relativePath(state.root,rawPath);
    if(!file)return;
    const changed=[];
    for(const observation of state.observations){
      let touched=false;
      for(const window of observation.windows){
        if(!window.stale&&(window.pathKey===file.key||window.pathKey?.startsWith(file.key+'!/'))){
          window.stale=true;window.staleCause=WRITE_TOOLS.has(tool)?'known-write':'source-change';touched=true;
        }
      }
      if(!touched)continue;
      observation.stale=observation.windows.some(window=>window.stale);
      observation.staleAt=new Date().toISOString();
      observation.staleBySeq=seq??null;
      observation.staleByTool=tool??null;
      changed.push(observation.id);
    }
    if(!changed.length)return;
    state.staleMarks+=changed.length;
    runtime.get(agent).metrics.ledgerStale+=changed.length;
    addChange(state,{kind:'stale',ids:changed,path:file.display,seq:seq??null,tool:tool??null});
  }

  function markMutation(agent,{name,args,value,seq=null}){
    const state=stateFor(agent);
    for(const raw of mutationPathsFromValue(name,args,value))markStale(agent,raw,seq,name);
  }

  function rememberNested(agent,exec,result){
    const state=stateFor(agent),root=exec.rootCallId;
    state.root??=runtime.get(agent).root||null;
    if(!root)return;
    const list=state.nested.get(root)??[];
    const entry={callId:exec.callId,name:exec.name,arguments:exec.arguments??{},value:result.value,meta:result.meta,content:textBlocks(result.content),isError:!!result.isError};
    const prior=list.findIndex(item=>item.callId===exec.callId);
    if(prior>=0)list[prior]=entry;else list.push(entry);
    state.nested.set(root,list.slice(-32));
    if(state.nested.size>MAX_PENDING)state.nested.delete(state.nested.keys().next().value);
    if(isSuccessfulWrite(exec.name,result))markMutation(agent,{name:exec.name,args:exec.arguments,value:result.value,seq:null});
  }

  function bestCanonical(agent,window,{afterSeq=-1}={}){
    const state=stateFor(agent);
    const candidates=state.observations.filter(observation=>
      observation.seq>afterSeq&&observation.hasBody&&visible(agent,observation));
    for(let index=candidates.length-1;index>=0;index--){
      const observation=candidates[index];
      for(const prior of observation.windows){
        if(prior.stale||prior.referenceApplied||prior.pathKey!==window.pathKey||prior.start>window.start||prior.end<window.end)continue;
        if(window.revision&&prior.revision&&window.revision!==prior.revision)continue;
        if(window.stat&&prior.stat&&window.stat!==prior.stat)continue;
        const rows=prior.text.split('\n').slice(window.start-prior.start,window.end-prior.start+1).join('\n');
        if(rows===window.text)return observation;
      }
    }
    return null;
  }

  function receiptText(windows,priorById){
    const lines=[];
    for(const window of windows){
      const prior=priorById.get(window);
      if(!prior)return null;
      lines.push(`obs#${prior.ordinal} seq=${prior.seq} ${window.tool} path=${window.path} range=${window.start}-${window.end} revision=${window.revision??prior.revision??'observed'} state=fresh visible=yes shape=line/text`);
    }
    const text='[work-evidence ledger receipt]\n'+lines.join('\n')+
      '\nThe listed content is unchanged and its original body remains visible in this request; the receipt replaces only this duplicate model-visible body.';
    return text.length<=MAX_RECEIPT_CHARS?text:null;
  }

  async function prepareVisibleResult(agent,exec,result){
    const state=stateFor(agent);
    const skip=(reason,value=null)=>{state.receiptSkips[reason]=(state.receiptSkips[reason]??0)+1;runtime.effects?.decide(agent,'receipt',reason==='disabled'?'disabled':'not-applicable',reason);return value;};
    if(!enabled(agent)||result.isError)return skip(result.isError?'error-result':'disabled');
    if((result.content??[]).some(block=>block.type!=='text'))return skip('non-text-result');
    const root=await refreshRoot(agent);
    if(!root)return skip('no-workspace-root');
    let source,projection=parseResult(textBlocks(result.content));
    const nested=state.nested.get(exec.callId)??[],{reads,projected:batch}=nestedReadValues(nested);
    if(batch&&sameJson(textBlocks(result.content),batch)){
      source={name:reads[0].name,arguments:{files:reads.map(read=>read.arguments)},value:batch};
    }else if(exec.name==='run_code'&&(source=renderedReads(reads,textBlocks(result.content)))){
      projection=null;
    }else if(!exec.parent&&READ_TOOLS.has(exec.name)){
      source={name:exec.name,arguments:exec.arguments??{},value:result.value};
    }else if(exec.name==='run_code'&&projection&&reads.length){
      source={name:'run_code',arguments:{},value:projection};
    }else{
      if(!reads.length)return skip(nested.length?'nested-tool-not-read':'nested-no-read');
      if(reads.length>1)return skip('nested-multiple-reads');
      if(!sameJson(textBlocks(result.content),reads[0].value))return skip('outer-projection-mismatch');
      return skip('not-read-wrapper');
    }
    const windows=collectReadWindows(projection??source.value,pathsFromArguments(source.arguments)[0]??null);
    if(!windows.length)return skip('no-line-windows');
    for(const window of windows){
      const file=relativePath(root,window.path);if(!file)return skip('path-outside-workspace');
      window.path=file.display;window.pathKey=file.key;
    }
    const stats=await fingerprints(root,windows.map(window=>window.path));
    for(const window of windows){
      window.stat=stats.get(window.path)??null;
      window.tool=source.name;
    }
    const original=textBlocks(result.content);
    const prepared={source,windows,stats,priorById:new Map(),receipt:null,original,bodyHash:hashOf(original)};
    if(!config(agent).ledgerReceipt)return skip('disabled',prepared);
    if(runtime.canRecall?.(agent)!==true)return skip('historical-recall-unavailable',prepared);
    const defaultView=runtime.get(agent).sessionDefaultResponseView??config(agent).defaultResponseView;
    if((source.arguments?.responseView??defaultView)==='full'||reads.some(read=>read.arguments?.responseView==='full'))return skip('explicit-full-view',prepared);
    if(original.length<MIN_RECEIPT_BODY)return skip('smallBody',prepared);
    if(!projection){
      const reason=resultHasProblem(source.value)?'problem-or-incomplete-result':
        hasUnmappedReadContent(source.value,windows)?'unmapped-read-content':null;
      if(reason)return skip(reason,prepared);
    }
    let references=0;
    for(const window of windows){
      const prior=bestCanonical(agent,window);
      if(!prior)continue;
      if(source.renderedRows){
        const span=window.source.renderedSpan,replacement=receiptText([window],new Map([[window,prior]]));
        if(!span||!replacement||source.renderedRows.slice(span.start,span.end).join('\n').length<=replacement.length)continue;
      }
      const reference=resultReference(prior.seq,{path:window.path,range:{start:window.start,end:window.end},visible:true});
      if(projection){
        if(JSON.stringify(window.source[window.bodyField]).length-JSON.stringify(reference).length<MIN_RECEIPT_SAVING)continue;
        window.source[window.bodyField]=window.bodyField==='text'?'':[];window.source.bodyEmbedded=false;window.source.workEvidenceReference=reference;
      }
      window.referenceApplied=true;prepared.priorById.set(window,prior);references++;
    }
    if(!references)return skip('noMatchingVisibleBody',prepared);
    if(!projection&&!source.renderedRows&&references!==windows.length){
      for(const window of windows)window.referenceApplied=false;
      prepared.priorById.clear();
      return skip('partialWindowCoverage',prepared);
    }
    if(projection?.responseView?.kind==='full'&&references)projection.responseView={...projection.responseView,kind:'mixed-reference',
      bodyEmbedded:windows.some(window=>!window.referenceApplied),requestedBodiesComplete:false};
    let receipt;
    if(source.renderedRows){
      const rows=source.renderedRows.slice();
      for(const window of windows.slice().reverse()){
        if(!window.referenceApplied)continue;
        const span=window.source.renderedSpan,replacement=receiptText([window],prepared.priorById);
        if(!span||!replacement){receipt=null;break;}
        rows.splice(span.start,span.end-span.start,replacement);
      }
      if(receipt!==null)receipt=rows.join('\n');
    }else receipt=projection?JSON.stringify(projection):references===windows.length?receiptText(windows,prepared.priorById):null;
    if(!receipt||original.length-receipt.length<MIN_RECEIPT_SAVING||runtime.effects&&!runtime.effects.benefit(agent,'receipt',original,receipt)){
      for(const window of windows)window.referenceApplied=false;
      prepared.priorById.clear();
      return skip('notWorthIt',prepared);
    }
    prepared.receipt=receipt;
    return prepared;
  }

  function emptySearch(args,value){
    if(resultHasProblem(value))return false;
    const data=value?.data??value;
    if(data?.complete===false||data?.scanComplete===false||data?.pageComplete===false||data?.truncated)return false;
    for(const key of ['matches','paths','items','files'])if(Array.isArray(data?.[key]))return data[key].length===0;
    return false;
  }

  function recordSearchResult(agent,name,args,value,rootCallId){
    if(!SEARCH_TOOLS.has(name))return;
    if(resultHasProblem(value))return;
    const state=stateFor(agent),key=canonicalArgsKey(name,args);
    if(emptySearch(args,value)){
      const prior=state.negative.get(key);
      const entry=prior??{tool:name,arguments:args,count:0,firstSeq:null,lastSeq:null};
      if(rootCallId&&entry.lastRootCallId===rootCallId)return;
      entry.lastRootCallId=rootCallId;
      entry.count++;
      state.negative.set(key,entry);
      if(entry.count===2)addChange(state,{kind:'negative',tool:name,arguments:args,count:entry.count});
    }else state.negative.delete(key);
  }

  async function postExecute(exec,result,next){
    const decision=await next();
    if(!exec.agent||!enabled(exec.agent))return decision;
    const ledgerOn=ledgerActive(exec.agent);
    if(!ledgerOn)return decision;
    if(decision.kind==='block')return decision;
    if(exec.parent){
      if(ledgerOn||READ_TOOLS.has(exec.name))rememberNested(exec.agent,exec,result);
      if(ledgerOn&&!result.isError)recordSearchResult(exec.agent,exec.name,exec.arguments,result.value,exec.rootCallId||exec.callId);
      return decision;
    }
    const state=stateFor(exec.agent);
    state.root??=runtime.get(exec.agent).root||null;
    if(ledgerOn&&isSuccessfulWrite(exec.name,result))markMutation(exec.agent,{name:exec.name,args:exec.arguments,value:result.value});
    if(ledgerOn&&!result.isError)recordSearchResult(exec.agent,exec.name,exec.arguments,result.value,exec.rootCallId||exec.callId);
    if(Object.hasOwn(decision,'content')||Object.hasOwn(decision,'value'))return decision;
    let prepared;
    if(ledgerOn)try{prepared=await prepareVisibleResult(exec.agent,exec,result);}catch(error){addProblem(state,'receipt-prepare: '+error.message);}
    if(prepared){
      state.pending.set(exec.callId,{...prepared,receiptApplied:!!prepared.receipt,at:Date.now()});
      if(state.pending.size>MAX_PENDING)state.pending.delete(state.pending.keys().next().value);
    }
    const content=prepared?.receipt?[{type:'text',text:prepared.receipt}]:result.content;
    return content!==result.content?{...decision,content}:decision;
  }

  function addObservation(agent,event){
    const state=stateFor(agent);
    const callId=event.data?.message?.source?.callId;
    const pending=state.pending.get(callId);
    if(!pending)return;
    state.pending.delete(callId);
    const shown=event.data?.message?.content;
    const shownText=textBlocks(shown);
    if(event.data?.message?.isError||!shownText)return;
    if(!agent.session.surface.nodes.includes(event.seq))return;
    const observation={
      id:'obs-'+randomUUID(),ordinal:++state.ordinal,turn:event.data?.turn??null,step:event.data?.step??null,
      seq:event.seq,tool:pending.source.name,paths:[...new Set(pending.windows.map(window=>window.path))],
      pathKey:pending.windows[0].pathKey,
      path:pending.windows[0].path,
      revisions:[...new Set(pending.windows.map(window=>window.revision).filter(Boolean))],
      fingerprints:[...new Set([...pending.stats.values()].filter(Boolean))],
      revision:pending.windows[0].revision??null,windows:pending.windows.map(({source,...window})=>window),
      hash:pending.bodyHash,chars:pending.original.length,hasBody:pending.windows.some(window=>!window.referenceApplied),
      canonicalIds:[...new Set([...pending.priorById.values()].map(item=>item.id))],
      visible:true,stale:false,observedAt:new Date().toISOString(),
    };
    if(pending.receiptApplied){
      runtime.effects?.rewrite(agent,{feature:'receipt',seq:event.seq,retainedSeqs:[...new Set([...pending.priorById.values()].map(item=>item.seq))],afterMessage:event.data.message,beforeMessages:[{...event.data.message,content:[{type:'text',text:pending.original}]}]});
      runtime.effects?.decide(agent,'receipt','applied','duplicate-visible-body',{seq:event.seq,charsSaved:pending.original.length-shownText.length});
      observation.receiptChars=shownText.length;
      state.receiptHits++;
      state.receiptCharsSaved+=Math.max(0,pending.original.length-shownText.length);
      runtime.get(agent).metrics.ledgerReceipts++;
      runtime.get(agent).metrics.ledgerReceiptCharsSaved+=Math.max(0,pending.original.length-shownText.length);
      addChange(state,{kind:'receipt',ordinal:observation.ordinal,canonicalIds:observation.canonicalIds,path:observation.path,saved:Math.max(0,pending.original.length-shownText.length)});
    }
    for(const window of observation.windows){
      const changed=state.observations.some(old=>old.windows.some(prior=>!prior.stale&&prior.pathKey===window.pathKey&&
        ((prior.revision&&window.revision&&prior.revision!==window.revision)||(prior.stat&&window.stat&&prior.stat!==window.stat))));
      if(changed)markStale(agent,window.path,event.seq,'new-read');
    }
    state.observations.push(observation);
    runtime.get(agent).metrics.ledgerObservations++;
    let retained=state.observations.reduce((sum,item)=>sum+item.windows.reduce((chars,window)=>chars+window.text.length,0),0);
    while(state.observations.length>MAX_OBSERVATIONS||retained>8*1024*1024){const removed=state.observations.shift();retained-=removed.windows.reduce((sum,window)=>sum+window.text.length,0);}
  }

  function markSurfaceInvisible(agent,event){
    if(event.surfaceOp?.op!=='replace'||!Array.isArray(event.sourceEventSeqs))return;
    const state=stateFor(agent);
    const replaced=new Set(event.sourceEventSeqs);
    for(const observation of state.observations){
      if(replaced.has(observation.seq))observation.visible=false;
    }
  }

  function readReasoningConclusions(agent,event){
    const state=stateFor(agent);
    const message=event.data?.message;
    if(!message)return;
    const blocks=message.content??[];
    const reasoning=reasoningText(blocks);
    const text=textBlocks(blocks);
    const calls=blocks.filter(block=>block.type==='tool-call');
    if(text){
      for(const item of state.reasoning)if(!item.resolved&&text.includes(item.text))item.resolved=true;
    }
    if(!reasoning||!calls.length)return;
    const match=REASONING_MARKER.exec(reasoning);
    if(!match)return;
    const item={id:'reasoning-'+randomUUID(),seq:event.seq,turn:event.data?.turn??null,step:event.data?.step??null,
      text:match[1].trim(),resolved:text.includes(match[1].trim()),at:new Date().toISOString()};
    state.reasoning.push(item);
    if(state.reasoning.length>24)state.reasoning.shift();
    addChange(state,{kind:'reasoning',id:item.id,seq:item.seq,text:item.text});
  }

  function sessionEvent(session,event){
    const agent=ctx.agents.get(session.id);
    if(!agent||!enabled(agent)||!ledgerActive(agent))return;
    const state=stateFor(agent);
    state.root??=runtime.get(agent).root||null;
    if(event.type==='turn/start'){state.lastTurn=event.data?.turn??state.lastTurn;return;}
    if(event.type==='step/start'){state.lastStep=event.data?.step??state.lastStep;return;}
    if(event.type==='tool/call'){
      const data=event.data??{};
      if(data.callId)state.calls.set(data.callId,{name:data.name,arguments:data.arguments});
      if(state.calls.size>512)state.calls.delete(state.calls.keys().next().value);
      return;
    }
    if(event.type==='tool/ptc-dispatch'){
      const data=event.data??{};
      if(WRITE_TOOLS.has(data.name)&&!data.isError)markMutation(agent,{name:data.name,args:data.arguments,value:data.content,seq:event.seq});
      return;
    }
    if(event.type==='assistant/message'){
      readReasoningConclusions(agent,event);
      markSurfaceInvisible(agent,event);
      return;
    }
    if(event.type==='tool/result'){
      addObservation(agent,event);
      markSurfaceInvisible(agent,event);
      return;
    }
    markSurfaceInvisible(agent,event);
  }

  function unresolvedItems(state,agent){
    const out=[];
    const shown=item=>item.visible&&(!agent||(runtime.isBodyVisible?.(agent,item.seq)??true));
    const staleByPath=new Map();
    for(const observation of state.observations){
      if(!observation.stale)continue;
      for(const window of observation.windows.filter(value=>value.stale&&value.staleCause!=='known-write')){
        const newer=state.observations.some(item=>item.ordinal>observation.ordinal&&shown(item)&&item.hasBody&&item.windows.some(value=>!value.stale&&!value.referenceApplied&&
          value.pathKey===window.pathKey&&value.start<=window.start&&value.end>=window.end));
        if(newer)continue;
        const item=staleByPath.get(window.pathKey)??{kind:'stale',path:window.path,ordinals:[],seqs:[],staleBySeqs:[]};
        if(!item.ordinals.includes(observation.ordinal)){item.ordinals.push(observation.ordinal);item.seqs.push(observation.seq);}
        if(observation.staleBySeq!==null&&observation.staleBySeq!==undefined&&!item.staleBySeqs.includes(observation.staleBySeq))item.staleBySeqs.push(observation.staleBySeq);
        staleByPath.set(window.pathKey,item);
      }
    }
    for(const item of staleByPath.values())out.push({...item,count:item.ordinals.length});
    const byPath=new Map();
    for(const observation of state.observations){
      if(!shown(observation))continue;
      for(const window of observation.windows){
        if(window.stale||window.referenceApplied)continue;
        const prior=byPath.get(window.pathKey);
        if(prior&&prior.revision&&window.revision&&prior.revision!==window.revision){
          out.push({kind:'conflict',path:window.path,first:prior.ordinal,second:observation.ordinal});
        }
        byPath.set(window.pathKey,{revision:window.revision,ordinal:observation.ordinal});
      }
    }
    for(const entry of state.negative.values()){
      if(entry.count>=2)out.push({kind:'negative',tool:entry.tool,arguments:entry.arguments,count:entry.count});
    }
    for(const item of state.reasoning){
      if(!item.resolved)out.push({kind:'reasoning',seq:item.seq,text:item.text});
    }
    return out.slice(-12);
  }

  function maintenance(agent){
    if(!enabled(agent))return [];
    const state=stateFor(agent),configNow=config(agent);
    if(!configNow.ledgerUnresolved)return [];
    for(const observation of state.observations){
      if(observation.visible&&!agent.session.surface.nodes.includes(observation.seq))observation.visible=false;
    }
    const unresolved=configNow.ledgerUnresolved?unresolvedItems(state,agent):[];
    // Successful authored writes invalidate history without creating a new
    // requirement to reread it. Legacy search/write notices describe that same
    // invalidation; retain those facts in status instead of prompting twice.
    if(configNow.ledgerUnresolved)runtime.get(agent).pendingStateNotice=null;
    const unresolvedSignature=unresolved.map(item=>[item.kind,item.ordinal??item.seq??'',item.path??item.tool??'',item.text??''].join(':')).join('|');
    if(configNow.ledgerUnresolved&&!unresolved.length)state.injectedUnresolvedSignature='';
    const unresolvedChanged=configNow.ledgerUnresolved&&unresolved.length>0&&unresolvedSignature!==state.injectedUnresolvedSignature;
    if(!unresolvedChanged)return [];
    const lines=['[work-evidence ledger state]'];
    if(unresolved.length){
      lines.push('Mechanically observed unresolved or changed facts:');
      const recent=state.changes.filter(change=>change.version>state.injectedVersion);
      const changedOnly=unresolved.filter(item=>item.kind==='conflict'||
        (item.kind==='stale'&&recent.some(change=>change.kind==='stale'&&change.path===item.path))||
        (item.kind==='negative'&&recent.some(change=>change.kind==='negative'&&canonicalArgsKey(change.tool,change.arguments)===canonicalArgsKey(item.tool,item.arguments)))||
        (item.kind==='reasoning'&&recent.some(change=>change.kind==='reasoning'&&change.seq===item.seq)));
      for(const item of (changedOnly.length?changedOnly:unresolved).slice(0,8)){
        if(item.kind==='stale')lines.push(`- ${item.path} changed at its source; ${item.count} earlier observation${item.count===1?' is':'s are'} historical (${item.ordinals.map(value=>'obs#'+value).join(', ')}). Obtain current content only if a remaining decision depends on it.`);
        else if(item.kind==='conflict')lines.push(`- ${item.path} has two visible revisions at obs#${item.first} and obs#${item.second}; the later observation is current.`);
        else if(item.kind==='negative')lines.push(`- ${item.tool} ${argText(item.arguments)} returned no matches in two identical completed observations; that is a negative fact for the recorded scope and arguments.`);
        else if(item.kind==='reasoning')lines.push(`- reasoning at event ${item.seq} states: ${item.text}`);
      }
    }
    const fullText=lines.join('\n'),text=fullText.length<=MAX_CARD_CHARS?fullText:fullText.slice(0,MAX_CARD_CHARS-90)+'\nAdditional observations are available through work_state({mode:"detail"}).';
    if(text=== '[work-evidence ledger state]')return [];
    state.injectedVersion=state.version;
    state.injectedUnresolvedSignature=unresolvedSignature;
    runtime.get(agent).metrics.ledgerUnresolvedInjected++;
    return [{role:'user',id:randomUUID(),source:{kind:'work-evidence-ledger'},content:[{type:'text',text}]}];
  }

  function metrics(agent){
    const state=stateFor(agent);
    return {observations:state.observations.length,visible:state.observations.filter(item=>item.visible&&item.windows.some(window=>!window.stale)).length,
      aliases:state.observations.filter(item=>!item.hasBody).length,receipts:state.receiptHits,receiptCharsSaved:state.receiptCharsSaved,
      stale:state.observations.filter(item=>item.stale).length,unresolved:unresolvedItems(state,agent).length,
      receiptSkips:{...state.receiptSkips},policy:'preserve-reasoning-and-unique-content',problems:state.problems.slice(-8)};
  }

  function detail(agent){
    const state=stateFor(agent);
    return {
      observations:state.observations.map(({body,pathKey,...item})=>({...item,windows:item.windows.map(window=>({path:window.path,start:window.start,end:window.end,chars:window.chars,hash:window.hash,stat:window.stat,complete:window.complete,stale:!!window.stale,staleCause:window.staleCause??null,referenced:!!window.referenceApplied}))})),
      unresolved:unresolvedItems(state,agent),
      receiptSkips:{...state.receiptSkips},
      problems:state.problems.slice(),
    };
  }

  function clear(agent){
    const state=stateFor(agent);
    state.observations=[];state.pending.clear();state.nested.clear();state.calls.clear();state.negative.clear();
    state.reasoning=[];state.changes=[];state.version=0;state.injectedVersion=0;state.injectedUnresolvedSignature='';state.problems=[];
    state.receiptSkips={};
  }

  function observe(){
    ctx.on('tools/post-execute',postExecute);
    // Result observers still receive the tool's structured value and metadata.
    // They run before the outer PTC result is prepared for model projection.
    ctx.on('tools/result',(exec,result)=>{
      if(exec.parent&&exec.agent&&!result.isError&&READ_TOOLS.has(exec.name))rememberNested(exec.agent,exec,result);
    });
    ctx.on('session/event',sessionEvent);
    ctx.on('agent/disposed',({agent})=>ledgers.delete(agent.session.id));
  }

  return {observe,maintenance,metrics,detail,clear};
}
