import path from 'node:path';

function powershellStdin(command){
  const match=/^@'\r?\n([\s\S]*?)\r?\n'@[ \t]*\|[ \t]*(?:&[ \t]+'([A-Za-z]:[\\/][^'\r\n]+)'|(python(?:3(?:\.\d+)?)?(?:\.exe)?|node(?:\.exe)?))((?:[ \t]+[\w.=-]+)*)[ \t]*(?:\r?\n)?$/iu.exec(command);
  if(!match)return null;
  const [,body,absolute,bare,rawArguments]=match;
  // The first closing delimiter ends the literal, even when syntax follows it.
  if(/^'@/mu.test(body))return null;
  const executable=absolute??bare;
  const basename=executable.split(/[\\/]/u).at(-1);
  if(absolute&&!/^(?:python(?:3(?:\.\d+)?)?|node)\.exe$/iu.test(basename))return null;
  return {executable,basename,code:body+'\n',rawArguments};
}

function bashStdin(command){
  if(command.includes('\r'))return null;
  const lines=command.split('\n'),header=/^[ \t]*(python(?:3(?:\.\d+)?)?|node)((?:[ \t]+[^\s<>;&|$`'"\\]+)*)[ \t]+<<[ \t]*'([A-Za-z_][A-Za-z0-9_]{0,63})'[ \t]*$/u.exec(lines[0]);
  if(!header)return null;
  const [,executable,rawArguments,delimiter]=header;
  const end=lines.indexOf(delimiter,1);
  if(end<1||lines.slice(end+1).some(line=>line.trim()))return null;
  const code=lines.slice(1,end).join('\n')+'\n';
  return {executable,basename:executable,code,rawArguments};
}

/** Accept one literal stdin program without interpreting Shell syntax. */
export function nativeShellScript(name,args,root){
  if(!['bash','pwsh'].includes(name)||!args||typeof args!=='object'||Array.isArray(args))return null;
  if(Object.keys(args).some(key=>!['command','description','timeoutMs','run_in_background','workdir'].includes(key))||
    args.run_in_background!==undefined&&args.run_in_background!==false)return null;
  if(args.workdir!==undefined){
    if(typeof root!=='string'||!path.isAbsolute(root)||typeof args.workdir!=='string')return null;
    const nativePath=value=>process.platform==='win32'?value.replaceAll('\\','/'):value;
    const workdir=nativePath(args.workdir).replace(/\/+$/u,''),project=nativePath(root).replace(/\/+$/u,'');
    // work_exec runs at the project root. Do not reinterpret a subdirectory or an override.
    if(workdir!=='.'&&(!path.isAbsolute(args.workdir)||workdir!==project))return null;
  }
  if(args.timeoutMs!==undefined&&(!Number.isInteger(args.timeoutMs)||args.timeoutMs<1||args.timeoutMs>600000))return null;
  const command=args.command;
  if(typeof command!=='string'||command.length>65000||command.includes('\0'))return null;
  const program=name==='bash'?bashStdin(command):powershellStdin(command);
  if(!program)return null;
  const {executable,basename,code,rawArguments}=program;
  if(!code.trim()||code.length>64000)return null;
  const argv=rawArguments.trim()?rawArguments.trim().split(/[ \t]+/u):[];
  const runtime=/^node(?:\.exe)?$/iu.test(basename)?'node':'python';
  for(let index=0;index<argv.length;index++){
    const arg=argv[index];
    if(arg==='-'){if(index!==argv.length-1)return null;continue;}
    if(runtime==='node'){
      if(!['--input-type=module','--input-type=commonjs','--no-warnings'].includes(arg))return null;
    }else if(arg==='-X'){
      if(argv[++index]!=='utf8')return null;
    }else if(!['-B','-u'].includes(arg))return null;
  }
  if(runtime==='node'&&argv.filter(arg=>arg.startsWith('--input-type=')).length>1)return null;
  if(name==='pwsh'&&argv.at(-1)!=='-')return null;
  return {runtime,executable,code,nativeArguments:argv,...(args.timeoutMs!==undefined?{timeoutMs:args.timeoutMs}:{})};
}
