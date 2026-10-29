import {renderedReads} from './observation-ledger.mjs';
import {resultText,parseResult,resultHasProblem,historyReferences,contentReferences} from './visible-results.mjs';
import {argsOf} from './runtime.mjs';
export {historyReferences} from './visible-results.mjs';

const count=text=>Array.from(text).length;
const READ=new Set(['read','ops_read_files','ops_inspect_local_file','project_evidence']);
export const prunableMessage=message=>!!message&&!message.isError&&Array.isArray(message.content)&&
  message.content.length>0&&message.content.every(block=>block?.type==='text')&&!hasPruneProblem(message.content);

export function hasPruneProblem(content,value=null){
  const text=resultText(content),parsed=value??parseResult(text);
  if(resultHasProblem(parsed??text))return true;
  // A successful wrapper can contain a failed command or a failed assertion.
  return /(?:^|\n)\s*(?:fatal:|Traceback\b|\w*(?:Error|Exception):|FAIL(?:ED)?\b)|["']passed["']\s*:\s*false|\b(?:exit(?:\s+code)?|exitCode|exit_code)\s*["']?\s*[:= ]\s*-?[1-9]\d*\b/i.test(text);
}

function excerpt(text,{seq,offset=0,sourcePath,thresholdChars,headChars,tailChars}){
  const points=Array.from(text);
  if(points.length<=thresholdChars)return null;
  const head=points.slice(0,headChars).join(''),tail=tailChars?points.slice(-tailChars).join(''):'';
  const omitted=points.length-headChars-tailChars;
  const reference={seq,offset:offset+head.length,...(sourcePath?{path:sourcePath}:{})};
  const marker=`\n[work-evidence history ${JSON.stringify(reference)}]\n[${omitted} middle characters omitted. Historical original: work_recall({seq:${seq},offset:${reference.offset}}). Retrieve needed text there; rerun only for a new observation.]\n`;
  const after=head+marker+tail;
  return count(after)<points.length?after:null;
}

function repeatedLines(text,{seq,offset}){
  const lines=text.match(/[^\n]*\n|[^\n]+$/g)??[];
  let after='',cursor=0;
  for(let index=0;index<lines.length;){
    const line=lines[index];let end=index+1;
    while(end<lines.length&&lines[end]===line)end++;
    const marker=`[work-evidence history ${JSON.stringify({seq,offset:offset+cursor+line.length})}]\n[Previous line repeated ${end-index-1} more times. Historical original: work_recall({seq:${seq},offset:${offset+cursor+line.length}}).]\n`;
    after+=end-index>=3&&line.length*(end-index-1)>marker.length+256?line+marker:lines.slice(index,end).join('');
    cursor+=line.length*(end-index);index=end;
  }
  return after;
}

/** Old output only. A native read window is the smallest independently pruned unit. */
export function planContextPrune(message,reads,options){
  if(!prunableMessage(message))return null;
  const original=resultText(message.content);
  if(contentReferences(original).hasReferences)return null;
  if(count(original)<=options.thresholdChars)return null;
  let content,ranges=[];
  if(reads.length){
    // Never cut an unidentified compound output across file boundaries.
    if(message.content.length!==1)return null;
    const rendered=renderedReads(reads,original);
    if(!rendered)return null;
    const lines=original.match(/[^\n]*\n|[^\n]+$/g)??[];
    const offsets=[0];for(const line of lines)offsets.push(offsets.at(-1)+line.length);
    let cursor=0,after='';
    for(const window of rendered.value.items){
      const {start,end}=window.renderedSpan;
      if(start<cursor||end>lines.length)return null;
      const from=offsets[start],to=offsets[end],body=original.slice(from,to);
      after+=original.slice(offsets[cursor],from);
      const replacement=options.retainSource?.(window.path)?null:excerpt(body,{...options,offset:from,sourcePath:window.path});
      after+=replacement??body;
      if(replacement)ranges.push({path:window.path,offset:from,end:to,startLine:window.lines[0]?.number,endLine:window.lines.at(-1)?.number});
      cursor=end;
    }
    after+=original.slice(offsets[cursor]);
    if(!ranges.length)return null;
    content=[{...message.content[0],text:after}];
  }else{
    let offset=0;
    content=message.content.map(block=>{
      const text=block.text??'',cleaned=repeatedLines(text,{seq:options.seq,offset});
      const after=count(cleaned)<=options.thresholdChars?cleaned:excerpt(text,{...options,offset})??text;
      if(after!==text)ranges.push({offset,end:offset+text.length});
      offset+=text.length+1;
      return {...block,text:after};
    });
    if(!ranges.length)return null;
  }
  const charsBefore=count(original),charsAfter=count(resultText(content));
  if(charsBefore-charsAfter<512)return null;
  return {content,charsBefore,charsAfter,ranges};
}

export function readDispatch(data){
  if(!READ.has(data.name))return null;
  return {name:data.name,arguments:argsOf(data.arguments),callId:data.subCallId??data.callId,
    isError:!!data.isError,value:data.value??parseResult(resultText(data.content)),meta:data.meta};
}
