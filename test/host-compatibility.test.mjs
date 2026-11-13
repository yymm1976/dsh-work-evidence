import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';

import {DSH_APP} from './helpers/paths.mjs';

const root=path.resolve(import.meta.dirname,'..');
const app=DSH_APP;

async function versionOf(app,packageName){
  const file=path.join(app,'node_modules',...packageName.split('/'),'package.json');
  if(!existsSync(file))return null;
  return JSON.parse(await fs.readFile(file,'utf8')).version;
}

const declared=value=>String(value??'').split('||').map(item=>item.trim()).filter(Boolean);
const supportedHosts=['0.2.1-rc.4','0.2.2-rc.1','0.2.2-rc.2'];

test('the package declaration exactly matches the supported host runtimes',async t=>{
  const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const dshVersions=declared(manifest.engines?.dsh);
  const peers=['@deepseek-ai/dsh-llm','@deepseek-ai/dsh-ptc-runtime-node','@deepseek-ai/dsh-session-reference'];
  assert.deepEqual(dshVersions,supportedHosts);
  for(const name of peers){
    assert.deepEqual(declared(manifest.peerDependencies?.[name]),supportedHosts,name);
    assert.deepEqual(manifest.peerDependenciesMeta?.[name],{optional:true},name);
  }
  const tools=await versionOf(app,'@deepseek-ai/dsh-tools');
  if(!tools){
    if(process.env.DSH_APP?.trim())assert.fail(`No DSH host runtime found at DSH_APP: ${app}`);
    t.skip('No DSH host runtime is installed for this compatibility check.');
    return;
  }
  assert.ok(dshVersions.includes(tools),`${app} dsh-tools ${tools} is not declared in engines.dsh`);
  // peerDependenciesMeta marks dsh-llm optional so non-host consumers can install
  // the package without the desktop runtime. Host tests always load dsh-llm, so a
  // missing host implementation is a configuration failure, not a skipped check.
  const llm=await versionOf(app,'@deepseek-ai/dsh-llm');
  assert.ok(llm,`${app} is missing the runtime-required @deepseek-ai/dsh-llm`);
  assert.ok(supportedHosts.includes(llm),`${app} @deepseek-ai/dsh-llm ${llm} is not declared in peerDependencies`);
  for(const name of peers){
    const version=await versionOf(app,name);
    if(version)assert.ok(supportedHosts.includes(version),`${app} ${name} ${version} is not declared in peerDependencies`);
  }
});
