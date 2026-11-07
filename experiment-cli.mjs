#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {readRun,tokenFields,writeJson,VERSION} from './experiment-store.mjs';
import {taskRequestConsumption} from './experiment-consumption.mjs';

const safeId=value=>typeof value==='string'&&/^[-a-zA-Z0-9_][-.a-zA-Z0-9_]{0,127}$/.test(value);
const desktopApp=value=>value?.trim()||process.env.DSH_APP?.trim()||path.join(os.homedir(),'AppData','Local','Programs','DSH Desktop','dsh-desktop');
export function checkedLabel(value) {
  const allowed=['taskKey','contextKey','variant','rubric','evaluator','outcome','score','evidence','notes','recordedAt'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('Unrecognized assessment fields');
  for(const key of ['taskKey','contextKey','variant'])if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>200)throw new Error(key+' is required (1–200 characters)');
  for(const key of ['rubric','evaluator','notes'])if(value[key]!==undefined&&(typeof value[key]!=='string'||value[key].length>2000))throw new Error('Invalid '+key);
  if(!['pass','fail','unknown'].includes(value.outcome))throw new Error('outcome must be pass, fail or unknown');
  if(value.score!==undefined&&value.score!==null&&(typeof value.score!=='number'||!Number.isFinite(value.score)||value.score<0||value.score>100))throw new Error('score must be null or a number from 0 to 100');
  if(!Array.isArray(value.evidence)||value.evidence.length>30||value.evidence.some(item=>typeof item!=='string'||!item.trim()||item.length>2000))throw new Error('evidence must be a bounded array of strings');
  if((value.outcome!=='unknown'||value.score!=null)&&(!value.evaluator?.trim()||!value.evidence.length))throw new Error('A judgement or score requires an evaluator and evidence');
  if(value.score!=null&&!value.rubric?.trim())throw new Error('A score requires the name of its scoring rubric');
  if(value.recordedAt!==undefined&&(typeof value.recordedAt!=='string'||!Number.isFinite(Date.parse(value.recordedAt))))throw new Error('Invalid recordedAt');
  return {...value,score:value.score??null,recordedAt:value.recordedAt||new Date().toISOString()};
}
export async function readRuns(directory) {
  let entries;try{entries=await fs.readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return {runs:[],problems:[]};throw error;}
  const runs=[],problems=[];
  for(const entry of entries){
    if(!entry.isDirectory()||entry.name==='labels'||!safeId(entry.name))continue;
    try{runs.push(await readRun(path.join(directory,entry.name)));}catch(error){problems.push({runId:entry.name,code:error.code||error.name});}
  }
  const latest=new Map();for(const run of runs)if(run.importedAt){const previous=latest.get(run.sessionId);if(!previous||run.importedAt>previous.importedAt)latest.set(run.sessionId,run);}
  return {runs:runs.filter(run=>!run.importedAt||latest.get(run.sessionId)===run),problems};
}
function unionMs(intervals) {
  const sorted=intervals.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>=a).sort((a,b)=>a[0]-b[0]);
  let total=0,end=-Infinity;for(const [a,b] of sorted){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total;
}
function childCoverageFor(sessions,family){
  const missing=[],external=[],unknownInventories=[],unlisted=[],conflicts=[],unmatchedDelegations=[];
  for(const parent of family){
    const parts=sessions.get(parent),listed=new Map();
    for(const part of parts){
      const inventory=part.childInventory;
      if(inventory?.schema!=='work-evidence.native-child-inventory.v1'||!Array.isArray(inventory.children)){
        unknownInventories.push(parent);continue;
      }
      if(inventory.source!=='native-session-readonly'||inventory.complete!==true||inventory.problems?.length)unknownInventories.push(parent);
      for(const child of inventory.children){
        if(!child||typeof child.childId!=='string'||!['one-shot','continuable','unknown','external'].includes(child.mode)){
          unknownInventories.push(parent);continue;
        }
        const previous=listed.get(child.childId);
        if(previous&&previous.mode!==child.mode){conflicts.push({parentSession:parent,childId:child.childId,reason:'conflicting-child-modes'});continue;}
        listed.set(child.childId,child);
      }
    }
    if(!listed.size&&parts.some(part=>Object.entries(part.tools.byName).some(([name,count])=>
      /^(subagent|subagent_fork|delegate_files)$/.test(name)&&count.calls)))unmatchedDelegations.push(parent);
    for(const child of listed.values()){
      const identity={parentSession:parent,childId:child.childId,mode:child.mode};
      if(child.mode==='external'){external.push(identity);continue;}
      const imported=sessions.get(child.childId);
      if(imported?.some(part=>part.parentSession!==parent)||child.childId===parent){
        conflicts.push({...identity,reason:'child-header-parent-mismatch'});continue;
      }
      if(!family.has(child.childId)||!imported)missing.push(identity);
    }
    for(const child of family)if(child!==parent&&sessions.get(child).some(part=>part.parentSession===parent)&&!listed.has(child))
      unlisted.push({parentSession:parent,childId:child});
  }
  const unknownInventorySessions=[...new Set(unknownInventories)],known=missing.length+external.length+unknownInventorySessions.length+unlisted.length+conflicts.length+unmatchedDelegations.length===0;
  return {status:known?'recorded-local-family-covered':'unknown',missingLocalChildren:missing,externalExecutions:external,
    unknownInventorySessions,unlistedImportedChildren:unlisted,lineageConflicts:conflicts,unmatchedDelegationSessions:unmatchedDelegations,
    scope:'Only recorded native local parent/child agent requests. External model work, plugin auxiliary calls and unreported provider retries are separate; no child session is opened automatically.'};
}
export async function trialsFor(directory,runs) {
  const sessions=new Map();for(const run of runs){const group=sessions.get(run.sessionId)||[];group.push(run);sessions.set(run.sessionId,group);}
  const trials=[];
  for(const [sessionId,own] of sessions){
    if(own[0].parentSession&&sessions.has(own[0].parentSession))continue;
    const family=new Set([sessionId]);let changed=true;
    while(changed){changed=false;for(const [child,parts] of sessions)if(!family.has(child)&&family.has(parts[0].parentSession)){family.add(child);changed=true;}}
    const parts=[...family].flatMap(id=>sessions.get(id));
    let assessment=null;
    if(safeId(sessionId))try{assessment=checkedLabel(JSON.parse(await fs.readFile(path.join(directory,'labels',sessionId+'.json'),'utf8')));}catch(error){if(error.code!=='ENOENT')throw new Error('Invalid label for '+sessionId+': '+error.message);}
    const requests=parts.reduce((sum,p)=>sum+p.requests.started,0);
    const settled=parts.reduce((sum,p)=>sum+p.requests.settled,0);
    const counters=Object.fromEntries(tokenFields.map(field=>[field,{known:parts.reduce((sum,p)=>sum+p.tokens[field].known,0),reportedRequests:parts.reduce((sum,p)=>sum+p.tokens[field].reportedRequests,0)}]));
    const detailLost=parts.some(p=>p.capture.lostDetailRows||p.capture.ioFailed||p.capture.malformedRows||p.partialStart);
    const finished=parts.every(p=>p.endReason!==null);
    const childCoverage=childCoverageFor(sessions,family),childCoverageUnknown=childCoverage.status==='unknown';
    const routes=[...new Set(parts.flatMap(p=>p.routes.map(route=>JSON.stringify(route))))].sort();
    const latest=[...own].sort((a,b)=>(b.startedAt||0)-(a.startedAt||0))[0];
    const accountingCoverage=parts.every(p=>!!p.attemptAccounting);
    const unknownConsumptionAttempts=parts.reduce((sum,p)=>sum+(p.attemptAccounting?.counts.unknownConsumptionAttempts??Math.max(p.requests.noSurfaceAttempts,p.requests.missingUsage)),0);
    const importedRequestsComplete=requests>0&&requests===settled&&counters.totalTokens.reportedRequests===requests&&!detailLost&&finished;
    const reportedTotalTokensComplete=importedRequestsComplete&&!childCoverageUnknown;
    const taskConsumption=taskRequestConsumption(parts),taskRequests=taskConsumption.requests,taskTokens=taskConsumption.tokens;
    const taskAccountingUnknown=taskConsumption.unknown;
    const totalTaskTokensComplete = reportedTotalTokensComplete && !taskAccountingUnknown &&
      unknownConsumptionAttempts === 0 && taskTokens.totalTokens.reportedRequests === taskRequests;
    trials.push({sessionId,turns:own.reduce((sum,p)=>sum+p.turnsStarted,0),childSessions:family.size-1,segments:parts.length,
      taskKey:assessment?.taskKey??null,contextKey:assessment?.contextKey??null,variant:assessment?.variant||own[0].variant,
      preset:own[0].preset,initialPreset:own[0].initialPreset??null,presetSource:own[0].presetSource??null,toolDefinitionsObserved:[...new Set(own.flatMap(p=>p.toolDefinitionsObserved||[]))].sort(),pluginVersions:[...new Set(parts.map(p=>p.pluginVersion).filter(Boolean))],collectorVersions:[...new Set(parts.map(p=>p.collectorVersion).filter(Boolean))],routes:routes.map(r=>JSON.parse(r)),
      requests,settledRequests:settled,tokens:counters,
      reportedTotalTokensComplete,totalTokensComplete:reportedTotalTokensComplete&&unknownConsumptionAttempts===0,
      importedRequestsComplete,unknownConsumptionAttempts,attemptAccountingCoverage:accountingCoverage?'recorded-attempts':'legacy-incomplete',
      nativeOnly:true,taskRequests,taskTokens,taskAccountingUnknown,totalTaskTokensComplete,
      taskRequestAccounting:taskConsumption.sessions,taskConsumptionProblems:taskConsumption.problems,taskRequestsByKind:taskConsumption.byKind,
      recordedRetries:accountingCoverage?parts.reduce((sum,p)=>sum+p.attemptAccounting.counts.retryEvents,0):null,
      observedRetryWaitMs:accountingCoverage?parts.reduce((sum,p)=>sum+p.attemptAccounting.observedRetryWaitMs,0):null,
      retryWaitCoverage:accountingCoverage?parts.reduce((sum,p)=>sum+p.attemptAccounting.counts.measuredRetryWaits,0):null,
      activeWallMs:own.length===1&&own[0].source?(parts.length===1?own[0].wallMs:null):(finished?unionMs(parts.map(p=>[p.startedAt,p.endedAt])):null),
      requestMsSummed:parts.reduce((sum,p)=>sum+p.requestTime.sumMs,0),requestTimingCoverage:parts.reduce((sum,p)=>sum+p.requestTime.measured,0),
      toolCalls:parts.reduce((sum,p)=>sum+p.tools.modelCalls,0),toolExecutions:parts.reduce((sum,p)=>sum+p.tools.executions,0),nestedToolExecutions:parts.reduce((sum,p)=>sum+p.tools.nestedExecutions,0),
      toolErrors:parts.reduce((sum,p)=>sum+p.tools.failures,0),
      noSurfaceAttempts:parts.reduce((sum,p)=>sum+p.requests.noSurfaceAttempts,0),
      reportsSaved:parts.reduce((sum,p)=>sum+p.delivery.reportsSaved,0),lastClaimedStatus:latest.delivery.lastClaimedStatus,
      automaticEvidenceNotices:parts.reduce((sum,p)=>sum+p.notices.automaticEvidence,0),repeatedEmptyLookupNotices:parts.reduce((sum,p)=>sum+p.notices.repeatedEmptyLookup,0),
      reportFileState:latest.workspaceArtifacts?.report?.state??'unreported',handoffFileState:latest.workspaceArtifacts?.handoff?.state??'unreported',
      optimization:latest.optimization||null,runtimeFileState:latest.workspaceArtifacts?.runtime?.state??'unreported',
      endReason:latest.endReason,finished,detailLost,childCoverageUnknown,childCoverage,
      outcome:assessment?.outcome||'unknown',score:assessment?.score??null,rubric:assessment?.rubric||null,evaluator:assessment?.evaluator||null,
      evidence:assessment?.evidence||[],runIds:parts.map(p=>p.runId),
    });
  }
  return trials;
}
export function compareTrials(trials,{taskKey,contextKey,reference='recorder-only'}) {
  if(!taskKey||!contextKey)throw new Error('compare requires --task and --context; matching labels must describe the same task and starting conditions');
  const selected=trials.filter(t=>t.taskKey===taskKey&&t.contextKey===contextKey),groups=new Map();
  for(const trial of selected){
    const routeKey=JSON.stringify(trial.routes),key=JSON.stringify([trial.variant,routeKey,trial.rubric]);
    const group=groups.get(key)||{variant:trial.variant,routes:trial.routes,rubric:trial.rubric,trials:[],routeKey};group.trials.push(trial);groups.set(key,group);
  }
  const result=[...groups.values()].map(group=>{
    const n=group.trials.length,scored=group.trials.filter(t=>t.score!==null),passes=group.trials.filter(t=>t.outcome==='pass');
    const tokenComplete=group.trials.every(t=>t.totalTaskTokensComplete===true),timeComplete=group.trials.every(t=>t.activeWallMs!==null);
    return {...group,trials:group.trials.map(t=>t.sessionId),n,correct:passes.length,incorrect:group.trials.filter(t=>t.outcome==='fail').length,
      unknown:group.trials.filter(t=>t.outcome==='unknown').length,scored:scored.length,meanQualityScore:scored.length?scored.reduce((s,t)=>s+t.score,0)/scored.length:null,
      knownTokens:group.trials.reduce((s,t)=>s+(t.taskTokens?.totalTokens.known??t.tokens.totalTokens.known),0),tokenComplete,
      nativeKnownTokens:group.trials.reduce((s,t)=>s+t.tokens.totalTokens.known,0),
      nativeMeanTokens:group.trials.every(t=>t.totalTokensComplete)?group.trials.reduce((s,t)=>s+t.tokens.totalTokens.known,0)/n:null,
      tokenScope:'native agent requests plus observed auxiliary and compaction streams across explicitly imported local descendants',
      unknownConsumptionAttempts:group.trials.reduce((s,t)=>s+(t.unknownConsumptionAttempts||0),0),
      meanReportedTokens:group.trials.every(t=>t.reportedTotalTokensComplete)?group.trials.reduce((s,t)=>s+t.tokens.totalTokens.known,0)/n:null,
      meanTokens:tokenComplete?group.trials.reduce((s,t)=>s+t.taskTokens.totalTokens.known,0)/n:null,
      meanActiveWallMs:timeComplete?group.trials.reduce((s,t)=>s+t.activeWallMs,0)/n:null,
      tokensPerCorrect:tokenComplete&&passes.length?group.trials.reduce((s,t)=>s+t.taskTokens.totalTokens.known,0)/passes.length:null};
  });
  for(const group of result){const ref=result.find(r=>r.variant===reference&&r.routeKey===group.routeKey&&r.rubric===group.rubric);
    group.tokenChangePct=ref&&ref.meanTokens>0&&group.meanTokens!==null?(group.meanTokens/ref.meanTokens-1)*100:null;}
  for(const group of result)delete group.routeKey;
  return {taskKey,contextKey,reference,groups:result,interpretation:'Observed local trials only; human/model assessments retain their evaluator and evidence. Unknown quality is not failure or success. No causal or billing claim.'};
}
const help=`DSH work evidence ${VERSION}\nCommands:\n  audit --file NATIVE_EVENTS_JSON_OR_JSONL [--observations REQUESTS_JSONL] [--session SESSION_ID] [--annotations audit.json] [--prices prices.json] [--assessment assessment.json] [--budget TOKENS] [--out audit-result.json]\n  import --session SESSION_ID --variant work-evidence|recorder-only\n  import --file ENGINEERING_JSON --variant work-evidence|recorder-only [--observations REQUESTS_JSONL]\n  list [--task KEY]\n  show --run RUN_ID\n  label --session SESSION_ID --file assessment.json\n  compare --task KEY --context KEY [--reference recorder-only]\n  export --out results.csv [--task KEY]\nGlobal: --dir ABSOLUTE_RECORD_DIRECTORY (otherwise $DSH_HOME/work-evidence/experiments)\nImport may set --home DSH_HOME --app DESKTOP_NODE_APP_DIRECTORY. Reads native sessions without starting DSH or a model.\nLabel file: {"taskKey":"...","contextKey":"...","variant":"work-evidence","outcome":"unknown","score":null,"evidence":[]}\nNon-unknown outcome requires evaluator and evidence; numeric score also requires rubric.\nLabels cover one main session and its recorded descendants; use a separate session per actual task.\n`;
async function main() {
  const [command,...rest]=process.argv.slice(2),options={};
  if(!command||['help','--help','-h'].includes(command)){console.log(help+'\nQuick comparison: pair --off SESSION_ID --on SESSION_ID --task TASK_KEY --context STARTING_CONDITIONS_KEY\n');return;}
  for(let i=0;i<rest.length;i+=2){if(!/^--[a-z]+$/.test(rest[i])||!rest[i+1]||rest[i+1].startsWith('--'))throw new Error('Expected --name value pairs');options[rest[i].slice(2)]=rest[i+1];}
  const allowed={audit:['file','annotations','prices','assessment','budget','out','observations','session'],pair:['dir','off','on','task','context','home','app'],import:['dir','session','variant','file','home','app','observations'],list:['dir','task'],show:['dir','run'],label:['dir','session','file'],compare:['dir','task','context','reference'],export:['dir','task','out']}[command];
  if(!allowed||Object.keys(options).some(key=>!allowed.includes(key)))throw new Error('Unknown command or option; use --help');
  if(command==='audit'){
    if(!options.file)throw Error('audit requires --file pointing to existing native events.');
    const {readAuditInput,auditDshSession}=await import('./trajectory-audit.mjs');
    const {input,problems}=await readAuditInput(path.resolve(options.file));
    let requestAccounting=null;
    if(options.observations){
      if(Array.isArray(input?.requests))throw Error('Use the saved request list or an observation ledger, not both.');
      const {readRequestAccounting}=await import('./experiment-consumption.mjs');
      const sessionId=options.session??input.sessionId??input.header?.id;
      if(!sessionId)throw Error('audit --observations requires --session when the native file has no session identity.');
      requestAccounting=await readRequestAccounting(path.resolve(options.observations),Array.isArray(input)?input:input.events,{sessionId});
    }
    const annotations=options.annotations?JSON.parse(await fs.readFile(options.annotations,'utf8')):[];
    const pricing=options.prices?JSON.parse(await fs.readFile(options.prices,'utf8')):[];
    const review=options.assessment?await readAuditInput(path.resolve(options.assessment)):null;
    if(review&&(review.problems.length||!review.input||Array.isArray(review.input)||typeof review.input!=='object'))
      throw Error('Assessment must contain one valid JSON object.');
    const tokenBudget=options.budget===undefined?null:Number(options.budget);
    if(options.budget!==undefined&&(!/^\d+$/u.test(options.budget)||!Number.isSafeInteger(tokenBudget)||tokenBudget<=0))
      throw Error('audit --budget must be a positive safe integer Token count.');
    const audit=auditDshSession(input,{sourceId:path.resolve(options.file),annotations,pricing,problems,assessment:review?.input??null,tokenBudget,requestAccounting});
    const body=JSON.stringify(audit,null,2)+'\n';
    if(options.out){
      const out=path.resolve(options.out);
      let outputReal=null,outputInfo=null;
      try{outputReal=await fs.realpath(out);outputInfo=await fs.stat(out);}catch(error){if(error.code!=='ENOENT')throw error;}
      for(const file of [options.file,options.annotations,options.prices,options.assessment,options.observations].filter(Boolean)){
        const [inputReal,inputInfo]=await Promise.all([fs.realpath(file),fs.stat(file)]);
        if(path.resolve(file)===out||inputReal===outputReal||outputInfo&&inputInfo.ino!==0&&inputInfo.dev===outputInfo.dev&&inputInfo.ino===outputInfo.ino)
          throw Error('Audit output must not overwrite any input file.');
      }
      await fs.writeFile(out,body);console.log(JSON.stringify({out,events:audit.sourceEventCount,candidates:audit.detectionCounts.remainingCandidates,
        confirmedIssues:audit.detectionCounts.confirmedIssues,confirmedWaste:audit.detectionCounts.confirmedWaste,taskOutcome:audit.taskOutcome,
        judgmentReviews:{status:audit.judgmentReviews.status,listed:audit.judgmentReviews.items.length,
          challenged:audit.judgmentReviews.items.filter(item=>item.status==='challenged').length,
          superseded:audit.judgmentReviews.items.filter(item=>item.status==='superseded').length,
          unknown:audit.judgmentReviews.items.filter(item=>item.status==='unknown').length},
        verification:{status:audit.verification.status,listedCriteria:audit.verification.listedCriteria,addressedCriteria:audit.verification.addressedCriteria,
          missedCriteria:audit.verification.missedCriteria,unknownCriteria:audit.verification.unknownCriteria,
          allListedCriteriaAddressed:audit.verification.allListedCriteriaAddressed},
        ...(audit.fullSuccessAtBudget?{fullSuccessAtBudget:audit.fullSuccessAtBudget}:{})}));
    }else console.log(body);
    return;
  }
  const home=options.home||process.env.DSH_HOME?.trim()||path.join(os.homedir(),'.dsh');
  const directory=path.resolve(options.dir||path.join(home,'work-evidence','experiments'));
  if(command==='pair'){
    if(!safeId(options.off)||!safeId(options.on)||options.off===options.on||!options.task||!options.context)throw new Error('pair requires different --off and --on session IDs, --task and --context');
    const {importSession}=await import('./experiment-native.mjs');
    for(const [sessionId,variant] of [[options.off,'recorder-only'],[options.on,'work-evidence']]){
      await importSession({directory,sessionId,variant,home,app:desktopApp(options.app)});
      const labelFile=path.join(directory,'labels',sessionId+'.json');let previous=null;
      try{previous=JSON.parse(await fs.readFile(labelFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(previous&&(previous.taskKey!==options.task||previous.contextKey!==options.context||previous.variant!==variant))throw new Error('Existing session label disagrees with this pair; use explicit label to change it');
      if(!previous){await fs.mkdir(path.dirname(labelFile),{recursive:true});await writeJson(labelFile,checkedLabel({taskKey:options.task,contextKey:options.context,variant,outcome:'unknown',score:null,evidence:[]}));}
    }
    const imported=await readRuns(directory),all=await trialsFor(directory,imported.runs);
    console.log(JSON.stringify({directory,problems:imported.problems,...compareTrials(all,{taskKey:options.task,contextKey:options.context})},null,2));return;
  }
  if(command==='import'){
    if(options.session&&!safeId(options.session))throw new Error('Invalid session id');
    if(!!options.session===!!options.file)throw new Error('Specify exactly one of --session or --file');
    const {importSession}=await import('./experiment-native.mjs');
    console.log(JSON.stringify(await importSession({directory,sessionId:options.session,variant:options.variant,home,app:desktopApp(options.app),file:options.file,observations:options.observations}),null,2));return;
  }
  const {runs,problems}=await readRuns(directory);
  if(command==='show'){
    if(!safeId(options.run))throw new Error('Invalid run id');const run=runs.find(r=>r.runId===options.run);if(!run)throw new Error('Run not found');console.log(JSON.stringify(run,null,2));return;
  }
  if(command==='label'){
    if(!safeId(options.session)||!options.file)throw new Error('label requires --session and --file');
    if(!runs.some(run=>run.sessionId===options.session&&!run.parentSession))throw new Error('Observed main session not found; do not independently score its children');
    const assessment=checkedLabel(JSON.parse(await fs.readFile(options.file,'utf8')));
    await fs.mkdir(path.join(directory,'labels'),{recursive:true});await writeJson(path.join(directory,'labels',options.session+'.json'),assessment);
    console.log(JSON.stringify({saved:true,sessionId:options.session,assessment}));return;
  }
  const allTrials=await trialsFor(directory,runs),trials=options.task?allTrials.filter(t=>t.taskKey===options.task):allTrials;
  if(command==='compare'){console.log(JSON.stringify({directory,problems,...compareTrials(trials,{taskKey:options.task,contextKey:options.context,reference:options.reference})},null,2));return;}
  if(command==='export'){
    if(!options.out)throw new Error('export requires --out');
    const fields=['sessionId','taskKey','contextKey','variant','preset','initialPreset','presetSource','toolDefinitionsObserved','turns','childSessions','requests','knownTotalTokens','tokenComplete','reportedTotalTokensComplete','importedRequestsComplete','childCoverageUnknown','childCoverage','unknownConsumptionAttempts','attemptAccountingCoverage','recordedRetries','observedRetryWaitMs','retryWaitCoverage','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','reasoningTokens','nativeOnly','taskRequests','knownTaskTokens','totalTaskTokensComplete','taskAccountingUnknown','taskRequestAccounting','taskConsumptionProblems','taskRequestsByKind','activeWallMs','toolCalls','nestedToolExecutions','toolErrors','reportsSaved','lastClaimedStatus','automaticEvidenceNotices','repeatedEmptyLookupNotices','reportFileState','handoffFileState','runtimeFileState','optimization','endReason','outcome','score','rubric','evaluator'];
    const cell=value=>{const str=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);return '"'+(/^[=+@-]/.test(str)?"'":'')+str.replaceAll('"','""')+'"';};
    const lines=trials.map(t=>{const row={...t,knownTotalTokens:t.tokens.totalTokens.known,knownTaskTokens:t.taskTokens.totalTokens.known,tokenComplete:t.totalTokensComplete,uncachedInputTokens:t.tokens.inputTokens.reportedRequests===t.requests?t.tokens.inputTokens.known:null};for(const field of tokenFields)if(field!=='inputTokens'&&field!=='totalTokens')row[field]=t.tokens[field].reportedRequests===t.requests?t.tokens[field].known:null;return fields.map(f=>cell(row[f])).join(',');});
    const output=path.resolve(options.out);await fs.writeFile(output,'\uFEFF'+[fields.join(','),...lines].join('\r\n')+'\r\n','utf8');console.log(JSON.stringify({saved:true,path:output,trials:trials.length,problems}));return;
  }
  console.log(JSON.stringify({directory,problems,trials},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
