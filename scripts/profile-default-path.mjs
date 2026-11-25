import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createRuntime,defaults} from '../runtime.mjs';
import {createContextEconomics} from '../context-economics.mjs';
import {createEffectObserver} from '../effect-observer.mjs';
import {createHistoryHygiene} from '../history-hygiene.mjs';
import {createRequestWorkingSet} from '../request-working-set.mjs';
import {createTaskFlow} from '../task-flow.mjs';
import {createBoundedPatch,readSourceBundle} from '../bounded-patch.mjs';
import {createNativeFiles} from '../native-files.mjs';
import {modelJson} from '../model.mjs';

const rounds=Number(process.env.WE_PROFILE_ROUNDS??30);
const root=path.resolve(process.env.WE_PROFILE_ROOT??process.cwd());

function bench(name,fn){
  const samples=[];
  for(let index=0;index<rounds;index++){
    const began=performance.now();
    fn(index);
    samples.push(performance.now()-began);
  }
  samples.sort((a,b)=>a-b);
  const sum=samples.reduce((total,value)=>total+value,0);
  return {name,rounds,meanMs:sum/rounds,p50Ms:samples[Math.floor(rounds*0.5)],p95Ms:samples[Math.min(rounds-1,Math.floor(rounds*0.95))],maxMs:samples.at(-1)};
}

const results=[];
{
  const state={root,step:0,config:defaults({}),dirty:false};
  const runtime=createRuntime({get:()=>state},{});
  results.push(bench('runtime.get',()=>runtime.get({session:{id:'profile'}})));
}
{
  const roots=Array.from({length:200},(_,index)=>path.join(root,'src','file-'+index+'.js'));
  results.push(bench('history-hygiene source key set',()=>{
    const seen=new Set();
    for(const file of roots)seen.add(file.replaceAll('\\','/'));
  }));
}
{
  const payload={files:Array.from({length:50},(_,index)=>({path:'src/file-'+index+'.js',content:'export const value = '+index+';\n'.repeat(200)}))};
  results.push(bench('request payload JSON serialization',()=>JSON.stringify(payload)));
}
{
  const text='import path from "node:path";\nexport function load(value) {\n  return value.map(item => item * 2);\n}\n'.repeat(600);
  results.push(bench('local text token estimate',()=>Math.ceil(text.length/3.6)));
}
{
  const observer=createEffectObserver({on:()=>()=>{}},{get:()=>({dir:null,telemetryDir:null,step:0,config:{toolSurface:'compact'}}),isEnabled:()=>true,problem:()=>{}});
  const agent={session:{id:'profile-session',seq:0,surface:{nodes:[]},log:[]}};
  results.push(bench('effect snapshot without storage',()=>observer.snapshot(agent)));
}
{
  const state={root,step:0,config:defaults({})};
  const economics=createContextEconomics({tokenMeter:{measure:()=>({totalTokens:1000})}},{get:()=>state});
  const agent={session:{id:'profile-econ',surface:{nodes:[]},requestHeader:()=>null}};
  results.push(bench('context economics summary',()=>economics.summary(agent)));
}
{
  const files=createNativeFiles({get:()=>null});
  results.push(bench('native file provider construction',()=>createNativeFiles({get:()=>null})));
  if(typeof files?.list!=='function')throw new Error('native file list seam missing');
}
{
  const state={root,step:0,config:defaults({})};
  const runtime={get:()=>state,init:async()=>state,beginRequest:async()=>{},currentRequest:()=>null,currentSelection:()=>null,
    isEnabled:()=>false,execFor:()=>({}),problem:()=>{},recordMutation:()=>{}};
  const ctx={on:()=>{},get:()=>null,tools:{get:()=>null}};
  const effects={decide:()=>{}};
  results.push(bench('bounded patch construction',()=>createBoundedPatch(ctx,runtime,{effects})));
}
{
  const bundlePromise=readSourceBundle(root,'profile only reads source');
  const started=performance.now();
  const resolved=Boolean(await bundlePromise);
  results.push({name:'readSourceBundle source tree',rounds:1,note:'asynchronous native/Node filesystem read',
    resolved,durationMs:performance.now()-started});
}

console.log(JSON.stringify({generatedAt:new Date().toISOString(),root,rounds,hostVersion:process.env.DSH_TEST_HOST_VERSION??null,
  node:process.version,platform:process.platform,results},null,2));
