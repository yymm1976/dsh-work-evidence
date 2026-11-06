import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const app=process.env.DSH_APP??path.join(os.homedir(),'AppData','Local','Programs','DSH Desktop','dsh-desktop');

async function versionOf(app,packageName){
  const file=path.join(app,'node_modules',...packageName.split('/'),'package.json');
  if(!existsSync(file))return null;
  return JSON.parse(await fs.readFile(file,'utf8')).version;
}

const declared=value=>String(value??'').split('||').map(item=>item.trim()).filter(Boolean);

test('the package declaration covers every host runtime present for this release check',async t=>{
  const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const dshVersions=declared(manifest.engines?.dsh),peerVersions=declared(manifest.peerDependencies?.['@deepseek-ai/dsh-session-reference']);
  const tools=await versionOf(app,'@deepseek-ai/dsh-tools');
  if(!tools){
    if(process.env.DSH_APP)assert.fail(`No DSH host runtime found at DSH_APP: ${app}`);
    t.skip('No DSH host runtime is installed for this compatibility check.');
    return;
  }
  const reference=await versionOf(app,'@deepseek-ai/dsh-session-reference');
  assert.ok(dshVersions.includes(tools),`${app} dsh-tools ${tools} is not declared in engines.dsh`);
  if(reference)assert.ok(peerVersions.includes(reference),`${app} session-reference ${reference} is not declared in peerDependencies`);
});
