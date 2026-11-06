import {argsOf,eventLog} from './runtime.mjs';
import {toolModeFor,isBatchToolHost,patchSystemPromptTools} from './tool-execution.mjs';

const LIMIT=64000;
function sessionPrograms(session){
  const events=eventLog(session);
  const calls=new Map(),eventRefs=new Map();
  for(const event of events){
    if(event.type!=='tool/call'||event.data?.name!=='run_code'||typeof event.data.callId!=='string')continue;
    calls.set(event.data.callId,{seq:event.seq,arguments:event.data.arguments});
  }
  for(const event of events){
    if(!Number.isSafeInteger(event.seq)||event.seq<0)continue;
    const callId=event.type==='tool/call'&&event.data?.name==='run_code'?event.data.callId:
      event.type==='tool/result'?(event.data?.message??event.data)?.toolCallId:null;
    if(typeof callId==='string'&&calls.has(callId))eventRefs.set('event:'+event.seq,callId);
  }
  return {calls,eventRefs};
}
function resolve(input,{calls,eventRefs},signal){
  const chain=[],seen=new Set();let args=input;
  while(true){
    signal?.throwIfAborted();
    if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Native program arguments must be an object');
    const code=typeof args.code==='string',ref=typeof args.programRef==='string'&&args.programRef.length>0;
    if(code===ref||args.code!==undefined&&!code)throw new Error('Provide exactly one of code or programRef');
    if(args.edits!==undefined&&(!ref||!Array.isArray(args.edits)||args.edits.length>16))throw new Error('Native program edits require programRef and at most 16 replacements');
    if(code){
      if(!args.code.trim()||args.code.length>LIMIT)throw new Error('Referenced native program must contain 1–64000 characters');
      let body=args.code;
      for(const edits of chain.reverse())for(const edit of edits){
        signal?.throwIfAborted();
        if(!edit||typeof edit.before!=='string'||!edit.before||typeof edit.after!=='string'||edit.before.length>LIMIT||edit.after.length>LIMIT||
          Object.keys(edit).some(key=>!['before','after'].includes(key)))throw new Error('Native program edits need nonempty before and string after');
        const at=body.indexOf(edit.before);
        if(at<0||body.indexOf(edit.before,at+1)>=0)throw new Error('Native program edit must match exactly once; no program was executed');
        body=body.slice(0,at)+edit.after+body.slice(at+edit.before.length);
        if(!body.trim()||body.length>LIMIT)throw new Error('Edited native program must contain 1–64000 characters');
      }
      return {code:body,sourceCallIds:[...seen]};
    }
    const reference=eventRefs.get(args.programRef)??args.programRef;
    if(args.programRef.length>256||seen.has(reference)||seen.size>=32)throw new Error('Invalid or cyclic native programRef');
    seen.add(reference);
    const prior=calls.get(reference);
    if(!prior)throw new Error('programRef must identify an original run_code call in this session');
    chain.push(args.edits??[]);args=argsOf(prior.arguments);
  }
}

export function resolveNativeProgram(input,session,signal){return resolve(input,sessionPrograms(session),signal);}
export function nativeProgramAddress(session,callId){
  const event=eventLog(session).findLast(event=>event.type==='tool/call'&&event.data?.name==='run_code'&&event.data.callId===callId);
  return Number.isSafeInteger(event?.seq)&&event.seq>=0?'event:'+event.seq:null;
}
export function latestNativeProgram(session){
  const programs=sessionPrograms(session);
  for(const [programRef,call]of [...programs.calls].reverse().slice(0,16))try{
    const program=resolve({programRef},programs);
    if(program.code.length>=1000)return {programRef,seq:call.seq,programChars:program.code.length};
  }catch{}
  return null;
}

function declareProgramReference(assembly,context,enabled){
  const agent=context?.agent;
  if(!enabled(agent)||!latestNativeProgram(agent.session)||!Array.isArray(assembly.tools))return;
  assembly.tools=assembly.tools.map(tool=>{
    if(tool.name!=='run_code')return tool;
    const schema=tool.parameters;
    if(schema?.type!=='object'||schema.properties?.code?.type!=='string'||schema.properties.programRef)return tool;
    return {...tool,description:'Supply code, or programRef with exact literal edits to a recorded program from this session. '+
      'Only program text is reused; each call executes again. Earlier effects remain and may already have completed. '+tool.description.replace('Takes two required arguments: `code`,','Takes `code`,'),
      parameters:{...schema,required:(schema.required??[]).filter(key=>key!=='code'),properties:{...schema.properties,
        programRef:{type:'string',description:'Exact event:<seq> address of a run_code call or its result in this session; the original call id is also accepted. Supply this instead of code; only program text is inherited. Current workspace, permissions and native runtime apply.'},
        edits:{type:'array',description:'With programRef: at most 16 sequential literal replacements; each before must occur exactly once. Omit to explicitly execute unchanged.',
          items:{type:'object',additionalProperties:false,properties:{before:{type:'string'},after:{type:'string'}},required:['before','after']}}}}};
  });
}

/** Expand explicit references before native validation; the host still owns execution and permissions. */
export function installNativeProgramReferences(ctx,runtime,effects){
  const enabled=agent=>!!agent&&runtime.isEnabled(agent)&&runtime.get(agent).config.executionTriage&&runtime.get(agent).config.nativeProgramReuse&&toolModeFor(ctx,agent)==='ptc';
  ctx.on('tools/pre-execute',(exec,next)=>{
    if(exec.name!=='run_code'||exec.parent||!enabled(exec.agent)||exec.arguments?.programRef===undefined&&exec.arguments?.edits===undefined)return next();
    const input=exec.arguments,program=resolveNativeProgram(input,exec.agent.session,exec.signal);
    const {programRef,edits,...native}=input;
    exec.arguments=Object.freeze({...native,code:program.code});
    effects?.decide(exec.agent,'nativeProgramReuse','applied','explicit-recorded-program-edit',{
      programChars:program.code.length,submittedChars:JSON.stringify(input).length,sourceCallIds:program.sourceCallIds});
    return next();
  },{prepend:true});
  if(isBatchToolHost(ctx))patchSystemPromptTools(ctx,(assembly,context)=>declareProgramReference(assembly,context,enabled));
  else ctx.on('system-prompt/assemble',async(assembly,context,next)=>{
    const result=await next();declareProgramReference(assembly,context,enabled);return result;
  },{prepend:true});
}
