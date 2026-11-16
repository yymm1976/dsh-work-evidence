import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool,requestText} from './test/helpers/host.mjs';
const filler=[tool('glob',{pattern:'*.txt'})];
const write=[tool('write',{file_path:'a.txt',content:'changed\n'})];
const done=[text('完成。')];
const REMINDER='改动后未复核';
const answers=new Map();
for(let n=1;n<4;n++)answers.set(n,filler);
answers.set(4,write);answers.set(5,done);
const host=await startHost({script:async(_o,n)=>answers.get(n)??done});
try{
  await fs.writeFile(path.join(host.cwd,'a.txt'),'original\nline2\n');
  const agent=await host.createAgent('max');
  await host.send(agent,'处理 a.txt');
  for(const m of ['继续。','继续。','继续。'])await host.send(agent,m);
  for(let i=0;i<host.requests.length;i++){
    const t=requestText(host.requests[i]);
    const n=[...t.matchAll(new RegExp(REMINDER,'g'))].length;
    if(n)console.log('request',i,'reminder occurrences:',n);
  }
  const d=(await host.command(agent,'detail')).state;
  console.log('stateNotices:',d.counts.stateNotices);
}finally{await host.close();}
