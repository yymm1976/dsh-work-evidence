import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

// Independent native tool application. No Desktop restart and no source mutation.
const app=process.env.DSH_APP?.trim()||path.join(os.homedir(),'AppData','Local','Programs','DSH Desktop','dsh-desktop');
const workspace=process.env.DSH_ENGINEERING_WORKSPACE?.trim();
if(!workspace)throw new Error('Set DSH_ENGINEERING_WORKSPACE to the project directory under test');
const require=createRequire(app+'/package.json'),load=n=>import(pathToFileURL(require.resolve('@deepseek-ai/'+n)));
const {Context}=await load('cordis'),ctx=new Context();
const id='engineering-apply-'+Date.now(),signal=AbortSignal.timeout(60000);let handle;
const withModel=process.argv.includes('--with-model');let modelRoute;
async function mount(n,c={}){const mod=await load(n),f=await ctx.plugin(mod.default||mod,c);await f.ready;}
async function execute(name,args,allowError=false){
  const result=await handle.agent.ctx.tools.execute({name:'run_code',arguments:name==='run_code'?args:{code:`return await tools[${JSON.stringify(name)}](${JSON.stringify(args)});`,description:'Apply the engineering evidence tool'},agent:handle.agent,signal,callId:'application:'+randomUUID()});
  if(result.isError&&!allowError)throw new Error(name+': '+JSON.stringify(result.error));
  return name==='run_code'?result:{...result,value:result.value.result,content:[{type:'text',text:JSON.stringify(result.value.result)}]};
}
try{
  await mount('dsh-session');await mount('dsh-agent');await mount('dsh-session-projection');await mount('dsh-system-prompt');
  await mount('dsh-token-meter');
  await mount('dsh-tools',{mode:'ptc'});await mount('dsh-fs-local',{cwd:workspace});await mount('dsh-working-directory',{defaultDirectory:workspace});
  await mount('dsh-subprocess-local');await mount('dsh-sandbox-local');await mount('dsh-sandbox-policy',{mode:'danger-full-access',workspaceRoot:workspace});
  await mount('dsh-ptc-runtime-node',{executionMode:'per-call'});await mount('dsh-tool-fs',{read:true,write:true,edit:false});
  await mount('dsh-tool-fs-search',{sampleOverCapGlobResults:false,globMaxResults:50,grepMaxMatches:30,timeoutMs:10000});
  await mount('dsh-llm');await mount('dsh-agent-loop');
  if(withModel){const api=await import('../dsh-mechanism-lab/api.mjs');await mount('dsh-llm-pi-ai',{providers:api.isolatedProviderConfig()});modelRoute={provider:api.route.provider,model:api.route.model,reasoningEffort:'low'};}
  const plugin=await import('./index.mjs');
  handle=await ctx.agents.create({sessionId:id,meta:{cwd:workspace},setup:async agentCtx=>{
    const f=await agentCtx.plugin(plugin,modelRoute?{modelRoute}:{});await f.ready;
    agentCtx.tools.guard(exec=>{
      if(['write','edit'].includes(exec.name)&&!path.resolve(workspace,exec.arguments.file_path||'').startsWith(path.join(workspace,'.dsh','work-evidence')+path.sep))return 'Only plugin-owned application records may be written';
      if(['pwsh','bash'].includes(exec.name))return 'No external commands are required by this application';
    });
  }});
  const session=handle.agent.session;session.append('turn/start',{turn:1});session.append('step/start',{turn:1,step:1});
  const first=await execute('run_code',{code:'return await tools.read({file_path:"src/main/java/dev/qingming/xiuxian/command/InterestPointCommand.java"});',description:'Read the historical missing project path'},true);
  const {agentEvents}=await load('dsh-agent');
  const decision=await agentEvents(handle.agent.ctx,handle.agent).waterfall('agent/pre-step',{turn:1,step:2,signal,messages:[]},()=>Promise.resolve({kind:'enter',messages:[]}));
  const notice=[...(first.additionalContexts||[]),...decision.messages].find(m=>m.source?.kind==='work-evidence');
  if(!notice){console.log(JSON.stringify({first:first.content,events:session.log.filter(e=>e.type.startsWith('tool/ptc-')),status:(await execute('work_status',{})).value}));throw new Error('PTC missing-file result did not produce automatic evidence');}
  await execute('work_status',{});
  const status=(await execute('work_status',{})).value;
  const indexed=(await execute('evidence_index',{mode:'query',query:'InterestPointCommand.java'})).value;
  if(!indexed.matches.some(m=>m.path.endsWith('InterestPointCommand.java')))throw new Error('Recovered source was not available through the learned index');
  let semantic=null,candidatePrediction=null;
  if(withModel&&!process.argv.includes('--candidates'))semantic=(await execute('evidence_index',{mode:'learn',query:'InterestPointCommand',file:'src/main/java/dev/qingming/xiuxian/exploration/interest/InterestPointCommand.java',semantic:true})).value;
  if(withModel&&process.argv.includes('--candidates'))candidatePrediction=(await execute('candidate_select',{
    task:'需要产出可安装的模组JAR。只比较这两个已有Gradle命令方案，不运行命令。证据不足请返回unknown。',
    data_report:'依据来自当前工程Gradle配置；没有运行候选，也没有声称它们成功。运行耗时为人为估计，不是测得数据。',
    evidence_paths:['build.gradle','gradle.properties'],estimated_run_ms:120000,execute:false,
    candidates:[{id:'compile-classes',file_path:'build.gradle',tool:'pwsh',command:'./gradlew.bat classes'},{id:'package-jar',file_path:'build.gradle',tool:'pwsh',command:'./gradlew.bat jar'}]
  })).value;
  const final=(await execute('work_status',{})).value;
  session.append('turn/end',{turn:1,reason:{kind:'completed'}});
  const output={sessionId:id,at:new Date().toISOString(),modelRequests:final.metrics.auxiliaryCalls,semanticRevision:semantic,candidatePrediction,ptcMissingFileRecovered:true,indexedPaths:indexed.matches.map(x=>x.path),
    pluginStatus:status,metrics:final.metrics,
    scope:'Native tool execution and scripted step boundaries; not a live model completion or efficiency comparison.'};
  await fs.writeFile(path.join(import.meta.dirname,'engineering',id+'.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
}finally{await handle?.dispose();await ctx.fiber.dispose();}
