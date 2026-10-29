export const name='work-evidence-flash1017-route';
export const inject=[];
const provider='magpie',model='cline/cline-pass/deepseek-v4.1-flash-1017';

/** Mounted only inside the explicitly selected Flash preset. */
export function apply(ctx){
  ctx.on('agent/request',async({agent},next)=>{
    const proposed=await next();
    const selections=(agent.session.log||[]).filter(event=>event.type==='model/selection');
    const selected=selections.at(-1)?.data;
    if(selected?.provider&&selected?.model&&(selected.provider!==provider||selected.model!==model)){
      const error=new Error('Flash1017 preset requires magpie / '+model+'. Select that exact route, or choose the original ptc preset to use another model. No alternate route was selected.');
      error.code='FLASH1017_ROUTE_REQUIRED';throw error;
    }
    return {...proposed,provider,model,reasoningEffort:proposed.reasoningEffort||'max'};
  });
}
