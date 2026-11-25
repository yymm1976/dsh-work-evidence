import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPtcPatterns} from '../ptc-patterns.mjs';

test('ptc pattern workspace matching follows the physical directory behind an alias',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'we-ptc-workspace-'));
  const real=path.join(root,'real');
  const alias=path.join(root,'alias');
  try{
    await fs.mkdir(real);
    try{
      await fs.symlink(real,alias,process.platform==='win32'?'junction':'dir');
    }catch(error){
      if(['EPERM','EACCES','ENOSYS','UNKNOWN'].includes(error.code))return t.skip('host does not permit a workspace alias');
      throw error;
    }
    const header={id:'saved-session',cwd:real,createdAt:new Date().toISOString()};
    const opened=[];
    const patterns=createPtcPatterns({
      workingDirectory:{ensure:async()=>alias},
      sessionPersistence:{
        list:async()=>[{header,eventCount:0}],
        open:async id=>{
          opened.push(id);
          return {header,inheritedEventCount:0,read:async()=>({events:[]}),close:async()=>{}};
        },
      },
    },{
      get:()=>({dir:root}),
      save:async()=>{},
    });
    const result=await patterns.scan({session:{id:'current-session',log:[]}},{scope:'session',sessionId:'saved-session',
      maxEventsPerSession:2000,minSupport:1,minToolCalls:2,maxCandidates:10},new AbortController().signal);
    assert.equal(result.sessionsScanned,1);
    assert.deepEqual(opened,['saved-session']);
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
});
