import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {nativePwshInvocationDiagnostic} from '../recovery.mjs';
import {createTaskFlow} from '../task-flow.mjs';
import {defaults} from '../runtime.mjs';
import {startHost,tool,text} from './helpers/host.mjs';

const executable='C:\\Programs\\DSH Desktop\\python.exe',command=executable+' -m package 2>&1 | Select-Object -Last 15';
const stderr="C:\\Programs\\DSH: The term 'C:\\Programs\\DSH' is not recognized as a name of a cmdlet, function, script file, or executable program.";
const failed={isError:false,value:{kind:'foreground',exitCode:1,stdout:{text:''},stderr:{text:stderr}}};

test('a native PowerShell failure identifies only a split executable prefix from the actual command',()=>{
  const diagnostic=nativePwshInvocationDiagnostic({command},failed);
  assert.equal(diagnostic.kind,'unquoted-executable-path');assert.equal(diagnostic.executable,executable);
  assert.equal(diagnostic.reportedCommand,'C:\\Programs\\DSH');assert.equal(diagnostic.suggestedPrefix,"& '"+executable+"'");
  assert.equal(nativePwshInvocationDiagnostic({command:executable+' -c other.exe'},failed).executable,executable);
  assert.equal(nativePwshInvocationDiagnostic({command},{value:{data:failed.value}}).executable,executable);
  assert.equal(failed.value.exitCode,1);assert.equal(failed.value.stderr.text,stderr);
});

test('success, partial results, different errors and already quoted commands produce no invocation advice',()=>{
  for(const change of [{exitCode:0},{exitCode:null},{kind:'background'},{kind:'promoted'},{status:'pending'},{timedOut:true},
    {aborted:true},{cancelled:true},{signal:'SIGTERM'},{partial:true},{outputPartial:true},{lossy:true},{complete:false},
    {truncated:true},{stderr:{text:stderr,truncated:true}},{stdout:{text:'',complete:false}},
    {stderr:{text:"The term 'different' is not recognized as a name of a cmdlet, function, script file, or executable program."}}])
    assert.equal(nativePwshInvocationDiagnostic({command},{value:{...failed.value,...change}}),null,JSON.stringify(change));
  for(const code of ["& '"+executable+"' -m package",'"'+executable+'" -m package','node script.js',command+'\nWrite-Output 42',
    'C:\\Programs\\tool.exe -c "C:\\Programs\\DSH Desktop\\python.exe"',executable.replace('DSH Desktop','DSH $name')+' -m package'])
    assert.equal(nativePwshInvocationDiagnostic({command:code},failed),null,code);
});

test('the same executable is advised once per user request and respects disabled and canceled execution',()=>{
  const log=[{seq:0,type:'user/message',data:{message:{id:'request',role:'user',source:{kind:'user'},content:[{type:'text',text:'执行指定程序。'}]}}}];
  const agent={session:{id:'pwsh-syntax',log}},state={config:defaults(),root:process.cwd()};
  const runtime={get:()=>state,isEnabled:()=>true,activeMode:()=> 'aggressive'};
  let flow=createTaskFlow({},runtime);
  const exec={agent,name:'pwsh',callId:'first',arguments:{command}};
  const notice=flow.executionShellContext(exec,failed);assert.ok(notice);
  assert.equal(flow.executionShellContext({...exec,callId:'second'},failed),null);
  log.push({seq:1,type:'user/message',data:{message:notice}});
  flow=createTaskFlow({},runtime);
  assert.equal(flow.executionShellContext(exec,failed),null,'a recorded context survives state reconstruction');
  log.push({seq:2,type:'user/message',data:{message:{id:'next-request',role:'user',source:{kind:'user'},content:[{type:'text',text:'处理新的执行请求。'}]}}});
  assert.equal(flow.executionShellContext({...exec,signal:{aborted:true}},failed),null);
  state.config.executionTriage=false;assert.equal(flow.executionShellContext(exec,failed),null);
  state.config.executionTriage=true;
  assert.equal(flow.executionShellContext({...exec,name:'work_exec'},failed),null);
  assert.ok(flow.executionShellContext(exec,failed));
});

test('native PTC delivers one syntax context, preserves the failure and executes only an explicit corrected command',async()=>{
  const exe=path.win32.normalize(process.execPath);
  assert.match(exe,/\s/u,'the installed executable path provides the real space boundary');
  const unquoted=exe+' -e "console.log(42)"',quoted="& '"+exe.replaceAll("'","''")+"' -e \"console.log(42)\"";
  const results=[];
  const host=await startHost({toolMode:'ptc',extraMounts:[['dsh-ptc-runtime-node']],pluginConfig:{stepPacing:false},script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'const r=await tools.pwsh('+JSON.stringify({command:unquoted,description:'Observe the requested invocation'})+'); console.log(r.exitCode);',description:'Execute the original command'})];
    if(n===2){
      const contexts=options.messages.filter(message=>message.source?.taskFlow?.key?.includes('pwsh-unquoted-executable'));
      assert.equal(contexts.length,1);assert.ok(contexts[0].content[0].text.includes(JSON.stringify(exe)));
      return [tool('run_code',{code:'const r=await tools.pwsh('+JSON.stringify({command:quoted,description:'Explicitly quote the same executable'})+'); console.log(r.exitCode,r.stdout.text);',description:'Explicitly correct the invocation prefix'})];
    }
    return [text('42')];
  }});
  host.ctx.on('tools/result',(exec,result)=>{if(exec.name==='pwsh')results.push(result);});
  try{
    const agent=await host.createAgent('max');await host.send(agent,'运行指定命令，处理实际调用错误并返回结果。');
    assert.equal(host.requests.length,3);assert.equal(results.length,2);
    assert.equal(results[0].isError,false);assert.equal(results[0].value.exitCode,1);
    assert.equal(results[1].value.exitCode,0);assert.match(results[1].value.stdout.text,/42/u);
    const calls=host.events.filter(event=>event.type==='tool/ptc-dispatch-start'&&event.data.name==='pwsh');
    assert.equal(calls.length,2);assert.equal(calls[0].data.arguments.command,unquoted);assert.equal(calls[1].data.arguments.command,quoted);
    assert.equal(host.events.filter(event=>event.type==='user/message'&&(event.data.message??event.data).source?.taskFlow?.key?.includes('pwsh-unquoted-executable')).length,1);
  }finally{await host.close();}
});
