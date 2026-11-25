import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {applyPatchProposal,boundedPatchGuidance,failedPatchStatus,readSourceBundle,selectSourceDirectory,sourceOnlyMaintenanceTask} from '../bounded-patch.mjs';
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

test('task detection follows source-only write authorization rather than the number of reported symptoms',()=>{
  const report='修复工作目录中的库。只能通过阅读源码定位问题，不能运行测试。\n'
    +'1. 开启 dot 后隐藏文件匹配不到。\n2. 多级模式遇到隐藏目录会漏配。\n'
    +'3. nocase 选项没有生效。\n4. 基名匹配对带目录的路径结果不对。\n'
    +'5. 花括号范围少展开一项。\n6. 否定模式残留了排除项。\n';
  assert.equal(sourceOnlyMaintenanceTask(report),true);
  assert.equal(sourceOnlyMaintenanceTask('修复工作目录中的库。只能通过阅读源码定位问题。这里有一个行为问题。'),true);
  assert.equal(sourceOnlyMaintenanceTask('修复工作目录中的库。只能通过阅读源码定位问题。这里有四个彼此独立的行为问题。'),true);
  assert.equal(sourceOnlyMaintenanceTask('修复工作目录中的库。只能通过阅读源码定位问题。\n1. 保留接口\n2. 不要改测试\n3. 完成后汇报\n'),true);
  assert.equal(sourceOnlyMaintenanceTask('只通过源码定位工作目录中的库。这里有六个彼此独立的行为问题。请分析并给出修复建议。'),false,
    'applicability signals cannot replace affirmative write authorization');
});

test('an abort stays distinct from partial and failed without discarding applied evidence',()=>{
  assert.equal(failedPatchStatus({aborted:true,applied:2}),'aborted');
  assert.equal(failedPatchStatus({aborted:false,applied:2}),'partial');
  assert.equal(failedPatchStatus({aborted:false,applied:0}),'failed');
});

test('large source-only maintenance runs bounded whole-source passes and keeps native tools for the handoff',async()=>{
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
    assert.ok(Array.isArray(finalTools)&&finalTools.some(tool=>tool.name==='write'),
      'a completed patch application must not remove the native tools');
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.done,true);
    assert.equal(status.boundedPatch.result.patchStatus,'completed');
    assert.equal(status.boundedPatch.result.taskStatus,'unknown');
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

async function writeScopedTarget(host) {
  await fs.mkdir(path.join(host.cwd,'target','src'),{recursive:true});
  await fs.mkdir(path.join(host.cwd,'target','test'),{recursive:true});
  await fs.writeFile(path.join(host.cwd,'target','alpha.js'),'export const alpha = "root";\n');
  await fs.writeFile(path.join(host.cwd,'target','src','alpha.js'),'export const alpha = "src";\n');
  await fs.writeFile(path.join(host.cwd,'target','test','anchor.test.js'),'export const expected = "test";\n');
  for(let index=0;index<30;index++)await fs.writeFile(path.join(host.cwd,'target','src','filler-'+index+'.js'),
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
    assert.equal(payloads[0].sourceComplete,false,'a published manifest view is not the complete source bundle');
    assert.match(payloads[0].coverageStatus,/partial/u);
    assert.ok(payloads[0].omittedCount>0);
    assert.ok(payloads[0].omittedReasons['published-manifest-exclusion']>0);
    assert.deepEqual(payloads[1].referenceOnlyFiles,['fixture.test.js']);
    assert.equal(payloads[1].sourceComplete,false,'a focused review of one follow-up file is not whole-source coverage');
    assert.equal(payloads[1].coverageStatus,'published-view-partial');
    assert.ok(payloads[1].omittedReasons['published-manifest-exclusion']>0);
    assert.ok(payloads[1].files.some(file=>file.path==='fixture.test.js'&&file.content.includes('"expected"')));
    assert.equal(await fs.readFile(path.join(host.cwd,'target','fixture.test.js'),'utf8'),'export const expected = "expected";\n');
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.coverage.status,'published-view-partial',
      'the handoff reports the actual published model views, not only the refreshed source bundle');
    assert.equal(status.boundedPatch.result.coverage.views.length,2);
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
    const focusedPayload=JSON.parse(auxiliaryPayloads[2]);
    assert.equal(focusedPayload.sourceComplete,false,'a focused review does not cover the whole source bundle');
    assert.equal(focusedPayload.coverageStatus,'focused-partial');
    assert.ok(focusedPayload.omittedReasons['outside-focused-scope']>0);
  }finally{await host.close();}
});

test('a focused pass still reviews a file that an earlier pass modified',async()=>{
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
    assert.equal(calls,3);
  }finally{await host.close();}
});

test('a file omitted from the focused pass remains an explicit follow-up',async()=>{
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>{
      if(n===1)return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"original"',replacement:'"fixed"'}],
        followup:[{scope:'Review both large files.',files:['beta.js','gamma.js']}]}))];
      if(n===2)return [text(JSON.stringify({edits:[],followup:[{scope:'Review both large files.',files:['beta.js','gamma.js']}]}))];
      return [text(JSON.stringify({edits:[],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await fs.mkdir(path.join(host.cwd,'target'),{recursive:true});
    await fs.writeFile(path.join(host.cwd,'target','alpha.js'),'export const alpha = "original";\n');
    await fs.writeFile(path.join(host.cwd,'target','beta.js'),'export const beta = "'+('b'.repeat(90000))+'";\n');
    await fs.writeFile(path.join(host.cwd,'target','gamma.js'),'export const gamma = "'+('g'.repeat(90000))+'";\n');
    for(let index=0;index<30;index++)await fs.writeFile(path.join(host.cwd,'target','filler-'+index+'.js'),
      '// '+(index+1)+'\n'+('export const value'+index+' = '+index+';\n').repeat(400));
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只允许通过源码定位问题。做完直接汇报。');
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.patchStatus,'partial');
    assert.equal(status.boundedPatch.result.followup,1,'the omitted focused file is not silently cleared');
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
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.patchStatus,'partial');
    assert.equal(status.boundedPatch.result.partial,true);
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

test('read-only, review-only and denied-write requests never enter the bounded patch flow',async()=>{
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:()=>{throw new Error('the bounded patch auxiliary must not run');},
    script:()=>[text('已完成。')],
  });
  try{
    await writeLargeTarget(host);
    await fs.writeFile(path.join(host.cwd,'target','anchor.test.js'),'export const expected = "unchanged";\n');
    const beforeAlpha=await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8');
    const beforeTest=await fs.readFile(path.join(host.cwd,'target','anchor.test.js'),'utf8');
    const agent=await host.createAgent('max');
    for(const request of [
      '只能通过源码定位六个问题，不要修改任何文件。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。',
      '审查并指出需要修复的十个缺陷。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。只读分析。',
      '无需修改源码，只给出修复建议。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。',
    ])await host.send(agent,request);
    assert.equal(host.auxiliaryRequests.length,0);
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),beforeAlpha);
    assert.equal(await fs.readFile(path.join(host.cwd,'target','anchor.test.js'),'utf8'),beforeTest);
  }finally{await host.close();}
});

test('only files inside the explicit src write scope may change',async()=>{
  const payloads=[];
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(options,n)=>{
      payloads.push(JSON.parse(options.messages.at(-1).content.map(block=>block.text??'').join('')));
      if(n===1)return [text(JSON.stringify({edits:[
        {file:'src/alpha.js',old:'"src"',replacement:'"fixed"'},
        {file:'alpha.js',old:'"root"',replacement:'"mutated-root"'},
        {file:'test/anchor.test.js',old:'"test"',replacement:'"mutated-test"'},
      ]}))];
      return [text(JSON.stringify({edits:[],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  let nativeWrites=0;
  host.ctx.on('tools/result',exec=>{
    if(exec.name==='write'&&exec.callId?.startsWith('work-evidence:native-cas:'))nativeWrites++;
  });
  try{
    await writeScopedTarget(host);
    const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
    const beforeRoot=await hash(path.join(host.cwd,'target','alpha.js'));
    const beforeTest=await hash(path.join(host.cwd,'target','test','anchor.test.js'));
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。只通过源码定位问题，不要修改测试文件，只修复 src 中的问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','src','alpha.js'),'utf8'),'export const alpha = "fixed";\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "root";\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','test','anchor.test.js'),'utf8'),'export const expected = "test";\n');
    assert.equal(await hash(path.join(host.cwd,'target','alpha.js')),beforeRoot);
    assert.equal(await hash(path.join(host.cwd,'target','test','anchor.test.js')),beforeTest);
    assert.equal(nativeWrites,1);
    assert.ok(payloads[0].readOnlyFiles.includes('alpha.js'));
    assert.ok(payloads[0].readOnlyFiles.includes('test/anchor.test.js'));
    assert.ok(payloads[0].writableFiles.includes('src/alpha.js'));
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.patchStatus,'partial');
    assert.ok(status.boundedPatch.result.rejected>0);
  }finally{await host.close();}
});

test('a concurrent native change is not overwritten by a bounded patch',async()=>{
  let mutated=false;
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>[text(JSON.stringify(n===1
      ? {edits:[{file:'alpha.js',old:'"original"',replacement:'"fixed"'}]}
      : {edits:[],followup:[]}))],
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    host.ctx.on('fs/write-intent',async(target,actor,next)=>{
      if(!mutated&&String(actor?.callId).startsWith('work-evidence:native-cas:')&&target.displayPath.endsWith('alpha.js')){
        mutated=true;
        await fs.writeFile(path.join(host.cwd,'target','alpha.js'),'export const alpha = "concurrent";\n');
      }
      return next();
    });
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(mutated,true);
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "concurrent";\n');
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.patchStatus,'failed','a write rejected by the version check is not an applied edit');
    assert.equal(status.boundedPatch.result.edits,0);
    assert.equal(status.boundedPatch.result.files,0);
    assert.ok(status.boundedPatch.result.rejected>0);
  }finally{await host.close();}
});

test('a failed source refresh after an edit is not replaced by the pre-edit snapshot',async()=>{
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>[text(JSON.stringify(n===1
      ? {edits:[{file:'alpha.js',old:'"original"',replacement:'"fixed"'}]}
      : {edits:[{file:'beta.js',old:'"original"',replacement:'"changed"'}],followup:[]}))],
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    const provider=host.ctx.get('fs');
    const originalList=provider.listDir.bind(provider);
    let lists=0;
    provider.listDir=async(...args)=>{
      lists++;
      if(lists===3)throw new Error('injected source-list failure');
      return originalList(...args);
    };
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "fixed";\n');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','beta.js'),'utf8'),'export const beta = "original";\n',
      'a failed refresh must stop before a later pass can edit using the pre-edit bundle');
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.patchStatus,'partial');
    assert.match(status.boundedPatch.result.warning,/source bundle refresh/iu);
  }finally{await host.close();}
});

test('cancellation after a committed bounded edit reports aborted without losing the applied evidence',async()=>{
  let passTwoStarted;
  const atPassTwo=new Promise(resolve=>{passTwoStarted=resolve;});
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:async(options,n)=>{
      if(n===1)return [text(JSON.stringify({edits:[
        {file:'alpha.js',old:'"original"',replacement:'"fixed"'}]}))];
      if(n===2){
        passTwoStarted();
        await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(
          Object.assign(new Error('cancelled during the bounded patch'),{name:'AbortError'})),{once:true}));
      }
      return [text(JSON.stringify({edits:[],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    const agent=await host.createAgent('max');
    const sending=host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。只允许通过源码定位问题。做完直接汇报。');
    await Promise.race([atPassTwo,new Promise((_,reject)=>setTimeout(()=>reject(new Error('bounded patch did not reach pass two')),15000))]);
    agent.cancel({kind:'user'});
    await sending;
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "fixed";\n');
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.patchStatus,'aborted');
    assert.equal(status.boundedPatch.result.taskStatus,'unknown');
    assert.ok(status.boundedPatch.result.edits>=1);
    assert.ok(status.boundedPatch.result.files>=1);
  }finally{await host.close();}
});

test('a cancelled host turn is recorded as aborted in the bounded patch result',async()=>{
  let passTwoStarted;
  const atPassTwo=new Promise(resolve=>{passTwoStarted=resolve;});
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:async(options,n)=>{
      if(n===1)return [text(JSON.stringify({edits:[
        {file:'alpha.js',old:'"original"',replacement:'"fixed"'}]}))];
      if(n===2){
        passTwoStarted();
        await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(
          Object.assign(new Error('cancelled during the bounded patch'),{name:'AbortError'})),{once:true}));
      }
      return [text(JSON.stringify({edits:[],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    const agent=await host.createAgent('max');
    const sending=host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。只允许通过源码定位问题。做完直接汇报。');
    await Promise.race([atPassTwo,new Promise((_,reject)=>setTimeout(()=>reject(new Error('bounded patch did not reach pass two')),15000))]);
    agent.cancel({kind:'user'});
    await sending;
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "fixed";\n');
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.taskStatus,'unknown');
    assert.ok(status.boundedPatch.result.edits>=1,'the applied edit remains recorded');
    assert.ok(status.boundedPatch.result.files>=1);
    assert.ok(status.boundedPatch.result.coverage);
  }finally{await host.close();}
});

test('all rejected candidates still hand the native tools back',async()=>{
  let finalTools=null;
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>[text(JSON.stringify(n===1
      ? {edits:[{file:'alpha.js',old:'"not-present"',replacement:'"fixed"'}]}
      : {edits:[],followup:[]}))],
    script:options=>{finalTools=options.tools??null;return [text('未能应用补丁。')];},
  });
  try{
    await writeLargeTarget(host);
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。只允许通过源码定位问题。做完直接汇报。');
    assert.ok(Array.isArray(finalTools)&&finalTools.some(tool=>tool.name==='write'),
      'a failed patch must not remove the tools the native agent needs');
    const status=await host.command(agent,'status');
    assert.equal(status.boundedPatch.result.patchStatus,'failed');
    assert.equal(status.boundedPatch.result.taskStatus,'unknown');
    assert.equal(status.boundedPatch.result.requestedEdits,1);
    assert.ok(status.boundedPatch.result.rejectedCount>=1,
      'a proposal rejected during normalization remains in the handoff');
  }finally{await host.close();}
});

async function writeScopeFixture() {
  const root=await fs.mkdtemp(path.join(process.env.TEMP??'.','we-scope-'));
  const target=path.join(root,'target');
  for(const directory of ['src','src/generated','config','test'])await fs.mkdir(path.join(target,directory),{recursive:true});
  for(const [file,text] of [
    ['src/alpha.js','export const alpha = "src";\n'],
    ['src/generated/generated.js','export const generated = "generated";\n'],
    ['config/settings.js','export const setting = "config";\n'],
    ['test/anchor.test.js','export const expected = "test";\n'],
    ['alpha.js','export const alpha = "root";\n'],
  ])await fs.writeFile(path.join(target,file),text);
  for(let index=0;index<8;index++)await fs.writeFile(path.join(target,'src','filler-'+index+'.js'),
    'export const filler'+index+' = '+index+';\n');
  return {root,target};
}

test('write scope requires explicit paths and lets nested denials win over a parent scope',async()=>{
  const {root,target}=await writeScopeFixture();
  try{
    const request='修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只修复 src 中的问题，不要修改 src/generated，也不要修改测试文件。';
    const bundle=await readSourceBundle(root,request);
    assert.equal(bundle.writeScope.status,'explicit');
    assert.deepEqual(bundle.writeScope.scopes,['src']);
    assert.ok(bundle.writeScope.files.includes('src/alpha.js'));
    assert.ok(!bundle.writeScope.files.includes('src/generated/generated.js'));
    assert.ok(!bundle.writeScope.files.includes('test/anchor.test.js'));
    assert.ok(bundle.writeScope.forbidden.includes('src/generated/generated.js'));
    const absolute=await readSourceBundle(root,`修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只修复 ${path.join(target,'src')} 中的问题。`);
    assert.deepEqual(absolute.writeScope.scopes,['src']);
    assert.ok(absolute.writeScope.files.includes('src/alpha.js'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('an unresolved subdirectory name is not widened to the whole project',async()=>{
  const root=await fs.mkdtemp(path.join(process.env.TEMP??'.','we-scope-ambiguous-'));
  try{
    const target=path.join(root,'target');
    for(const directory of ['pkg/src','other/src','test'])await fs.mkdir(path.join(target,directory),{recursive:true});
    for(const file of ['pkg/src/a.js','other/src/b.js','test/c.js'])await fs.writeFile(path.join(target,file),'export const value = 1;\n');
    const bundle=await readSourceBundle(root,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只修复 src 中的问题。');
    assert.equal(bundle.writeScope.status,'ambiguous');
    assert.deepEqual(bundle.writeScope.files,[]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('a traversal budget reports unvisited entries instead of a complete omission count',async()=>{
  const root=await fs.mkdtemp(path.join(process.env.TEMP??'.','we-scope-budget-'));
  try{
    const target=path.join(root,'target');
    await fs.mkdir(target,{recursive:true});
    for(let index=0;index<520;index++)await fs.writeFile(path.join(target,`file-${String(index).padStart(3,'0')}.js`),'export const value = 1;\n');
    const bundle=await readSourceBundle(root,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。');
    assert.equal(bundle.files.length,512);
    assert.equal(bundle.complete,false);
    assert.equal(bundle.traversalStopped,true);
    assert.equal(bundle.unvisitedEntries,8);
    assert.equal(bundle.omittedCountKnown,false);
    assert.equal(bundle.omittedCount>=0,true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('the independent entry limit bounds a tree of non-source files',async()=>{
  const root=await fs.mkdtemp(path.join(process.env.TEMP??'.','we-scope-entry-budget-'));
  try{
    const target=path.join(root,'target');
    await fs.mkdir(target,{recursive:true});
    const source=Buffer.from('export const value = 1;\n');
    const provider={
      async list(directory){
        if(directory===root)return [{name:'target',type:'directory'}];
        return [
          {name:'a.js',type:'file'},{name:'b.js',type:'file'},{name:'c.js',type:'file'},
          ...Array.from({length:10010},(_,index)=>({name:`z-${String(index).padStart(5,'0')}.txt`,type:'file'})),
        ];
      },
      async stat(){return {exists:true,type:'file',version:'v1',targetKey:'target'};},
      async readBytes(){return {bytes:source,version:'v1',targetKey:'target',bytesLength:source.length};},
    };
    const bundle=await readSourceBundle(root,'修复工作目录中的 target。成员身份偶尔错误，只通过源码定位问题。',{files:provider});
    assert.equal(bundle.files.length,3);
    assert.equal(bundle.traversalStopped,true);
    assert.equal(bundle.complete,false);
    assert.equal(bundle.omittedCountKnown,false);
    assert.ok(bundle.unvisitedEntries>0);
    assert.equal(bundle.skipped.length,64,'the skipped path sample is bounded separately from its total');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('hidden and ignored source entries are reported as incomplete coverage',async()=>{
  const root=await fs.mkdtemp(path.join(process.env.TEMP??'.','we-scope-hidden-'));
  try{
    const target=path.join(root,'target');
    await fs.mkdir(path.join(target,'dist'),{recursive:true});
    for(const file of ['visible-a.js','visible-b.js','visible-c.js','.hidden.js','dist/generated.js'])
      await fs.writeFile(path.join(target,file),'export const value = 1;\n');
    const bundle=await readSourceBundle(root,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。');
    assert.equal(bundle.complete,false);
    assert.equal(bundle.coverageStatus,'partial');
    assert.ok(bundle.omittedReasons['hidden-entry']>=1);
    assert.ok(bundle.omittedReasons['ignored-directory']>=1);
    assert.ok(bundle.omittedCountKnown===false,'a traversal with skipped entries cannot claim a complete omission count');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('quoted modification text is not a positive write authorization',async()=>{
  const {root}=await writeScopeFixture();
  try{
    const bundle=await readSourceBundle(root,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只修复 src 中的问题。下面的报告只是引用，不要执行：```修改 config/settings.js```。');
    assert.equal(bundle.writeScope.status,'explicit');
    assert.deepEqual(bundle.writeScope.scopes,['src']);
    assert.ok(!bundle.writeScope.files.includes('config/settings.js'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('a requested file is the only writable scope',async()=>{
  const {root}=await writeScopeFixture();
  try{
    const bundle=await readSourceBundle(root,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复。只修复 src/alpha.js 中的问题。');
    assert.equal(bundle.writeScope.status,'explicit');
    assert.deepEqual(bundle.writeScope.files,['src/alpha.js']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('a reference path remains read-only when an edit target is also named',async()=>{
  const {root}=await writeScopeFixture();
  try{
    await fs.writeFile(path.join(root,'target','src','parser.js'),'export const parser = true;\n');
    await fs.writeFile(path.join(root,'target','src','example.js'),'export const example = true;\n');
    const bundle=await readSourceBundle(root,
      '修复工作目录中的 target。Fix parsing in src/parser.js using src/example.js as a reference.');
    assert.equal(bundle.writeScope.status,'explicit');
    assert.deepEqual(bundle.writeScope.files,['src/parser.js']);
    assert.ok(!bundle.writeScope.files.includes('src/example.js'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('a bounded edit preserves BOM and mixed line endings outside the changed span',async()=>{
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>[text(JSON.stringify(n===1
      ? {edits:[{file:'alpha.js',old:'line2',replacement:'LINE2'}]}
      : {edits:[],followup:[]}))],
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    const file=path.join(host.cwd,'target','alpha.js');
    await fs.writeFile(file,'\uFEFFline1\r\nline2\nline3\r\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(file,'utf8'),'\uFEFFline1\r\nLINE2\nline3\r\n');
  }finally{await host.close();}
});

async function proposalFixture(effectValue){
  const original='value = 1\n',changed='value = 2\n';
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const bundle={sourceRelative:'.',workspaceRoot:'.',complete:true,coverageStatus:'complete',
    files:[{path:'alpha.py',text:original,version:'v1',targetKey:'target-1',contentHash:hash(original),bytes:original.length}],
    writeScope:{status:'explicit',scopes:['.'],files:['alpha.py']},writable:['alpha.py'],forbidden:[],
    omittedCount:0,omittedCountKnown:true,omittedReasons:{},omittedExamples:[]};
  const calls={apply:0,stat:0,read:0};
  const cas={
    async stat(){calls.stat++;return {ok:true,exists:true,type:'file',revision:'v1',targetKey:'target-1'};},
    async read(){calls.read++;return {ok:true,text:original,sha256:hash(original),revision:'v1',targetKey:'target-1'};},
    async apply(){calls.apply++;return typeof effectValue==='function'?effectValue(changed):effectValue;},
  };
  return {bundle,cas,calls,hash,changed,original};
}

test('a bounded patch skips helper execution when the request forbids it',async()=>{
  const fixture=await proposalFixture(()=>({ok:true,status:'completed',effectState:'applied',revision:'v2',
    targetKey:'target-1',contentHash:createHash('sha256').update('value = 2\n').digest('hex'),callId:'write-1'}));
  const result=await applyPatchProposal({edits:[{file:'alpha.py',old:'value = 1',replacement:'value = 2'}]},
    fixture.bundle,new AbortController().signal,{python:process.execPath,agent:{},cas:fixture.cas,allowSyntax:false});
  assert.equal(result.applied.length,1);
  assert.equal(result.applied[0].syntaxStatus,'skipped');
  assert.equal(fixture.calls.apply,1);
  assert.equal(result.requestedEdits,1);
  assert.match(result.proposalDigest,/^[0-9a-f]{64}$/);
});

test('a bounded patch retains an unknown native effect and its rejection in the pass facts',async()=>{
  const fixture=await proposalFixture({ok:false,status:'error',effectState:'unknown',callId:'write-2',
    error:{message:'native write outcome unavailable'}});
  const result=await applyPatchProposal({edits:[{file:'alpha.py',old:'value = 1',replacement:'value = 2'}]},
    fixture.bundle,new AbortController().signal,{python:process.execPath,agent:{},cas:fixture.cas,allowSyntax:false});
  assert.equal(result.applied.length,0);
  assert.equal(result.effects.length,1);
  assert.equal(result.effects[0].effectState,'unknown');
  assert.equal(result.effects[0].callId,'write-2');
  assert.equal(result.rejections.some(item=>item.reason==='native-write-effect-unknown'),true);
});

test('authorization is checked again after syntax validation and before dispatch',async()=>{
  const fixture=await proposalFixture(()=>({ok:true,status:'completed',effectState:'applied',revision:'v2',
    targetKey:'target-1',contentHash:createHash('sha256').update('value = 2\n').digest('hex'),callId:'write-1'}));
  let checks=0;
  const result=await applyPatchProposal({edits:[{file:'alpha.py',old:'value = 1',replacement:'value = 2'}]},
    fixture.bundle,new AbortController().signal,{python:process.execPath,agent:{},cas:fixture.cas,allowSyntax:false,
      validate:()=>++checks===1?{ok:true}:{ok:false,reason:'request-identity-changed'}});
  assert.equal(fixture.calls.apply,0);
  assert.equal(result.applied.length,0);
  assert.ok(result.rejections.some(item=>item.reason==='authorization-changed'));
});

test('failed and aborted guidance never denies an unconfirmed write',()=>{
  const base={applied:[],files:[],rejected:[],followup:[],warning:null,unverified:[],
    sourceCoverage:{status:'partial',omittedCount:0,omittedCountKnown:true}};
  const failed=boundedPatchGuidance({...base,patchStatus:'failed',unknownEffects:[{file:'alpha.js'}]});
  assert.match(failed,/No confirmed source edit was applied/u);
  assert.match(failed,/unknown write effects/u);
  assert.match(failed,/alpha\.js/u);
  const aborted=boundedPatchGuidance({...base,patchStatus:'aborted',unknownEffects:[{file:'beta.js'}]});
  assert.match(aborted,/aborted/u);
  assert.match(aborted,/unknown write effects/u);
  assert.match(aborted,/beta\.js/u);
});

test('a bounded patch never falls back to a direct child process for syntax checking',async()=>{
  const original='const value = 1;\n',changed='const value = ;\n';
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const bundle={sourceRelative:'.',sourceRoot:'.',workspaceRoot:'.',complete:true,coverageStatus:'complete',
    files:[{path:'alpha.js',text:original,version:'v1',targetKey:'target-js',contentHash:hash(original),bytes:original.length}],
    writeScope:{status:'explicit',scopes:['.'],files:['alpha.js']},writable:['alpha.js'],forbidden:[]};
  let applied=false;
  const cas={
    async stat(){return {ok:true,exists:true,type:'file',revision:'v1',targetKey:'target-js'};},
    async read(){return {ok:true,text:original,sha256:hash(original),revision:'v1',targetKey:'target-js'};},
    async apply(){applied=true;return {ok:true,status:'completed',effectState:'applied',revision:'v2',
      targetKey:'target-js',contentHash:hash(changed),callId:'write-js'};},
  };
  const result=await applyPatchProposal({edits:[{file:'alpha.js',old:'const value = 1;',replacement:'const value = ;'}]},
    bundle,new AbortController().signal,{agent:{},cas,allowSyntax:true});
  assert.equal(applied,true);
  assert.equal(result.applied.length,1);
  assert.equal(result.applied[0].syntaxStatus,'unavailable',
    'without a host subprocess service the helper must be unavailable, not run through node:child_process');
});

test('a bounded patch validates .mjs source with module syntax',async()=>{
  const original='await Promise.resolve(1);\n',changed='await Promise.resolve(2);\n';
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const bundle={sourceRelative:'.',sourceRoot:'.',workspaceRoot:'.',complete:true,coverageStatus:'complete',
    files:[{path:'alpha.mjs',text:original,version:'v1',targetKey:'target-mjs',contentHash:hash(original),bytes:original.length}],
    writeScope:{status:'explicit',scopes:['.'],files:['alpha.mjs']},writable:['alpha.mjs'],forbidden:[]};
  let syntaxArgs=null;
  const cas={
    async stat(){return {ok:true,exists:true,type:'file',revision:'v1',targetKey:'target-mjs'};},
    async read(){return {ok:true,text:original,sha256:hash(original),revision:'v1',targetKey:'target-mjs'};},
    async apply(){return {ok:true,status:'completed',effectState:'applied',revision:'v2',
      targetKey:'target-mjs',contentHash:hash(changed),callId:'write-mjs'};},
  };
  const result=await applyPatchProposal({edits:[{file:'alpha.mjs',old:'1',replacement:'2'}]},bundle,
    new AbortController().signal,{agent:{},cas,allowSyntax:true,
      syntaxRunner:async(_command,args,input)=>{syntaxArgs={args,input};return {ok:true};}});
  assert.equal(result.applied.length,1);
  assert.ok(syntaxArgs.args.includes('--input-type=module'));
  assert.equal(syntaxArgs.input,changed);
  assert.equal(result.applied[0].syntaxStatus,'passed');
});

test('a bounded patch proposal uses strict JSON instead of repairing an invalid escape',async()=>{
  const host=await startHost({
    workspace:{boundedPatch:true,stepPacing:false,qualityReview:false,completionNotice:false,finalJsonGuard:false},
    auxiliary:(_options,n)=>{
      if(n===1)return [text('{"edits":[{"file":"alpha.js","old":"\\"original\\"","replacement":"C:\\q"}]}')];
      if(n===2)return [text(JSON.stringify({edits:[{file:'alpha.js',old:'"original"',replacement:'"fixed"'}]}))];
      return [text(JSON.stringify({edits:[],followup:[]}))];
    },
    script:()=>[text('已完成有界源码修复。')],
  });
  try{
    await writeLargeTarget(host);
    const agent=await host.createAgent('max');
    await host.send(agent,'修复工作目录中的 target。成员身份偶尔错误，请求失败后内容丢失，历史结果重复，设置切换后无法恢复，结果偶尔错位。只允许通过源码定位问题。做完直接汇报。');
    assert.equal(await fs.readFile(path.join(host.cwd,'target','alpha.js'),'utf8'),'export const alpha = "fixed";\n');
    assert.equal((await host.command(agent,'status')).boundedPatch.result.patchStatus,'completed');
  }finally{await host.close();}
});
