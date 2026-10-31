import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const source=import.meta.dirname;
const desktopHome=path.join(os.homedir(),'Documents','DSH Desktop','home');
const release=path.join(desktopHome,'tools','dsh-work-evidence');
const profile=path.join(desktopHome,'profiles','web');
const link=path.join(profile,'node_modules','@local','dsh-work-evidence');
const manifest=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'));
if(path.resolve(source)===path.resolve(release))throw new Error('Run from the development directory');
const previous=await fs.lstat(link);
if(!previous.isSymbolicLink())throw new Error('Expected the desktop plugin path to be a directory junction');
await fs.mkdir(release,{recursive:true});
for(const entry of ['package.json',...manifest.files]){
  if(entry.includes('*')){
    if(entry!=='locale/*.json')throw new Error('Unsupported package file pattern: '+entry);
    await fs.cp(path.join(source,'locale'),path.join(release,'locale'),{recursive:true});
  }else await fs.copyFile(path.join(source,entry),path.join(release,entry));
}
// Keep runtime dependencies on the installed host, never on development files.
await fs.mkdir(path.join(release,'node_modules'),{recursive:true});
const hostDependency=await fs.realpath(path.join(source,'node_modules','@deepseek-ai'));
const dependencyLink=path.join(release,'node_modules','@deepseek-ai');
try{await fs.lstat(dependencyLink);}catch(error){
  if(error.code!=='ENOENT')throw error;
  await fs.symlink(hostDependency,dependencyLink,'junction');
}
await fs.cp(path.join(source,'.fastedit-venv'),path.join(release,'.fastedit-venv'),{recursive:true});
const normalized=value=>value.replaceAll('\\','/');
const profilePackage=path.join(profile,'package.json');
const config=JSON.parse(await fs.readFile(profilePackage,'utf8'));
config.dependencies[manifest.name]='link:'+normalized(release);
await fs.writeFile(profilePackage,JSON.stringify(config,null,2)+'\n');
for(const file of ['pnpm-lock.yaml','cordis.patch.yml']){
  const full=path.join(profile,file);
  const text=await fs.readFile(full,'utf8');
  await fs.writeFile(full,text.replaceAll(normalized(source),normalized(release)));
}
const current=await fs.realpath(link);
if(path.resolve(current)!==path.resolve(release)){
  // rmdir removes the junction itself; its development target stays intact.
  await fs.rmdir(link);
  await fs.symlink(release,link,'junction');
}
console.log(JSON.stringify({source,release,desktopLink:await fs.realpath(link),version:manifest.version}));
