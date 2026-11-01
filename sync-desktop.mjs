import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const source=import.meta.dirname;
const codeOnly=process.argv.includes('--code-only');
if(process.argv.slice(2).some(arg=>arg!=='--code-only'))throw new Error('Unknown sync option');
const desktopHome=path.join(os.homedir(),'Documents','DSH Desktop','home');
const release=path.join(desktopHome,'tools','dsh-work-evidence');
const profile=path.join(desktopHome,'profiles','web');
const link=path.join(profile,'node_modules','@local','dsh-work-evidence');
const manifest=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'));
if(path.resolve(source)===path.resolve(release))throw new Error('Run from the development directory');
const previous=await fs.lstat(link);
if(!previous.isSymbolicLink())throw new Error('Expected the desktop plugin path to be a directory junction');
const current=await fs.realpath(link);
if(path.resolve(current)!==path.resolve(release)){
  const linkedPackage=JSON.parse(await fs.readFile(path.join(current,'package.json'),'utf8'));
  if(linkedPackage.name!==manifest.name)throw new Error('Desktop link belongs to another package');
}
const normalized=value=>value.replaceAll('\\','/');
const lockFile=path.join(profile,'pnpm-lock.yaml'),lockText=await fs.readFile(lockFile,'utf8');
const lockPattern=/^([ \t]*)'@local\/dsh-work-evidence':(\r?\n)\1[ \t]+specifier:[^\r\n]*\r?\n\1[ \t]+version:[^\r\n]*/gm;
if([...lockText.matchAll(lockPattern)].length!==1)throw new Error('Expected one desktop lock entry for Work Evidence');
const repairedLock=lockText.replace(lockPattern,(_all,indent,eol)=>indent+"'@local/dsh-work-evidence':"+eol+
  indent+'  specifier: link:'+normalized(release)+eol+indent+'  version: link:'+normalized(path.relative(profile,release)));
await fs.mkdir(release,{recursive:true});
for(const entry of ['package.json',...manifest.files]){
  if(entry.includes('*')){
    if(entry!=='locale/*.json')throw new Error('Unsupported package file pattern: '+entry);
    await fs.cp(path.join(source,'locale'),path.join(release,'locale'),{recursive:true});
  }else await fs.copyFile(path.join(source,entry),path.join(release,entry));
}
if(!codeOnly){
// Keep runtime dependencies on the installed host, never on development files.
await fs.mkdir(path.join(release,'node_modules'),{recursive:true});
const hostDependency=await fs.realpath(path.join(source,'node_modules','@deepseek-ai'));
const dependencyLink=path.join(release,'node_modules','@deepseek-ai');
try{await fs.lstat(dependencyLink);}catch(error){
  if(error.code!=='ENOENT')throw error;
  await fs.symlink(hostDependency,dependencyLink,'junction');
}
await fs.cp(path.join(source,'.fastedit-venv'),path.join(release,'.fastedit-venv'),{recursive:true});
const profilePackage=path.join(profile,'package.json');
const config=JSON.parse(await fs.readFile(profilePackage,'utf8'));
config.dependencies[manifest.name]='link:'+normalized(release);
await fs.writeFile(profilePackage,JSON.stringify(config,null,2)+'\n');
const profilePatch=path.join(profile,'cordis.patch.yml'),profileText=await fs.readFile(profilePatch,'utf8');
const repairedProfile=profileText.replaceAll(normalized(source),normalized(release)).replaceAll(normalized(current),normalized(release));
if(repairedProfile!==profileText)await fs.writeFile(profilePatch,repairedProfile);
}
if(repairedLock!==lockText){
  if(await fs.readFile(lockFile,'utf8')!==lockText)throw new Error('Desktop lock changed during synchronization');
  await fs.writeFile(lockFile,repairedLock,'utf8');
}
if(path.resolve(current)!==path.resolve(release)){
  if(await fs.realpath(link)!==current)throw new Error('Desktop link changed during synchronization');
  // rmdir removes the junction itself; its development target stays intact.
  await fs.rmdir(link);
  await fs.symlink(release,link,'junction');
}
console.log(JSON.stringify({source,release,desktopLink:await fs.realpath(link),version:manifest.version,codeOnly}));
