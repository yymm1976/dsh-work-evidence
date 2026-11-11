import {resolveJsonPointer} from './json-pointer.mjs';

const failure=(code,message,details={})=>Object.assign(new Error(message),{code,...details});
const kind=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const ownObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
const clip=(text,limit)=>{let end=limit;if(end>0&&text.charCodeAt(end-1)>=0xD800&&text.charCodeAt(end-1)<=0xDBFF)end--;return text.slice(0,end);};
function valueView(value,maxChars){
  const serialized=JSON.stringify(value);
  return serialized.length<=maxChars?{value,complete:true}:{serializedPreview:clip(serialized,maxChars),serializedChars:serialized.length,complete:false};
}
function parse(text,line){
  const location=line===undefined?{}:{physicalLine:line};let root;
  try{root=JSON.parse(text);}catch{throw failure('JSON_PARSE_ERROR','The source is not valid JSON.',location);}
  // JSON.parse handles deep trees natively; a reviver would recurse through every subtree.
  const pending=[root];
  while(pending.length){
    const value=pending.pop();
    if(typeof value==='number'&&(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value)))
      throw failure('JSON_NUMBER_UNSAFE','A number cannot be represented safely; use a lossless reader.',location);
    if(value&&typeof value==='object')for(const child of Object.values(value))pending.push(child);
  }
  return root;
}

/** Exact declared selections use JSON semantics; no generated program is evaluated. */
export function queryStructuredJson(text,selectors,options={}){
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>2_097_152)throw failure('JSON_INPUT_LIMIT','JSON text is required within the 2 MiB byte limit.');
  if(!ownObject(options)||Object.keys(options).some(key=>!['format','maxValueChars'].includes(key)))throw failure('INVALID_JSON_OPTIONS','Invalid JSON query options.');
  const {format='json',maxValueChars=8000}=options;
  if(!['json','jsonl'].includes(format)||!integer(maxValueChars,256,16000))throw failure('INVALID_JSON_OPTIONS','Invalid JSON query options.');
  if(!Array.isArray(selectors)||!integer(selectors.length,1,32))throw failure('INVALID_JSON_SELECTORS','Provide 1 to 32 JSON selectors.');
  for(const selector of selectors){
    if(!ownObject(selector)||Object.keys(selector).some(key=>!['pointer','op','offset','limit'].includes(key))||
      !['value','keys','count','page'].includes(selector.op))throw failure('INVALID_JSON_SELECTOR','Invalid JSON selector.');
    resolveJsonPointer(null,selector.pointer);
    if(['value','count'].includes(selector.op)&&(Object.hasOwn(selector,'offset')||Object.hasOwn(selector,'limit'))||
      selector.offset!==undefined&&!integer(selector.offset,0,Number.MAX_SAFE_INTEGER)||
      selector.limit!==undefined&&!integer(selector.limit,1,100))throw failure('INVALID_JSON_SELECTOR','Invalid JSON selector page.');
  }
  const bom=text.startsWith('\uFEFF'),source=bom?text.slice(1):text,recordLines=[];
  let root;
  if(format==='json')root=parse(source);
  else{
    root=[];let line=0;
    for(const record of source.split(/\r\n|\r|\n/u)){
      line++;if(/^[\t ]*$/u.test(record))continue;
      root.push(parse(record,line));recordLines.push(line);
    }
  }
  const results=selectors.map(selector=>{
    const selected=resolveJsonPointer(root,selector.pointer),recordIndex=format==='jsonl'&&selector.pointer!==''?Number(selector.pointer.split('/')[1]):NaN;
    const base={pointer:selector.pointer,op:selector.op,found:selected.found,
      ...(selected.found&&Number.isSafeInteger(recordIndex)&&recordLines[recordIndex]!==undefined?{recordPhysicalLine:recordLines[recordIndex]}:{})};
    if(!selected.found)return {...base,status:'missing'};
    const value=selected.value,type=kind(value),array=Array.isArray(value),object=ownObject(value);
    if(selector.op==='value')return {...base,status:'selected',type,...valueView(value,maxValueChars)};
    if(selector.op==='count')return array||object?{...base,status:'selected',type,count:array?value.length:Object.keys(value).length,complete:true}:
      {...base,status:'type-mismatch',type,expected:'array-or-object'};
    if(selector.op==='keys'&&!object||selector.op==='page'&&!array)return {...base,status:'type-mismatch',type,expected:selector.op==='keys'?'object':'array'};
    const all=selector.op==='keys'?Object.keys(value):value,offset=selector.offset??0,limit=selector.limit??20;
    const page=all.slice(offset,offset+limit),view=valueView(page,maxValueChars);
    return {...base,status:'selected',type,offset,limit,total:all.length,selectedCount:page.length,hasMore:offset+page.length<all.length,...view};
  });
  return {format,bom,sourceComplete:true,...(format==='jsonl'?{records:root.length}:{}),
    semantics:{numbers:'JavaScript binary64 (decimal rounding/underflow apply); unsafe integer results and nonfinite numbers rejected',objectKeys:'JSON.parse last duplicate wins; keys use JavaScript enumeration order',pointers:'RFC6901; JSONL indices address nonempty records'},results};
}
