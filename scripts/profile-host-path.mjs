import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {startHost,text,tool,requestText} from '../test/helpers/host.mjs';

const rounds=Math.max(1,Number(process.env.WE_PROFILE_HOST_ROUNDS??3));
const TASK='读取源码文件以检查历史增长和原生工具处理。只做只读核对，完成后报告。';
const PWSH_PATH=process.env.WE_PROFILE_PWSH?.trim()||(process.platform==='win32'?'D:/dsh-tools/pwsh7/pwsh.exe':null);
const MODES=[
  {name:'plugin-off',variable:null,mountPlugin:false,workspace:null},
  {name:'plugin-default',variable:null,mountPlugin:true,workspace:{}},
  {name:'request-accounting-off',variable:'requestAccounting',mountPlugin:true,workspace:{requestAccounting:false}},
  {name:'history-hygiene-off',variable:'historyHygiene',mountPlugin:true,workspace:{historyHygiene:false}},
  {name:'step-pacing-off',variable:'stepPacing',mountPlugin:true,workspace:{stepPacing:false}},
  {name:'context-protocol-off',variable:'contextProtocol',mountPlugin:true,workspace:{contextProtocol:false}},
];
const FS_OPS=['appendFile','lstat','mkdir','open','readFile','readdir','rename','rm','stat','truncate','writeFile'];

const percentile=(samples,ratio)=>{
  if(!samples.length)return null;
  const ordered=[...samples].sort((left,right)=>left-right);
  return ordered[Math.min(ordered.length-1,Math.floor(ordered.length*ratio))];
};
const median=samples=>percentile(samples,0.5);
const round=value=>value===null||value===undefined?null:Math.round(value*100)/100;
const mean=samples=>samples.length?samples.reduce((sum,value)=>sum+value,0)/samples.length:null;
const areaOf=file=>{
  const value=String(file??'').replaceAll('\\','/');
  if(value.endsWith('/config.json')||value==='config.json')return 'config';
  if(value.includes('.dsh/work-evidence'))return 'telemetry';
  if(value.includes('.sessions'))return 'sessions';
  if(value.includes('we-host-'))return 'workspace';
  return 'other';
};

let fsWindow=null;
const fsOriginals=new Map();
function fsBucket(window,map,key){
  return map[key]??={calls:0,errors:0,totalMs:0,samples:[]};
}
function recordFs(operation,args,elapsed,ok){
  if(!fsWindow)return;
  const file=typeof args[0]==='string'?args[0]:'';
  const area=areaOf(file);
  const bucket=fsBucket(fsWindow,fsWindow.byOp,operation);
  bucket.calls++;bucket.errors+=ok?0:1;bucket.totalMs+=elapsed;bucket.samples.push(elapsed);
  const areaBucket=fsBucket(fsWindow,fsWindow.byArea,area);
  areaBucket.calls++;areaBucket.errors+=ok?0:1;areaBucket.totalMs+=elapsed;areaBucket.samples.push(elapsed);
  fsWindow.calls++;fsWindow.errors+=ok?0:1;fsWindow.totalMs+=elapsed;
}
function installFsMetrics(){
  for(const operation of FS_OPS){
    const original=fs[operation];
    if(typeof original!=='function')continue;
    fsOriginals.set(operation,original);
    fs[operation]=async function(...args){
      const started=performance.now();
      try{
        const result=await original.apply(this,args);
        recordFs(operation,args,performance.now()-started,true);
        return result;
      }catch(error){
        recordFs(operation,args,performance.now()-started,false);
        throw error;
      }
    };
  }
}
function restoreFsMetrics(){
  for(const [operation,original] of fsOriginals)fs[operation]=original;
  fsOriginals.clear();
}
function startFsWindow(){
  fsWindow={calls:0,errors:0,totalMs:0,byOp:{},byArea:{}};
  return fsWindow;
}
function finishFsWindow(window=fsWindow){
  if(fsWindow===window)fsWindow=null;
  if(!window)return null;
  const describe=bucket=>({calls:bucket.calls,errors:bucket.errors,totalMs:round(bucket.totalMs),
    p50Ms:round(median(bucket.samples)),p95Ms:round(percentile(bucket.samples,.95)),samples:bucket.samples.slice()});
  return {calls:window.calls,errors:window.errors,totalMs:round(window.totalMs),
    byOp:Object.fromEntries(Object.entries(window.byOp).map(([key,value])=>[key,describe(value)])),
    byArea:Object.fromEntries(Object.entries(window.byArea).map(([key,value])=>[key,describe(value)]))};
}

let toolWindow=null;
function recordTool(name,elapsed,ok,isError){
  if(!toolWindow)return;
  const key=name||'unknown';
  const bucket=toolWindow.byName[key]??={calls:0,errors:0,totalMs:0,samples:[]};
  bucket.calls++;bucket.errors+=ok&&!isError?0:1;bucket.totalMs+=elapsed;bucket.samples.push(elapsed);
  toolWindow.calls++;toolWindow.errors+=ok&&!isError?0:1;toolWindow.totalMs+=elapsed;
  if(ok&&isError)toolWindow.toolErrors=(toolWindow.toolErrors??0)+1;
}
function startToolWindow(){
  toolWindow={calls:0,errors:0,toolErrors:0,totalMs:0,byName:{}};
  return toolWindow;
}
function finishToolWindow(window=toolWindow){
  if(toolWindow===window)toolWindow=null;
  if(!window)return null;
  return {calls:window.calls,errors:window.errors,toolErrors:window.toolErrors,totalMs:round(window.totalMs),
    byName:Object.fromEntries(Object.entries(window.byName).map(([key,value])=>[key,{calls:value.calls,errors:value.errors,
      totalMs:round(value.totalMs),p50Ms:round(median(value.samples)),p95Ms:round(percentile(value.samples,.95)),
      samples:value.samples.slice()}]))};
}
function installToolMetrics(host){
  const service=host.ctx.tools;
  const tools=service?.[Symbol.for('cordis.original')]??service;
  if(!tools||typeof tools.execute!=='function')return ()=>{};
  const original=tools.execute;
  tools.execute=async function(...args){
    const input=args[0],names=Array.isArray(input?.calls)?input.calls.map(call=>call?.name).filter(Boolean):[],
      name=names.length===1?names[0]:names.length>1?'batch':input?.name??'unknown';
    const started=performance.now();
    try{
      const result=await original.apply(this,args);
      const error=result?.isError===true||(Array.isArray(result?.results)&&result.results.some(item=>item?.result?.isError===true));
      recordTool(name,performance.now()-started,true,error);
      return result;
    }catch(error){
      recordTool(name,performance.now()-started,false,true);
      throw error;
    }
  };
  return ()=>{tools.execute=original;};
}

async function fixture(cwd){
  await fs.mkdir(path.join(cwd,'src'),{recursive:true});
  for(let index=0;index<10;index++){
    const lines=Array.from({length:180},(_,line)=>
      `export const file${index}_line${line} = "${'x'.repeat(64)}";`);
    await fs.writeFile(path.join(cwd,'src',`file${index}.js`),lines.join('\n')+'\n');
  }
}

async function observe(mode){
  const bootStarted=performance.now();
  let measuring=false,step=0,lastRequestAt=null;
  const requestGaps=[];
  const host=await startHost({
    mountPlugin:mode.mountPlugin,
    workspace:mode.workspace,
    pwshPath:PWSH_PATH,
    script:()=>{
      if(!measuring)return [text('warmup complete')];
      const now=performance.now();
      if(lastRequestAt!==null)requestGaps.push(now-lastRequestAt);
      lastRequestAt=now;
      step++;
      if(step<=10)return [tool('read',{file_path:`src/file${step-1}.js`})];
      if(step<=14)return [tool('read',{file_path:`src/file${step-11}.js`})];
      if(step===15)return [tool('grep',{path:'src',pattern:'file0_line0'})];
      if(step===16)return [tool('pwsh',{command:'Get-Content src/file0.js | Select-Object -First 20',description:'Read the first source fixture lines'})];
      if(step===17)return [tool('read',{file_path:'src/does-not-exist.js'})];
      if(step===18)return [tool('read',{file_path:'src/file0.js'})];
      if(step<=20)return [tool('read',{file_path:`src/file${step-19}.js`})];
      return [text('完成。')];
    },
  });
  const bootMs=performance.now()-bootStarted;
  const restoreTools=installToolMetrics(host);
  let handle=null;
  try{
    await fixture(host.cwd);
    const warm=await host.createAgentHandle('max');
    await host.send(warm.agent,'warm up the host and plugin modules');
    await warm.dispose();
    host.requests.length=0;
    host.events.length=0;
    host.auxiliaryRequests.length=0;
    step=0;
    lastRequestAt=null;
    requestGaps.length=0;
    measuring=true;

    let window=startFsWindow();
    const createStarted=performance.now();
    handle=await host.createAgentHandle('max');
    const createMs=performance.now()-createStarted;
    const createFs=finishFsWindow(window);

    let status=null,initMs=null,initFs=null;
    if(mode.mountPlugin){
      window=startFsWindow();
      const initStarted=performance.now();
      status=await host.command(handle.agent,'status');
      initMs=performance.now()-initStarted;
      initFs=finishFsWindow(window);
    }

    startToolWindow();
    window=startFsWindow();
    const sendStarted=performance.now();
    await host.send(handle.agent,TASK);
    const sendMs=performance.now()-sendStarted;
    const sendFs=finishFsWindow(window);
    const tools=finishToolWindow();
    await new Promise(resolve=>setTimeout(resolve,120));

    let after=null,statusMs=null,statusFs=null;
    if(mode.mountPlugin){
      window=startFsWindow();
      const statusStarted=performance.now();
      after=await host.command(handle.agent,'status');
      statusMs=performance.now()-statusStarted;
      statusFs=finishFsWindow(window);
    }
    const requestChars=host.requests.reduce((sum,request)=>sum+requestText(request).length,0);
    const requestLengths=host.requests.map(request=>requestText(request).length);
    const messageCounts=host.requests.map(request=>request.messages?.length??0);
    const firstChars=requestLengths[0]??0,lastChars=requestLengths.at(-1)??0;
    let telemetry=null;
    if(mode.mountPlugin){
      const file=after?.observability?.persistence?.file??status?.observability?.persistence?.file;
      if(file){
        try{
          window=startFsWindow();
          const body=await fs.readFile(file,'utf8');
          const telemetryFs=finishFsWindow(window);
          telemetry={bytes:Buffer.byteLength(body),rows:body.split('\n').filter(Boolean).length,
            complete:after?.observability?.persistence?.complete??null,readFs:telemetryFs};
        }catch(error){telemetry={missing:true,error:error.code??String(error)};}
      }
    }
    window=startFsWindow();
    const disposeStarted=performance.now();
    await handle.dispose();
    handle=null;
    const disposeMs=performance.now()-disposeStarted;
    const disposeFs=finishFsWindow(window);
    const meanStepMs=requestGaps.length?requestGaps.reduce((sum,value)=>sum+value,0)/requestGaps.length:null;
    return {bootMs,createMs,initMs,statusMs,sendMs,disposeMs,meanStepMs,requests:host.requests.length,
      toolResults:host.events.filter(event=>event.type==='tool/result').length,
      failedToolResults:host.events.filter(event=>event.type==='tool/result'&&(event.data?.message?.isError===true||event.data?.isError===true)).length,
      stepP50Ms:percentile(requestGaps,.5),stepP95Ms:percentile(requestGaps,.95),
      requestChars,maxRequestChars:Math.max(0,...requestLengths),maxMessages:Math.max(0,...messageCounts),
      firstRequestChars:firstChars,finalRequestChars:lastChars,historyGrowthChars:lastChars-firstChars,
      finalMessages:messageCounts.at(-1)??0,auxiliaryRequests:host.auxiliaryRequests.length,
      telemetry,providerScriptedWaitMs:0,
      fs:{create:createFs,init:initFs,send:sendFs,status:statusFs,dispose:disposeFs},tools};
  }finally{
    restoreTools();
    if(handle)await handle.dispose().catch(()=>{});
    await host.close();
  }
}

function aggregateBuckets(samples){
  const buckets=new Map();
  for(const sample of samples.filter(Boolean)){
    for(const [key,value] of Object.entries(sample)){
      let bucket=buckets.get(key);
      if(!bucket){bucket={calls:0,errors:0,totalMs:0,samples:[]};buckets.set(key,bucket);}
      bucket.calls+=value.calls??0;bucket.errors+=value.errors??0;bucket.totalMs+=value.totalMs??0;
      bucket.samples.push(...(value.samples??[]));
    }
  }
  return Object.fromEntries([...buckets].map(([key,value])=>[key,{calls:value.calls,errors:value.errors,
    totalMs:round(value.totalMs),p50Ms:round(median(value.samples)),p95Ms:round(percentile(value.samples,.95))}]));
}
function aggregateFs(samples){
  const total={calls:0,errors:0,totalMs:0};
  for(const sample of samples.filter(Boolean)){
    total.calls+=sample.calls??0;total.errors+=sample.errors??0;total.totalMs+=sample.totalMs??0;
  }
  return {...total,totalMs:round(total.totalMs),byOp:aggregateBuckets(samples.map(sample=>sample?.byOp)),
    byArea:aggregateBuckets(samples.map(sample=>sample?.byArea))};
}
function aggregateTools(samples){
  const total={calls:0,errors:0,toolErrors:0,totalMs:0};
  for(const sample of samples.filter(Boolean)){
    total.calls+=sample.calls??0;total.errors+=sample.errors??0;total.toolErrors+=sample.toolErrors??0;total.totalMs+=sample.totalMs??0;
  }
  return {...total,totalMs:round(total.totalMs),byName:aggregateBuckets(samples.map(sample=>sample?.byName))};
}
function summarizeRuns(runs){
  const numeric=['bootMs','createMs','initMs','statusMs','sendMs','disposeMs','meanStepMs','stepP50Ms','stepP95Ms',
    'requests','toolResults','failedToolResults','requestChars','maxRequestChars','maxMessages','firstRequestChars',
    'finalRequestChars','historyGrowthChars','finalMessages','auxiliaryRequests'];
  const summary={};
  for(const key of numeric){
    const values=runs.map(run=>run[key]).filter(value=>typeof value==='number');
    summary[key]=key.endsWith('Ms')?{p50Ms:round(median(values)),p95Ms:round(percentile(values,.95))}:
      {mean:values.length?round(mean(values)):null};
  }
  summary.sendFs=aggregateFs(runs.map(run=>run.fs?.send));
  summary.initFs=aggregateFs(runs.map(run=>run.fs?.init));
  summary.tools=aggregateTools(runs.map(run=>run.tools));
  return summary;
}

installFsMetrics();
const evidence={schema:'work-evidence.host-profile.v1',generatedAt:new Date().toISOString(),
  node:process.version,platform:process.platform,rounds,
  scope:'deterministic host loop with native read/grep/pwsh tools; scripted model wait is zero; local filesystem, tool, history and persistence segments',
  caveat:'This measures local plugin, host, filesystem and tool processing. It does not measure provider latency, provider billing, auxiliary-model work or causal task savings. No online model request is made.',
  task:{requestsPerRun:21,promptChars:TASK.length,fixtureFiles:10,fixtureLinesPerFile:180,repeatedReads:7,failedReads:1},
  modes:[],peakRssBytes:null,heapUsedBytes:null};
try{
  for(const mode of MODES){
    const runs=[];
    for(let index=0;index<rounds;index++)runs.push(await observe(mode));
    evidence.modes.push({name:mode.name,variable:mode.variable,samples:runs.map(run=>({...run,bootMs:round(run.bootMs),createMs:round(run.createMs),
      initMs:round(run.initMs),statusMs:round(run.statusMs),sendMs:round(run.sendMs),disposeMs:round(run.disposeMs),
      meanStepMs:round(run.meanStepMs),stepP50Ms:round(run.stepP50Ms),stepP95Ms:round(run.stepP95Ms)})),
      summary:summarizeRuns(runs)});
  }
}finally{
  restoreFsMetrics();
}
const memory=process.memoryUsage();
evidence.peakRssBytes=process.resourceUsage().maxRSS*1024;
evidence.heapUsedBytes=memory.heapUsed;
const output=JSON.stringify(evidence,null,2);
const target=process.env.WE_PROFILE_OUT;
if(target)await fs.mkdir(path.dirname(path.resolve(target)),{recursive:true}).then(()=>fs.writeFile(target,output,'utf8'));
console.log(output);
