const MAX_CALLS=16,MAX_CHARS=64000;
const SDK_ARGUMENTS=/^`run_code` takes two required arguments: `code`, ([^\n]+?), and `description`, a short summary of what the program does\./mu;
const LITERAL_CALL_EXAMPLE=JSON.stringify({calls:[{name:'write',arguments:{file_path:'template.txt',content:'${name}\n\\bword\\b\n'}}],description:'Save the supplied literal text'});

function compileCalls(input,ctx,exec){
  if(input.code!==undefined||input.programRef!==undefined||input.edits!==undefined)throw new Error('Provide calls or a JavaScript program, not both');
  if(!Array.isArray(input.calls)||input.calls.length<1||input.calls.length>MAX_CALLS)throw new Error('calls must contain 1–16 native calls');
  if(input.parallel!==undefined&&typeof input.parallel!=='boolean')throw new Error('parallel must be a boolean');
  if(input.resultView!==undefined&&!['compact','full'].includes(input.resultView))throw new Error('resultView must be compact or full');
  for(const call of input.calls){
    exec.signal?.throwIfAborted();
    if(!call||typeof call!=='object'||Array.isArray(call)||Object.keys(call).some(key=>!['name','arguments'].includes(key))||
      typeof call.name!=='string'||!call.name||call.name==='run_code'||!call.arguments||typeof call.arguments!=='object'||Array.isArray(call.arguments))
      throw new Error('Each call requires a visible native tool name and an arguments object; recursive run_code is not allowed');
    if(!ctx.tools.get(call.name,exec.agent))throw new Error('Structured call tool is unavailable in this scope: '+call.name);
  }
  const serialized=JSON.stringify(input.calls);
  if(serialized.length>MAX_CHARS)throw new Error('Structured calls must contain at most 64000 serialized characters');
  // Parse data at runtime so keys such as __proto__ remain ordinary JSON keys.
  const declaration='const calls=JSON.parse('+JSON.stringify(serialized)+');';
  const body=input.parallel?
    'const values=await Promise.all(calls.map(call=>tools[call.name](call.arguments)));':
    'const values=[];for(const call of calls)values.push(await tools[call.name](call.arguments));';
  const projection=input.resultView==='full'?'const shown=values;':
    'const shown=values.map((value,index)=>{'+
    'if(!["write","edit"].includes(calls[index].name)||!value||typeof value!=="object"||typeof value.path!=="string"||value.isError===true||value.error||value.success===false||value.ok===false)return value;'+
    'const result={...value},omittedFileText={};'+
    'if(calls[index].name==="write"&&typeof calls[index].arguments.content==="string"&&typeof value.after==="string")result.submittedContentMatchesAfter=value.after===calls[index].arguments.content;'+
    'for(const key of ["before","after"])if(typeof result[key]==="string"&&!(key==="after"&&result.submittedContentMatchesAfter===false)){omittedFileText[key]={chars:result[key].length};delete result[key];}'+
    'return Object.keys(omittedFileText).length?{...result,omittedFileText}:result;});';
  return declaration+body+projection+'console.log(JSON.stringify(shown.length===1?shown[0]:shown));';
}

/** Fixed SDK forwarding; native dispatch still owns validation, guards and outcomes. */
export function installStructuredCalls(ctx,runtime,effects){
  const declaredAgents=new WeakSet();
  const enabled=agent=>{
    const native=ctx.get('ptcRuntime');
    return !!agent&&runtime.isEnabled(agent)&&runtime.get(agent).config.structuredCalls&&ctx.tools.modeFor(agent)==='ptc'&&
      native?.language==='typescript'&&native.programFormat==='function-body';
  };
  ctx.on('tools/pre-execute',(exec,next)=>{
    const input=exec.arguments;
    if(exec.name!=='run_code'||exec.parent||!enabled(exec.agent)||!declaredAgents.has(exec.agent)||input?.calls===undefined&&input?.parallel===undefined&&input?.resultView===undefined)return next();
    const code=compileCalls(input,ctx,exec),{calls,parallel,resultView,...native}=input;
    exec.arguments=Object.freeze({...native,code,description:input.description??'Run structured native calls'});
    effects?.decide(exec.agent,'structuredCalls','applied','explicit-native-call-forwarding',{
      callCount:calls.length,parallel:parallel??false,resultView:resultView??'compact',submittedChars:JSON.stringify(input).length,generatedProgramChars:code.length});
    return next();
  },{prepend:true});
  ctx.on('system-prompt/assemble',async(assembly,context,next)=>{
    const result=await next();
    if(context?.agent)declaredAgents.delete(context.agent);
    if(!enabled(context?.agent)||!Array.isArray(assembly.tools))return result;
    const sdk=assembly.sections?.find(section=>section.name==='tools:sdk');
    if(!sdk||!SDK_ARGUMENTS.test(sdk.text))return result;
    let declared=false;
    assembly.tools=assembly.tools.map(tool=>{
      if(tool.name!=='run_code')return tool;
      const schema=tool.parameters;
      if(schema?.type!=='object'||schema.properties?.code?.type!=='string')return tool;
      if(schema.properties.calls||schema.properties.parallel||schema.properties.resultView)throw new Error('run_code structured-call fields are already declared by another provider');
      declared=true;
      return {...tool,description:'Provide JavaScript code, or calls containing native tool names and their existing SDK arguments. '+
        'Use calls for literal file writes/edits and complete work_exec programs without JavaScript string wrappers. '+
        'When reading data to filter, parse, count or calculate, use code and return only the needed result instead of forwarding complete read values. '+
        'Calls run in order and stop on error; parallel:true is for independent calls. Results use compact JSON. File edits omit before/after full text with explicit character counts; resultView:"full" keeps it. '+
        'The existing tool permissions and error behavior apply. '+tool.description.replace('Takes two required arguments: `code`,','Takes `code` or `calls`,'),
        parameters:{...schema,required:(schema.required??[]).filter(key=>key!=='code'),properties:{...schema.properties,
          calls:{type:'array',minItems:1,maxItems:MAX_CALLS,description:'Instead of code. Native tools and argument names are declared in the current tools SDK. At most 64000 serialized characters.',
            items:{type:'object',additionalProperties:false,properties:{name:{type:'string',minLength:1},arguments:{type:'object',additionalProperties:true}},required:['name','arguments']}},
          parallel:{type:'boolean',description:'With calls only. Default false: execute in order and stop at the first failure. True: independent calls use native concurrency; a failed call does not cancel others already dispatched.'},
          resultView:{type:'string',enum:['compact','full'],description:'With calls only; default compact omits native write/edit before/after file bodies and reports their exact lengths. Full keeps all native values. Other tool results and all errors keep their data.'}}}};
    });
    if(declared){
      declaredAgents.add(context.agent);
      assembly.sections=assembly.sections.map(section=>section!==sdk?section:{...section,text:section.text.replace(SDK_ARGUMENTS,
      '`run_code` accepts exactly one of `code` or `calls`, with `description` summarizing the operation. '+
      'For literal file writes/edits or a complete work_exec program, use `calls:[{name,arguments}]` directly as JSON without a JavaScript string wrapper. '+
      'Example run_code tool arguments: '+LITERAL_CALL_EXAMPLE+'. Put supplied text directly in arguments.content; JSON escaping preserves placeholders and backslashes without String.raw or placeholder replacement programs. '+
      'Calls run sequentially; use parallel:true only for independent calls. File edits omit before/after text with explicit character counts; resultView:"full" keeps it. '+
      'A successful compact write reports submittedContentMatchesAfter when the native tool returns after text. This confirms the submitted text at that write, not compliance with the requested text or later file state. Reuse that write observation; reread only for an unresolved need. A mismatch keeps the actual after text. '+
      'For data reading, filtering, parsing, calculation, conditions or dependent results, use `code`, $1, and return only the needed result. Do not forward complete read values merely to calculate from them in another model step.')});
    }
    return result;
  },{prepend:true});
}
