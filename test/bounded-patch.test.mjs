import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {readSourceBundle,selectSourceDirectory,sourceOnlyMaintenanceTask} from '../bounded-patch.mjs';
import {startHost,text} from './helpers/host.mjs';

test('source bundle selects one writable project and excludes an explicitly untouched sibling',async()=>{
  const root=await fs.mkdtemp(path.join(process.env.TEMP??'.','we-bounded-select-'));
  try{
    for(const [directory,file,body] of [['target','a.js','export const a = 1;\n'],['target','b.py','value = 2\n'],
      ['target','c.ts','export const c = 3;\n'],['untouched','d.js','export const d = 4;\n']]){
      await fs.mkdir(path.join(root,directory),{recursive:true});
      await fs.writeFile(path.join(root,directory,file),body);
    }
    const request='修复工作目录中的 target。用户偶尔看到错误，失败后内容丢失，重试后旧结果重复，设置无法恢复。只能通过通读文件代码上下文来定位问题。不要修改 untouched。';
    const entries=await fs.readdir(root,{withFileTypes:true});
    assert.equal(selectSourceDirectory(request,entries),'target');
    assert.equal(sourceOnlyMaintenanceTask(request),true);
    const bundle=await readSourceBundle(root,request);
    assert.deepEqual(bundle.files.map(file=>file.path),['a.js','b.py','c.ts']);
    assert.equal(bundle.sourceRelative,'target');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('task detection accepts a numbered multi-defect report without the narrow symptom words',()=>{
  const report='修复工作目录中的库。只能通过阅读源码定位问题，不能运行测试。\n'
    +'1. 开启 dot 后隐藏文件匹配不到。\n2. 多级模式遇到隐藏目录会漏配。\n'
    +'3. nocase 选项没有生效。\n4. 基名匹配对带目录的路径结果不对。\n'
    +'5. 花括号范围少展开一项。\n6. 否定模式残留了排除项。\n';
  assert.equal(sourceOnlyMaintenanceTask(report),true);
  assert.equal(sourceOnlyMaintenanceTask(report.split('\n').slice(0,5).join('\n')+'\n'),false);
  assert.equal(sourceOnlyMaintenanceTask('修复工作目录中的库。只能通过阅读源码定位问题。\n1. 保留接口\n2. 不要改测试\n3. 完成后汇报\n'),false);
  assert.equal(sourceOnlyMaintenanceTask('修复工作目录中的库。只能通过阅读源码定位问题。这里有四个彼此独立的行为问题。'),false);
  assert.equal(sourceOnlyMaintenanceTask('修复工作目录中的库。只能通过阅读源码定位问题。这里有六个彼此独立的行为问题。'),true);
});

test('large source-only maintenance runs bounded whole-source passes and then returns a tool-free report request',async()=>{
  const auxiliaryPayloads=[];
  let finalTools=null;
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(options,n)=>{
      auxiliaryPayloads.push(options.messages.at(-1).content.map(block=>block.text??'').join(''));
      if(n===1)return [text(JSON.stringify({edits:[{file:'alpha.js',old:'export const alpha = "old";',replacement:'export const alpha = "fixed";'}],
        followup:[{scope:'Beta must recover after an interrupted call.',files:['beta.js']}]}))];
      if(n===2)return [text(JSON.stringify({edits:[{file:'gamma.js',old:'export const gamma = false;',replacement:'export const gamma = true;'}],
        followup:[{scope:'Beta must recover after an interrupted call.',files:['beta.js']}]}))];
      return [text(JSON.stringify({edits:[{file:'beta.js',old:'return value;',replacement:'return value ?? null;'}],followup:[]}))];
    },
    script:options=>{
      finalTools=options.tools??null;
      return [text('已完成有界源码修复。')];
    },
  });
  try{
    await fs.mkdir(path.join(host.cwd,'target'),{recursive:true});
    await fs.mkdir(path.join(host.cwd,'untouched'),{recursive:true});
    await fs.writeFile(path.join(host.cwd,'target','alpha.js'),'export const alpha = "old";\n');
    await fs.writeFile(path.join(host.cwd,'target','beta.js'),'export function beta(value) {\n  return value;\n}\n');
    await fs.writeFile(path.join(host.cwd,'target','gamma.js'),'export const gamma = false;\n');
    await fs.writeFile(path.join(host.cwd,'target','settings.json'),'{"enabled":true}\n');
    for(let index=0;index<30;index++)await fs.writeFile(path.join(host.cwd,'target','filler-'+index+'.js'),
      '// '+(index+1)+'\n'+('export const value'+index+' = '+index+';\n').repeat(400));
    await fs.writeFile(path.join(host.cwd,'untouched','hidden.js'),'export const hidden = "must-not-change";\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "fixed";\n');
    assert.match(await fs.readFile(path.join(host.cwd,'target','beta.js'),'utf8'),/return value \?\? null;/u);
    assert.equal(await fs.readFile(path.join(host.cwd,'target','gamma.js'),'utf8'),'export const gamma = true;\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'untouched','hidden.js'),'utf8'),'export const hidden = "must-not-change";\n');
    assert.equal(auxiliaryPayloads.length,3);
    assert.ok(auxiliaryPayloads.every(payload=>!payload.includes('hidden.js')));
    assert.ok(auxiliaryPayloads[1].includes('export const alpha = \\"fixed\\"'));
    assert.deepEqual(finalTools,[]);
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.done,true);
    assert.equal(status.boundedPatch.result.passes,3);
  }finally{await host.close();}
});

async function writeLargeTarget(host) {
  await fs.mkdir(path.join(host.cwd,'target'),{recursive:true});
  await fs.writeFile(path.join(host.cwd,'target','alpha.js'),'export const alpha = "original";\n');
  await fs.writeFile(path.join(host.cwd,'target','beta.js'),'export const beta = "original";\n');
  for(let index=0;index<30;index++)await fs.writeFile(path.join(host.cwd,'target','filler-'+index+'.js'),
    '// '+(index+1)+'\n'+('export const value'+index+' = '+index+';\n').repeat(400));
}

test('published source starts small and can bring omitted files back as read-only evidence',async()=>{
  const payloads=[];
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(options,requestNumber)=>{
      payloads.push(JSON.parse(options.messages.at(-1).content.map(block=>block.text??'').join('')));
      return [text(JSON.stringify(requestNumber===1
        ? {edits:[{file:'alpha.js',old:'"original"',replacement:'"fixed"'}],
          followup:[{scope:'Check the expected value in the fixture.',files:['fixture.test.js']}]}
        : {edits:[{file:'fixture.test.js',old:'"expected"',replacement:'"rewritten"'}]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    await fs.writeFile(path.join(host.cwd,'target','package.json'),'{"main":"alpha.js","files":["alpha.js","beta.js"]}\n');
    await fs.writeFile(path.join(host.cwd,'target','fixture.test.js'),'export const expected = "expected";\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。这里有六个行为问题，只允许通过源码定位问题。不要修改测试文件。做完直接汇报。');
    assert.equal(payloads.length,2);
    assert.deepEqual(payloads[0].files.map(file=>file.path),['alpha.js','beta.js','package.json']);
    assert.ok(payloads[0].availableFiles.includes('fixture.test.js'));
    assert.deepEqual(payloads[1].referenceOnlyFiles,['fixture.test.js']);
    assert.ok(payloads[1].files.some(file=>file.path==='fixture.test.js'&&file.content.includes('"expected"')));
    assert.equal(await fs.readFile(path.join(host.cwd,'target','fixture.test.js'),'utf8'),'export const expected = "expected";\n');
  }finally{await host.close();}
});

test('a focused pass runs only for review files that earlier passes did not modify',async()=>{
  const auxiliaryPayloads=[];
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(options,n)=>{
      auxiliaryPayloads.push(options.messages.at(-1).content.map(block=>block.text??'').join(''));
      if(n===1)return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"original"',replacement:'"first"'}],
        followup:[{scope:'Beta must recover after an interrupted call.',files:['beta.js']}]}))];
      if(n===2)return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"first"',replacement:'"second"'}],
        followup:[{scope:'Beta must recover after an interrupted call.',files:['beta.js']}]}))];
      return [text(JSON.stringify({edits:[{file:'beta.js',old:'"original"',replacement:'"fixed"'}],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "second";\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','beta.js'),'utf8'),'export const beta = "fixed";\n');
    assert.equal(auxiliaryPayloads.length,3);
    assert.ok(auxiliaryPayloads[1].includes('export const alpha = \\"first\\"'));
    assert.ok(auxiliaryPayloads[2].includes('export const beta = \\"original\\"'));
    assert.ok(!auxiliaryPayloads[2].includes('export const alpha = \\"second\\"'));
  }finally{await host.close();}
});

test('a focused pass is skipped when every review file was already modified',async()=>{
  let calls=0;
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>{
      calls=n;
      if(n===1)return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"original"',replacement:'"first"'}],
        followup:[{scope:'Alpha must recover after an interrupted call.',files:['alpha.js']}]}))];
      return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"first"',replacement:'"second"'}],
        followup:[{scope:'Alpha must recover after an interrupted call.',files:['alpha.js']}]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "second";\n');
    assert.equal(calls,2);
  }finally{await host.close();}
});

test('one malformed edit does not discard the other edits in the same pass',async()=>{
  let calls=0;
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>{
      calls=n;
      if(n===1)return [text(JSON.stringify({edits:[
        {file:'alpha.js',old:'"original"',replacement:'"fixed"'},
        {file:'missing.js',old:'"original"',replacement:'"fixed"'},
        {file:'beta.js',replacement:'"fixed"'},
        {file:'beta.js',old:'"original"',replacement:'"fixed"'},
      ]}))];
      return [text(JSON.stringify({edits:[],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "fixed";\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','beta.js'),'utf8'),'export const beta = "fixed";\n');
    assert.equal(calls,2);
  }finally{await host.close();}
});

test('a proposal without an edits field still returns its followup instead of failing the pass',async()=>{
  let calls=0;
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>{
      calls=n;
      if(n===1)return [text(JSON.stringify({followup:[{scope:'Alpha must recover.',files:['alpha.js']}]}))];
      return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"original"',replacement:'"fixed"'}],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "fixed";\n');
    assert.equal(calls,2);
  }finally{await host.close();}
});

test('a syntax-invalid replacement is rejected without discarding other files',async()=>{
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>{
      if(n===1)return [text(JSON.stringify({edits:[
        {file:'alpha.js',old:'"original"',replacement:'"fixed"'},
        {file:'beta.js',old:'"original"',replacement:';'},
        {file:'settings.json',old:'{"enabled":true}',replacement:'{'},
      ]}))];
      return [text(JSON.stringify({edits:[],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await fs.mkdir(path.join(host.cwd,'target'),{recursive:true});
    await fs.writeFile(path.join(host.cwd,'target','alpha.js'),'export const alpha = "original";\n');
    await fs.writeFile(path.join(host.cwd,'target','beta.js'),'export const beta = "original";\n');
    await fs.writeFile(path.join(host.cwd,'target','settings.json'),'{"enabled":true}\n');
    for(let index=0;index<30;index++)await fs.writeFile(path.join(host.cwd,'target','filler-'+index+'.js'),
      '// '+(index+1)+'\n'+('export const value'+index+' = '+index+';\n').repeat(400));
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "fixed";\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','beta.js'),'utf8'),'export const beta = "original";\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','settings.json'),'utf8'),'{"enabled":true}\n');
  }finally{await host.close();}
});

test('the review pass sees prior edits and can revert an overreach',async()=>{
  const auxiliaryPayloads=[];
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(options,n)=>{
      auxiliaryPayloads.push(options.messages.at(-1).content.map(block=>block.text??'').join(''));
      if(n===1)return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"original"',replacement:'"regressed"'}]}))];
      return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"regressed"',replacement:'"original"'}],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await fs.mkdir(path.join(host.cwd,'target'),{recursive:true});
    await fs.writeFile(path.join(host.cwd,'target','alpha.js'),'export const alpha = "original";\n');
    for(let index=0;index<30;index++)await fs.writeFile(path.join(host.cwd,'target','filler-'+index+'.js'),
      '// '+(index+1)+'\n'+('export const value'+index+' = '+index+';\n').repeat(400));
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(auxiliaryPayloads.length,2);
    assert.ok(auxiliaryPayloads[1].includes('\\"regressed\\"'));
    assert.ok(auxiliaryPayloads[1].includes('changes'));
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "original";\n');
  }finally{await host.close();}
});

test('the focused pass cannot edit files outside the listed review scope',async()=>{
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>{
      if(n===1)return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"original"',replacement:'"first"'}],
        followup:[{scope:'Beta must recover after an interrupted call.',files:['beta.js']}]}))];
      if(n===2)return [text(JSON.stringify({edits:[],followup:[{scope:'Beta must recover after an interrupted call.',files:['beta.js']}]}))];
      return [text(JSON.stringify({edits:[
        {file:'alpha.js',old:'"first"',replacement:'"outside"'},
        {file:'beta.js',old:'"original"',replacement:'"fixed"'},
      ],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await fs.mkdir(path.join(host.cwd,'target'),{recursive:true});
    await fs.writeFile(path.join(host.cwd,'target','alpha.js'),'export const alpha = "original";\n');
    await fs.writeFile(path.join(host.cwd,'target','beta.js'),'export const beta = "original";\n');
    for(let index=0;index<30;index++)await fs.writeFile(path.join(host.cwd,'target','filler-'+index+'.js'),
      '// '+(index+1)+'\n'+('export const value'+index+' = '+index+';\n').repeat(400));
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "first";\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','beta.js'),'utf8'),'export const beta = "fixed";\n');
  }finally{await host.close();}
});

test('a pass without a JSON object is retried once before the normal loop takes over',async()=>{
  let calls=0;
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>{
      calls=n;
      if(n===1)return [text('我先分析源码，不做替换。')];
      if(n===2)return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"original"',replacement:'"fixed"'}]}))];
      return [text(JSON.stringify({edits:[],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await fs.mkdir(path.join(host.cwd,'target'),{recursive:true});
    await fs.writeFile(path.join(host.cwd,'target','alpha.js'),'export const alpha = "original";\n');
    for(let index=0;index<30;index++)await fs.writeFile(path.join(host.cwd,'target','filler-'+index+'.js'),
      '// '+(index+1)+'\n'+('export const value'+index+' = '+index+';\n').repeat(400));
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "fixed";\n');
    assert.equal(calls,3);
  }finally{await host.close();}
});
