import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';

// The Flash1017 preset is the official PTC preset this plugin ships. Its rules
// live in flash-preset-rules.mjs and are rendered into the bundle by
// prepare-flash-preset.mjs; both the generator output and the mounted preset
// are checked here so a rule edit cannot silently miss the composition.

const repo=path.resolve(import.meta.dirname,'..');
const bundle=readFileSync(path.join(repo,'cordis.patch.yml'),'utf8');
const presetBlock=text=>/^    - id: preset-work-evidence-flash1017\r?\n([\s\S]*?)(?=^    - id: |$(?![\s\S]))/m.exec(text)?.[1];
const suffixBlock=preset=>/suffix: \|-\r?\n((?: {16}[^\r\n]*(?:\r?\n|$))+)/.exec(preset)?.[1];

test('the Flash1017 preset is composed from the native PTC preset and keeps native compaction',()=>{
  const preset=presetBlock(bundle);
  assert.ok(preset,'preset-work-evidence-flash1017 must be present in the bundle');
  assert.match(preset,/id: work-evidence-flash1017$/m);
  assert.match(preset,/name: 工程证据 · Flash1017/u);
  assert.match(preset,/@deepseek-ai\/dsh-compaction-basic/u,'native compaction must stay composed');
  // The route guard is what refuses a non-Flash model instead of silently swapping one.
  assert.match(preset,/work-evidence-flash1017-route/u);
  assert.match(preset,/@local\/dsh-work-evidence\/flash1017-preset/u);
});

test('every preset rule is rendered into the persona suffix verbatim',async()=>{
  const {FLASH_PRESET_RULES,FLASH_PRESET_SUFFIX}=await import('../flash-preset-rules.mjs');
  assert.equal(FLASH_PRESET_RULES.length,9);
  assert.equal(FLASH_PRESET_SUFFIX,FLASH_PRESET_RULES.join('\n'));
  const preset=presetBlock(bundle);
  const suffix=suffixBlock(preset);
  assert.ok(suffix,'the persona suffix must exist in the preset');
  const rendered=suffix.replaceAll('\r','').split('\n').filter(Boolean).map(line=>line.trim());
  assert.deepEqual(rendered,FLASH_PRESET_RULES);
});

test('the preset selectors accept a CRLF checkout',()=>{
  const crlf=bundle.replaceAll('\r\n','\n').replaceAll('\n','\r\n');
  const preset=presetBlock(crlf);
  assert.ok(preset,'the preset block is found with CRLF');
  assert.ok(suffixBlock(preset),'the suffix block is found with CRLF');
});

test('the route guard refuses a non-Flash model instead of swapping routes',async()=>{
  const preset=await import('../flash1017-preset.mjs');
  const handlers=[];
  const ctx={on:(name,handler)=>handlers.push({name,handler})};
  preset.apply(ctx);
  assert.equal(handlers.length,1,'the guard attaches exactly one request hook');
  const {handler,name}=handlers[0];
  assert.equal(name,'agent/request');

  const run=(choice,proposed)=>handler({agent:{session:{log:choice?[{type:'model/selection',data:choice}]:[]}}},async()=>proposed);
  const flash={provider:'magpie',model:'opencode-go/deepseek-v4.1-flash',reasoningEffort:'low'};

  // A recorded Flash selection keeps its route and gets max effort.
  assert.deepEqual(await run(flash,{...flash,reasoningEffort:'low'}),{...flash,reasoningEffort:'low'});
  // A recorded non-Flash selection is refused, not rewritten to Flash.
  await assert.rejects(()=>run({provider:'magpie',model:'group/qwen3.8flash'},{...flash}),error=>{
    assert.equal(error.code,'FLASH1017_ROUTE_REQUIRED');
    assert.match(error.message,/paired with a magpie DeepSeek V4\.1 Flash route/u);
    return true;
  });
  // With no recorded selection the proposed route is what gets checked.
  await assert.rejects(()=>run(null,{provider:'magpie',model:'qoder/ultimate'}),error=>error.code==='FLASH1017_ROUTE_REQUIRED');
  const noEffort=await run(null,{provider:'magpie',model:'workbuddy-ai/deepseek-v4.1-flash'});
  assert.equal(noEffort.reasoningEffort,'max','a missing effort is filled with max');
  for(const model of ['3/deepseek-v4-1-flash-1017','3/deepseek-v4_1-flash']){
    const selection={provider:'magpie',model};
    assert.deepEqual(await run(selection,flash),{...selection,reasoningEffort:'low'});
    assert.deepEqual(await run(null,selection),{...selection,reasoningEffort:'max'});
  }
});
