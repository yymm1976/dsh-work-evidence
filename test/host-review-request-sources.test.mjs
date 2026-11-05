import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool} from './helpers/host.mjs';
import {scopeReviewSources} from '../quality-review.mjs';

const definition='# README\n\n## Behavior rules\nKeep the first newline style. ORIGINAL_REQUEST_RULE\n\n## Examples\nEXAMPLE_SECTION_NOT_REQUIRED\n';
const request='遵守 README.md 中的“Behavior rules”，修改 core.mjs 并说明结果。';

async function capture({content=definition,limit=100,quoted=true,rewrite=false,secondSection=false}={}){
  let payload;
  const script=[tool('read',{file_path:'README.md',offset:1,limit})];
  if(rewrite)script.push(tool('write',{file_path:'README.md',content:definition.replace('ORIGINAL_REQUEST_RULE','LATER_ASSISTANT_REWRITE')}),
    tool('read',{file_path:'README.md'}));
  script.push(tool('write',{file_path:'core.mjs',content:'export const answer = 42;\n'}),text('修改已完成，读取结果已用于交付。'));
  const host=await startHost({workspace:{qualityReview:true},script:(_options,n)=>[script[n-1]??text('完成。')],auxiliary:options=>{
    payload=JSON.parse(options.messages[0].content[0].text);return [text('{"issues":[]}')];
  }});
  try{
    await fs.writeFile(path.join(host.cwd,'README.md'),content,'utf8');
    const agent=await host.createAgent('ultra');
    const input=quoted?(secondSection?request+' 同时参考“Examples”。':request):'读取 README.md，再修改 core.mjs 并补充用法。';
    await host.send(agent,input);assert.ok(payload);
    const reads=host.events.filter(event=>event.type==='tool/call'&&event.data.name==='read');
    assert.equal(reads.length,rewrite?2:1,'Review assembly must not perform an additional source read.');
    return {payload,reads,events:host.events,cwd:host.cwd};
  }finally{await host.close();}
}

test('review preserves the complete section explicitly named by the user and its source address',async()=>{
  const {payload,events}=await capture();
  assert.equal(payload.requestSources.length,1);
  const source=payload.requestSources[0];assert.equal(source.heading,'Behavior rules');
  assert.equal(source.requestSeq,payload.request.seq);assert.equal(source.startLine,3);assert.equal(source.endLine,5);
  const original=events.find(event=>event.seq===source.seq);assert.equal(original.type,'tool/result');
  const evidence=payload.evidence.find(item=>item.seq===source.seq);
  assert.ok(evidence.data.includes('ORIGINAL_REQUEST_RULE'));assert.ok(!evidence.data.includes('EXAMPLE_SECTION_NOT_REQUIRED'));
  assert.deepEqual(evidence.sourceFiles,[source.path]);
});

test('merely requesting a README update and incomplete or clipped sections do not become requirement sources',async()=>{
  const plain=await capture({quoted:false});assert.deepEqual(plain.payload.requestSources,[]);
  const partial=await capture({limit:4});assert.deepEqual(partial.payload.requestSources,[]);
  const clipped=await capture({content:definition.replace('ORIGINAL_REQUEST_RULE','X'.repeat(3000))});
  assert.deepEqual(clipped.payload.requestSources,[]);
});

test('an assistant rewrite does not replace the earlier definition referenced by the user',async()=>{
  const {payload,events}=await capture({rewrite:true});assert.equal(payload.requestSources.length,1);
  const source=payload.requestSources[0],rewrite=events.find(event=>event.type==='tool/call'&&event.data.name==='write'&&
    JSON.parse(event.data.arguments).file_path==='README.md');
  assert.ok(source.seq<rewrite.seq);
  assert.ok(payload.evidence.find(item=>item.seq===source.seq).data.includes('ORIGINAL_REQUEST_RULE'));
  assert.ok(!payload.evidence.find(item=>item.seq===source.seq).data.includes('LATER_ASSISTANT_REWRITE'));
});

test('two requested sections in one observation keep both excerpts at that original event',async()=>{
  const {payload}=await capture({secondSection:true});assert.equal(payload.requestSources.length,2);
  const [first,second]=payload.requestSources;assert.equal(first.seq,second.seq);
  const body=payload.evidence.find(item=>item.seq===first.seq).data;
  assert.ok(body.includes('ORIGINAL_REQUEST_RULE'));assert.ok(body.includes('EXAMPLE_SECTION_NOT_REQUIRED'));
});

test('a heading inside a code fence is excluded and duplicate actual headings remain ambiguous',async()=>{
  const fenced=await capture({content:'# README\n\n```md\n## Behavior rules\nCODE_EXAMPLE_NOT_A_DEFINITION\n```\n\n'+definition});
  assert.equal(fenced.payload.requestSources.length,1);
  const source=fenced.payload.requestSources[0],body=fenced.payload.evidence.find(item=>item.seq===source.seq).data;
  assert.ok(body.includes('ORIGINAL_REQUEST_RULE'));assert.ok(!body.includes('CODE_EXAMPLE_NOT_A_DEFINITION'));
  const duplicate=await capture({content:definition+'\n## Behavior rules\nCONFLICTING_SECOND_DEFINITION\n'});
  assert.deepEqual(duplicate.payload.requestSources,[]);
});

test('focused source review retains a referenced requirement from an otherwise omitted document',()=>{
  const payload={requestSources:[{seq:2,path:'README.md',heading:'Behavior rules'}],observed:{
    mutation:{seq:8},artifacts:[{seq:8,path:'core.mjs',effectState:'applied'},{seq:9,path:'README.md',effectState:'applied'}],
    executions:[],unresolvedErrors:[],pendingJobEvents:[]},evidence:[
    {seq:2,type:'tool/result',data:'ORIGINAL_REQUEST_RULE'},
    {seq:8,type:'tool/result',sourceFiles:['core.mjs'],data:'source detail\n'.repeat(2500)},
    {seq:9,type:'tool/result',sourceFiles:['README.md'],data:'unrelated examples\n'.repeat(2500)},
  ]};
  const result=scopeReviewSources(payload,process.cwd(),'auto');assert.equal(result.sourceReview.mode,'focused');
  assert.deepEqual(result.sourceReview.requestSourceFiles,['README.md']);
  assert.ok(result.evidence.some(item=>item.seq===2&&item.data==='ORIGINAL_REQUEST_RULE'));
  assert.ok(!result.evidence.some(item=>item.seq===9));
});

test('focused review prefers application source to a later check script while preserving exact completion facts',()=>{
  const payload={observed:{mutation:{seq:9},artifacts:[{seq:8,path:'src/main.py',effectState:'applied'},
    {seq:9,path:'tools/check_main.py',effectState:'applied'}],executions:[{seq:12,completionObservation:{seq:11,registrationSeq:10}}],
    unresolvedErrors:[],pendingJobEvents:[]},evidence:[
    {seq:7,type:'tool/result',sourceFiles:['tools/check_main.py'],data:'older checks\n'.repeat(2000)},
    {seq:8,type:'tool/result',sourceFiles:['src/main.py'],data:'implementation\n'.repeat(2000)},
    {seq:9,type:'tool/result',sourceFiles:['tools/check_main.py'],data:'checks\n'.repeat(3000)},
    {seq:10,type:'job/registered',data:'registered'},
    {seq:11,type:'job/settled',data:'exit code: 0'},
    {seq:12,type:'tool/result',data:'OK'},
  ]};
  const result=scopeReviewSources(payload,process.cwd(),'auto');
  assert.equal(result.sourceReview.mode,'focused');assert.deepEqual(result.sourceReview.files,['src/main.py']);
  assert.ok(result.evidence.some(item=>item.seq===8));
  assert.ok(result.evidence.some(item=>item.seq===10));assert.ok(result.evidence.some(item=>item.seq===11));
  assert.ok(result.evidence.some(item=>item.seq===7),'Recorded check reads remain with the check script.');
  assert.ok(result.evidence.some(item=>item.seq===9));
  assert.deepEqual(result.sourceReview.omittedFiles,[]);
});
