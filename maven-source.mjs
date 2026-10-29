import path from 'node:path';

const concrete=value=>typeof value==='string'&&/^[0-9][A-Za-z0-9.+_-]*$/.test(value);
const coordinate=value=>typeof value==='string'&&/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value);
const identity=item=>[item.group,item.name,item.version].join(':');

// Associate observed coordinates only. This does not resolve an effective POM.
export function mavenArchiveBinding(archive,manifestVersion,metadata,dependencies){
  const declared=dependencies.filter(item=>item.ecosystem==='maven'&&item.versionState==='resolved'
    &&item.groupState!=='unresolved'&&item.artifactState!=='unresolved'
    &&coordinate(item.group)&&coordinate(item.name)&&concrete(item.version)
    &&(!item.type||item.type==='jar')&&!item.classifier);
  const unbound=reason=>({state:'unbound',matches:[],evidence:reason,strength:0});
  if(metadata&&metadata.state!=='missing'){
    if(metadata.state!=='observed'||metadata.truncated||metadata.descriptors?.length!==1)
      return unbound('Maven descriptors are unreadable, incomplete, or describe multiple artifacts.');
    const observed=metadata.descriptors[0];
    if(observed.state!=='observed')return unbound('Maven descriptor is unavailable.');
    if(manifestVersion&&manifestVersion!==observed.version)
      return unbound('Manifest and Maven descriptor versions disagree.');
    const matches=declared.filter(item=>item.group===observed.group&&item.name===observed.artifact&&item.version===observed.version);
    if(!matches.length)return unbound('Observed Maven coordinates do not match a concrete direct dependency declaration.');
    return {state:'matched',matches,strength:3,evidence:'exact Maven descriptor coordinates match a concrete direct dependency',
      coordinates:{group:observed.group,artifact:observed.artifact,version:observed.version},descriptor:observed.entry};
  }
  // A bare artifact-version filename cannot establish its groupId. Require the
  // complete repository suffix, still inside the current workspace.
  const normalized='/'+archive.replaceAll('\\','/');
  const matches=declared.filter(item=>{
    const suffix='/'+item.group.replaceAll('.','/')+'/'+item.name+'/'+item.version+'/'+item.name+'-'+item.version+'-sources.jar';
    return normalized.endsWith(suffix)&&(!manifestVersion||manifestVersion===item.version);
  });
  const identities=new Set(matches.map(identity));
  if(identities.size!==1)return unbound('A full Maven repository path or unique matching descriptor is required; version-only paths are not binding.');
  const first=matches[0];
  return {state:'matched',matches,strength:2,evidence:'full Maven repository path matches direct dependency coordinates',
    coordinates:{group:first.group,artifact:first.name,version:first.version},path:path.posix.normalize(archive.replaceAll('\\','/'))};
}
