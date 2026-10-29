import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export {VERSION} from './runtime.mjs';
export const tokenFields = ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','reasoningTokens','totalTokens'];
export const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function cleanUsage(value) {
  return Object.fromEntries(tokenFields.map(key => [key, numberOrNull(value?.[key])]));
}
export function newSummary(meta) {
  return {schemaVersion:1, ...meta, endedAt:null, endReason:null,
    requests:{started:0,settled:0,noSurfaceAttempts:0,interrupted:0,missingUsage:0},
    tokens:Object.fromEntries(tokenFields.map(key=>[key,{known:0,reportedRequests:0}])),
    routes:[], requestTime:{sumMs:0,measured:0}, firstTokenTime:{sumMs:0,measured:0},activeWallMs:0,activeTurnStart:null,turnsStarted:0,turnIntervals:0,timingIncomplete:false,
    tools:{modelCalls:0,executions:0,nestedExecutions:0,errors:0,nonzeroExitCodes:0,failures:0,sumMs:0,nestedSumMs:0,measured:0,byName:{}},
    delivery:{reportsSaved:0,lastClaimedStatus:null,interruptionNotesSaved:0},
    notices:{automaticEvidence:0,repeatedEmptyLookup:0},
    evidenceModes:{entry:0,locate:0,failure:0,read:0,archive:0,source:0}, capture:{lostDetailRows:0,ioFailed:false},
    coverage:{scope:'agent-loop requests and native tool executions; auxiliary LLM calls and adapter-internal HTTP retries are not observed',partialStart:!!meta.partialStart},
  };
}
export function applyRow(summary, row) {
  if(row.kind==='turn-start') {
    summary.turnsStarted++;
    summary.activeTurnStart=typeof row.at==='number'?row.at:null;
    summary.endedAt=null;summary.endReason=null;
    if(summary.activeTurnStart===null)summary.timingIncomplete=true;
  } else if(row.kind==='request-start') {
    summary.requests.started++;
    if(row.route && !summary.routes.some(r=>JSON.stringify(r)===JSON.stringify(row.route)) && summary.routes.length<16) summary.routes.push(row.route);
  } else if(row.kind==='request-end') {
    summary.requests.settled++;
    if(row.noSurfaceAttempt) summary.requests.noSurfaceAttempts++;
    if(row.interrupted) summary.requests.interrupted++;
    if(!row.usage || row.usage.inputTokens===null || row.usage.outputTokens===null) summary.requests.missingUsage++;
    for(const key of tokenFields) { const n=numberOrNull(row.usage?.[key]); if(n!==null){summary.tokens[key].known+=n;summary.tokens[key].reportedRequests++;} }
    for(const [field,value] of [['requestTime',row.elapsedMs],['firstTokenTime',row.firstTokenMs]]) {
      if(numberOrNull(value)!==null){summary[field].sumMs+=value;summary[field].measured++;}
    }
  } else if(row.kind==='plugin-notice') {
    if(row.notice==='automatic-evidence')summary.notices.automaticEvidence++;
    if(row.notice==='repeated-empty-lookup')summary.notices.repeatedEmptyLookup++;
  } else if(row.kind==='model-tool-call') summary.tools.modelCalls++;
  else if(row.kind==='tool-end') {
    const tools=summary.tools;
    tools.executions++;if(row.nested)tools.nestedExecutions++;if(row.error)tools.errors++;if(row.nonzeroExit)tools.nonzeroExitCodes++;
    if(row.error||row.nonzeroExit)tools.failures++;
    // PTC dispatches overlap their enclosing run_code: keep their time separate.
    if(numberOrNull(row.elapsedMs)!==null){if(row.nested)tools.nestedSumMs+=row.elapsedMs;else{tools.sumMs+=row.elapsedMs;tools.measured++;}}
    const name=Object.hasOwn(tools.byName,row.tool)||Object.keys(tools.byName).length<256 ? row.tool : '(other tools)';
    if(!Object.hasOwn(tools.byName,name))Object.defineProperty(tools.byName,name,{value:{calls:0,errors:0,sumMs:0,measured:0,resultTextChars:0},enumerable:true});
    const bucket=tools.byName[name];bucket.calls++;if(row.error||row.nonzeroExit)bucket.errors++;
    if(numberOrNull(row.elapsedMs)!==null){bucket.sumMs+=row.elapsedMs;bucket.measured++;}bucket.resultTextChars+=row.resultTextChars||0;
    if(row.reportSaved){summary.delivery.reportsSaved++;summary.delivery.lastClaimedStatus=row.claimedStatus;}
    if(row.interruptionSaved)summary.delivery.interruptionNotesSaved++;
    if(row.evidenceMode && Object.hasOwn(summary.evidenceModes,row.evidenceMode))summary.evidenceModes[row.evidenceMode]++;
  } else if(row.kind==='turn-end') {
    summary.endedAt=row.at;summary.endReason=row.reason;
    if(summary.activeTurnStart!==null&&typeof row.at==='number'){summary.activeWallMs+=Math.max(0,row.at-summary.activeTurnStart);summary.turnIntervals++;}
    else summary.timingIncomplete=true;
    summary.activeTurnStart=null;
  }
  return summary;
}
export async function writeJson(file, value) {
  const temp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temp, JSON.stringify(value,null,2)+'\n', {encoding:'utf8',flag:'wx'});
  try { await fs.rename(temp,file); } catch(error) { await fs.rm(temp,{force:true}).catch(()=>{});throw error; }
}

export async function readRun(directory) {
  const meta=JSON.parse(await fs.readFile(path.join(directory,'meta.json'),'utf8'));
  const summary=newSummary(meta);let malformed=0;
  let raw='';try{raw=await fs.readFile(path.join(directory,'events.jsonl'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const line of raw.split('\n')) {if(!line.trim())continue;try{applyRow(summary,JSON.parse(line));}catch{malformed++;}}
  try{const saved=JSON.parse(await fs.readFile(path.join(directory,'summary.json'),'utf8'));summary.capture=saved.capture||summary.capture;summary.coverage=saved.coverage||summary.coverage;if(saved.attemptAccounting)summary.attemptAccounting=saved.attemptAccounting;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  summary.capture.malformedRows=malformed;
  // An absent end stays unfinished; neither CLI nor model may turn it into success.
  summary.wallMs=summary.endReason!==null&&!summary.timingIncomplete&&summary.turnIntervals>0?summary.activeWallMs:null;
  summary.assessment=null;
  return summary;
}
