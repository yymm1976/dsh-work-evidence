import path from 'node:path';
import {createHash} from 'node:crypto';
import {argsOf,eventLog} from './runtime.mjs';

export const VERSION='0.8.3';
export const REPORT_SCHEMA='work-evidence.ptc-patterns.v1';

const TOOL_ALIASES=Object.freeze({
  ops_inspect_local_file:'read',
  ops_read_files:'read',
  read:'read',
  read_files:'read',
  read_table:'read',
  read_docx:'read',
  read_pdf:'read',
  read_image:'read',
  ops_grep:'grep',
  grep:'grep',
  ops_glob:'glob',
  glob:'glob',
  ops_stat:'stat',
  stat:'stat',
  ops_diff:'diff',
  diff:'diff',
  ops_result:'result',
  result:'result',
  working_directory:'working_directory',
  ops_bash:'shell',
  bash:'shell',
  pwsh:'shell',
  ops_edit_file:'edit',
  edit:'edit',
  edit_file:'edit',
  ops_write_file:'write',
  write:'write',
  write_file:'write',
  str_replace_editor:'edit',
  ops_replace:'replace',
  replace:'replace',
  ops_copy:'copy',
  copy:'copy',
  ops_move:'move',
  move:'move',
  ops_remove:'remove',
  remove:'remove',
  ops_batch:'batch',
  batch:'batch',
});

const READ_ONLY=new Set(['read','grep','glob','stat','diff','result','working_directory']);
const MUTATIONS=new Set(['edit','write','replace','copy','move','remove','batch']);
const CALL_RE=/\btools\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const VALID_SESSION=/^[-a-zA-Z0-9_][-.a-zA-Z0-9_]{0,127}$/;

function canonicalTool(name){return TOOL_ALIASES[name]||String(name||'unknown');}
function digest(value){return createHash('sha256').update(value).digest('hex');}
function cap(value,max){const text=String(value??'');return text.length<=max?text:text.slice(0,max)+'…';}
function sameSessionId(a,b){return String(a||'').replace(/^session-/,'')===String(b||'').replace(/^session-/,'');}

function maskNonCode(source){
  const input=String(source??''),out=input.split('');
  let state='code';
  for(let i=0;i<input.length;i++){
    const ch=input[i],next=input[i+1];
    if(state==='line'){
      if(ch==='\n')state='code';else if(ch!=='\r')out[i]=' ';
      continue;
    }
    if(state==='block'){
      if(ch==='*'&&next==='/'){out[i]=' ';out[i+1]=' ';i++;state='code';}
      else if(ch!=='\n'&&ch!=='\r')out[i]=' ';
      continue;
    }
    if(state==='single'||state==='double'||state==='template'){
      if(ch==='\\'){out[i]=' ';if(i+1<input.length&&input[i+1]!=='\n'&&input[i+1]!=='\r')out[++i]=' ';continue;}
      if((state==='single'&&ch==="'")||(state==='double'&&ch==='"')||(state==='template'&&ch==='`'))state='code';
      if(ch!=='\n'&&ch!=='\r')out[i]=' ';
      continue;
    }
    if(ch==='/'&&next==='/'){out[i]=' ';out[i+1]=' ';i++;state='line';continue;}
    if(ch==='/'&&next==='*'){out[i]=' ';out[i+1]=' ';i++;state='block';continue;}
    if(ch==="'"){out[i]=' ';state='single';continue;}
    if(ch==='"'){out[i]=' ';state='double';continue;}
    if(ch==='`'){out[i]=' ';state='template';continue;}
  }
  return out.join('');
}

function matchingParen(source,open){
  let depth=0,state='code';
  for(let i=open;i<source.length;i++){
    const ch=source[i],next=source[i+1];
    if(state==='line'){
      if(ch==='\n')state='code';
      continue;
    }
    if(state==='block'){
      if(ch==='*'&&next==='/'){i++;state='code';}
      continue;
    }
    if(state==='single'||state==='double'||state==='template'){
      if(ch==='\\'){i++;continue;}
      if((state==='single'&&ch==="'")||(state==='double'&&ch==='"')||(state==='template'&&ch==='`'))state='code';
      continue;
    }
    if(ch==='/'&&next==='/'){i++;state='line';continue;}
    if(ch==='/'&&next==='*'){i++;state='block';continue;}
    if(ch==="'"){state='single';continue;}
    if(ch==='"'){state='double';continue;}
    if(ch==='`'){state='template';continue;}
    if(ch==='(')depth++;
    else if(ch===')'&&--depth===0)return i;
  }
  return -1;
}

function assignmentBefore(source,index){
  const prefix=source.slice(Math.max(0,index-320),index);
  return /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s*)?$/s.exec(prefix)?.[1]||null;
}

export function extractToolCalls(code){
  const source=String(code??''),masked=maskNonCode(source),calls=[];
  CALL_RE.lastIndex=0;
  for(let match;(match=CALL_RE.exec(masked));){
    const open=match.index+match[0].lastIndexOf('('),close=matchingParen(source,open);
    if(close<0)break;
    calls.push({
      name:match[1],
      canonical:canonicalTool(match[1]),
      variable:assignmentBefore(source,match.index),
      argsText:source.slice(open+1,close),
      argsMasked:masked.slice(open+1,close),
      sourceStart:match.index,
    });
    CALL_RE.lastIndex=close+1;
  }
  const control=[];
  for(const name of ['if','for','while','switch','catch']){
    if(new RegExp(`\\b${name}\\s*\\(`).test(masked))control.push(name);
  }
  if(/\bnew\s+Promise\b/.test(masked))control.push('promise');
  return {calls,control,bracketAccess:/\btools\s*\[/.test(masked),truncated:/return\s+await\s+tools\s*\./.test(masked)&&calls.length===0};
}

function shapeOf(value,depth=0){
  if(value===null)return 'null';
  if(Array.isArray(value))return depth>=2?'array':`[${value.slice(0,4).map(v=>shapeOf(v,depth+1)).join(',')}]`;
  if(typeof value==='object'){
    if(depth>=2)return 'object';
    const keys=Object.keys(value).sort();
    return `{${keys.slice(0,12).join(',')}${keys.length>12?',…':''}}`;
  }
  return typeof value;
}

function alignCalls(sourceCalls,dispatches){
  const matched=[],unmatchedDispatches=[];
  let cursor=0;
  for(const dispatch of dispatches){
    const wanted=canonicalTool(dispatch.name);
    while(cursor<sourceCalls.length&&sourceCalls[cursor].canonical!==wanted)cursor++;
    if(cursor>=sourceCalls.length){unmatchedDispatches.push(dispatch.name);continue;}
    matched.push({...sourceCalls[cursor],dispatch});
    cursor++;
  }
  return {matched,unmatchedDispatches,unobservedSourceCalls:Math.max(0,sourceCalls.length-matched.length)};
}

function dependenciesFor(matched){
  const edges=[];
  for(let to=1;to<matched.length;to++){
    for(let from=0;from<to;from++){
      const variable=matched[from].variable;
      if(!variable)continue;
      if(new RegExp(`\\b${variable.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`).test(matched[to].argsMasked)){
        edges.push({fromStep:from+1,toStep:to+1,via:variable});
      }
    }
  }
  return edges;
}

function effectOf(dispatch){
  if(MUTATIONS.has(canonicalTool(dispatch.name)))return 'mutation';
  if(canonicalTool(dispatch.name)==='shell')return 'command';
  if(READ_ONLY.has(canonicalTool(dispatch.name)))return 'read-only';
  return 'unknown';
}

function rootAnalysis(root){
  const dispatches=root.dispatches||[];
  const parsed=extractToolCalls(root.code);
  const aligned=alignCalls(parsed.calls,dispatches);
  const dependencies=dependenciesFor(aligned.matched);
  const effects=[...new Set(dispatches.map(effectOf))];
  const toolSequence=dispatches.map(d=>canonicalTool(d.name));
  const argShapes=dispatches.map(d=>shapeOf(argsOf(d.arguments)));
  const blockers=[];
  if(!root.code)blockers.push('run-code-source-missing');
  if(root.failed)blockers.push('run-code-failed');
  if(aligned.unmatchedDispatches.length)blockers.push('dispatch-not-found-in-source');
  if(aligned.unobservedSourceCalls)blockers.push('source-call-not-observed');
  if(parsed.bracketAccess)blockers.push('dynamic-tool-access');
  if(parsed.control.length)blockers.push('control-flow:'+parsed.control.join(','));
  if(effects.includes('mutation'))blockers.push('mutation');
  if(effects.includes('command'))blockers.push('command-safety-unclassified');
  if(effects.includes('unknown'))blockers.push('unknown-tool-effect');
  if(!toolSequence.length)blockers.push('no-nested-tool-calls');
  const signature=[...toolSequence].join('>')+
    (dependencies.length?`|${dependencies.map(e=>`${e.fromStep}->${e.toStep}`).join(',')}`:'')+
    (parsed.control.length?`|control:${[...new Set(parsed.control)].sort().join(',')}`:'');
  return {
    callId:root.callId,seq:root.seq,turn:root.turn,
    toolSequence,argShapes,dependencies,effects,blockers:[...new Set(blockers)],
    structurallyReadOnly:effects.length>0&&effects.every(effect=>effect==='read-only')&&!blockers.length,
    signature,
  };
}

function rootsAndDispatches(events){
  const roots=new Map(),rootResults=new Map(),dispatches=new Map();
  for(const event of events){
    const data=event.data||{};
    if(event.type==='tool/call'&&data.name==='run_code'&&data.callId){
      const args=argsOf(data.arguments);
      roots.set(data.callId,{callId:data.callId,seq:event.seq??null,turn:Number.isInteger(data.turn)?data.turn:null,code:typeof args.code==='string'?args.code:''});
    }else if(['tool/code-dispatch','tool/ptc-dispatch'].includes(event.type)&&data.rootCallId){
      const list=dispatches.get(data.rootCallId)||[];list.push({seq:event.seq??null,name:data.name,arguments:data.arguments,isError:!!data.isError});dispatches.set(data.rootCallId,list);
    }else if(event.type==='tool/result'){
      const callId=data.message?.source?.callId;
      if(callId&&roots.has(callId))rootResults.set(callId,!!data.message?.isError);
    }
  }
  return [...roots.values()].map(root=>({...root,dispatches:dispatches.get(root.callId)||[],failed:!!rootResults.get(root.callId)})).sort((a,b)=>(a.seq??0)-(b.seq??0));
}

export function summarizeSession(events,sessionId,minToolCalls=3){
  const roots=rootsAndDispatches(events),byTurn=new Map();
  for(const root of roots){
    if(!root.dispatches.length)continue;
    const key=root.turn===null?'unknown':String(root.turn);
    const list=byTurn.get(key)||[];list.push(root);byTurn.set(key,list);
  }
  const occurrences=[];
  for(const [turn,turnRoots] of byTurn){
    for(let start=0;start<turnRoots.length-1;start++){
      for(let count=2;count<=Math.min(4,turnRoots.length-start);count++){
        const window=turnRoots.slice(start,start+count).map(rootAnalysis);
        if(window.reduce((sum,root)=>sum+root.toolSequence.length,0)<minToolCalls)continue;
        const signature=window.map(root=>root.signature).join('||');
        const blockers=[...new Set(window.flatMap(root=>root.blockers))];
        const structurallyReadOnly=window.every(root=>root.structurallyReadOnly);
        if(!structurallyReadOnly)blockers.push('cross-request-input-binding-unproven');
        else blockers.push('cross-request-input-binding-unproven','human-approval-required');
        occurrences.push({
          signature,sessionId,turn,firstSeq:window[0].seq,
          requestCount:window.length,
          nestedToolCalls:window.reduce((sum,root)=>sum+root.toolSequence.length,0),
          roots:window,
          structurallyReadOnly,
          blockers:[...new Set(blockers)],
        });
      }
    }
  }
  return occurrences;
}

function mergeOccurrences(occurrences){
  const groups=new Map();
  for(const occurrence of occurrences){
    let group=groups.get(occurrence.signature);
    if(!group){
      group={signature:occurrence.signature,occurrences:0,turns:new Set(),sessions:new Set(),
        safeOccurrences:0,safeTurns:new Set(),safeSessions:new Set(),blockers:new Set(),argumentShapeVariants:new Set(),sample:null};
      groups.set(occurrence.signature,group);
    }
    group.occurrences++;
    for(const root of occurrence.roots)group.argumentShapeVariants.add(root.argShapes.join('>'));
    group.turns.add(occurrence.sessionId+':'+occurrence.turn);
    group.sessions.add(occurrence.sessionId);
    for(const blocker of occurrence.blockers)group.blockers.add(blocker);
    if(occurrence.structurallyReadOnly){
      group.safeOccurrences++;
      group.safeTurns.add(occurrence.sessionId+':'+occurrence.turn);
      group.safeSessions.add(occurrence.sessionId);
    }
    if(!group.sample||occurrence.firstSeq>(group.sample.firstSeq??-1))group.sample=occurrence;
  }
  return [...groups.values()];
}

function compactCandidate(group,index){
  const sample=group.sample;
  const id='ptc-'+digest(group.signature).slice(0,12);
  const roots=sample.roots.map(root=>root.toolSequence);
  const dependencies=sample.roots.flatMap((root,rootIndex)=>root.dependencies.map(edge=>({requestIndex:rootIndex+1,...edge})));
  return {
    id,
    rank:index+1,
    toolSequence:roots,
    requestCount:sample.requestCount,
    nestedToolCalls:sample.nestedToolCalls,
    occurrences:group.occurrences,
    turns:group.turns.size,
    sessions:group.sessions.size,
    structurallyReadOnlyOccurrences:group.safeOccurrences,
    structurallyReadOnlyTurns:group.safeTurns.size,
    structurallyReadOnlySessions:group.safeSessions.size,
    dependencies,
    argumentShapeVariants:[...group.argumentShapeVariants].slice(0,8),
    argumentShapeVariantCount:group.argumentShapeVariants.size,
    sample:{sessionId:sample.sessionId,turn:sample.turn,firstSeq:sample.firstSeq},
    blockers:[...group.blockers].sort(),
    executionEligible:false,
    structuralRequestSavingsUpperBound:group.safeOccurrences*Math.max(0,sample.requestCount-1),
    savingsMeaning:'只表示如果整段被安全替换为一次高层工具调用，结构上最多少发出多少次外层模型请求；未扣除输入、缓存、失败和语义判断成本。',
  };
}

async function readSessionEvents(persistence,snapshot,maxEvents,signal){
  const handle=await persistence.open(snapshot.header.id,'read',{signal});
  try{
    const events=[],inherited=handle.inheritedEventCount||0;
    const startOffset=Number.isInteger(snapshot.eventCount)?Math.max(inherited,snapshot.eventCount-maxEvents):inherited;
    let offset=startOffset;
    while(events.length<maxEvents){
      const page=await handle.read(offset,Math.min(500,maxEvents-events.length),{signal});
      if(!page.events.length)break;
      events.push(...page.events);offset+=page.events.length;
      if(page.events.length<500)break;
    }
    return {events,truncated:startOffset>inherited||(events.length>=maxEvents&&(!Number.isInteger(snapshot.eventCount)||offset<snapshot.eventCount)),header:handle.header,inheritedEventCount:inherited};
  }finally{await handle.close();}
}

function validateArgs(input){
  const known=new Set(['scope','sessionId','maxSessions','maxEventsPerSession','minSupport','minToolCalls','maxCandidates']);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!known.has(key)))throw new Error('Unknown ptc_patterns field');
  const scope=input.scope??'workspace';if(!['workspace','session'].includes(scope))throw new Error('scope must be workspace or session');
  if(input.sessionId!==undefined&&(typeof input.sessionId!=='string'||!VALID_SESSION.test(input.sessionId)))throw new Error('Invalid sessionId');
  const bounded=(key,fallback,min,max)=>{const value=input[key]??fallback;if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${key} must be an integer from ${min} to ${max}`);return value;};
  return {scope,sessionId:input.sessionId??null,maxSessions:bounded('maxSessions',8,1,32),
    maxEventsPerSession:bounded('maxEventsPerSession',20000,2000,50000),
    minSupport:bounded('minSupport',2,1,20),minToolCalls:bounded('minToolCalls',3,2,32),
    maxCandidates:bounded('maxCandidates',10,1,30)};
}

export function createPtcPatterns(ctx,runtime){
  async function scan(agent,args,signal){
    const input=validateArgs(args||{}),root=path.resolve(await ctx.workingDirectory.ensure(agent,signal));
    const workspaceKey=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
    const snapshots=[...(await ctx.sessionPersistence.list({signal}))];
    const allowed=snapshots.filter(snapshot=>typeof snapshot.header.cwd==='string'&&workspaceKey(snapshot.header.cwd)===workspaceKey(root))
      .sort((a,b)=>b.header.createdAt-a.header.createdAt);
    const currentId=agent.session.id,currentEvents=eventLog(agent.session);
    let selected,scanCurrent=false;
    if(input.scope==='session'){
      const id=input.sessionId||agent.session.id;
      if(sameSessionId(id,currentId)){
        scanCurrent=true;selected=[];
      }else{
      const snapshot=allowed.find(item=>item.header.id===id);
      if(!snapshot)throw new Error('Requested session is outside the current workspace or unavailable');
      selected=[snapshot];
      }
    }else{
      scanCurrent=true;
      selected=allowed.filter(item=>!sameSessionId(item.header.id,currentId)).slice(0,Math.max(0,input.maxSessions-1));
    }
    const allOccurrences=[],scanned=[];
    if(scanCurrent){
      const inherited=Number(agent.session.inheritedEventCount)||0,currentLive=currentEvents.slice(inherited),events=currentLive.slice(-input.maxEventsPerSession);
      const occurrences=summarizeSession(events,currentId,input.minToolCalls);
      allOccurrences.push(...occurrences);
      scanned.push({sessionId:currentId,createdAt:new Date().toISOString(),events:events.length,inheritedEvents:inherited,
        truncated:currentLive.length>events.length,occurrences:occurrences.length,liveSession:true});
    }
    for(const snapshot of selected){
      signal.throwIfAborted();
      try{
        const loaded=await readSessionEvents(ctx.sessionPersistence,snapshot,input.maxEventsPerSession,signal);
        const occurrences=summarizeSession(loaded.events,snapshot.header.id,input.minToolCalls);
        allOccurrences.push(...occurrences);
        scanned.push({sessionId:snapshot.header.id,createdAt:new Date(snapshot.header.createdAt).toISOString(),events:loaded.events.length,
          inheritedEvents:loaded.inheritedEventCount,truncated:loaded.truncated,occurrences:occurrences.length});
      }catch(error){
        if(signal.aborted)throw error;
        scanned.push({sessionId:snapshot.header.id,createdAt:new Date(snapshot.header.createdAt).toISOString(),events:0,unavailable:cap(error.message,300)});
      }
    }
    const groups=mergeOccurrences(allOccurrences)
      .filter(group=>group.safeTurns.size>=input.minSupport)
      .sort((a,b)=>{
        const aScore=a.safeOccurrences*Math.max(0,a.sample.requestCount-1);
        const bScore=b.safeOccurrences*Math.max(0,b.sample.requestCount-1);
        return bScore-aScore||b.safeSessions.size-a.safeSessions.size||b.safeTurns.size-a.safeTurns.size;
      });
    const candidates=groups.slice(0,input.maxCandidates).map(compactCandidate);
    const state=runtime.get(agent),reportPath=path.join(state.dir,'ptc-patterns.json');
    const report={schema:REPORT_SCHEMA,version:VERSION,generatedAt:new Date().toISOString(),workspace:root,
      scope:input.scope,minSupport:input.minSupport,minToolCalls:input.minToolCalls,
      sessions:scanned,candidateCount:candidates.length,candidates,
      limits:{maxSessions:input.maxSessions,maxEventsPerSession:input.maxEventsPerSession,maxCandidates:input.maxCandidates,
        noPromptOrMessageTextStored:true,argsReducedToStructuralShapes:true,
        executionEligible:false,note:'候选只描述可复核的重复结构；跨请求输入绑定、语义判断和真实净收益仍未证明。'}};
    await runtime.save(agent,reportPath,report,signal);
    return {version:VERSION,reportPath,scope:input.scope,sessionsScanned:scanned.filter(item=>!item.unavailable).length,
      sessionsUnavailable:scanned.filter(item=>item.unavailable).length,candidateCount:candidates.length,
      candidates:candidates.slice(0,input.maxCandidates),note:report.limits.note};
  }
  return {scan};
}
