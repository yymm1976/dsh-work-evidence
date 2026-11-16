import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreStoredDefinitions} from '../ptc-fastpath.mjs';

const validDefinition=()=>({
  name:'list-readme',
  description:'List the project README with a glob.',
  inputs:[{name:'pattern',type:'string',required:true,description:'Glob pattern to run.'}],
  steps:[{id:'globbed',tool:'glob',arguments:{pattern:'README*'}}],
});

test('a stored store keeps its valid fast-paths when another entry names a removed tool',()=>{
  // A saved store can still contain tools that no longer exist. Rejecting the
  // whole store over one such entry would disable every valid fast-path, so the
  // restored set must drop only the unusable entries.
  const legacy={...validDefinition(),name:'list-readme-legacy',
    steps:[{id:'readFiles',tool:'ops_read_files',arguments:{paths:['README.md']}}]};
  const restored=restoreStoredDefinitions([validDefinition(),legacy]);
  assert.equal(restored.valid.length,1);
  assert.equal(restored.valid[0].name,'list-readme');
  assert.equal(restored.skipped.length,1);
  assert.equal(restored.skipped[0].name,'list-readme-legacy');
  assert.match(restored.skipped[0].reason,/read-only tool/u);
});

test('a stored store with only unusable entries yields an empty valid set instead of throwing',()=>{
  const restored=restoreStoredDefinitions([{name:'broken',description:'x',steps:[]},'not-an-object']);
  assert.deepEqual(restored.valid,[]);
  assert.equal(restored.skipped.length,2);
  assert.equal(restored.skipped[1].reason,'not-an-object');
});
