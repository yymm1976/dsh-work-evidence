import {randomUUID} from 'node:crypto';
import {textOf} from './runtime.mjs';

const SOURCE='work-evidence-completion',VERSION='completion-notice-v1';
const messageOf=event=>event?.data?.message??event?.data;
const pending=agent=>(agent.inbox?.nextStep?.length??0)>0||(agent.inbox?.nextTurn?.length??0)>0;
const SUMMARY_HEADING=/^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?阶段摘要(?:[（(][^）)\n]{0,120}[）)])?(?:\*\*)?[ \t]*(?:[:：][^\n]*|$)/gmu;
const NEXT_STEP=/^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:\*\*)?(?:下一步|下一项)(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/gmu;
const PAUSED_OR_NEEDS_USER=/(?:等待|待|需要|需|请)(?:用户|你|您|对方)?(?:[^。\n]{0,20})?(?:确认|决定|授权|选择|批准|回复|提供|指示)|(?:用户要求|按用户要求|根据用户要求|依用户要求)(?:暂停|停止|结束)|(?:先|暂时|立即|马上)?暂停(?:等待|至|到|当前|本轮)?|无法继续|无法自行|受(?:权限|环境|外部条件)限制|实际阻碍|被阻塞|阻塞于/iu;
const REQUEST_PAUSE=/(?:请|先|暂时|立即|马上)?(?:暂停|停下|停止(?:当前|本轮|工作)?|不要继续|不再继续|先别继续|等我(?:确认|授权|决定|回复)|等待我(?:确认|授权|决定)|待我(?:确认|授权|决定)|需要我(?:确认|授权|决定)|未经[^。\n]{0,8}(?:确认|批准|授权|同意)|未经我(?:确认|授权|同意)[^。\n]{0,24}(?:不要|不得|暂停)|先(?:只)?汇报|只汇报|仅汇报|到这里|到此为止|本轮(?:先)?停)/iu;

const withoutNegatedStop=text=>String(text??'')
  .replace(/(?:无需|不需要|不需|不必|不用|不要|不得|别)(?:再|先)?(?:等|等待|待)?(?:用户|我|你|您)?(?:确认|决定|授权|选择|批准|回复|提供|指示)/gu,'')
  .replace(/(?:无需|不需要|不需|不必|不用|不要|不得|别|不是|并非)(?:是|说)?(?:只|仅)/gu,'')
  .replace(/(?:无需|不需要|不需|不必|不用|不要|不得|别)(?:暂停|停下|停止|结束)/gu,'')
  .replace(/(?:无|没有|不存在)(?:实际)?阻碍/gu,'');

const continuationText=text=>withoutNegatedStop(String(text??'').replace(
  /```[\s\S]*?```|`[^`\n]*`|“[^”\n]*”|「[^」\n]*」|"[^"\n]*"|'[^'\n]*'/gu,' '));

// “只/仅” must attach to a plan-writing verb, or to 计划/方案 as a whole clause, so that
// noun uses such as 只按计划修改 and 仅方案B stay eligible for continuation.
const PLAN_WRITING=/(?<!不)(?:只|仅)(?:需要|要|需)?(?:制定|编写|拟定|起草|列出|提供|给出|输出|整理|写|给|出|做|生成)(?:一(?:份|个|版|套|页))?(?:计划|方案)/u;
const PLAN_ONLY_CLAUSE=/(?<!不)(?:只|仅)(?:需要|要|需)?(?:一(?:份|个|版|套|页))?(?:计划|方案)(?=$|[，,、。.;；:：！!？?）)\s])/u;
const CONFIRMATION_GATE=/(?:经|获得|等待|等|待)?(?:用户|我|你|您)[^。；;\n]{0,8}(?:获批|确认|批准|授权|同意|决定)(?:之后|后|再)[^。；;\n]{0,10}?(?:执行|实施|修改|开发|修复|继续|开始|推进|上线|交付|发布|部署|提交|回滚|删除)|(?:只|仅)(?:需要|要|需)?(?:计划|方案)[^。；;\n]{0,8}(?:获批|确认|授权|批准|同意)(?:之后|后|再)/gu;
const GATE_NEGATED=/(?:不要|不用|无需|无须|不必|不需|没有|别)\s*(?:再|由|让|等|待|我|你|您)?\s*$/u;
const IMMEDIATE_ACTION=/(?:马上|立刻|立即|直接|现在就|即刻|随即)[^。；;\n]{0,6}?(?:执行|实施|修改|开发|修复|开始|推进|交付|落地)/u;
// Confirmation without an explicit person is only a gate when it opens a clause after punctuation, so 核对确认后执行 stays executable.
const PUNCTUAL_GATE=/(?:^|[，,、：:；;。])\s*(?:待|等|需|须|经|获得|取得|收到)?(?<!不)(?<!未)(?<!无)(?:获批|确认|批准|授权|同意)(?!无误|完毕|完成)(?:之后|后|再)[^。；;\n]{0,10}?(?:执行|实施|修改|开发|修复|继续|开始|推进|上线|交付|发布|部署|提交|回滚|删除)/gu;

function needsConfirmationGate(request){
  for(const gate of [...request.matchAll(CONFIRMATION_GATE),...request.matchAll(PUNCTUAL_GATE)]){
    if(GATE_NEGATED.test(request.slice(Math.max(0,gate.index-8),gate.index)))continue;
    return true;
  }
  return false;
}

export const requestPausesContinuation=text=>{
  const request=continuationText(text);
  if(REQUEST_PAUSE.test(request))return true;
  if(needsConfirmationGate(request))return true;
  const planOnly=PLAN_WRITING.test(request)||PLAN_ONLY_CLAUSE.test(request);
  if(planOnly&&/(?:经|获得|等|等待)[^。；;\n]{0,12}(?:用户|我|您|你)[^。；;\n]{0,8}(?:确认|授权|批准)/u.test(request))return true;
  const steps=[...request.matchAll(/(?:然后|随后|接着|之后|并且|并|再|还要|还需|也要)([^。；;\n]{0,16}?)(?:执行|实施|实现|修改|开发|修复)/gu)];
  const proceed=IMMEDIATE_ACTION.test(request)||steps.some(step=>!/(?:不(?:要|得|必|能|允许)?|无需|无须|禁止|避免)\s*(?:(?:再|去|继续|立即|立刻)\s*)?$/u.test(step[1])&&
    !/(?:询问|请示|确认|决定|批准|授权|同意|是否|能否|可否)/u.test(step[1]));
  return planOnly&&!proceed;
};

function actionableNextStep(value){
  const text=String(value??'').trim().replace(/^[\s>*_`~]+|[\s*_`~]+$/gu,'');
  if(!text)return false;
  if(/^(?:无|没有|暂无|無|none|n\/a|not\s+applicable|[-—–]+|（无）|\(none\)|已完成(?:全部|所有)?(?:工作|任务)?[。.!！]?)$/iu.test(text))return false;
  if(/^(?:无|没有|暂无)(?:其他|其它|更多|剩余|待办|后续|进一步|未完成|工作|任务|动作|事项)?(?:[，,。.;；:：)）]|$)/u.test(text))return false;
  return true;
}

function withoutFencedCode(text){
  let fence=null;
  return text.split('\n').map(line=>{
    const match=/^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if(!fence&&match){fence=match[1];return '';}
    if(fence){
      if(match&&match[1][0]===fence[0]&&match[1].length>=fence.length&&!match[2].trim())fence=null;
      return '';
    }
    return line;
  }).join('\n');
}

function hasCompletionCandidate(current,requestText){
  const answer=withoutFencedCode(textOf(messageOf(current.assistant))).trim();
  if(!answer||!requestText.trim()||requestPausesContinuation(requestText))return false;
  const headings=[...answer.matchAll(SUMMARY_HEADING)];
  if(!headings.length)return false;
  const summary=answer.slice(headings.at(-1).index);
  const next=[...summary.matchAll(NEXT_STEP)].at(-1)?.[1]??'';
  const status=continuationText(summary);
  return actionableNextStep(next)&&!PAUSED_OR_NEEDS_USER.test(continuationText(next))&&!PAUSED_OR_NEEDS_USER.test(status);
}

/**
 * Remind once when a stage summary ends a turn with an actionable next step.
 * Register this after createQualityReview so the serial turn-stopping dispatch
 * lets final review finish (or steer) before this handler observes the inbox.
 */
export function createCompletionNotice(ctx,runtime,finalJson){
  const sent=new Map();
  const willContinue=(agent,current=finalJson.inspect(agent))=>{
    if(!runtime.isEnabled(agent)||pending(agent)||typeof agent.steer!=='function')return false;
    const config=runtime.get(agent).config;
    if(config.completionNotice===false||!current.request||!current.assistant||current.issue)return false;
    if((messageOf(current.assistant)?.content??[]).some(block=>block.type==='tool-call'))return false;
    const id=agent.session.id;
    const requestSeq=current.request.seq;
    if(sent.get(id)===requestSeq)return false;
    const alreadySent=current.events.some(event=>event.type==='user/message'&&messageOf(event)?.source?.kind===SOURCE&&
      messageOf(event).source.completionNotice?.requestSeq===requestSeq);
    return !alreadySent&&hasCompletionCandidate(current,textOf(messageOf(current.request)));
  };
  ctx.on('agent/turn-stopping',({agent,turn,signal})=>{
    if(signal.aborted)return;
    const current=finalJson.inspect(agent,turn);
    if(!willContinue(agent,current))return;
    const id=agent.session.id,requestSeq=current.request.seq;
    try{
      agent.steer({id:randomUUID(),role:'user',source:{kind:SOURCE,completionNotice:{version:VERSION,
        requestSeq,afterSeq:current.assistant.seq}},content:[{type:'text',text:
        '[work-evidence] 上一条答复包含阶段摘要和可执行的下一步。先依据当前用户请求核对是否仍有已授权且可执行的工作；有则在同一轮继续实际动作。用户要求暂停、需要用户决定或授权、下一步为无或任务已完成时，说明真实状态并结束。'}]});
      sent.set(id,requestSeq);
      runtime.effects?.decide(agent,'completionNotice','applied','stage-summary-actionable-next-step',{requestSeq,afterSeq:current.assistant.seq});
    }catch(error){
      runtime.effects?.decide(agent,'completionNotice','unavailable','native-steering-failed',{requestSeq,message:String(error?.message??error).slice(0,240)});
    }
  });
  ctx.on('agent/disposed',({agent})=>sent.delete(agent.session.id));
  return {willContinue,summary(agent){
    const current=finalJson.inspect(agent);
    return {enabled:runtime.isEnabled(agent)&&runtime.get(agent).config.completionNotice!==false,version:VERSION,
      notices:current.events.filter(event=>event.type==='user/message'&&messageOf(event)?.source?.kind===SOURCE).length,
      currentRequestNotified:!!current.request&&current.events.some(event=>messageOf(event)?.source?.kind===SOURCE&&
        messageOf(event).source.completionNotice?.requestSeq===current.request.seq),
      scope:'process-local once-per-request stage-summary reminder'};
  }};
}
