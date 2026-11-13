import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveJsonPointer} from '../json-pointer.mjs';

test('JSON pointers select root, empty key and escaped slash and tilde once',()=>{
  const root={'':'empty','a/b':'slash','m~n':'tilde','~1':'literal'};
  for(const [pointer,value] of [['',root],['/','empty'],['/a~1b','slash'],['/m~0n','tilde'],['/~01','literal']])
    assert.deepEqual(resolveJsonPointer(root,pointer),{found:true,value});
});
test('JSON pointer traversal uses own members and never follows prototypes',()=>{
  const root=JSON.parse('{"__proto__":"own"}');
  assert.deepEqual(resolveJsonPointer(root,'/__proto__'),{found:true,value:'own'});
  for(const pointer of ['/constructor','/toString'])assert.deepEqual(resolveJsonPointer(root,pointer),{found:false});
});
test('JSON pointer array indices are canonical and numeric object keys remain usable',()=>{
  const root={list:['zero','one'],'01':'object-key'};
  assert.deepEqual(resolveJsonPointer(root,'/list/0'),{found:true,value:'zero'});
  assert.deepEqual(resolveJsonPointer(root,'/01'),{found:true,value:'object-key'});
  for(const pointer of ['/list/01','/list/-','/list/9007199254740992','/list/2','/list/0/x'])
    assert.deepEqual(resolveJsonPointer(root,pointer),{found:false});
});
test('JSON pointer distinguishes a null value from a missing member',()=>{
  assert.deepEqual(resolveJsonPointer({nil:null},'/nil'),{found:true,value:null});
  for(const pointer of ['/absent','/nil/x'])assert.deepEqual(resolveJsonPointer({nil:null},pointer),{found:false});
  assert.deepEqual(resolveJsonPointer(null,''),{found:true,value:null});
  assert.deepEqual(resolveJsonPointer(null,'/x'),{found:false});
});
test('JSON pointer rejects invalid syntax before even traversing a missing branch',()=>{
  for(const pointer of [null,'a','/a~2','/a~',`/${'x'.repeat(2048)}`,`/${Array(65).fill('x').join('/')}`,'/missing/~x'])
    assert.throws(()=>resolveJsonPointer({},pointer),{code:'INVALID_JSON_POINTER',message:'Invalid JSON pointer'});
});
