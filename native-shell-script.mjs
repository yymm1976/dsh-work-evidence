/** Accept one literal stdin program, without interpreting any Shell syntax. */
export function nativeShellScript(name,args){
  if(name!=='bash'||!args||typeof args!=='object'||Array.isArray(args))return null;
  if(Object.keys(args).some(key=>!['command','description','timeoutMs','run_in_background'].includes(key))||
    args.run_in_background!==undefined&&args.run_in_background!==false)return null;
  if(args.timeoutMs!==undefined&&(!Number.isInteger(args.timeoutMs)||args.timeoutMs<1||args.timeoutMs>600000))return null;
  const command=args.command;
  if(typeof command!=='string'||command.length>65000||command.includes('\0')||command.includes('\r'))return null;
  const lines=command.split('\n'),header=/^[ \t]*(python(?:3(?:\.\d+)?)?|node)((?:[ \t]+[^\s<>;&|$`'"\\]+)*)[ \t]+<<[ \t]*'([A-Za-z_][A-Za-z0-9_]{0,63})'[ \t]*$/u.exec(lines[0]);
  if(!header)return null;
  const [,executable,rawArguments,delimiter]=header;
  const end=lines.indexOf(delimiter,1);
  if(end<1||lines.slice(end+1).some(line=>line.trim()))return null;
  const code=lines.slice(1,end).join('\n')+'\n';
  if(!code.trim()||code.length>64000)return null;
  const argv=rawArguments.trim()?rawArguments.trim().split(/[ \t]+/u):[];
  const runtime=executable==='node'?'node':'python';
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
  return {runtime,executable,code,nativeArguments:argv,...(args.timeoutMs!==undefined?{timeoutMs:args.timeoutMs}:{})};
}
