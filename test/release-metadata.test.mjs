import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {VERSION} from '../runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');

test('package, runtime and release documentation identify the same stable version',async()=>{
  const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(manifest.version,'1.1.1');
  assert.equal(VERSION,manifest.version);
  assert.match(manifest.version,/^\d+\.\d+\.\d+$/u);
  const readme=await fs.readFile(path.join(root,'README.md'),'utf8');
  assert.match(readme,/1\.1\.0/u);
  for(const file of ['RELEASE-NOTES-1.1.1.md','MIGRATION-1.1.1.md','ROLLBACK-1.1.1.md','RELEASE-GATES-1.1.1.md',
    'FEATURE-CONTROL-MATRIX-1.1.1.md','OPTIMIZATION-REGISTER-1.1.1.md','DEFECT-LEDGER-1.1.1.md','coderabbit-review-ledger.md']){
    assert.ok(manifest.files.includes(file),file);
    await fs.access(path.join(root,file));
  }
  assert.equal(manifest.dependencies.fflate,'^0.8.3');
});
