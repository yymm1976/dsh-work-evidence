import {within,finalizeEvidenceWindow} from './evidence.mjs';
import {archiveSource} from './archive-source.mjs';

export function archiveLocator(value){
  if(typeof value!=='string')return null;
  const match=/^(.+\.(?:jar|zip))![\\/](.+)$/i.exec(value);
  return match?{archive:match[1],entry:match[2]}:null;
}
const failure=(code,message)=>({code,message,effectState:'none',retry:'after-input-change'});
const completed=result=>!result.isError&&result.value?.status==='completed';
const dataOf=result=>result.value?.data||result.value;
function toolResult(value){return {isError:false,value,content:[{type:'text',text:JSON.stringify(value)}]};}

// This adapter runs after tool guards and uses the DSH filesystem provider.
export function createReadRouting(ctx,runtime,call,nativeFiles){
  return async function route(exec){
    if(!exec.agent||!['read','ops_read_files'].includes(exec.name))return null;
    const args=exec.arguments;
    const requests=exec.name==='read'?[{path:args?.file_path,offset:args?.offset,limit:args?.limit}]:args?.files;
    if(!Array.isArray(requests)||!requests.length||requests.length>32||!requests.some(item=>archiveLocator(item?.path)))return null;
    if(exec.name==='ops_read_files'&&Object.keys(args).some(key=>key!=='files'))return null;
    if(exec.name==='read'&&Object.keys(args).some(key=>!['file_path','offset','limit'].includes(key)))return null;
    if(requests.some(item=>!item||typeof item.path!=='string'||Object.keys(item).some(key=>!['path','offset','limit'].includes(key))))return null;
    await runtime.init(exec.agent,exec.signal);
    if(!runtime.isEnabled(exec.agent)||!runtime.get(exec.agent).config.archiveReadRouting)return null;
    const root=await ctx.workingDirectory.ensure(exec.agent,exec.signal),s=runtime.get(exec.agent),permissions=new Map();
    const items=[];
    for(const request of requests){
      exec.signal.throwIfAborted();
      const locator=archiveLocator(request.path);
      if(!locator){
        const native=await call('read',{file_path:request.path,offset:request.offset??1,limit:request.limit??80},exec);
        if(exec.name==='read')return native;
        const value=dataOf(native);
        items.push(Array.isArray(value?.lines)?{path:value.path,status:'completed',items:value.lines.map(line=>({path:value.path,line:line.number,text:line.text})),
          lineCount:value.totalLines,total:value.totalLines,rangeComplete:!value.truncatedByBytes&&value.lines.length===Math.min(request.limit??80,Math.max(0,value.totalLines-(request.offset??1)+1)),
          complete:(request.offset??1)-1+value.lines.length===value.totalLines&&!value.truncatedByBytes,...(value.truncatedByBytes?{truncated:true}:{}),source:{kind:'dsh-native-read'}}:
          {path:request.path,status:'error',complete:false,error:native.value?.error||native.error||failure('READ_UNAVAILABLE','Native read returned no file receipt.')});
        continue;
      }
      let source;
      try{
        const archive=within(root,locator.archive),limit=request.limit??160,offset=request.offset??1;
        if(!Number.isInteger(limit)||limit<1||limit>160||!Number.isInteger(offset)||offset<1){
          items.push({path:request.path,status:'error',complete:false,error:failure('ARCHIVE_RANGE_LIMIT','Archive ranges require offset>=1 and limit=1-160; request a smaller relevant range.')});continue;
        }
        let permission=permissions.get(archive);
        if(!permission){permission=await call('work-evidence:stat',{path:archive},exec);permissions.set(archive,permission);}
        if(!completed(permission)||dataOf(permission)?.exists===false){
          items.push({path:request.path,status:'error',complete:false,error:permission.value?.error||permission.error||failure('ARCHIVE_UNAVAILABLE','The native archive stat was unavailable.')});continue;
        }
        source=await archiveSource(root,{...locator,offset,limit},{...exec,nativeFiles},call);
        finalizeEvidenceWindow(source,'archive');
      }catch(error){
        if(exec.signal.aborted)throw error;
        items.push({path:request.path,status:'error',complete:false,error:failure('ARCHIVE_READ_UNAVAILABLE',error.message)});continue;
      }
      if(source.state!=='observed'){
        items.push({path:request.path,status:'error',complete:false,error:failure(source.code||'ARCHIVE_READ_UNAVAILABLE',source.message||source.note||'Archive source unavailable.')});continue;
      }
      const item={path:source.path,status:'completed',items:source.lines.map(line=>({path:source.path,line:line.line,text:line.text,...(line.lineTextTruncated?{truncatedInLine:true}:{})})),
        complete:source.fileHasMore===false&&source.lineTextComplete!==false,rangeComplete:source.rangeComplete,
        truncated:source.lineTextComplete===false,source:{kind:'archive',archive:source.archive,entry:source.entry,readOnly:true,cache:source.cache||null}};
      if(Number.isInteger(source.totalLines)){item.lineCount=source.totalLines;item.total=source.totalLines;}
      if(source.fileHasMore&&source.lineTextComplete!==false)item.nextOffset=(source.lines.at(-1)?.line??request.offset??1)+1;
      items.push(item);
    }
    s.metrics.archiveReadRoutes++;s.active=true;s.dirty=true;
    if(exec.name==='read'){
      const item=items[0];
      if(item.status!=='completed')return {isError:true,error:item.error,content:[{type:'text',text:item.error?.message||'Archive read failed.'}]};
      if(item.truncated){const error=failure('ARCHIVE_LINE_TEXT_LIMIT','Archive lines exceed the native read representation; request the exact entry range again, or use the current route\'s detailed archive entry when it is exposed.');return {isError:true,error,content:[{type:'text',text:error.message}]};}
      return toolResult({path:item.path,offset:requests[0].offset??1,totalLines:item.lineCount,lines:item.items.map(line=>({number:line.line,text:line.text}))});
    }
    const failed=items.filter(item=>item.status!=='completed').length;
    const value={status:failed?'error':'completed',data:{items,total:items.length,failed,nextIndex:items.length,pending:0,complete:true,
      source:{kind:'work-evidence-archive-routing',note:'File order is preserved; virtual archive paths are read-only. Native file receipts retain their original fields.'}}};
    if(failed)value.error=failure('ARCHIVE_READ_FAILED','Some requested file ranges could not be read; inspect per-file errors and keep successful items.');
    return toolResult(ctx.tools.modeFor(exec.agent)==='ptc'?value:{status:value.status,...value.data,...(value.error?{error:value.error}:{})});
  };
}
