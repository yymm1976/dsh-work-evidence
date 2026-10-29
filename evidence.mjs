import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const limits=Object.freeze({files:4,lines:40,matches:12,reportItems:16,itemChars:1200,evidenceChars:7500});
export function within(root,file){
  if(typeof file!=='string'||!file.trim()||file.includes('\0')||file.length>1024)throw new Error('Invalid path');
  const full=path.resolve(root,file),relative=path.relative(root,full);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Path must remain inside the current workspace');
  return full;
}
export async function assertExistingFileWithin(root,file){
  const rootReal=await fs.realpath(root),fileReal=await fs.realpath(file);
  const relative=path.relative(rootReal,fileReal);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Path resolves outside the current workspace');
  const stat=await fs.stat(fileReal);
  if(!stat.isFile())throw new Error('Path is not a regular file');
  return {full:file,real:fileReal,size:stat.size};
}
export async function readUtf8File(file,{maxBytes=2_000_000}={}){
  const stat=await fs.stat(file);
  if(stat.size>maxBytes)throw new Error(`File exceeds the ${maxBytes}-byte read budget`);
  const buffer=await fs.readFile(file),text=buffer.toString('utf8');
  if(buffer.length>maxBytes)throw new Error(`File exceeds the ${maxBytes}-byte read budget`);
  if(!Buffer.from(text,'utf8').equals(buffer))throw new Error('File is not valid UTF-8');
  return {buffer,text,sha256:createHash('sha256').update(buffer).digest('hex'),bytes:buffer.length};
}
export const literal=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function textWindow(value,{maxLines=limits.lines,maxLineChars=500}={}){
  if(!value||typeof value.path!=='string'||!Array.isArray(value.lines))return null;
  const sourceLines=value.lines;
  const isCut=l=>String(l.text).length>maxLineChars||l.lineTextTruncated===true||l.truncated===true||/\.\.\. \(line truncated to \d+ chars\)$/.test(String(l.text));
  const lineTextTruncated=sourceLines.some(isCut);
  const lines=sourceLines.slice(0,maxLines).map(l=>({line:l.number,text:String(l.text).slice(0,maxLineChars),...(isCut(l)?{lineTextTruncated:true}:{})}));
  const linesTruncated=lines.length<sourceLines.length;
  const lastLine=lines.at(-1)?.line||0;
  const fileHasMore=Number.isInteger(value.totalLines)?lastLine<value.totalLines:null;
  return {path:value.path,lines,totalLines:value.totalLines,lineTextTruncated,linesTruncated,fileHasMore,...(value.truncatedByBytes?{budgetTruncated:true}:{}),
    truncated:!!value.truncatedByBytes||lineTextTruncated||linesTruncated||fileHasMore===true};
}
export function finalizeEvidenceWindow(source,mode){
  if(!source?.requestedRange){source.rangeComplete=false;source.rowRangeComplete=false;return source;}
  const {offset,limit}=source.requestedRange;
  if(!source.lines?.length){
    source.rowRangeComplete=Number.isInteger(source.totalLines)&&offset>source.totalLines;
    source.rangeComplete=false;
    source.lineTextComplete=false;
    source.fileHasMore=Number.isInteger(source.totalLines)?offset<=source.totalLines:null;
    source.emptyRange=source.rowRangeComplete;
    return source;
  }
  const first=source.lines[0].line,last=source.lines.at(-1).line;
  source.observedRange={first,last};
  const expectedEnd=mode==='archive'
    ?source.returnedThrough
    :(Number.isInteger(source.totalLines)?Math.min(source.totalLines,offset+limit-1):offset+limit-1);
  source.rowRangeComplete=first===offset&&Number.isInteger(expectedEnd)&&last>=expectedEnd;
  source.lineTextComplete=!source.lineTextTruncated&&!source.budgetTruncated;
  source.rangeComplete=source.rowRangeComplete&&source.lineTextComplete;
  source.fileHasMore=Number.isInteger(source.totalLines)?last<source.totalLines:(mode==='archive'?!!source.hasMore:null);
  if(!source.rowRangeComplete&&(source.fileHasMore!==false||mode==='archive'))source.nextOffset=last+1;
  if(!source.lineTextComplete){
    source.contentLimitation=source.lineTextMaximumReached?'line-text-exceeds-maximum':'line_text_or_return_budget_truncated';
    delete source.nextOffset;
  }
  return source;
}
export function boundEvidence(facts,maxChars=limits.evidenceChars){
  const dedup=items=>{
    const seen=new Set(),unique=[];
    for(const item of items){const key=JSON.stringify(item);if(seen.has(key)){unique.find(entry=>entry.key===key).count++;continue;}seen.add(key);unique.push({key,value:item,count:1});}
    return unique.map(entry=>entry.count===1?entry.value:{...entry.value,repeatCount:entry.count});
  };
  for(const search of [facts.search,facts.entryMatches,facts.references])if(Array.isArray(search?.matches)){
    const before=search.matches.length;search.matches=dedup(search.matches);if(before!==search.matches.length)search.exactDuplicatesRemoved=before-search.matches.length;
  }
  if(Array.isArray(facts.failures))facts.failures=dedup(facts.failures);
  const missing=source=>({path:source.path,state:'partial',originalState:source.state,omitted:true,budgetTruncated:true,
    ...(source.archive?{archive:source.archive,entry:source.entry}:{}),...(source.requestedRange?{requestedRange:source.requestedRange}:{}),
    ...(source.member?{member:source.member}:{}),...(source.members?{members:source.members.map(member=>({member:member.member,memberState:'omitted-response-budget',matches:[]}))}:{}),
    retrieveCurrent:source.retrieveCurrent||null,omissionReason:'response-budget',rangeComplete:false,lineTextComplete:false});
  // Keep per-request identities even when their bodies cannot fit.
  while(JSON.stringify(facts).length>maxChars){
    if(facts.references?.matches?.length){facts.references.matches.pop();facts.references.truncated=true;continue;}
    if(facts.failures?.some(f=>f.detail?.length>160)){
      for(const failure of facts.failures)if(failure.detail?.length>160){failure.detail=failure.detail.slice(0,160);failure.detailTruncated=true;}
      continue;
    }
    if(facts.failures?.length>1){facts.failures.pop();facts.omittedFailures=(facts.omittedFailures||0)+1;continue;}
    const search=[facts.search,facts.entryMatches].find(s=>s?.matches?.length);
    if(search){search.matches.pop();search.truncated=true;search.omittedMatches=(search.omittedMatches||0)+1;continue;}
    const lookup=facts.missingFileLookups?.find(s=>s.candidates?.length);
    if(lookup){lookup.candidates.pop();lookup.truncated=true;continue;}
    const memberMatches=facts.sources.flatMap(source=>[
      ...(source.matches||[]).map(match=>({source,match,member:source})),
      ...(source.members||[]).flatMap(member=>(member.matches||[]).map(match=>({source,member,match})))
    ]).filter(item=>item.match.lines?.length);
    const longest=memberMatches.sort((a,b)=>JSON.stringify(b.match.lines).length-JSON.stringify(a.match.lines).length)[0];
    if(longest){
      longest.match.observedRange??={first:longest.match.lines[0].line,last:longest.match.lines.at(-1).line};
      longest.match.lines.pop();longest.match.complete=false;longest.match.budgetTruncated=true;
      longest.member.budgetTruncated=true;longest.source.budgetTruncated=true;facts.budgetTruncated=true;continue;
    }
    const source=facts.sources.filter(s=>s.lines?.length).sort((a,b)=>JSON.stringify(b.lines).length-JSON.stringify(a.lines).length)[0];
    if(source){source.lines.pop();source.truncated=true;source.budgetTruncated=true;continue;}
    const compact={mode:facts.mode,workspace:facts.workspace,observedAt:facts.observedAt,
      ...(facts.selectionState?{selectionState:facts.selectionState,selected:facts.selected}:{}),
      sources:facts.sources.map(missing),truncated:true,budgetTruncated:true,
      nextFactNeeded:'Response budget omitted the listed bodies. Re-read one relevant range, or explicitly raise maxChars (up to 64000). A locator is not delivered source.'};
    if(JSON.stringify(compact).length<=maxChars)return compact;
    // Argument sizes can exceed the body budget; retain each locator, not a
    // silently shortened source list or a fabricated complete result.
    compact.sources=compact.sources.map(source=>({path:source.path,state:'partial',omitted:true,omissionReason:'response-budget',rangeComplete:false,
      retrieveCurrent:{tool:'project_evidence',arguments:{mode:'read',files:[{path:source.path,offset:source.requestedRange?.offset||1,limit:40}],responseView:'full',maxChars:64000}}}));
    compact.budgetMetadataExceeded=JSON.stringify(compact).length>maxChars;return compact;
  }
  return facts;
}
export function references(text){
  // Extract locators only. A locator from an error is a candidate, not a confirmed root cause.
  const result=[];
  for(const m of text.matchAll(/([A-Za-z]:[\\/][^\n"<>]*?\.(?:java|mjs|cjs|js|ts|tsx)|(?:[\w.@-]+[\\/])+[\w.@-]+\.(?:java|mjs|cjs|js|ts|tsx)|[\w$-]+\.java):(?:\[)?(\d+)/g)){
    const line=Number(m[2]);if(line>0&&Number.isSafeInteger(line))result.push({file:m[1],line});
    if(result.length===limits.files)break;
  }
  return result;
}
export function failureFact(exec,result){
  const exitCode=result?.value?.exitCode;
  if(!result?.isError&&!(typeof exitCode==='number'&&exitCode!==0))return null;
  const code=result.error?.info?.code||result.error?.code||'';
  const category=/DENIED|APPROVAL|SANDBOX|ARGS|ARGUMENT|NOT_FOUND|ABORT|CANCEL/i.test(code)?'tool-or-environment':'unclassified';
  return {tool:exec.name,callId:exec.callId,category,code,exitCode:typeof exitCode==='number'?exitCode:null,
    ...(exec.name==='read'&&typeof exec.arguments?.file_path==='string'?{filePath:exec.arguments.file_path}:{}),
    detail:(result.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').slice(0,2000),observedAt:new Date().toISOString()};
}
export function checkedReport(args){
  if(!args||Object.keys(args).some(k=>!['status','summary','observed','unverified','remaining','claims'].includes(k)))throw new Error('Unknown report field');
  if(!['complete','partial','unknown'].includes(args.status))throw new Error('status must be complete, partial or unknown');
  if(typeof args.summary!=='string'||!args.summary.trim()||args.summary.length>2000)throw new Error('summary must contain 1 to 2000 characters');
  for(const key of ['observed','unverified','remaining'])if(!Array.isArray(args[key])||args[key].length>limits.reportItems||args[key].some(s=>typeof s!=='string'||!s.trim()||s.length>limits.itemChars))throw new Error(key+' must be a bounded list of nonempty strings');
  if(args.status==='complete'&&args.remaining.length)throw new Error('Required work remains: use partial; unverified observations may still be listed separately');
  if(args.claims!==undefined&&(!Array.isArray(args.claims)||args.claims.length>8||args.claims.some(item=>!item||typeof item!=='object'||Object.keys(item).some(key=>!['claim','support','assumptions','counterexamples','remaining','status'].includes(key))||typeof item.claim!=='string'||!item.claim.trim()||item.claim.length>800||['support','remaining'].some(key=>item[key]!==undefined&&(typeof item[key]!=='string'||item[key].length>1200))||['assumptions','counterexamples'].some(key=>item[key]!==undefined&&(!Array.isArray(item[key])||item[key].length>8||item[key].some(value=>typeof value!=='string'||!value.trim()||value.length>800)))||!['observed','inferred','challenged','unknown'].includes(item.status))))throw new Error('claims must be at most 8 bounded key-claim records');
  return args;
}
export function reportMarkdown(args,{sessionId,failures,writes}){
  const list=items=>items.length?items.map(t=>'- '+t.replace(/\n/g,'\n  ')).join('\n'):'- 无登记项。';
  const claims=Array.isArray(args.claims)&&args.claims.length?args.claims.map(item=>`- [${item.status}] ${item.claim}\n  - 依据：${item.support||'未填写'}\n  - 假设：${item.assumptions?.length?item.assumptions.join('；'):'无登记'}\n  - 反例：${item.counterexamples?.length?item.counterexamples.join('；'):'无登记'}\n  - 仍缺：${item.remaining||'无登记'}`).join('\n'):'- 未登记关键判断依据。';
  return `# 本次工作记录\n\n会话：${sessionId}\n记录时间：${new Date().toISOString()}\n模型声明状态：${args.status}。这不是宿主对业务正确性的判定。\n\n${args.summary}\n\n## 已完成与依据（模型陈述）\n\n${list(args.observed)}\n\n## 关键判断的依据、假设与反例（模型陈述）\n\n${claims}\n\n以上“observed”标签仍是模型分类；插件没有验证引用是否支持结论。\n\n## 仍未验证\n\n${list(args.unverified)}\n\n## 仍未完成／缺口与接续\n\n${list(args.remaining)}\n\n## 插件实际观察的近期工具事实\n\n成功写入：${writes.length?JSON.stringify(writes):'未在当前插件生命周期观察到'}\n\n失败记录：${failures.length?JSON.stringify(failures):'未在当前插件生命周期观察到'}\n\n工具成功、文件存在、模型结束及业务正确分别判断。此文件由 work_report 经原生 write 写入；不会改变 DSH 原生结束状态。\n`;
}
