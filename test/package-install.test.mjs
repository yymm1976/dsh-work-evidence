import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DSH_APP} from './helpers/paths.mjs';

const source=path.resolve(import.meta.dirname,'..');
const npmCli=process.env.npm_execpath??path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
const host=DSH_APP;
const hostScope=path.join(host,'node_modules','@deepseek-ai');

const runNpm=(args,{cwd,env})=>spawnSync(process.execPath,[npmCli,...args],{cwd,env,encoding:'utf8',windowsHide:true});
const output=result=>[result.stdout,result.stderr].filter(Boolean).join('\n').trim();
const fileReference=value=>'file:'+value.replaceAll('\\','/');

test('packed tarball installs without host peers and loads with the installed host runtime',async t=>{
  if(!existsSync(npmCli)){t.skip('npm CLI is not available beside the running Node.js');return;}
  const fflate=path.join(source,'node_modules','fflate');
  assert.ok(existsSync(path.join(fflate,'package.json')),'fflate must be installed for the isolated package check');
  if(!existsSync(path.join(hostScope,'dsh-llm','package.json'))){
    if(process.env.DSH_APP?.trim())assert.fail(`No DSH host runtime found at DSH_APP: ${host}`);
    t.skip('No DSH host runtime is installed for the isolated load check.');
    return;
  }
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'we-install-'));
  const install=path.join(directory,'install'),cache=path.join(directory,'cache'),link=path.join(install,'node_modules','@deepseek-ai');
  let linked=false;
  try{
    const pack=runNpm(['pack','--json','--pack-destination',directory],{cwd:source,env:{...process.env,npm_config_cache:cache}});
    assert.equal(pack.status,0,output(pack));
    const tarball=path.join(directory,JSON.parse(pack.stdout)[0].filename);
    await fs.mkdir(install);
    await fs.writeFile(path.join(install,'package.json'),JSON.stringify({
      name:'we-package-install-probe',
      version:'1.0.0',
      private:true,
      dependencies:{'@local/dsh-work-evidence':fileReference(tarball),fflate:fileReference(fflate)},
    },null,2)+'\n');
    const installed=runNpm(['install','--offline','--ignore-scripts','--no-audit','--no-fund','--loglevel=error'],
      {cwd:install,env:{...process.env,npm_config_cache:cache}});
    assert.equal(installed.status,0,output(installed));
    const packageDirectory=path.join(install,'node_modules','@local','dsh-work-evidence');
    const manifest=JSON.parse(await fs.readFile(path.join(packageDirectory,'package.json'),'utf8'));
    assert.equal(manifest.version,'1.1.0');
    assert.deepEqual(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-llm'],{optional:true});
    assert.equal(existsSync(path.join(install,'node_modules','@deepseek-ai','dsh-llm','package.json')),false,
      'offline installation must not fetch a host peer');
    await fs.rm(link,{recursive:true,force:true});
    await fs.symlink(hostScope,link,'junction');
    linked=true;
    const plugin=await import(pathToFileURL(path.join(packageDirectory,'index.mjs')).href);
    const runtime=await import(pathToFileURL(path.join(packageDirectory,'runtime.mjs')).href);
    assert.equal(plugin.name,'work-evidence-local');
    assert.equal(typeof plugin.apply,'function');
    assert.ok(plugin.inject.includes('llm'));
    assert.equal(runtime.VERSION,manifest.version);
    console.log('isolatedPackageInstall',JSON.stringify({version:manifest.version,hostPeerInstalled:false,hostLinked:true,entry:plugin.name}));
  }finally{
    if(linked)await fs.rm(link,{force:true,maxRetries:3});
    await fs.rm(directory,{recursive:true,force:true,maxRetries:3});
  }
});
