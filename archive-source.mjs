import {readArchiveEntry} from './archive-store.mjs';
import {finalizeEvidenceWindow} from './evidence.mjs';
import {checkedLineTextLimit,sourceMemberSource,MAX_LINE_TEXT_LIMIT} from './source-members.mjs';

export async function archiveSource(root,args,exec,_call){
  const offset=args.offset??1,limit=args.limit??100;
  if(!Number.isInteger(offset)||offset<1||!Number.isInteger(limit)||limit<1||limit>160)throw new Error('archive offset>=1 and limit=1-160 required');
  const lineTextLimit=checkedLineTextLimit(args.lineTextLimit);
  const value=await readArchiveEntry(root,args.archive,args.entry,exec);if(value.state!=='observed')return value;
  const {archive,entry,cache}=value;
  const selectedLines=value.lines.slice(offset-1,offset-1+limit),maxLineLength=Math.max(0,...selectedLines.map(text=>text.length));
  const lines=selectedLines.map((text,index)=>({line:offset+index,text:text.slice(0,lineTextLimit),...(text.length>lineTextLimit?{lineTextTruncated:true}:{})}));
  const canIncrease=maxLineLength>lineTextLimit&&maxLineLength<=MAX_LINE_TEXT_LIMIT;
  const maximumReached=lineTextLimit===MAX_LINE_TEXT_LIMIT&&maxLineLength>MAX_LINE_TEXT_LIMIT;
  return finalizeEvidenceWindow({state:'observed',path:archive+'!/'+entry,archive,entry,cache,lines,totalLines:value.lines.length,
    returnedThrough:lines.at(-1)?.line??offset-1,requestedRange:{offset,limit},hasMore:offset-1+lines.length<value.lines.length,
    lineTextTruncated:lines.some(line=>line.lineTextTruncated),lineTextLimit,lineTextMaximum:MAX_LINE_TEXT_LIMIT,
    ...(maximumReached?{lineTextMaximumReached:true}:{}),
    ...(canIncrease?{nextLineTextLimit:maxLineLength,nextRetrieval:{tool:'project_evidence',arguments:{mode:'archive',archive:args.archive,entry,offset,limit,lineTextLimit:maxLineLength}}}:{}),
    retrieveCurrent:{tool:'project_evidence',arguments:{mode:'archive',archive:args.archive,entry,offset,limit,lineTextLimit}}},'archive');
}

export async function archiveMemberSource(root,args,exec,options={}){
  const {archive,entry}=args;
  const parsingOptions={...(exec.evidenceConfig||{}),...options};
  const value=await readArchiveEntry(root,archive,entry,exec);
  if(value.state!=='observed')return {...value,rangeComplete:false,lineTextComplete:false};
  return sourceMemberSource({
    filePath:value.entry,
    displayPath:value.archive+'!/'+value.entry,
    lines:value.lines,
    sourceText:value.text,
    totalLines:value.lines.length,
    args,
    exec,
    options:parsingOptions,
    extra:{archive:value.archive,entry:value.entry,cache:value.cache},
  });
}
