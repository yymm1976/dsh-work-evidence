import fs from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {startHost,text,tool,requestText} from '../test/helpers/host.mjs';

const rounds=Math.max(1,Number(process.env.WE_PROFILE_HOST_ROUNDS??3));
const TASK='读取源码文件以检查历史增长和原生工具处理。只做只读核对，完成后报告。';
const MODES=[
  {name:'plugin-off',mountPlugin:false,workspace:null},
  {name:'plugin-default',mountPlugin:true,workspace:{}},
  {name:'core-only',mountPlugin:true,workspace:{stepPacing:false,contextProtocol:false,historyHygiene:false,
    evidenceViews:false,ledgerReceipt:false,requestProjection:false}},
  {name:'accounting-off',mountPlugin:true,workspace:{requestAccounting:false,requestProjection:false,
    compressionControl:false,stateLedger:false,stateInform:false,historyHygiene:false,contextProtocol:false,
    evidenceViews:false,ledgerReceipt:false,stepPacing:false}},
];

const percentile=(samples,ratio)=>{
  if(!samples.length)return null;
  const ordered=[...samples].sort((left,right)=>left-right);
  return ordered[Math.min(ordered.length-1,Math.floor(ordered.length*ratio))];
};
const median=samples=>percentile(samples,0.5);
const round=value=>value===null?null:Math.round(value*100)/100;

async function fixture(cwd){
  await fs.mkdir(path.join(cwd,'src'),{recursive:true});
  for(let index=0;index<6;index++){
    const lines=Array.from({length:140},(_,line)=>
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
    script:()=>{
      if(!measuring)return [text('warmup complete')];
      const now=performance.now();
      if(lastRequestAt!==null)requestGaps.push(now-lastRequestAt);
      lastRequestAt=now;
      step++;
      if(step<=6)return [tool('read',{file_path:`src/file${step-1}.js`})];
      if(step<=10)return [tool('read',{file_path:`src/file${(step-7)%6}.js`})];
      if(step===11)return [tool('pwsh',{command:'Get-Content src/file0.js | Select-Object -First 8'})];
      return [text('完成。')];
    },
  });
  const bootMs=performance.now()-bootStarted;
  let handle=null;
  try{
    await fixture(host.cwd);
    const warm=await host.createAgentHandle('max');
    await host.send(warm.agent,'warm up the host and plugin modules');
    await warm.dispose();
    host.requests.length=0;
    host.events.length=0;
    step=0;
    lastRequestAt=null;
    requestGaps.length=0;
    measuring=true;
    const createStarted=performance.now();
    handle=await host.createAgentHandle('max');
    const createMs=performance.now()-createStarted;
    const agent=handle.agent;
    let initMs=null;
    if(mode.mountPlugin){
      const started=performance.now();
      await host.command(agent,'status');
      initMs=performance.now()-started;
    }
    const sendStarted=performance.now();
    await host.send(agent,TASK);
    const sendMs=performance.now()-sendStarted;
    await new Promise(resolve=>setTimeout(resolve,120));
    const requestChars=host.requests.reduce((sum,request)=>sum+requestText(request).length,0);
    const requestLengths=host.requests.map(request=>requestText(request).length);
    const messageCounts=host.requests.map(request=>request.messages?.length??0);
    let telemetry=null;
    if(mode.mountPlugin){
      const status=await host.command(agent,'status');
      const file=status.observability.persistence.file;
      if(file){
        try{
          const body=await fs.readFile(file,'utf8');
          telemetry={bytes:Buffer.byteLength(body),rows:body.split('\n').filter(Boolean).length,
            complete:status.observability.persistence.complete};
        }catch(error){telemetry={missing:true,error:error.code??String(error)};}
      }
    }
    const disposeStarted=performance.now();
    await handle.dispose();
    handle=null;
    const disposeMs=performance.now()-disposeStarted;
    const meanStepMs=requestGaps.length?requestGaps.reduce((sum,value)=>sum+value,0)/requestGaps.length:null;
    return {bootMs,createMs,initMs,sendMs,disposeMs,meanStepMs,requests:host.requests.length,
      toolResults:host.events.filter(event=>event.type==='tool/result').length,
      stepP50Ms:percentile(requestGaps,.5),stepP95Ms:percentile(requestGaps,.95),
      requestChars,maxRequestChars:Math.max(0,...requestLengths),maxMessages:Math.max(0,...messageCounts),
      telemetry,providerScriptedWaitMs:0};
  }finally{
    if(handle)await handle.dispose().catch(()=>{});
    await host.close();
  }
}

const evidence={schema:'work-evidence.host-profile.v1',generatedAt:new Date().toISOString(),
  node:process.version,platform:process.platform,rounds,
  scope:'real scripted host loop with native read/pwsh tools; model provider wait is zero by construction',
  caveat:'This measures local plugin and host processing. It does not measure provider latency, provider billing or causal task savings. No online model request is made.',
  task:{requestsPerRun:12,promptChars:TASK.length,fixtureFiles:6,fixtureLinesPerFile:140},
  modes:[],peakRssBytes:null,heapUsedBytes:null};

for(const mode of MODES){
  const runs=[];
  for(let index=0;index<rounds;index++)runs.push(await observe(mode));
  const values=key=>runs.map(run=>run[key]).filter(value=>typeof value==='number');
  evidence.modes.push({name:mode.name,
    samples:runs.map(run=>({...run,bootMs:round(run.bootMs),createMs:round(run.createMs),initMs:round(run.initMs),
    sendMs:round(run.sendMs),disposeMs:round(run.disposeMs),meanStepMs:round(run.meanStepMs),
      stepP50Ms:round(run.stepP50Ms),stepP95Ms:round(run.stepP95Ms)})),
    summary:Object.fromEntries(['bootMs','createMs','initMs','sendMs','disposeMs','meanStepMs','stepP50Ms','stepP95Ms',
      'requests','toolResults','requestChars','maxRequestChars','maxMessages']
      .map(key=>[key,{p50Ms:key.endsWith('Ms')?round(median(values(key))):null,
        p95Ms:key.endsWith('Ms')?round(percentile(values(key),0.95)):null,
        value:key.endsWith('Ms')?null:Math.round(values(key).reduce((sum,value)=>sum+value,0)/values(key).length)}]))});
}

const memory=process.memoryUsage();
evidence.peakRssBytes=process.resourceUsage().maxRSS*1024;
evidence.heapUsedBytes=memory.heapUsed;
const output=JSON.stringify(evidence,null,2);
const target=process.env.WE_PROFILE_OUT;
if(target)await fs.mkdir(path.dirname(path.resolve(target)),{recursive:true}).then(()=>fs.writeFile(target,output,'utf8'));
console.log(output);
