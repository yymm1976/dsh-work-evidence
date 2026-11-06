import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const ROOT=path.resolve(import.meta.dirname,'..');
const EXCLUDED=new Set(['.git','node_modules','.fastedit-venv','.runtime-fastedit-validation','__pycache__']);
const SOURCE=/\.(?:mjs|js|cjs)$/u;
const files=[];

async function walk(directory,relative=''){
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    if(EXCLUDED.has(entry.name))continue;
    const next=relative?path.join(relative,entry.name):entry.name;
    if(entry.isDirectory())await walk(path.join(directory,entry.name),next);
    else if(entry.isFile()&&SOURCE.test(entry.name))files.push(next);
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
  await walk(ROOT);
  files.sort((left,right)=>left.localeCompare(right));
  const failures=[];
  for(const file of files){
    try{
      execFileSync(process.execPath,['--check',path.join(ROOT,file)],{stdio:['ignore','ignore','pipe'],encoding:'utf8'});
    }catch(error){
      failures.push({file,error:String(error.stderr??error.message??error).trim()});
    }
  }
  if(failures.length){
    for(const failure of failures)process.stderr.write(`${failure.file}\n${failure.error}\n`);
    process.stderr.write(`${failures.length} of ${files.length} JavaScript files failed the syntax check.\n`);
    process.exitCode=1;
  }else process.stdout.write(`Syntax check passed for ${files.length} JavaScript files.\n`);
}

export {ROOT,files,walk};
