import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRuntime} from '../runtime.mjs';
import {startHost,text} from './helpers/host.mjs';

test('init reuses loaded settings while refresh observes an external change',async()=>{
  const host=await startHost({mountPlugin:false,script:()=>[text('unused')]});
  try{
    const directory=path.join(host.cwd,'.dsh','work-evidence');
    const file=path.join(directory,'config.json');
    await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(file,JSON.stringify({historyHygiene:false}));
    const agent=await host.createAgent();
    const runtime=createRuntime(host.ctx,async()=>{throw new Error('No tool dispatch required');});
    const loaded=await runtime.init(agent);
    assert.equal(loaded.config.historyHygiene,false);

    await fs.writeFile(file,JSON.stringify({historyHygiene:true}));
    const reused=await runtime.init(agent);
    assert.equal(reused.config.historyHygiene,false,'init must not repeat file reads after loading');

    const refreshed=await runtime.refresh(agent);
    assert.equal(refreshed.config.historyHygiene,true,'the next request boundary must observe the new file');
  }finally{await host.close();}
});
