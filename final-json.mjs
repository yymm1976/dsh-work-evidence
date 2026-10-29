import {randomUUID} from 'node:crypto';
import {eventLog,isUserRequestMessage,textOf} from './runtime.mjs';

const SOURCE='work-evidence-final-json';
const messageOf=event=>event?.data?.message??event?.data;
function expectsFinalJson(text){
  if(/(?:故意|无效|非法|不合法|malformed|invalid)\s*JSON[^。；;\n]{0,16}(?:示例|例子|example|sample)/iu.test(text))return false;
  return /(?:最终|最后)[^。；;\n]{0,80}JSON|(?:只|仅)(?:能|需)?(?:返回|输出)[^。；;\n]{0,24}JSON|(?:返回|输出)(?:一[个份段])?(?:合法|有效|完整的?)?\s*JSON(?:对象|数组|代码块)|\b(?:final\s+(?:answer|response|result)|return\s+only|output\s+only)\b[^\n.]{0,80}\bJSON\b/iu.test(text);
}

/** Inspect declared final JSON without repairing or replacing the model's text. */
export function finalJsonSyntaxIssue(text,request){
  if(!expectsFinalJson(String(request??'')))return null;
  const fenced=[...String(text??'').matchAll(/```json\b[ \t]*\r?\n?([\s\S]*?)```/giu)].map(match=>match[1]);
  const trimmed=String(text??'').trim(),plain=trimmed.startsWith('{')||trimmed.startsWith('[');
  const candidates=fenced.length?fenced:plain&&/(?:只|仅)(?:能|需)?(?:返回|输出)|\b(?:return|output)\s+only\b/iu.test(request)?[trimmed]:[];
  for(const raw of candidates){
    try{JSON.parse(raw);}catch(error){return {raw,error:String(error.message).slice(0,300)};}
  }
  return null;
}

export function createFinalJsonGuard(ctx,runtime){
  const syntaxRepairing=new Map();
  if(typeof ctx.tools?.guard==='function')ctx.tools.guard(exec=>{
    const pending=exec.agent&&syntaxRepairing.get(exec.agent.session.id);
    if(!pending)return;
    return 'Final JSON syntax repair is active for assistant event '+pending.afterSeq+
      '. Use the successful observations already present in this session and rewrite the complete JSON without tool calls.';
  });
  function inspect(agent,turn){
    const events=eventLog(agent.session).filter(event=>event.surfaceOp?.op!=='replace');
    const request=events.findLast(event=>event.type==='user/message'&&isUserRequestMessage(messageOf(event)));
    const assistant=events.findLast(event=>event.type==='assistant/message'&&(turn===undefined||event.data?.turn===turn));
    const message=messageOf(assistant);
    const issue=request&&assistant&&assistant.seq>request.seq&&!message?.content?.some(block=>block.type==='tool-call')
      ?finalJsonSyntaxIssue(textOf(message),textOf(messageOf(request))):null;
    return {events,request,assistant,issue};
  }
  const feedback=event=>event.type==='user/message'&&messageOf(event)?.source?.kind===SOURCE;
  ctx.on('agent/turn-stopping',async({agent,turn,signal})=>{
    if(signal.aborted||!runtime.isEnabled(agent)||!runtime.get(agent).config.finalJsonGuard)return;
    const current=inspect(agent,turn);
    if(!current.issue){syntaxRepairing.delete(agent.session.id);return;}
    const prior=current.events.filter(event=>feedback(event)&&messageOf(event).source.finalJson?.requestSeq===current.request.seq);
    const repeated=prior.some(event=>{
      const seq=messageOf(event).source.finalJson.afterSeq;
      const original=current.events.find(item=>item.seq===seq&&item.type==='assistant/message');
      return original&&finalJsonSyntaxIssue(textOf(messageOf(original)),textOf(messageOf(current.request)))?.raw===current.issue.raw;
    });
    if(repeated){
      syntaxRepairing.delete(agent.session.id);
      runtime.effects?.decide(agent,'finalJson','failed','same-invalid-json-repeated',{afterSeq:current.assistant.seq,error:current.issue.error});
      await runtime.receipt(agent,signal,true);
      return;
    }
    if(typeof agent.steer!=='function'){
      syntaxRepairing.delete(agent.session.id);
      runtime.effects?.decide(agent,'finalJson','unavailable','native-steering-unavailable',{afterSeq:current.assistant.seq});
      return;
    }
    syntaxRepairing.set(agent.session.id,{turn,afterSeq:current.assistant.seq});
    agent.steer({id:randomUUID(),role:'user',source:{kind:SOURCE,finalJson:{kind:'syntax-repair',requestSeq:current.request.seq,afterSeq:current.assistant.seq}},
      content:[{type:'text',text:'[work-evidence] 用户明确要求的最终JSON在助手事件'+current.assistant.seq+'中无法严格解析。解析信息（数据）：'+JSON.stringify(current.issue.error)+'。只使用本会话已经成功取得的实际结果重写这份交付，不重新读取、执行或计算；依据错误只修正语法、转义、括号或漏掉的原有条目，保持相同数据和字段，输出一个紧凑JSON代码块。只有已有结果本身缺失时才补一个最小必要动作；不要只在说明中承认笔误，也不要只给改动片段。原答复保留，当前只修正这份交付。'}]});
    runtime.effects?.decide(agent,'finalJson','applied','invalid-final-json-repair-requested',{afterSeq:current.assistant.seq,error:current.issue.error});
  });
  return {inspect,summary(agent){
    const current=inspect(agent),notices=current.events.filter(feedback);
    return {enabled:runtime.isEnabled(agent)&&runtime.get(agent).config.finalJsonGuard,repairNotices:notices.length,
      currentRepairs:notices.filter(event=>messageOf(event).source.finalJson?.requestSeq===current.request?.seq).length,
      unresolvedSyntax:current.issue?{assistantSeq:current.assistant.seq,error:current.issue.error}:null,
      syntaxRepairActive:!!syntaxRepairing.get(agent.session.id),
      scope:'Strict JSON syntax for explicitly requested final JSON; semantic correctness is not established.'};
  }};
}
