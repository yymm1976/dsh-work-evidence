import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {startHost,text,tool} from './helpers/host.mjs';
import {OPS_ROOT} from './helpers/paths.mjs';

const OPS=OPS_ROOT;
const valueOf=options=>JSON.parse(options.messages.findLast(message=>message.role==='tool').content.map(block=>block.text??'').join(''));
const executeProgram=`import fs from 'node:fs';
const adjustment = 0;
const data = JSON.parse(fs.readFileSync('orders.json','utf8'));
function validateOrders(orders) {
  if (!Array.isArray(orders)) throw new TypeError('orders must be an array');
  const ids = new Set();
  for (const order of orders) {
    if (!order || typeof order !== 'object') throw new TypeError('order must be an object');
    if (typeof order.id !== 'string' || !order.id.trim()) throw new TypeError('order id must be nonempty');
    if (ids.has(order.id)) throw new TypeError('duplicate order id');
    ids.add(order.id);
    if (!Number.isSafeInteger(order.amount) || order.amount < 0) throw new TypeError('amount must be nonnegative integer cents');
    if (typeof order.archived !== 'boolean') throw new TypeError('archived must be boolean');
    if (!['paid', 'pending'].includes(order.status)) throw new TypeError('unknown status');
  }
  return orders;
}
const active = validateOrders(data).filter(order => !order.archived);
const totalCents = active.reduce((sum,order) => sum + order.amount,0) + adjustment;
if (!Number.isSafeInteger(totalCents)) throw new RangeError('total exceeds exact integer range');
console.log(JSON.stringify({activeCount:active.length,paidCount:active.filter(order=>order.status==='paid').length,
  totalCents,ids:active.map(order=>order.id).sort()}));`;

test('structured calls, retained data, exact program references, editing and handoff preserve file applicability',async()=>{
  const file=await import(pathToFileURL(OPS+'/file/index.js').href),discovery=await import(pathToFileURL(OPS+'/discovery/index.js').href),
    ptc=await import(pathToFileURL(OPS+'/ptc/index.js').href);
  let programRef,base,handoff,nativeSourceReads=0;const submitted=[];
  const wrapper='console.log(JSON.stringify(await tools.work_exec('+JSON.stringify({runtime:'node',code:executeProgram,sources:['orders.json']})+')));';
  assert.ok(wrapper.length>=1000);
  const batch=(name,args)=>tool('run_code',{calls:[{name,arguments:args}]});
  const host=await startHost({toolMode:'ptc',workspace:{toolSurface:'full',nativeProgramReuse:true,structuredCalls:true},
    extraMounts:[['dsh-ptc-runtime-node'],[file,{promptPolicy:false,required:true}],
      [discovery,{enabled:true,alwaysLoaded:['stat','edit_file','write_file'],required:true}],
      [ptc,{alwaysLoaded:['stat','edit_file','write_file'],required:true}]],script:(options,n)=>{
      if(n===1)return [batch('work_compute',{code:'var ordersSnapshot=JSON.parse((await tools.read({file_path:"orders.json"})).lines.map(line=>line.text).join("\\n"));ordersSnapshot.filter(order=>!order.archived).reduce((sum,order)=>sum+order.amount,0)'})];
      if(n===2){assert.equal(valueOf(options).value,1500);return [batch('work_compute',{code:'ordersSnapshot.filter(order=>!order.archived).map(order=>order.id)'})];}
      if(n===3){assert.deepEqual(valueOf(options).value,['order-A','order-C']);return [tool('run_code',{code:wrapper})];}
      if(n===4){
        assert.equal(JSON.parse(valueOf(options).stdout.text).totalCents,1500);
        programRef='event:'+host.events.findLast(event=>event.type==='tool/call'&&event.data.name==='run_code').seq;
        const args={programRef,edits:[{before:'const adjustment = 0;',after:'const adjustment = 5;'}]};
        submitted.push(JSON.stringify(args));return [tool('run_code',args)];
      }
      if(n===5){assert.equal(JSON.parse(valueOf(options).stdout.text).totalCents,1505);return [batch('work_state',{mode:'handoff',incremental:true})];}
      if(n===6){base=valueOf(options);return [batch('verified_exec',{summary:'修正订单 A 金额',apply:true,
        edits:[{file:'orders.json',mode:'replace_exact',old_text:'"amount":1200',new_text:'"amount":1300'}]})];}
      if(n===7){assert.equal(valueOf(options).status,'applied');return [batch('work_compute',{code:'typeof ordersSnapshot'})];}
      if(n===8){assert.equal(valueOf(options).value,'undefined');assert.equal(valueOf(options).resetReason,'observed-workspace-change');
        submitted.push(JSON.stringify({programRef}));return [tool('run_code',{programRef})];}
      if(n===9){assert.equal(JSON.parse(valueOf(options).stdout.text).totalCents,1600);return [batch('work_state',{mode:'handoff',baseDeliveryId:base.delivery.id})];}
      handoff=valueOf(options);return [text('已完成指定的订单计算、金额修改和交接。')];
    }});
  host.ctx.on('tools/pre-execute',(exec,next)=>{if(exec.name==='read')nativeSourceReads++;return next();});
  try{
    const orders=[{id:'order-A',amount:1200,status:'paid',archived:false},{id:'order-B',amount:900,status:'pending',archived:true},
      {id:'order-C',amount:300,status:'pending',archived:false}];
    await fs.writeFile(path.join(host.cwd,'orders.json'),JSON.stringify(orders));
    const agent=await host.createAgent('max');await host.send(agent,'读取订单，保留只读计算状态，执行并修改同一程序；修正订单 A 金额后重新计算，最后交接文件与执行记录。');
    assert.ok(handoff,JSON.stringify({requests:host.requests.length,end:host.events.findLast(event=>event.type==='turn/end')?.data.reason,
      recent:host.events.filter(event=>event.type==='tool/result').slice(-3).map(event=>event.data.message.content.map(block=>block.text??'').join('').slice(0,700))}));
    const latest=await host.command(agent,'handoff');
    assert.equal(JSON.parse(await fs.readFile(path.join(host.cwd,'orders.json'),'utf8'))[0].amount,1300);
    const executions=latest.observedWork.executions.items;
    assert.equal(executions.length,3);
    assert.ok(executions.slice(0,2).every(item=>item.executionCompleted&&item.evidenceValidity==='affected'));
    assert.equal(executions.at(-1).evidenceValidity,'current-for-declared-files');
    assert.ok(latest.observedWork.artifacts.items.some(item=>item.path.endsWith('orders.json')));
    assert.equal(nativeSourceReads,1);
    assert.equal(submitted.length,2);assert.ok(submitted.every(args=>args.length<wrapper.length/4));
    assert.equal(host.events.filter(event=>event.type==='tool/result'&&event.data.message.isError).length,0);
    await host.command(agent,'config {"nativeProgramReuse":false,"structuredCalls":false}');
    const view=await host.command(agent,'features');
    assert.ok(view.features.filter(item=>['nativeProgramReuse','structuredCalls'].includes(item.key)).every(item=>item.status==='off'));
    console.log('workflow',JSON.stringify({programChars:wrapper.length,referenceCallChars:submitted.map(args=>args.length),
      oldExecutionsAffected:2,currentExecution:1,retainedReset:true,nativeSourceReads,handoffKind:handoff.schema}));
  }finally{await host.close();}
});

test('PTC exact editing reports absent OPS capabilities without changing the file',async()=>{
  let result;
  const host=await startHost({toolMode:'ptc',workspace:{toolSurface:'full'},extraMounts:[['dsh-ptc-runtime-node']],script:(options,n)=>{
    if(n===1)return [tool('run_code',{code:'console.log(JSON.stringify(await tools.verified_exec('+JSON.stringify({summary:'Change the exact amount',apply:true,
      edits:[{file:'orders.json',mode:'replace_exact',old_text:'1200',new_text:'1300'}]})+')));'})];
    result=valueOf(options);return [text('当前环境缺少 OPS 文件入口。')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'orders.json'),'[1200]');
    const agent=await host.createAgent('max');await host.send(agent,'把订单金额 1200 改为 1300。');
    assert.equal(result.status,'deopt');assert.equal(result.reason,'cas-file-tools-unavailable');
    assert.deepEqual(result.missing,['ops_stat','ops_edit_file']);assert.equal(result.effectState,'none');
    assert.equal(await fs.readFile(path.join(host.cwd,'orders.json'),'utf8'),'[1200]');
  }finally{await host.close();}
});
