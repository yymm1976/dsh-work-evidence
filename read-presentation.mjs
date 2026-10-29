import path from 'node:path';

const MAX_CHARS=1500000,MAX_NODES=16000;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const lineNumber=row=>Number.isInteger(row?.line)?row.line:Number.isInteger(row?.number)?row.number:null;

// Only the displayed JSON is projected. Tool program values keep their native shape.
export function compactReadPresentation(text,{root=null,fallbackPath=null}={}){
  if(typeof text!=='string'||text.length>MAX_CHARS)return null;
  let value;try{value=JSON.parse(text);}catch{return null;}
  if(!object(value)&&!Array.isArray(value))return null;
  const files=[];let remaining=MAX_NODES,changed=0;
  const samePath=(left,right)=>{
    if(left===right)return true;
    if(!root||typeof left!=='string'||typeof right!=='string')return false;
    return path.resolve(root,left).replaceAll('\\','/')===path.resolve(root,right).replaceAll('\\','/');
  };
  const visit=(node,inherited,depth=0)=>{
    if(--remaining<0||depth>20)throw new Error('read presentation budget');
    if(Array.isArray(node))return node.map(item=>visit(item,inherited,depth+1));
    if(!object(node))return node;
    const sourcePath=typeof node.archive==='string'&&typeof node.entry==='string'?node.archive+'!/'+node.entry:
      [node.path,node.file,node.file_path,inherited].find(value=>typeof value==='string'&&value.length);
    const field=['lines','items'].find(key=>Array.isArray(node[key])&&node[key].length&&
      node[key].every(row=>object(row)&&typeof row.text==='string'&&lineNumber(row)!==null));
    if(field&&typeof sourcePath==='string'){
      const rows=node[field];
      const numbers=rows.map(lineNumber);
      if(numbers.some((number,index)=>index&&number!==numbers[index-1]+1))return node;
      const lines=rows.map(row=>{
        const result={...row};
        if(Object.hasOwn(result,'path')&&samePath(result.path,sourcePath)){delete result.path;changed++;}
        return result;
      });
      // A foreign lines field is meaningful metadata; do not overwrite it.
      if(field!=='lines'&&Object.hasOwn(node,'lines'))return node;
      const { [field]:body,...metadata}=node;
      const index=files.length;
      files.push({path:sourcePath,...metadata,lines});
      changed++;
      return {workEvidenceFileView:index};
    }
    return Object.fromEntries(Object.entries(node).map(([key,item])=>[key,visit(item,sourcePath,depth+1)]));
  };
  let metadata;try{metadata=visit(value,fallbackPath);}catch{return null;}
  if(!files.length||!changed)return null;
  const view=JSON.stringify({view:'work-evidence-read',files,result:metadata});
  if(text.length-view.length<128)return null;
  return {text:view,files:files.length,charsSaved:text.length-view.length,
    note:'Model display only; lines and all nonredundant metadata are retained. Original native program value is unchanged.'};
}
