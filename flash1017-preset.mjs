export const name='work-evidence-flash1017-route';
export const inject=[];
const PROVIDER='magpie';
// These prompt rules come from DeepSeek V4.1 Flash trajectories, so they stay paired with that route family.
const isFlashRoute=(provider,model)=>provider===PROVIDER&&typeof model==='string'&&/deepseek-v4\.1-flash/i.test(model);

function refuse(){
  const error=new Error('The Flash preset rules are paired with a magpie DeepSeek V4.1 Flash route, such as workbuddy-ai/deepseek-v4.1-flash. Select that route, or choose the original ptc preset to use another model. No alternate route was selected.');
  error.code='FLASH1017_ROUTE_REQUIRED';throw error;
}

/** Mounted only inside the explicitly selected Flash preset. */
export function apply(ctx){
  ctx.on('agent/request',async({agent},next)=>{
    const proposed=await next();
    const selections=(agent.session.log||[]).filter(event=>event.type==='model/selection');
    const choice=selections.at(-1)?.data;
    // A recorded selection is what the user actually picked: it wins over a request default that
    // may still point at an earlier Flash entry, and a non-Flash selection is refused, not swapped.
    if(choice?.provider&&choice?.model){
      if(!isFlashRoute(choice.provider,choice.model))refuse();
      return {...proposed,provider:choice.provider,model:choice.model,reasoningEffort:proposed.reasoningEffort||'max'};
    }
    if(!isFlashRoute(proposed.provider,proposed.model))refuse();
    return {...proposed,reasoningEffort:proposed.reasoningEffort||'max'};
  });
}
