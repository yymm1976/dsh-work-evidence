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

function repeatedLineOperations(text,{seq,offset}){
  const lines=text.match(/[^\n]*\n|[^\n]+$/g)??[];
  const starts=[];let cursor=0;
  for(const line of lines){starts.push(cursor);cursor+=line.length;}
  const operations=[];
  for(let index=0;index<lines.length;){
    const line=lines[index];let end=index+1;
    while(end<lines.length&&lines[end]===line)end++;
    const start=starts[index],runEnd=starts[end]??text.length;
    const marker=`[work-evidence history ${JSON.stringify({seq,offset:offset+start+line.length})}]\n[Previous line repeated ${end-index-1} more times. Historical original: work_recall({seq:${seq},offset:${offset+start+line.length}}).]\n`;
    if(end-index>=3&&line.length*(end-index-1)>marker.length+256)
      operations.push({start,end:runEnd,text:line+marker});
    index=end;
  }
  return operations;
}

const DEDUP_MIN_CHARS=2048;
const DEDUP_HASH_BASES=[1000003,1000033];
function hashWindow(text,start,length,base){
  let hash=0;
  for(let index=start;index<start+length;index++)hash=(Math.imul(hash,base)+text.charCodeAt(index))>>>0;
  return hash;
}
function hashPower(base,length){
  let power=1;
  for(let index=1;index<length;index++)power=Math.imul(power,base)>>>0;
  return power;
}
function rollHash(hash,base,power,outgoing,incoming){
  return (Math.imul((hash-Math.imul(outgoing,power))>>>0,base)+incoming)>>>0;
}
function windowsEqual(text,left,right,length){
  for(let index=0;index<length;index++)if(text.charCodeAt(left+index)!==text.charCodeAt(right+index))return false;
  return true;
}
/**
 * Long-common-segment dedup within one result body. A segment that appears a
 * second time (a re-read of the same file region, a repeated command block) is
 * replaced after its first occurrence with a recall locator; the first
 * occurrence stays verbatim as the authoritative source. Works on the raw
 * string so it composes with repeatedLines and excerpt budgets.
 */
function dedupOperations(text,{seq,offset=0}){
  if(text.length<DEDUP_MIN_CHARS*2)return null;
  // Hash every minimum-length window, then extend a hit to the real duplicate
  // boundary. Jumping past an adopted duplicate keeps the scan near-linear.
  const powers=DEDUP_HASH_BASES.map(base=>hashPower(base,DEDUP_MIN_CHARS));
  const seen=new Map(),segments=new Map();
  let cursor=0,hashes=DEDUP_HASH_BASES.map(base=>hashWindow(text,0,DEDUP_MIN_CHARS,base));
  while(cursor+DEDUP_MIN_CHARS<=text.length){
    const key=hashes.join(':');
    let prior=seen.get(key);
    let later=-1;
    if(prior===undefined)seen.set(key,cursor);
    else if(typeof prior==='number'){
      if(windowsEqual(text,prior,cursor,DEDUP_MIN_CHARS))later=prior;
      else seen.set(key,[prior,cursor]);
    }else{
      later=prior.find(start=>windowsEqual(text,start,cursor,DEDUP_MIN_CHARS))??-1;
      if(later<0)prior.push(cursor);
    }
    if(later<0){
      if(cursor+DEDUP_MIN_CHARS===text.length)break;
      const outgoing=text.charCodeAt(cursor),incoming=text.charCodeAt(cursor+DEDUP_MIN_CHARS);
      hashes=hashes.map((hash,index)=>rollHash(hash,DEDUP_HASH_BASES[index],powers[index],outgoing,incoming));
      cursor++;
      continue;
    }
    const gap=cursor-later;
    // Extend both ends while the two occurrences agree.
    let from=cursor,to=cursor+DEDUP_MIN_CHARS;
    while(from-gap>=0&&text[from-1]===text[from-1-gap])from--;
    while(to<text.length&&text[to]===text[to-gap])to++;
    const chars=to-from;
    const prev=segments.get(from);
    if(!prev||chars>prev.chars)segments.set(from,{chars,gap});
    if(to+DEDUP_MIN_CHARS>text.length)break;
    cursor=to;
    hashes=DEDUP_HASH_BASES.map(base=>hashWindow(text,cursor,DEDUP_MIN_CHARS,base));
  }
  const merged=[];
  const ordered=[...segments.entries()].sort((x,y)=>x[0]-y[0]);
  for(const [later,{chars,gap}] of ordered){
    const last=merged.at(-1);
    if(last&&later<last.later+last.chars)continue;
    // The whole earlier occurrence must remain visible. An overlapping match,
    // or an earlier occurrence crossing another fold, cannot supply that body.
    const sourceStart=later-gap;
    let retainedChars=Math.min(chars,gap);
    for(const previous of merged)if(sourceStart<previous.later+previous.chars&&previous.later<sourceStart+retainedChars)
      retainedChars=Math.min(retainedChars,Math.max(0,previous.later-sourceStart));
    if(retainedChars<DEDUP_MIN_CHARS)continue;
    merged.push({later,chars:retainedChars,gap});
  }
  const operations=[];let saved=0;
  for(const {later,chars,gap} of merged){
    const marker=`[work-evidence history ${JSON.stringify({seq,offset:offset+later})}]\n[${chars} characters identical to earlier content in this result; the earlier occurrence above is the authoritative body. Recall only if the earlier occurrence itself is pruned: work_recall({seq:${seq},offset:${offset+later}}).]\n`;
    operations.push({start:later,end:later+chars,sourceStart:later-gap,text:marker});
    saved+=chars-marker.length;
  }
  return saved>512?{operations,segments:merged.length,charsSaved:saved}:null;
}

function applyOperations(text,operations){
  if(!operations.length)return text;
  const ordered=[...operations].sort((left,right)=>left.start-right.start||right.end-left.end);
  let after='',cursor=0;
  for(const operation of ordered){
    if(operation.start<cursor)continue;
    after+=text.slice(cursor,operation.start)+operation.text;
    cursor=operation.end;
  }
  return after+text.slice(cursor);
}

/** Old output only. A native read window is the smallest independently pruned unit. */
export function planContextPrune(message,reads,options){
  if(!prunableMessage(message))return null;
  const original=resultText(message.content);
  if(contentReferences(original).hasReferences)return null;
  if(count(original)<=options.thresholdChars)return null;
  let content,ranges=[],dedupStats=[];
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
      const text=block.text??'';
      const repeated=repeatedLineOperations(text,{seq:options.seq,offset});
      let cleaned=applyOperations(text,repeated),stat=null;
      if(options.dedupSegments!==false){
        const deduped=dedupOperations(text,{seq:options.seq,offset});
        if(deduped){
          const outside=repeated.filter(operation=>!deduped.operations.some(range=>
            operation.start<range.end&&range.start<operation.end||
            operation.start<range.sourceStart+range.end-range.start&&range.sourceStart<operation.end));
          cleaned=applyOperations(text,[...deduped.operations,...outside]);
          stat={seq:options.seq,offset,segments:deduped.segments,charsSaved:deduped.charsSaved};
        }
      }
      const after=count(cleaned)<=options.thresholdChars?cleaned:excerpt(text,{...options,offset})??text;
      if(stat&&after===cleaned)dedupStats.push(stat);
      if(after!==text)ranges.push({offset,end:offset+text.length});
      offset+=text.length+1;
      return {...block,text:after};
    });
    if(!ranges.length)return null;
  }
  const charsBefore=count(original),charsAfter=count(resultText(content));
  if(charsBefore-charsAfter<512)return null;
  if(dedupStats.length&&Array.isArray(options.dedupStats))options.dedupStats.push(...dedupStats);
  return {content,charsBefore,charsAfter,ranges,...(dedupStats.length?{dedupStats}:{})};
}

export function readDispatch(data){
  if(!READ.has(data.name))return null;
  return {name:data.name,arguments:argsOf(data.arguments),callId:data.subCallId??data.callId,
    isError:!!data.isError,value:data.value??parseResult(resultText(data.content)),meta:data.meta};
}
