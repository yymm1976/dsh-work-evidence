// Keyless DSH host for plugin integration tests: real agent loop, tools and
// session store from the installed desktop runtime, with a scripted model.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire,registerHooks} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {patchToolExecution} from '../../tool-execution.mjs';
import {DSH_APP} from './paths.mjs';

export const APP=DSH_APP;
const require=createRequire(path.join(APP,'package.json'));
const rootZod=path.join(APP,'node_modules','zod');
const toolsVersion=JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-tools/package.json'),'utf8')).version;
const splitToolExecutor=toolsVersion.startsWith('0.2.2');
// Same zod de-duplication the experiment runner uses for the desktop bundle.
registerHooks({resolve(specifier,context,next){
  try{
    const resolved=next(specifier,context);
    if(specifier==='@deepseek-ai/dsh-llm'&&!context.conditions?.includes('require'))return next(pathToFileURL(require.resolve(specifier)).href,context);
    if(specifier==='zod'&&resolved.url?.startsWith('file:')){
      const nested=path.dirname(fileURLToPath(resolved.url));
      if(nested!==rootZod&&nested.startsWith(path.join(APP,'node_modules')+path.sep)&&existsSync(path.join(nested,'package.json'))&&
        !existsSync(path.join(nested,'v4','classic','deep-partial.js'))&&existsSync(path.join(rootZod,'v4','classic','deep-partial.js'))&&
        JSON.parse(readFileSync(path.join(nested,'package.json'),'utf8')).version===JSON.parse(readFileSync(path.join(rootZod,'package.json'),'utf8')).version)
        return next(pathToFileURL(path.join(rootZod,'index.js')).href,context);
    }
    return resolved;
  }catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND'||!specifier.startsWith('@deepseek-ai/'))throw e;return next(pathToFileURL(require.resolve(specifier)).href,context);}
}});
export const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)).href);
const PLUGIN=path.resolve(import.meta.dirname,'..','..');

export const text=value=>({kind:'text',text:value});
export const reasoning=value=>({kind:'reasoning',text:value});
export const tool=(name,args)=>({kind:'tool',name,args});

async function* emit(turn,usage){
  const calls=turn.filter(item=>item.kind==='tool');
  let index=0;
  for(const item of turn){
    if(item.kind==='reasoning'){
      yield {type:'block-start',index,blockType:'reasoning'};
      yield {type:'reasoning-delta',index,text:item.text};
      yield {type:'block-end',index,block:{type:'reasoning',text:item.text}};
    }else if(item.kind==='text'){
      yield {type:'block-start',index,blockType:'text'};
      yield {type:'text-delta',index,text:item.text};
      yield {type:'block-end',index,block:{type:'text',text:item.text}};
    }else{
      const id='call_'+randomUUID().slice(0,8),args=JSON.stringify(item.args??{});
      yield {type:'block-start',index,blockType:'tool-call'};
      yield {type:'tool-call-delta',index,id,name:item.name,argumentsDelta:args};
      yield {type:'block-end',index,block:{type:'tool-call',id,name:item.name,arguments:args}};
    }
    index++;
  }
  yield {type:'usage',usage};
  yield {type:'finish',reason:{kind:calls.length?'tool-calls':'stop'}};
}

/**
 * Start a host with the plugin mounted.
 * script(options, calls) returns an array of text()/tool() items for each main request;
 * auxiliary(options) answers non-loop calls (quality review, compaction).
 */
export async function startHost({script,auxiliary=()=>[text('{}')],pluginConfig={},workspace=null,efforts=['low','high','max'],toolMode='native',mountPlugin=true,
  extraMounts=[],usage=null,contextWindow=200000,pluginDirectory=PLUGIN,sessionQueryMount=['dsh-session-query']}={}){
  const [{Context},llm]=await Promise.all([load('cordis'),load('dsh-llm')]);
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'we-host-'));
  if(workspace){await fs.mkdir(path.join(cwd,'.dsh','work-evidence'),{recursive:true});await fs.writeFile(path.join(cwd,'.dsh','work-evidence','config.json'),JSON.stringify(workspace));}
  const requests=[],auxiliaryRequests=[];
  class ScriptedAdapter extends llm.LlmAdapter{
    providerInfo(provider){return {id:provider,name:'Scripted'};}
    providerRetryPolicy(){return llm.resolveRetryPolicy?.({mode:'normal',maxRetries:0},'scripted');}
    resolveModel(provider,model){return Promise.resolve({provider,id:model,name:model,context:{contextWindow},
      reasoning:{efforts:efforts.map(id=>({id,name:id})),defaultEffort:efforts.at(-1)}});}
    async *stream(options){
      const reported=usage?.(options)??{inputTokens:1000,outputTokens:100,cacheReadTokens:0,totalTokens:1100};
      // Loop requests carry the system prompt as their first message; one-shot
      // auxiliary calls (review, compaction) use options.system or a purpose.
      if(!options.purpose&&!options.system&&options.messages?.[0]?.role==='system'){
        requests.push(options);
        yield* emit(await script(options,requests.length),reported);
      }else{
        auxiliaryRequests.push(options);
        yield* emit(await auxiliary(options,auxiliaryRequests.length),reported);
      }
    }
  }
  const ctx=new Context();
  // A mount name is a desktop runtime package; a module object mounts as given (for example OPS).
  const mount=async(name,config={})=>{const m=typeof name==='string'?await load(name):name;await ctx.plugin(m.default??m,config);};
  for(const [name,config] of [
    ['dsh-session'],['dsh-agent'],['dsh-session-projection'],sessionQueryMount,['dsh-token-meter'],['dsh-system-prompt'],
    ['dsh-tools',splitToolExecutor?{}:{mode:toolMode}],
    ...(splitToolExecutor?[[toolMode==='ptc'?'dsh-tool-executor-ptc':'dsh-tool-executor-native',{}]]:[]),
    ['dsh-fs-local',{cwd}],['dsh-working-directory',{defaultDirectory:cwd}],['dsh-subprocess-local'],['dsh-sandbox-local'],['dsh-sandbox-policy',{mode:'danger-full-access',workspaceRoot:cwd}],
    ['dsh-shell-env'],['dsh-jobs-local'],['dsh-pwsh-local',{cwd}],['dsh-tool-pwsh',{}],['dsh-tool-fs',{read:true,write:true,edit:true}],['dsh-tool-fs-search',{sampleOverCapGlobResults:false}],
    ['dsh-llm'],['dsh-agent-loop'],['dsh-commands'],['dsh-session-persistence-jsonl',{root:path.join(cwd,'.sessions')}],...extraMounts,
  ])await mount(name,config);
  patchToolExecution(ctx);
  ctx.llm.registerAdapter(['scripted'],new ScriptedAdapter());
  if(mountPlugin){
    const plugin=await import(pathToFileURL(path.join(pluginDirectory,'index.mjs')).href);
    await ctx.plugin(plugin,{...(process.env.DSH_TEST_FASTEDIT_PYTHON?{fastEditPython:process.env.DSH_TEST_FASTEDIT_PYTHON}:{}),...pluginConfig});
  }
  const events=[];
  ctx.on('session/event',(_session,event)=>events.push(event));
  async function createAgent(effort='max'){
    const handle=await ctx.agents.create({sessionId:'we-test-'+randomUUID().slice(0,8),agentOptions:{provider:'scripted',model:'scripted-model',reasoningEffort:effort},meta:{cwd}});
    handle.agent.session.append('sandbox/mode',{mode:'danger-full-access',workspaceRoot:cwd});
    return handle.agent;
  }
  async function send(agent,message){
    agent.followup(llm.createUserMessage({content:[{type:'text',text:message}],source:{kind:'user'}}));
    await agent.whenIdle();
  }
  async function command(agent,input){
    const result=await ctx.commands.execute(agent,'/work-evidence '+input,[],AbortSignal.timeout(30000));
    if(result?.result?.kind!=='success')throw new Error(result?.result?.text??'command failed');
    return JSON.parse(result.result.text);
  }
  async function close(){
    try{await ctx.fiber?.dispose?.();}catch{}
    await fs.rm(cwd,{recursive:true,force:true,maxRetries:3});
  }
  return {ctx,cwd,requests,auxiliaryRequests,events,createAgent,send,command,close,llm};
}

export const systemOf=options=>{
  const first=options.messages?.[0];
  if(first?.role==='system')return (first.content??[]).map(block=>block.text??'').join('\n');
  return options.system??'';
};
export const toolNames=options=>(options.tools??[]).map(item=>item.name);
export const requestText=options=>(options.messages??[]).map(message=>
  (Array.isArray(message.content)?message.content:[{type:'text',text:String(message.content??'')}])
    .map(block=>block.text??(block.type==='tool-call'?block.name+' '+block.arguments:'')).join('\n')).join('\n---\n');
export const lastUserText=options=>{
  const message=(options.messages??[]).findLast(item=>item.role==='user');
  return (message?.content??[]).map(block=>block.text??'').join('\n');
};
