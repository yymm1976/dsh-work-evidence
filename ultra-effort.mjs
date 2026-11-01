import {isAgentLoopRequest,markAgentLoopRequest} from '@deepseek-ai/dsh-llm';

const nativeEffort=info=>info?.reasoning?.efforts?.find(item=>item.id==='max')?.id;
// Adapters relying on the base prepareCall resolve through the wrapped resolveModel,
// so the added entry must stay distinguishable from a provider's own ultra.
const synthetic=new WeakSet();
const nativeUltraOf=info=>!!info?.reasoning?.efforts?.some(item=>item.id==='ultra'&&!synthetic.has(item));
function expose(info){
  if(!nativeEffort(info)||info.reasoning.efforts.some(item=>item.id==='ultra'))return info;
  const added={id:'ultra',name:'Ultra'};synthetic.add(added);
  const result={...info,reasoning:{...info.reasoning,efforts:[...info.reasoning.efforts,added]}};
  return result;
}
function transport(options,effort,nativeUltra){
  if(options.reasoningEffort!=='ultra')return options;
  // A model that natively offers ultra needs no translation.
  if(nativeUltra)return options;
  if(!effort)throw new Error('Ultra requires a model with a native max reasoning effort');
  const translated={...options,reasoningEffort:effort};
  if(isAgentLoopRequest(options))markAgentLoopRequest(translated);
  return Object.isFrozen(options)?Object.freeze(translated):translated;
}

export function installUltraEffort(ctx){
  const patched=new Map();
  function refresh(){
    const registrations=ctx.llm?.adapters;
    if(!(registrations instanceof Map))return;
    for(const registration of registrations.values()){
      const adapter=registration?.adapter;
      if(!adapter||patched.has(adapter)||typeof adapter.resolveModel!=='function'||typeof adapter.prepareCall!=='function')continue;
      const resolve=adapter.resolveModel,prepare=adapter.prepareCall;
      const resolveDescriptor=Object.getOwnPropertyDescriptor(adapter,'resolveModel');
      const prepareDescriptor=Object.getOwnPropertyDescriptor(adapter,'prepareCall');
      const wrappedResolve=async function(provider,model,signal){return expose(await resolve.call(this,provider,model,signal));};
      const wrappedPrepare=async function(provider,model,signal){
        const call=await prepare.call(this,provider,model,signal);
        const effort=nativeEffort(call.model),nativeUltra=nativeUltraOf(call.model);
        return {...call,model:expose(call.model),stream:options=>call.stream(transport(options,effort,nativeUltra))};
      };
      try{
        Object.defineProperty(adapter,'resolveModel',{configurable:true,writable:true,value:wrappedResolve});
        Object.defineProperty(adapter,'prepareCall',{configurable:true,writable:true,value:wrappedPrepare});
        patched.set(adapter,{resolveDescriptor,prepareDescriptor,wrappedResolve,wrappedPrepare});
      }catch(error){
        if(adapter.resolveModel===wrappedResolve){if(resolveDescriptor)Object.defineProperty(adapter,'resolveModel',resolveDescriptor);else delete adapter.resolveModel;}
        ctx.logger.warn('work-evidence: Ultra unavailable for adapter: '+error.message);
      }
    }
  }
  refresh();
  const off=ctx.on('llm/adapters-updated',refresh);
  return ()=>{
    off?.();
    for(const [adapter,item] of patched){
      if(adapter.resolveModel===item.wrappedResolve){if(item.resolveDescriptor)Object.defineProperty(adapter,'resolveModel',item.resolveDescriptor);else delete adapter.resolveModel;}
      if(adapter.prepareCall===item.wrappedPrepare){if(item.prepareDescriptor)Object.defineProperty(adapter,'prepareCall',item.prepareDescriptor);else delete adapter.prepareCall;}
    }
    patched.clear();
  };
}
