import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');

test('every repository JavaScript file parses with the current Node runtime',async()=>{
  const output=execFileSync(process.execPath,[path.join(root,'scripts','check-syntax.mjs')],{encoding:'utf8',cwd:root});
  const count=Number(/Syntax check passed for (\d+) JavaScript files\./u.exec(output)?.[1]);
  assert.ok(Number.isSafeInteger(count)&&count>80,output);
  const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  for(const entry of manifest.files.filter(value=>/\.(?:mjs|js|cjs)$/u.test(value))){
    await fs.access(path.join(root,entry));
  }
});
