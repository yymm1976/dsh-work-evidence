import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {VERSION,newSummary,applyRow,cleanUsage,writeJson} from './experiment-store.mjs';
import {summarizeAttempts} from './experiment-attempts.mjs';
import {accountSessionRequests,readRequestAccounting} from './experiment-consumption.mjs';
import os from 'node:os';
import {nativeChildCatalogMode} from './host-references.mjs';

export function nativeChildInventory(events,{inherited=0,source='engineering-artifact'}={}){
  if(!Array.isArray(events)||!Number.isSafeInteger(inherited)||inherited<0||inherited>events.length)throw Error('Invalid native event range for child inventory.');
  const children=new Map(),problems=[];let throughSeq=null;
  for(const event of events.slice(inherited)){
    if(Number.isSafeInteger(event.seq))throughSeq=throughSeq===null?event.seq:Math.max(throughSeq,event.seq);
    if(event.type!=='subagent/catalog')continue;
    const value=event.data,mode=nativeChildCatalogMode(value);
    if(!Number.isSafeInteger(event.seq)||event.seq<0||!mode){
      problems.push({seq:event.seq??null,reason:'invalid-child-catalog'});continue;
    }
    const child={childId:value.childId,mode,version:value.version,childCreatedAt:value.childCreatedAt,sourceSeq:event.seq,
      ...(value.version===3?{name:value.name}:{})};
    const prior=children.get(child.childId);
    if(prior&&(prior.mode!==child.mode||prior.childCreatedAt!==child.childCreatedAt||
      prior.name!==undefined&&child.name!==undefined&&prior.name!==child.name))problems.push({seq:event.seq,reason:'conflicting-child-catalog',childId:child.childId});
    else if(!prior||prior.name===undefined&&child.name!==undefined)children.set(child.childId,child);
  }
  return {schema:'work-evidence.native-child-inventory.v1',source,complete:source==='native-session-readonly'&&throughSeq!==null&&!problems.length,
    throughSeq,children:[...children.values()],problems,
    scope:'Recorded own parent catalog only, inherited prefix excluded. Child identities do not authorize reading another session or establish model consumption. External entries have no local child session.'};
}

export async function importSession({directory,sessionId,variant,home,app,file,observations}) {
  if(!['work-evidence','recorder-only'].includes(variant))throw new Error('Import requires --variant work-evidence or recorder-only');
  const require=createRequire(path.join(app,'package.json'));
  const {assistantStreamFirstTokenTime,lastAssistantStreamChunk}=require('@deepseek-ai/dsh-llm');
  let events,header={},inherited=0,ctx,handle,observationsFile=observations?path.resolve(observations):null;
  if(file){const data=JSON.parse(await fs.readFile(file,'utf8'));events=data.events;header={id:data.sessionId,cwd:data.workspace};if(sessionId&&sessionId!==data.sessionId)throw new Error('Session id does not match the supplied engineering artifact');sessionId=data.sessionId;}
  else{
    if(!sessionId)throw new Error('Import requires --session');
    const {Context}=require('@deepseek-ai/cordis'),boot=require('@deepseek-ai/dsh-app-boot');
    const profile=boot.loadProfileDirectory('dsh',path.join(home,'profiles/web'),path.join(app,'package.json'));
    const resolution=await boot.createRuntimeResolution({installAnchor:path.join(app,'package.json'),profile,home});ctx=new Context();
    try{
      let fiber=await ctx.plugin(boot.PluginPackages,{resolution});await fiber.ready;
      const Persistence=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')));
      fiber=await ctx.plugin(Persistence.default||Persistence,{root:path.join(home,'sessions')});await fiber.ready;
      handle=await ctx.sessionPersistence.open(sessionId,'read');header=handle.header;inherited=handle.inheritedEventCount||0;
      events=(await handle.read()).events;
      if(!observationsFile){
        const location=ctx.sessionPersistence.locate?.({...header,id:sessionId}),root=header.cwd;
        const outside=target=>typeof root==='string'&&path.isAbsolute(root)&&
          (path.relative(root,target)==='..'||path.relative(root,target).startsWith('..'+path.sep)||path.isAbsolute(path.relative(root,target)));
        const hosted=typeof location?.path==='string'&&path.isAbsolute(location.path)?path.join(path.dirname(location.path),'work-evidence'):null;
        const fallback=path.join(os.homedir(),'.dsh','work-evidence','sessions',sessionId);
        const telemetry=hosted&&outside(hosted)?hosted:outside(fallback)?fallback:null;
        if(telemetry)observationsFile=path.join(telemetry,sessionId+'.observability.jsonl');
      }
    }finally{await handle?.close();await ctx.fiber.dispose();}
  }
  if(!Array.isArray(events)||!sessionId)throw new Error('No native session events found');
  // The immutable creation header is not the mounted preset: blank sessions can
  // select another preset before their first turn. Follow the native projection.
  let selectedPreset=header.agentPreset||null;
  const requestPresets=new Set(),presetSelections=[],toolDefinitionsObserved=new Set(),pluginVersions=new Set(),requestVariants=new Set();
  let mountedVersion=null;
  for(let index=0;index<events.length;index++){
    const event=events[index],data=event.data||{};
    if(event.type==='agent-preset/selected'){
      selectedPreset=data.agentPreset??null;
      presetSelections.push({sourceSeq:event.seq??null,preset:selectedPreset});
    }
    if(event.type==='system/message'){
      const text=((data.message||data).content||[]).filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n');
      mountedVersion=/工程证据\s*(\d+\.\d+\.\d+)：/.exec(text)?.[1]||null;
      if(index>=inherited)for(const name of ['project_evidence','work_report'])if(new RegExp('\\b'+name+'\\s*:\\s*\\{').test(text))toolDefinitionsObserved.add(name);
    }
    if(index>=inherited&&['assistant/message','assistant/attempt'].includes(event.type)){
      requestPresets.add(selectedPreset);
      if(mountedVersion)pluginVersions.add(mountedVersion);
      // Host mounting makes the preset name insufficient to identify the arm.
      // A visible plugin marker proves availability, not successful automation.
      // The shared PTC preset can host this plugin in either arm. Its name alone cannot prove absence.
      requestVariants.add(mountedVersion||selectedPreset==='work-evidence-ptc'?'work-evidence':'unknown');
    }
  }
  const usedPresets=[...requestPresets];
  if(usedPresets.length>1)throw new Error('This snapshot contains requests under multiple presets; do not aggregate it into one experiment arm');
  const preset=usedPresets.length?usedPresets[0]:selectedPreset;
  const knownVariants=new Set([...requestVariants].filter(value=>value!=='unknown'));
  if(knownVariants.size>1)throw new Error('This snapshot spans different plugin availability states; do not aggregate it into one experiment arm');
  const recordedVariant=requestVariants.size===1&&!requestVariants.has('unknown')?[...requestVariants][0]:null;
  if(!file&&knownVariants.has('work-evidence')&&variant==='recorder-only')throw new Error('The requested experiment arm disagrees with recorded plugin availability: work-evidence');
  const meta={runId:randomUUID(),sessionId,parentSession:header.parentSession||null,origin:header.origin||'main',
    preset,initialPreset:header.agentPreset||null,presetSelections,presetSource:file?'engineering-artifact':usedPresets.length?'request-preset-event-fold':'selected-preset-event-fold',toolDefinitionsObserved:[...toolDefinitionsObserved].sort(),
    workspace:header.cwd||null,turn:null,startedAt:null,firstSourceSeq:null,partialStart:false,
    pluginVersion:pluginVersions.size===1?[...pluginVersions][0]:null,collectorVersion:VERSION,variant,recordedPluginAvailability:recordedVariant,
    variantSource:!file&&recordedVariant?'recorded-request-plugin-presence':'operator-label',source:file?'engineering-artifact':'native-session-readonly',importedAt:new Date().toISOString()};
  meta.childInventory=nativeChildInventory(events,{inherited,source:meta.source});
  meta.requestAccounting=observationsFile?await readRequestAccounting(observationsFile,events,{sessionId,inherited}):
    accountSessionRequests(events,[],{sessionId,inherited,problems:[{reason:'observation-source-not-supplied'}]});
  // Automatic writes need not have a model tool-call event. Observe the two
  // exact report paths separately; file presence never substitutes for a call.
  meta.workspaceArtifacts={};
  if(typeof header.cwd==='string'&&/^[-a-zA-Z0-9_][-.a-zA-Z0-9_]{0,127}$/.test(sessionId)){
    for(const [key,suffix] of [['report','.md'],['handoff','-interrupted.md']]){
      const target=path.join(header.cwd,'.dsh','work-evidence',sessionId+suffix);
      try{const stat=await fs.stat(target);meta.workspaceArtifacts[key]={state:stat.isFile()?'present':'not-file',modifiedAt:stat.mtime.toISOString()};}
      catch(error){meta.workspaceArtifacts[key]={state:error.code==='ENOENT'?'absent':'unavailable'};}
    }
    try{
      const target=path.join(header.cwd,'.dsh','work-evidence',sessionId+'.runtime.json'),stat=await fs.stat(target);
      if(stat.size>100000)throw new Error('Oversized runtime record');
      const record=JSON.parse(await fs.readFile(target,'utf8'));
      if(record.sessionId!==sessionId||typeof record.metrics!=='object')throw new Error('Invalid runtime record');
      meta.optimization={version:record.version,at:record.at,metrics:Object.fromEntries(Object.entries(record.metrics).filter(([,v])=>typeof v==='number'&&Number.isFinite(v)&&v>=0)),
        auxiliaryUsage:cleanUsage(record.metrics.auxiliaryUsage||{}),requestObservations:Array.isArray(record.requestObservations)?record.requestObservations.slice(-24):[],scope:'Plugin activity counters; assembled request options do not prove provider transport parameter mapping. Auxiliary usage is separate from native main-agent usage. Not causal token savings.'};
      meta.workspaceArtifacts.runtime={state:'present',modifiedAt:stat.mtime.toISOString()};
    }catch(error){meta.workspaceArtifacts.runtime={state:error.code==='ENOENT'?'absent':'unavailable'};}
  }
  const summary=newSummary(meta),rows=[],starts=new Map(),steps=new Map();let route=null;
  const add=row=>{applyRow(summary,row);rows.push(JSON.stringify(row));};
  for(let index=inherited;index<events.length;index++){
    const event=events[index],data=event.data||{},at=typeof event.time==='number'?event.time:null,seq=event.seq??null;
    if(event.type==='subagent/catalog'){
      const child=meta.childInventory.children.find(item=>item.sourceSeq===seq);
      if(child)add({kind:'child-identity',at,sourceSeq:seq,...child});
    }else if(event.type==='user/message'){
      const message=data.message||data;
      if(message.source?.kind==='work-evidence')for(const block of message.content||[]){
        if(block.type!=='text')continue;
        if(block.text?.startsWith('已观察的工程失败与局部源码'))add({kind:'plugin-notice',notice:'automatic-evidence',at,sourceSeq:seq});
        if(block.text?.startsWith('已观察的局部检索事实'))add({kind:'plugin-notice',notice:'repeated-empty-lookup',at,sourceSeq:seq});
      }
    }else if(event.type==='turn/start'){if(meta.startedAt===null&&at!==null){meta.startedAt=at;summary.startedAt=at;}add({kind:'turn-start',at,sourceSeq:seq});}
    else if(event.type==='step/start')steps.set(data.turn+':'+data.step,at);
    else if(event.type==='request/header'){const config=data.header?.config;route=config?{provider:config.provider||null,model:config.model||null,reasoningEffort:config.reasoningEffort||null,maxTokens:Number.isFinite(config.maxTokens)?config.maxTokens:null}:null;}
    else if(event.type==='assistant/message'||event.type==='assistant/attempt'){
      const source=data.message?.source,begin=steps.get(data.turn+':'+data.step),first=assistantStreamFirstTokenTime(data.stream||[]);
      const usage=data.usage||lastAssistantStreamChunk(data.stream||[],'usage')?.usage;
      add({kind:'request-start',at:begin??null,route:route||{provider:source?.provider||null,model:source?.model||null,reasoningEffort:null}});
      add({kind:'request-end',at,sourceSeq:seq,usage:usage?cleanUsage(usage):null,noSurfaceAttempt:event.type==='assistant/attempt',interrupted:!!data.interrupted,
        elapsedMs:at!==null&&begin!=null?Math.max(0,at-begin):null,firstTokenMs:begin!=null&&first!==undefined?Math.max(0,first-begin):null});
      // Retries within a step have no separate durable start marker. Do not reuse its first timestamp.
      steps.delete(data.turn+':'+data.step);
    }else if(event.type==='tool/call'){starts.set(data.callId,{at,name:data.name,arguments:data.arguments});add({kind:'model-tool-call',at,sourceSeq:seq,tool:data.name});}
    else if(event.type==='tool/ptc-dispatch-start')starts.set('ptc:'+data.subCallId,{at,name:data.name,arguments:data.arguments});
    else if(event.type==='tool/result'||event.type==='tool/ptc-dispatch'){
      const nested=event.type==='tool/ptc-dispatch',key=nested?'ptc:'+data.subCallId:data.message?.source?.callId;
      const start=starts.get(key);starts.delete(key);
      const content=(nested?data.content:data.message?.content)||[];
      // Native surface logs preserve isError; a shell's numeric exit code may not be available here.
      const row={kind:'tool-end',at,sourceSeq:seq,tool:start?.name||(nested?data.name:null)||'(unmatched tool)',nested,error:nested?!!data.isError:!!data.message?.isError,nonzeroExit:false,
        elapsedMs:at!==null&&start?.at!=null?Math.max(0,at-start.at):null,resultTextChars:content.reduce((n,b)=>n+(b.type==='text'&&typeof b.text==='string'?b.text.length:0),0)};
      if(/(^|[./])work_report$/.test(row.tool)&&!row.error){for(const block of content)if(block.type==='text')try{const result=JSON.parse(block.text);if(result.saved===true){row.reportSaved=true;row.claimedStatus=result.claimedStatus;}}catch{}}
      if(/(^|[./])project_evidence$/.test(row.tool))row.evidenceMode=(start?.arguments||data.arguments)?.mode;
      add(row);
    }else if(event.type==='turn/end')add({kind:'turn-end',at,sourceSeq:seq,reason:data.reason?.kind||'unknown'});
  }
  if(!events.length)throw new Error('Session contains no events');
  summary.attemptAccounting=summarizeAttempts(events.slice(inherited));
  if(meta.startedAt===null)summary.coverage.partialStart=true;
  summary.coverage.scope='Native recorded usage and surface/PTC-dispatch events; attemptAccounting separates failed explicit-zero/missing usage and recorded retry waits. Unpublished adapter requests and billing remain unknown. Nested tool durations overlap outer run_code. Historical fork prefix excluded.';
  // Imported durations must never be presented as live transport or execution timing.
  meta.timingSource='native-event-step-and-tool-boundaries';
  const target=path.join(directory,meta.runId);await fs.mkdir(target,{recursive:true});
  await writeJson(path.join(target,'meta.json'),meta);
  await fs.writeFile(path.join(target,'events.jsonl'),rows.join('\n')+'\n','utf8');
  await writeJson(path.join(target,'summary.json'),summary);
  // A new import supersedes an earlier snapshot of this same session in readRuns().
  return {runId:meta.runId,sessionId,variant,source:meta.source,requests:summary.requests.settled,knownTokens:summary.tokens.totalTokens.known,reportSaved:summary.delivery.reportsSaved>0};
}
