import {randomUUID} from 'node:crypto';
import {eventLog,isUserRequestMessage,textOf} from './runtime.mjs';

const SOURCE='work-evidence-final-json';
const PROCESS_FIELDS=['exitCode','stdout','stderr'];
const SHELL_TOOLS=new Set(['pwsh','bash','ops_bash']);
const MAX_REPAIRS=2;
const messageOf=event=>event?.data?.message??event?.data;
const STRICT_JSON_OUTPUT=/(?:只|仅)(?:能|需)?(?:返回|输出)|\b(?:return|output)\s+only\b/iu;
const PROMPT_REFERENCE=/(?:(?:解释|说明|翻译|分析|审查|评审|修改|编辑|改写|替换|更新|检查|explain|translate|describe|review|analy[sz]e|edit|modify|rewrite|replace|update|inspect)[^。！？;\n]{0,140}(?:指令|要求|提示|示例|例子|README|instruction|prompt|example)|(?:指令|要求|提示|示例|例子|README|instruction|prompt|example)[^。！？;\n]{0,140}(?:解释|说明|翻译|分析|审查|评审|修改|编辑|改写|替换|更新|检查|explain|translate|describe|review|analy[sz]e|edit|modify|rewrite|replace|update|inspect))/iu;
const JSON_TOPIC_REFERENCE=/(?:最终|最后)\s*JSON\s*(?:解析|处理|校验|验证|格式|代码|文件|逻辑|函数|模块|配置|路径|字段|问题|实现|方案|需求|要求|示例|说明)|\bfinal\s+JSON\s+(?:parsing|handling|validation|format|code|file|logic|function|module|config|schema|example|instruction)\b/iu;
const CLAUSE_LEAD=/^(?:(?:and|but|so|then|also|finally|please|kindly)\s+|(?:can|could|would)\s+you\s+|i\s+need\s+you\s+to\s+|you\s+(?:must|should|need\s+to|have\s+to)\s+|请(?:你)?\s*|然后|随后|并且|同时)+/iu;
const REFERENCE_ACTION=/^(?:解释|说明|翻译|分析|审查|评审|修改|编辑|改写|替换|更新|检查)|\b(?:describe|explain|translate|review|analy[sz]e|edit|modify|rewrite|replace|update|inspect)\b/iu;
const ENGLISH_OUTPUT_ACTION=/^(?:(?:only|just)\s+)?(?:(?:you|assistant)\s+)?(?:(?:must|should|need\s+to|have\s+to|shall|will|can|could)\s+)?(?:return|output|provide|give|reply|respond)\b/iu;
const CHINESE_OUTPUT_ACTION=/^(?:(?:最终|最后|只|仅|直接|务必|必须|应该|应当|需要|能|需|须|可)\s*)*(?:返回|输出|提供|给出)/iu;
const ENGLISH_FINAL_ACTION=/^(?:the\s+)?final\s+(?:assistant\s+)?(?:answer|response|result|text|output)\s+(?:must|should|needs?\s+to|has\s+to|is\s+required\s+to|will)\s+(?:be|contain|consist\s+of)?[^\n]{0,80}\bJSON\b/iu;
const CHINESE_FINAL_ACTION=/^(?:最终|最后)(?:的)?(?:助手)?(?:回答|响应|结果|文本|输出)[^。；;\n]{0,40}(?:必须|应当|应该|需要|务必)[^。；;\n]{0,80}JSON/iu;
const JSON_AS_FINAL=/^(?:the\s+)?JSON\b[^\n]{0,60}(?:as|is)[^\n]{0,20}final\s+(?:assistant\s+)?(?:answer|response|result|text|output)\b|^(?:以下)?\s*JSON\s*[^。；;\n]{0,60}(?:作为|是)[^。；;\n]{0,20}(?:最终|最后)[^。；;\n]{0,20}(?:回答|响应|结果|文本|输出)/iu;
function requestDirectives(text){
  return text
    .replace(/```[\s\S]*?```/gu,'\n')
    .replace(/`[^`\r\n]*`/gu,' ')
    .replace(/"[^"\r\n]*"|“[^”\r\n]*”|'[^'\r\n]*'/gu,' ');
}
function requestClauses(text){
  return requestDirectives(String(text??''))
    .split(/[。！？?!;；\n,.，]/u)
    .map(clause=>clause.trim().replace(CLAUSE_LEAD,'').trim())
    .filter(Boolean);
}
function isAssistantOutputAction(clause){
  return ENGLISH_OUTPUT_ACTION.test(clause)||CHINESE_OUTPUT_ACTION.test(clause)||
    ENGLISH_FINAL_ACTION.test(clause)||CHINESE_FINAL_ACTION.test(clause)||JSON_AS_FINAL.test(clause);
}
function isReferenceAction(clause){
  return REFERENCE_ACTION.test(clause.replace(CLAUSE_LEAD,'').trim());
}
function mentionsRequestedFinalJson(clause){
  const rawOutput=/(?:裸|原始|纯|\braw\b|\bbare\b|\bunwrapped\b|\bplain\b|\bnaked\b|\bunformatted\b)[^。！？;\n]{0,16}JSON/iu.test(clause)&&
    /(?:最终|返回|输出|作为|return|output|final)/iu.test(clause);
  return rawOutput||/(?:最终|最后)[^。；;\n]{0,80}JSON|(?:只|仅)(?:能|需|须|可)?(?:返回|输出)[^。；;\n]{0,24}JSON|(?:返回|输出)(?:一[个份段])?(?:合法|有效|完整的?)?(?:裸|原始|纯)?\s*JSON(?:对象|数组|值|文本|代码块)|JSON[^。；;\n]{0,40}(?:作为|是)[^。；;\n]{0,16}(?:最终|回答|输出)|(?:返回|输出|提供)[^。；;\n]{0,80}JSON[^。；;\n]{0,80}(?:直接|原样)|(?:返回|输出|提供)[^。；;\n]{0,80}(?:直接|原样)[^。；;\n]{0,80}JSON/iu.test(clause)||
    /\b(?:final\s+(?:assistant\s+)?(?:answer|response|result|text|output)|(?:return|output)\s+only)\b[^\n.]{0,80}\bJSON\b|\bJSON\b[^\n.]{0,80}\bfinal\s+(?:assistant\s+)?(?:answer|response|result|text|output)\b|\b(?:return|output|provide)\b[^\n.]{0,80}\bJSON\b[^\n.]{0,80}\bdirectly\b/iu.test(clause);
}
function expectsFinalJson(text){
  const request=requestDirectives(String(text??''));
  if(/(?:故意|无效|非法|不合法|malformed|invalid)\s*JSON[^。；;\n]{0,16}(?:示例|例子|example|sample)/iu.test(request))return false;
  if(PROMPT_REFERENCE.test(request))return false;
  if(JSON_TOPIC_REFERENCE.test(request))return false;
  return requestClauses(request).some(clause=>
    !isReferenceAction(clause)&&isAssistantOutputAction(clause)&&mentionsRequestedFinalJson(clause));
}
function hasAllowedFenceOutput(text){
  return /JSON\s*代码块|(?:使用|用|放在|包装(?:在|成))[^。；;\n]{0,24}(?:(?:Markdown|markdown)\s*)?(?:代码块|围栏)|\bJSON\s+(?:Markdown\s+)?(?:code\s+)?(?:block|fence)\b|(?:return|output|provide)\b[^\n.]{0,24}\b(in|as|inside|within|using)\s+(?:a|the)\s+(?:Markdown\s+|JSON\s+)?(?:code\s+block|fence)\b/iu.test(text);
}
function requiresRawFinalJson(text){
  const allowedFence=hasAllowedFenceOutput(text);
  const clauses=requestClauses(text).filter(clause=>!isReferenceAction(clause));
  const action=clauses.some(isAssistantOutputAction);
  const hasNoFence=clause=>/(?:\bno\b|\bwithout\b)[^\n.]{0,40}\b(?:(?:surrounding\s+)?Markdown(?:\s+(?:formatting|fences?|blocks?|surrounding))?|(?:code\s+)?(?:fences?|blocks?))\b|\b(?:do|must|should)\s+not\b[^\n.]{0,40}(?:use|include|add|wrap)[^\n.]{0,20}\b(?:Markdown\s+)?(?:code\s+)?(?:fences?|blocks?)\b|(?:不要|不得|禁止|无需|不加|不使用|不能使用|不允许)[^。；;\n]{0,24}(?:(?:(?:Markdown|markdown)\s*)?(?:代码围栏|围栏|代码块)|(?:周围的?|外层的?|包裹的?)\s*Markdown)/iu
    .test(clause);
  return clauses.some(clause=>{
    if(!isAssistantOutputAction(clause))return false;
    const raw=/\b(raw|bare|unwrapped|plain|naked|unformatted)\s+JSON\b/iu.test(clause)||
      /(?:裸|未包装|未经包装|原始|纯)\s*JSON/iu.test(clause);
    const direct=/(?:return|output|provide)\b[^\n.]{0,100}\bJSON\b[^\n.]{0,80}\bdirectly\b|\bJSON\b[^\n.]{0,80}\bdirectly\s+as\s+(?:the\s+)?final\s+(?:assistant\s+)?(?:answer|response|result|text)\b/iu.test(clause)||
      /(?:直接|原样)[^。；;\n]{0,80}(?:作为|是)[^。；;\n]{0,16}(?:最终|回答|输出)|(?:直接|原样)[^。；;\n]{0,24}(?:返回|输出|提供|给出)[^。；;\n]{0,24}JSON|(?:返回|输出|提供)[^。；;\n]{0,80}(?:直接|原样)[^。；;\n]{0,24}JSON/iu.test(clause);
    const exact=/\b(?:exactly|solely)\s+(?:one|a\s+single)\s+JSON(?:\s+(?:value|object|array|document))?\b|\bonly\s+one\s+JSON(?:\s+(?:value|object|array|document))?\b|(?:最终|最后)[^。；;\n]{0,40}(?:恰好|精确|严格|仅|只)[^。；;\n]{0,20}(?:一个|一[个份])?\s*JSON\s*值/iu.test(clause);
    const strictOnly=STRICT_JSON_OUTPUT.test(clause)&&/JSON/iu.test(clause);
    return hasNoFence(clause)||!allowedFence&&(raw||direct||exact||strictOnly);
  })||action&&clauses.some(hasNoFence);
}
// Unlabeled fences are ambiguous with shell/JS, so require a JSON-shaped leading token.
function looksLikeJsonBlock(raw){
  const value=raw.trim();
  if(value.startsWith('{')){
    const rest=value.slice(1).trimStart();
    if(rest===''||rest.startsWith('}'))return true;
    if(!rest.startsWith('"'))return false;
    const key=/^"(?:[^"\\]|\\.)*"/u.exec(rest);
    return !key||rest.slice(key[0].length).trimStart().startsWith(':');
  }
  if(!value.startsWith('['))return false;
  const rest=value.slice(1).trimStart();
  if(rest==='')return true;
  if(rest[0]===']'||rest[0]==='{'||rest[0]==='[')return true;
  if(rest[0]==='"'){
    const string=/^"(?:[^"\\]|\\.)*"/u.exec(rest);
    if(!string)return true;
    const tail=rest.slice(string[0].length).trimStart();
    return tail===''||tail.startsWith(',')||tail.startsWith(']');
  }
  if(/^(?:true|false|null)(?=\s*[,\]}]|\s*$)/u.test(rest))return true;
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?=\s*[,\]]|\s*$)/u.test(rest);
}
function fencedCandidates(text){
  const candidates=[];
  for(const match of text.matchAll(/```([^\r\n`]*)\r?\n([\s\S]*?)```/gu)){
    const language=match[1].trim().split(/\s+/u)[0].toLowerCase();
    if(language==='json'||(!language&&looksLikeJsonBlock(match[2])))candidates.push(match[2]);
  }
  return candidates;
}

/** Inspect declared final JSON without repairing or replacing the model's text. */
export function finalJsonSyntaxIssue(text,request){
  const requestText=String(request??''),source=String(text??'');
  if(!expectsFinalJson(requestText))return null;
  const trimmed=source.trim();
  if(requiresRawFinalJson(requestDirectives(requestText))){
    try{JSON.parse(trimmed);}catch(error){return {raw:trimmed,error:String(error.message).slice(0,300),rawFinal:true};}
    return null;
  }
  const plain=trimmed.startsWith('{')||trimmed.startsWith('[');
  const candidates=fencedCandidates(source);
  if(!candidates.length&&plain&&STRICT_JSON_OUTPUT.test(requestText))candidates.push(trimmed);
  for(const raw of candidates){
    try{JSON.parse(raw);}catch(error){return {raw,error:String(error.message).slice(0,300)};}
  }
  return null;
}

function jsonValue(text){
  const blocks=fencedCandidates(text);
  if(blocks.length>1)return null;
  try{return JSON.parse(blocks[0]??text.trim());}catch{return null;}
}
function processFields(value){
  if(!value||Array.isArray(value)||!Number.isSafeInteger(value.exitCode)||
    typeof value.stdout!=='string'||typeof value.stderr!=='string')return null;
  return Object.fromEntries(PROCESS_FIELDS.map(key=>[key,value[key]]));
}
function completeProcessResult(result){
  const value=result?.value?.data??result?.value;
  if(result?.isError||!value||value.partial||value.timedOut||value.aborted||value.cancelled||value.background||value.signal||value.jobId||
    value.complete===false||value.truncated===true||value.kind&&!['completed','foreground'].includes(value.kind)||
    value.status&&value.status!=='completed')return null;
  const streams=[value.stdout,value.stderr];
  if(streams.some(stream=>!stream||typeof stream.text!=='string'||stream.truncated!==false||stream.complete===false))return null;
  const fields=processFields({exitCode:value.exitCode,stdout:value.stdout.text,stderr:value.stderr.text});
  return fields&&fields.stdout.length+fields.stderr.length<=32000?fields:null;
}

// Compare only a displayed, unchanged native result for an explicit literal-copy request.
export function finalJsonResultIssue({events,request,assistant,observation,visibleSeqs}){
  const requestText=textOf(messageOf(request));
  if(!observation||request?.seq!==observation.requestSeq||!expectsFinalJson(requestText)||!STRICT_JSON_OUTPUT.test(requestText)||
    !PROCESS_FIELDS.every(key=>new RegExp('\\b'+key+'\\b','u').test(requestText))||
    !/(?:完整(?:的)?(?:实际)?(?:输出|结果)|原样|逐字|\b(?:exact|verbatim|full actual|complete actual)\b)/iu.test(requestText)||
    /(?:摘要|截取|脱敏|归一|规范化|去掉|删除换行|不含换行|\b(?:summary|summarize|redact|normalize|trim|strip|truncate|replace|without)\b)/iu.test(requestText))return null;
  const source=events.findLast(event=>event.type==='tool/result'&&event.seq>request.seq&&event.seq<assistant.seq);
  if(!source||!Array.isArray(visibleSeqs)||!visibleSeqs.includes(source.seq)||messageOf(source)?.isError||
    (messageOf(source)?.source?.callId??messageOf(source)?.toolCallId)!==observation.rootCallId)return null;
  const dispatches=events.filter(event=>['tool/ptc-dispatch','tool/code-dispatch'].includes(event.type)&&
    event.seq>request.seq&&event.seq<source.seq&&event.data?.rootCallId===observation.rootCallId);
  if(dispatches.length!==1||dispatches[0].data.subCallId!==observation.callId||dispatches[0].data.isError||
    dispatches[0].data.name!==observation.tool)return null;
  const original=jsonValue(textOf(messageOf(source))),answer=jsonValue(textOf(messageOf(assistant)));
  if(!original||Object.keys(original).length!==3||!processFields(original)||!answer||Array.isArray(answer)||
    typeof answer!=='object'||Object.keys(answer).some(key=>!PROCESS_FIELDS.includes(key))||
    PROCESS_FIELDS.some(key=>original[key]!==observation.fields[key]))return null;
  const fields=PROCESS_FIELDS.filter(key=>!Object.hasOwn(answer,key)||answer[key]!==original[key]);
  if(!fields.length||fields.some(key=>key==='exitCode'||typeof answer[key]!=='string'||
    !original[key].startsWith(answer[key])||! /^(?:\r\n|\n|\r)+$/u.test(original[key].slice(answer[key].length))))return null;
  return {kind:'observed-result-repair',sourceSeq:source.seq,fields,
    error:'Final JSON omits terminal line endings from the complete visible native execution result in: '+fields.join(', ')};
}

export function createFinalJsonGuard(ctx,runtime){
  const syntaxRepairing=new Map(),observations=new Map();
  ctx.on('tools/result',(exec,result)=>{
    if(!exec.agent||!SHELL_TOOLS.has(exec.name))return;
    const agent=exec.agent,id=agent.session.id,config=runtime.get(agent).config;
    observations.delete(id);
    if(exec.signal?.aborted||!runtime.isEnabled(agent)||!config.finalJsonGuard||!config.finalJsonResultGuard)return;
    const request=eventLog(agent.session).findLast(event=>event.type==='user/message'&&isUserRequestMessage(messageOf(event)));
    const fields=completeProcessResult(result);
    if(request&&fields)observations.set(id,{requestSeq:request.seq,rootCallId:exec.rootCallId??exec.callId,callId:exec.callId,tool:exec.name,fields});
  });
  if(typeof ctx.tools?.guard==='function')ctx.tools.guard(exec=>{
    const pending=exec.agent&&syntaxRepairing.get(exec.agent.session.id);
    if(!pending)return;
    const config=runtime.get(exec.agent).config;
    if(exec.signal?.aborted||!runtime.isEnabled(exec.agent)||!config.finalJsonGuard||
      pending.kind==='observed-result-repair'&&!config.finalJsonResultGuard){syntaxRepairing.delete(exec.agent.session.id);return;}
    return 'Final JSON repair is active for assistant event '+pending.afterSeq+
      '. Use the successful observations already present in this session and rewrite the complete JSON without tool calls.';
  });
  function inspect(agent,turn){
    const events=eventLog(agent.session).filter(event=>event.surfaceOp?.op!=='replace');
    const request=events.findLast(event=>event.type==='user/message'&&isUserRequestMessage(messageOf(event)));
    const assistant=events.findLast(event=>event.type==='assistant/message'&&(turn===undefined||event.data?.turn===turn));
    const message=messageOf(assistant);
    let issue=null;
    if(request&&assistant&&assistant.seq>request.seq&&!message?.content?.some(block=>block.type==='tool-call')){
      issue=finalJsonSyntaxIssue(textOf(message),textOf(messageOf(request)));
      if(!issue&&runtime.get(agent).config.finalJsonResultGuard)issue=finalJsonResultIssue({events,request,assistant,
        observation:observations.get(agent.session.id),visibleSeqs:agent.session.surface?.nodes});
    }
    return {events,request,assistant,issue};
  }
  const feedback=event=>event.type==='user/message'&&messageOf(event)?.source?.kind===SOURCE;
  ctx.on('agent/turn-stopping',async({agent,turn,signal})=>{
    if(signal?.aborted||!runtime.isEnabled(agent)||!runtime.get(agent).config.finalJsonGuard){syntaxRepairing.delete(agent.session.id);return;}
    const current=inspect(agent,turn);
    if(!current.issue){syntaxRepairing.delete(agent.session.id);return;}
    if(syntaxRepairing.get(agent.session.id)?.afterSeq===current.assistant.seq)return;
    const prior=current.events.filter(event=>feedback(event)&&messageOf(event).source.finalJson?.requestSeq===current.request.seq);
    const kind=current.issue.kind??'syntax-repair';
    if(prior.length>=MAX_REPAIRS||kind==='observed-result-repair'&&prior.some(event=>messageOf(event).source.finalJson.kind===kind)){
      syntaxRepairing.delete(agent.session.id);
      runtime.effects?.decide(agent,kind==='observed-result-repair'?'finalJsonResult':'finalJson','failed','final-json-repair-limit',{afterSeq:current.assistant.seq,kind,error:current.issue.error});
      await runtime.receipt?.(agent,signal,true);
      return;
    }
    const repeated=prior.some(event=>{
      if(kind!=='syntax-repair')return false;
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
      runtime.effects?.decide(agent,kind==='observed-result-repair'?'finalJsonResult':'finalJson','unavailable','native-steering-unavailable',{afterSeq:current.assistant.seq});
      return;
    }
    syntaxRepairing.set(agent.session.id,{turn,kind,afterSeq:current.assistant.seq});
    const rawFinal=current.issue.rawFinal===true;
    const rawInstruction=rawFinal
      ?(/[\u3400-\u9fff]/u.test(textOf(messageOf(current.request)))
        ?'只输出一个 JSON 值作为最终助手文本，不得添加说明、前缀或后缀，也不得使用 Markdown 代码围栏。'
        :'Output exactly one JSON value directly as the final assistant text, with no prose, prefix, suffix, or Markdown fence.')
      :'输出一个紧凑JSON代码块。';
    const notice=kind==='observed-result-repair'
      ?'[work-evidence] 用户要求完整实际执行结果。助手事件'+current.assistant.seq+'的最终JSON与本轮完整可见的原生结果不一致。差异位置（数据）：'+JSON.stringify({sourceSeq:current.issue.sourceSeq,fields:current.issue.fields})+'。只依据该结果原样重写exitCode、stdout、stderr，保留字符串内的全部字符和末尾换行，使用JSON转义。已有结果足够，不重新执行、读取或计算。原答复保留。'
      :'[work-evidence] 用户明确要求的最终JSON在助手事件'+current.assistant.seq+'中无法严格解析。解析信息（数据）：'+JSON.stringify(current.issue.error)+'。只使用本会话已经成功取得的实际结果重写这份交付，不重新读取、执行或计算；依据错误只修正语法、转义、括号或漏掉的原有条目，保持相同数据和字段，'+rawInstruction+'只有已有结果本身缺失时才补一个最小必要动作；不要只在说明中承认笔误，也不要只给改动片段。原答复保留，当前只修正这份交付。';
    try{agent.steer({id:randomUUID(),role:'user',source:{kind:SOURCE,finalJson:{kind,requestSeq:current.request.seq,afterSeq:current.assistant.seq}},
      content:[{type:'text',text:notice}]});}
    catch(error){
      syntaxRepairing.delete(agent.session.id);
      runtime.effects?.decide(agent,kind==='observed-result-repair'?'finalJsonResult':'finalJson','unavailable','native-steering-failed',{afterSeq:current.assistant.seq});
      runtime.problem?.(runtime.get(agent),'final-json-steering',String(error?.message??error));
      return;
    }
    runtime.effects?.decide(agent,kind==='observed-result-repair'?'finalJsonResult':'finalJson','applied',kind==='syntax-repair'?'invalid-final-json-repair-requested':'observed-result-repair-requested',
      {afterSeq:current.assistant.seq,error:current.issue.error,...(current.issue.sourceSeq===undefined?{}:{sourceSeq:current.issue.sourceSeq,fields:current.issue.fields})});
  });
  ctx.on('session/event',(session,event)=>{
    if(event.type==='turn/end')syntaxRepairing.delete(session.id);
    if(event.type==='user/message'&&isUserRequestMessage(messageOf(event))){syntaxRepairing.delete(session.id);observations.delete(session.id);}
  });
  ctx.on('agent/disposed',({agent})=>{syntaxRepairing.delete(agent.session.id);observations.delete(agent.session.id);});
  return {inspect,clear:agent=>{syntaxRepairing.delete(agent.session.id);observations.delete(agent.session.id);},summary(agent){
    const current=inspect(agent),notices=current.events.filter(feedback);
    return {enabled:runtime.isEnabled(agent)&&runtime.get(agent).config.finalJsonGuard,repairNotices:notices.length,
      currentRepairs:notices.filter(event=>messageOf(event).source.finalJson?.requestSeq===current.request?.seq).length,
      unresolvedSyntax:current.issue&&!current.issue.kind?{assistantSeq:current.assistant.seq,error:current.issue.error}:null,
      unresolvedResult:current.issue?.kind==='observed-result-repair'?{assistantSeq:current.assistant.seq,sourceSeq:current.issue.sourceSeq,fields:current.issue.fields}:null,
      syntaxRepairActive:syntaxRepairing.get(agent.session.id)?.kind==='syntax-repair',
      resultRepairActive:syntaxRepairing.get(agent.session.id)?.kind==='observed-result-repair',
      resultGuardEnabled:runtime.isEnabled(agent)&&runtime.get(agent).config.finalJsonGuard&&!!runtime.get(agent).config.finalJsonResultGuard,
      maxRepairsPerRequest:MAX_REPAIRS,
      scope:'Explicit final JSON syntax, plus optional literal process-field copying from one complete visible native result; general semantic correctness is not established.'};
  }};
}
