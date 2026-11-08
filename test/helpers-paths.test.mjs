import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const helper=pathToFileURL(path.resolve(import.meta.dirname,'helpers','paths.mjs')).href;

const read=env=>spawnSync(process.execPath,['-e',`import(${JSON.stringify(helper)}).then(module=>{process.stdout.write([module.DSH_APP,module.DSH_PROFILE,module.DSH_PYTHON].join('\\n'))})`],
  {encoding:'utf8',env:{...process.env,...env}});

test('bare Python executable overrides keep PATH lookup semantics',()=>{
  const result=read({DSH_TEST_PYTHON:'python.exe',DSH_APP:'',DSH_PROFILE:''});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.split('\n')[2],'python.exe');
});

test('relative path overrides resolve while absolute paths remain stable',()=>{
  const result=read({DSH_TEST_PYTHON:'./python.exe',DSH_APP:'./host',DSH_PROFILE:'./profile'});
  assert.equal(result.status,0,result.stderr);
  const [app,profile,python]=result.stdout.split('\n');
  assert.equal(app,path.resolve('host'));
  assert.equal(profile,path.resolve('profile'));
  assert.equal(python,path.resolve('python.exe'));
});
