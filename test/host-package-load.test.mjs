import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {defaults,RETIRED_SETTINGS,VERSION} from '../runtime.mjs';
import {startHost,text,tool,APP} from './helpers/host.mjs';
import {OPS_ROOT} from './helpers/paths.mjs';

const source=path.resolve(import.meta.dirname,'..');
const FEATURE_KEYS=['enabled','aggressiveMode','selfIndex','fastEditEnabled','stateLedger','stateInform','completionNotice',
  'archiveReadRouting','readArgumentRecovery','requestAccounting','evidenceViews','memberParsing','mavenSourceBinding','contextProtocol',
  'historyHygiene','nativeVerifiedEdits','fileProfiling','structuredJson','ledgerReceipt','ledgerUnresolved','swLedger','swEviction','requestProjection','projectionRestore',
  'compressionControl','deferPressureCompaction','stubSummary','executionTriage','nativeProgramReuse','hostNodeFallback','structuredCalls','nativeReasoningReplay',
  'stageWorkingSet','stepPacing','retainedCompute','finalJsonGuard','finalJsonResultGuard','qualityReview','qualityReviewEffort',
  'qualityReviewScope','toolSurface','defaultResponseView'];
const TOOL_NAMES=['project_evidence','work_exec','work_recall','work_status','work_state','work_report','work_probe','evidence_index',
  'candidate_select','ptc_patterns','ptc_fastpath','verified_exec','fastedit_java','work_compute','file_profile','structured_json'];
const contained=(root,relative)=>{
  const full=path.resolve(root,relative),part=path.relative(root,full);
  assert.ok(part&&!part.startsWith('..')&&!path.isAbsolute(part),'Package files remain inside their directory.');return full;
};

test('declared package files independently load all retained controls and preserve native behavior when disabled',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'we-package-'));let host;
  try{
    const manifest=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')),files=[];
    for(const entry of manifest.files){
      if(entry==='locale/*.json'){
        for(const file of await fs.readdir(path.join(source,'locale')))if(file.endsWith('.json'))files.push('locale/'+file);
      }
      else if(!entry.includes('*'))files.push(entry);
      else throw Error('Unsupported package file pattern: '+entry);
    }
    files.push('package.json');
    for(const file of files){const target=contained(directory,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(contained(source,file),target);}
    await fs.mkdir(path.join(directory,'node_modules'));await fs.symlink(await fs.realpath(path.join(source,'node_modules/fflate')),path.join(directory,'node_modules/fflate'),'junction');
    const workspace={...Object.fromEntries(Object.entries(defaults()).filter(([key,value])=>typeof value==='boolean'&&!RETIRED_SETTINGS.includes(key)).map(([key])=>[key,true])),
      toolSurface:'full',fastEditPython:process.env.DSH_TEST_FASTEDIT_PYTHON||path.join(source,'.fastedit-venv/Scripts/python.exe'),
      projectionPricing:[{provider:'scripted',model:'scripted-model',input:.15,cacheRead:.003,output:.6,currency:'USD'}]};
    const opsRoot=OPS_ROOT;
    const ops=await Promise.all(['file','ptc'].map(name=>import(pathToFileURL(opsRoot+'/'+name+'/index.js').href)));
    let sourceValue,nativeValue;
    host=await startHost({pluginDirectory:directory,workspace,toolMode:'ptc',
      extraMounts:[['dsh-ptc-runtime-node'],['dsh-compaction-basic',{thresholdRatio:.8,retainTokens:4000,maxTokens:10000,headroomTokens:4000}],
        [ops[0],{promptPolicy:false,required:true}],[ops[1],{alwaysLoaded:['stat','edit_file','write_file'],required:true}]],
      script:(options,n)=>{
        if(n===1)return [tool('run_code',{calls:[{name:'project_evidence',arguments:{mode:'read',files:[{path:'source.txt',offset:1,limit:10}]}}]})];
        if(n===2){sourceValue=options.messages.findLast(message=>message.role==='tool');return [text('来源已取得。')];}
        const schema=options.tools.find(item=>item.name==='run_code').parameters;
        assert.equal(schema.properties.calls,undefined);assert.equal(schema.properties.programRef,undefined);
        if(n===3)return [tool('run_code',{code:'console.log(JSON.stringify(await tools.read({file_path:"source.txt"})));',description:'Read the source through the native runtime'})];
        nativeValue=options.messages.findLast(message=>message.role==='tool');return [text('原生来源已取得。')];
      },auxiliary:()=>[text('{"issues":[]}')]});
    await fs.writeFile(path.join(host.cwd,'source.txt'),'package-load-marker\n');
    const agent=await host.createAgent('ultra');await host.send(agent,'读取 source.txt 后说明结果，保留已有工程功能供下一阶段修改使用。');
    const features=await host.command(agent,'features');assert.equal(features.version,VERSION);
    assert.equal(features.pluginEffective,true);assert.ok(features.dependencies.archiveDecoder.available);
    assert.ok(features.dependencies.nativeCompactionAttached);
    assert.deepEqual(features.features.map(item=>item.key),FEATURE_KEYS);
    assert.equal(new Set(features.features.map(item=>item.key)).size,41);
    assert.deepEqual(features.tools.map(item=>item.name),TOOL_NAMES);
    assert.equal(new Set(features.tools.map(item=>item.name)).size,16);
    assert.ok(features.tools.every(item=>item.exposed===true),JSON.stringify(features.tools.filter(item=>!item.exposed)));
    assert.ok(features.features.filter(item=>typeof item.configured==='boolean').every(item=>item.configured));
    assert.equal(features.features.find(item=>item.key==='fastEditEnabled').status,'ready');
    assert.equal(features.features.find(item=>item.key==='nativeReasoningReplay').status,'waiting');
    const nativeHost=JSON.parse(await fs.readFile(createRequire(path.join(APP,'package.json')).resolve('@deepseek-ai/dsh-tools/package.json'),'utf8')).version==='0.2.2-rc.2';
    assert.deepEqual(features.features.filter(item=>item.status==='blocked').map(item=>item.key),nativeHost?[]:['nativeVerifiedEdits']);
    assert.ok(JSON.stringify(sourceValue).includes('package-load-marker'));
    await host.command(agent,'off');await host.send(agent,'读取 source.txt，保持 Work Evidence 关闭。');
    assert.ok(JSON.stringify(nativeValue)?.includes('package-load-marker'),JSON.stringify({requests:host.requests.length,
      end:host.events.findLast(event=>event.type==='turn/end')?.data.reason,nativeValue,
      results:host.events.filter(event=>event.type==='tool/result').slice(-2).map(event=>event.data.message.content.map(block=>block.text??'').join('').slice(0,800))}));
    assert.equal((await host.command(agent,'status')).effective,false);
    console.log('packageLoad',JSON.stringify({version:features.version,declaredFiles:files.length,featureEntries:features.features.length,
      configuredBooleanFeatures:features.features.filter(item=>typeof item.configured==='boolean').length,
      blocked:0,archiveDecoder:true,python:'existing-runtime',nativeCompaction:true,sourceRead:true,disabledNativeRead:true}));
  }finally{
    await host?.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('we-package-'));await fs.rm(directory,{recursive:true,force:true,maxRetries:3});
  }
});
