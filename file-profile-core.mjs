const integer=(value,min,max,name)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error('Invalid '+name);return value;};

function createCsvShape(delimiter,maxShapes){
  let mode='start',fields=1,seen=false,skipLf=false,first=true,offset=0,records=0,minFields=null,maxFields=null,overflowRecords=0,error=null;
  const shapes=new Map();
  const fail=(code,index)=>{error??={code,offsetUtf16:index};};
  function record(){
    records++;minFields=minFields===null?fields:Math.min(minFields,fields);maxFields=maxFields===null?fields:Math.max(maxFields,fields);
    if(shapes.has(fields))shapes.set(fields,shapes.get(fields)+1);
    else if(shapes.size<maxShapes)shapes.set(fields,1);else overflowRecords++;
    fields=1;seen=false;mode='start';
  }
  return {
    push(text){
      for(let index=0;index<text.length;index++){
        const char=text[index],at=offset++;
        if(first){first=false;if(char==='\uFEFF')continue;}
        if(error)continue;
        if(skipLf){skipLf=false;if(char==='\n')continue;}
        if(mode==='quoted'){
          if(char==='"')mode='after-quote';
          continue;
        }
        if(char==='\r'||char==='\n'){record();skipLf=char==='\r';continue;}
        if(char===delimiter){fields++;seen=true;mode='start';continue;}
        if(char==='"'){
          if(mode==='start'){mode='quoted';seen=true;}
          else if(mode==='after-quote')mode='quoted';
          else fail('quote-inside-unquoted-field',at);
          continue;
        }
        if(mode==='after-quote'){fail('content-after-closing-quote',at);continue;}
        mode='unquoted';seen=true;
      }
    },
    finish(){
      if(!error){if(mode==='quoted')fail('unterminated-quoted-field',offset);else if(seen)record();}
      return {valid:error===null,records,minFields,maxFields,fieldCounts:[...shapes].sort(([a],[b])=>a-b).map(([fields,count])=>({fields,count})),
        fieldCountDistributionComplete:error===null&&overflowRecords===0,overflowRecords,
        scope:error?'complete-records-before-first-error':'all-input-records',...(error?{error}:{})};
    },
  };
}

/** Analyze decoded chunks without retaining the file or asserting file freshness. */
export function createFileProfile(options={}){
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('Profile options must be an object');
  const {format='text',delimiter=',',sampleLines=4,maxSampleLineChars=200,maxFieldShapes=32}=options;
  if(!['text','csv'].includes(format))throw new Error('Invalid profile format');
  if(typeof delimiter!=='string'||delimiter.length!==1||['\r','\n','"','\0','\uFEFF'].includes(delimiter))throw new Error('Invalid CSV delimiter');
  integer(sampleLines,0,16,'sampleLines');integer(maxSampleLineChars,1,1000,'maxSampleLineChars');integer(maxFieldShapes,1,128,'maxFieldShapes');
  let units=0,lineUnits=0,prefix='',prefixClosed=false,lines=0,pendingCr=false,closed=false,result;
  const newlines={crlf:0,lf:0,cr:0},ascii={spaces:0,tabs:0,uppercase:0,lowercase:0,digits:0,nul:0},head=[],tail=[];
  const csv=format==='csv'?createCsvShape(delimiter,maxFieldShapes):null;
  function endLine(){
    lines++;
    // A preview limit must not expose half of a valid surrogate pair.
    const last=prefix.charCodeAt(prefix.length-1),text=last>=0xD800&&last<=0xDBFF?prefix.slice(0,-1):prefix;
    const line={line:lines,text,utf16Units:lineUnits,truncated:text.length<lineUnits};
    if(head.length<sampleLines)head.push(line);
    if(sampleLines){tail.push(line);if(tail.length>sampleLines)tail.shift();}
    prefix='';prefixClosed=false;lineUnits=0;
  }
  return {
    push(text){
      if(closed)throw new Error('Profile is already finished');
      if(typeof text!=='string')throw new Error('Decoded text chunk required');
      csv?.push(text);units+=text.length;
      for(let index=0;index<text.length;index++){
        const char=text[index],code=text.charCodeAt(index);
        if(pendingCr){pendingCr=false;if(char==='\n'){newlines.crlf++;continue;}newlines.cr++;}
        if(char==='\r'){endLine();pendingCr=true;continue;}
        if(char==='\n'){newlines.lf++;endLine();continue;}
        lineUnits++;
        if(!prefixClosed){
          if(prefix.length<maxSampleLineChars)prefix+=char;
          else{
            prefixClosed=true;
            const previous=prefix.charCodeAt(prefix.length-1);
            if(code>=0xDC00&&code<=0xDFFF&&previous>=0xD800&&previous<=0xDBFF)prefix=prefix.slice(0,-1);
          }
        }
        if(char===' ')ascii.spaces++;else if(char==='\t')ascii.tabs++;else if(code===0)ascii.nul++;
        else if(code>=65&&code<=90)ascii.uppercase++;else if(code>=97&&code<=122)ascii.lowercase++;else if(code>=48&&code<=57)ascii.digits++;
      }
    },
    finish(){
      if(closed)return result;
      closed=true;if(pendingCr){newlines.cr++;pendingCr=false;}if(lineUnits)endLine();
      result={format,utf16Units:units,physicalLines:lines,newlines,ascii,head,tail,...(csv?{delimiter,csv:csv.finish()}: {})};
      return result;
    },
  };
}
