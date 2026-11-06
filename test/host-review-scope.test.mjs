import test from 'node:test';
import assert from 'node:assert/strict';
import {startHost,text,tool} from './helpers/host.mjs';

const source='export const SELECTED_SOURCE_BRANCH = true;\n/*\n'+'source detail\n'.repeat(500)+'*/\n';
const docs='# OMITTED_DOC_SOURCE\n'+'usage detail\n'.repeat(750);

async function exercise(mode,invalidCitation=false){
  let payload;const host=await startHost({workspace:{qualityReview:true,qualityReviewScope:mode},script:(_options,n)=>{
    if(n===1)return [tool('write',{file_path:'core.mjs',content:source})];
    if(n===2)return [tool('write',{file_path:'README.md',content:docs})];
    if(n===3)return [tool('read',{file_path:'core.mjs'})];
    if(n===4)return [tool('read',{file_path:'README.md'})];
    return [text('源码与说明已写入并读取。')];
  },auxiliary:options=>{
    payload=JSON.parse(options.messages[0].content[0].text);
    if(invalidCitation){
      const omitted=host.events.findLast(event=>event.type==='tool/result');
      assert.ok(!payload.evidence.some(item=>item.seq===omitted.seq));
      return [text(JSON.stringify({issues:[{kind:'unsupported-success',detail:'An omitted event must not become evidence.',evidence:[payload.answer.seq,omitted.seq]}]}))];
    }
    return [text('{"issues":[]}')];
  }});
  try{
    const agent=await host.createAgent('ultra');await host.send(agent,'写入 core.mjs 和 README.md，再读取并说明结果。');
    assert.ok(payload);const {qualityReview}=await host.command(agent,'detail');
    assert.equal(qualityReview.sourceReview.configured,mode);
    const scopeFeature=(await host.command(agent,'feature qualityReviewScope')).features[0];
    assert.equal(scopeFeature.effect.status,'applied');assert.equal(scopeFeature.effect.lastReason,'review-options-selected');
    assert.deepEqual(qualityReview.sourceReview.last,payload.sourceReview);
    assert.ok(payload.evidence.some(item=>item.data.includes('SELECTED_SOURCE_BRANCH')));
    if(invalidCitation){assert.equal(qualityReview.status,'paused');assert.equal(qualityReview.process.last.reason,'invalid-review-result');}
    else assert.equal(qualityReview.status,'clean');
    if(mode==='auto'){
      assert.equal(payload.sourceReview.mode,'focused');assert.ok(payload.sourceReview.files[0].endsWith('core.mjs'));
      assert.ok(payload.evidence.some(item=>item.sourceFiles?.some(file=>file.endsWith('core.mjs'))&&item.data.includes('SELECTED_SOURCE_BRANCH')),
        'Native rendered reads retain their file identity when source scope changes.');
      assert.ok(payload.sourceReview.omittedFiles[0].endsWith('README.md'));
      assert.ok(payload.evidence.some(item=>item.seq===payload.observed.mutation.seq),'The latest observed modification remains available.');
    }else{
      assert.equal(payload.sourceReview.mode,'all-supplied');assert.equal(payload.sourceReview.files.length,2);
      assert.deepEqual(payload.sourceReview.omittedFiles,[]);assert.ok(payload.evidence.some(item=>item.data.includes('OMITTED_DOC_SOURCE')));
    }
    return JSON.stringify(payload).length;
  }finally{await host.close();}
}

test('large source review states its narrowed file scope and full mode preserves both files',async()=>{
  const focused=await exercise('auto'),full=await exercise('full');assert.ok(focused<full);
});

test('a scoped review cannot cite an observation that was not supplied to its model',async()=>{
  await exercise('auto',true);
});
