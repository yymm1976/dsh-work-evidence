import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool} from './helpers/host.mjs';
import {buildZip} from './helpers/archive.mjs';
const JAVA='package demo;\npublic class Calc {\n  public int add(int a, int b) {\n    return a + b;\n  }\n  public int sub(int a, int b) {\n    return a - b;\n  }\n}\n';
const output=host=>host.events.filter(e=>e.type==='tool/result').map(e=>{const body=e.data.message.content.map(b=>b.text??'').join('');try{return JSON.parse(body);}catch{return {error:e.data.message.isError,text:body};}});
async function run(workspace,steps,setup){
  const host=await startHost({workspace:{toolSurface:'full',...workspace},script:(_o,n)=>steps[n-1]??[text('完成。')]});
  try{await setup(host.cwd);const agent=await host.createAgent('max');await host.send(agent,'按指定范围读取源码');return {results:output(host),status:await host.command(agent,'detail'),features:(await host.command(agent,'features')).features};}
  finally{await host.close();}
}

test('archiveReadRouting reads virtual archive paths and exposes an ordinary file error when disabled',async()=>{
  const steps=[[tool('read',{file_path:'src-sources.jar!/demo/Calc.java',offset:2,limit:4})]];
  const setup=cwd=>fs.writeFile(path.join(cwd,'src-sources.jar'),buildZip([{name:'demo/Calc.java',data:JAVA}]));
  const on=await run({},steps,setup),off=await run({archiveReadRouting:false},steps,setup);
  assert.match(on.results[0].text,/2: public class Calc/);assert.match(on.results[0].text,/4:     return a \+ b/);
  assert.equal(on.status.metrics.archiveReadRoutes,1);
  assert.equal(on.features.find(item=>item.key==='archiveReadRouting').effect.status,'applied');
  assert.equal(off.status.metrics.archiveReadRoutes,0);assert.ok(off.results[0].error);
});

test('evidenceViews references a proven full body and sends full text after a write',async()=>{
  const args={mode:'read',files:[{path:'a.txt',offset:1,limit:80}],responseView:'reference-if-visible'};
  const steps=[[tool('project_evidence',args)],[tool('project_evidence',args)],
    [tool('write',{file_path:'a.txt',content:'changed\n'})],[tool('project_evidence',args)]];
  const setup=cwd=>fs.writeFile(path.join(cwd,'a.txt'),Array.from({length:65},(_,i)=>`row ${i} `+'z'.repeat(40)).join('\n'));
  const on=await run({ledgerReceipt:false},steps,setup),off=await run({evidenceViews:false,ledgerReceipt:false},steps,setup);
  assert.equal(on.results[0].responseView.kind,'full');assert.equal(on.results[1].responseView.kind,'reference');
  assert.equal(on.results[3].responseView.kind,'full');assert.match(JSON.stringify(on.results[3]),/changed/);
  assert.equal(on.features.find(item=>item.key==='evidenceViews').effect.status,'applied');
  assert.ok(off.results.filter(x=>x.mode==='read').every(x=>x.responseView.kind==='full'));
  assert.equal(off.features.find(item=>item.key==='evidenceViews').effect.status,'not-observed');
});

test('defaultResponseView independently records its actual default and explicit override',async()=>{
  const args={mode:'read',files:[{path:'a.txt',offset:1,limit:80}]};
  const steps=[[tool('project_evidence',args)],[tool('project_evidence',args)],
    [tool('project_evidence',{...args,responseView:'full'})]];
  const setup=cwd=>fs.writeFile(path.join(cwd,'a.txt'),Array.from({length:65},(_,i)=>`row ${i} `+'z'.repeat(40)).join('\n'));
  const on=await run({ledgerReceipt:false,defaultResponseView:'reference-if-visible'},steps,setup);
  assert.equal(on.features.find(item=>item.key==='defaultResponseView').effect.status,'applied');
  const defaults=on.features.find(item=>item.key==='defaultResponseView').effect;
  assert.equal(defaults.applied,1);assert.equal(defaults.notApplicable,1);
  assert.equal(defaults.lastReason,'configured-reference-if-visible');
  assert.equal(on.results[1].responseView.kind,'reference');
  assert.equal(on.results[2].responseView.reason,'explicit-full-view');
  const off=await run({ledgerReceipt:false,evidenceViews:false,defaultResponseView:'reference-if-visible'},steps,setup);
  const offEffect=off.features.find(item=>item.key==='defaultResponseView').effect;
  assert.equal(offEffect.status,'not-applied');
  assert.equal(offEffect.unavailable,2);
  assert.equal(offEffect.applied,0);
  assert.equal(offEffect.notApplicable,0);
});

test('memberParsing finds Java method bodies with parsing on and with its lexical fallback',async()=>{
  for(const memberParsing of [true,false]){
    const observed=await run({memberParsing},[[tool('project_evidence',{mode:'source',query:'Calc',member:'add'})]],
      async cwd=>{await fs.mkdir(path.join(cwd,'src'));await fs.writeFile(path.join(cwd,'src','Calc.java'),JAVA);});
    const body=JSON.stringify(observed.results[0]);
    assert.equal(observed.results[0].sources[0].parser.mode,memberParsing?'tree-sitter':'lexical');
    const effect=observed.features.find(item=>item.key==='memberParsing').effect;
    assert.equal(effect.status,memberParsing?'applied':'not-applicable');
    assert.ok(body.includes('return a + b;'));
    assert.ok(!body.includes('return a - b;'),'the unrelated method body is not included');
  }
});

test('mavenSourceBinding requires coordinates and selects a matching sources jar',async()=>{
  const steps=[[tool('project_evidence',{mode:'source',query:'demo.Calc'})]];
  async function setup(cwd){
    await fs.writeFile(path.join(cwd,'pom.xml'),'<project><modelVersion>4.0.0</modelVersion><groupId>app</groupId><artifactId>demo-app</artifactId><version>1.0</version><dependencies><dependency><groupId>com.acme</groupId><artifactId>math</artifactId><version>1.0</version></dependency></dependencies></project>');
    await fs.writeFile(path.join(cwd,'math-1.0-sources.jar'),buildZip([{name:'demo/Calc.java',data:JAVA},
      {name:'META-INF/maven/com.acme/math/pom.properties',data:'groupId=com.acme\nartifactId=math\nversion=1.0\n'}]));
  }
  const on=await run({},steps,setup),off=await run({mavenSourceBinding:false},steps,setup);
  assert.equal(on.results[0].selected.mavenBinding.state,'matched');
  assert.equal(on.features.find(item=>item.key==='mavenSourceBinding').effect.status,'applied');
  assert.match(JSON.stringify(on.results[0]),/return a \+ b/);
  assert.equal(off.results[0].selected?.mavenBinding,undefined);
  assert.equal(off.features.find(item=>item.key==='mavenSourceBinding').effect.status,'not-observed');
  const mismatch=await run({},steps,async cwd=>{
    await setup(cwd);
    await fs.writeFile(path.join(cwd,'math-1.0-sources.jar'),buildZip([{name:'demo/Calc.java',data:JAVA},
      {name:'META-INF/maven/com.acme/math/pom.properties',data:'groupId=com.acme\nartifactId=math\nversion=2.0\n'}]));
  });
  assert.equal(mismatch.results[0].selected,null,'a filename match cannot override conflicting Maven metadata');
  assert.equal(mismatch.results[0].sources.length,0);
});
