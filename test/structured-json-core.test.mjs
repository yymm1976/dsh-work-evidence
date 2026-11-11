import test from 'node:test';
import assert from 'node:assert/strict';
import {queryStructuredJson} from '../structured-json-core.mjs';

test('JSON selections distinguish missing, null, exact containers and type mismatch',()=>{
  const query=(pointer,op='value')=>({pointer,op});
  const result=queryStructuredJson('{"nil":null,"items":[1,2,3],"obj":{"a":1}}',[
    query('/nil'),query('/missing'),query('/items','count'),query('/obj','count'),query('/items','keys')]);
  assert.deepEqual(result.results[0],{pointer:'/nil',op:'value',found:true,status:'selected',type:'null',value:null,complete:true});
  assert.equal(result.results[1].status,'missing');assert.equal(result.results[2].count,3);assert.equal(result.results[3].count,1);
  assert.equal(result.results[4].status,'type-mismatch');
});
test('JSON array and object-key pages preserve total and remaining coverage',()=>{
  const result=queryStructuredJson('{"items":[10,20,30,40],"obj":{"z":0,"2":2,"a":1}}',[
    {pointer:'/items',op:'page',offset:1,limit:2},{pointer:'/obj',op:'keys',limit:2},{pointer:'/items',op:'page',offset:100}]);
  assert.deepEqual(result.results[0].value,[20,30]);assert.equal(result.results[0].total,4);assert.equal(result.results[0].hasMore,true);
  assert.deepEqual(result.results[1].value,['2','z']);assert.deepEqual(result.results[2].value,[]);assert.equal(result.results[2].hasMore,false);
});
test('JSON parse semantics are explicit and unsafe numeric IDs are rejected',()=>{
  const result=queryStructuredJson('\uFEFF{"key":1,"key":2}',[{pointer:'/key',op:'value'}]);
  assert.equal(result.bom,true);assert.equal(result.results[0].value,2);assert.match(result.semantics.objectKeys,/last duplicate wins/);
  for(const source of ['9007199254740993','1e400','{"id":-9007199254740992}'])
    assert.throws(()=>queryStructuredJson(source,[{pointer:'',op:'value'}]),{code:'JSON_NUMBER_UNSAFE'});
});
test('malformed JSON errors never echo source data and JSONL reports the physical line',()=>{
  assert.throws(()=>queryStructuredJson('{secret', [{pointer:'',op:'value'}]),{message:'The source is not valid JSON.',code:'JSON_PARSE_ERROR'});
  assert.throws(()=>queryStructuredJson('1\r\n\r\n{"secret":', [{pointer:'',op:'count'}],{format:'jsonl'}),{code:'JSON_PARSE_ERROR',physicalLine:3});
  const result=queryStructuredJson('\uFEFF\n{"x":1}\r\n\nnull\r\n',[{pointer:'/0/x',op:'value'},{pointer:'/1',op:'value'}],{format:'jsonl'});
  assert.equal(result.records,2);assert.equal(result.results[0].value,1);assert.equal(result.results[1].value,null);
  assert.equal(result.results[0].recordPhysicalLine,2);assert.equal(result.results[1].recordPhysicalLine,4);
  for(const character of ['\u00A0','\uFEFF','\v'])assert.throws(()=>queryStructuredJson('\n'+character+'\n{"x":1}',[{pointer:'/0',op:'value'}],{format:'jsonl'}),{code:'JSON_PARSE_ERROR',physicalLine:2});
  assert.equal(queryStructuredJson('',[{pointer:'',op:'count'}],{format:'jsonl'}).results[0].count,0);
});
test('oversize selected values return an explicitly incomplete serialized preview',()=>{
  const value=queryStructuredJson(JSON.stringify({text:'x'.repeat(400)}),[{pointer:'',op:'value'}],{maxValueChars:256}).results[0];
  assert.equal(value.complete,false);assert.equal(value.value,undefined);assert.equal(value.serializedPreview.length,256);assert.ok(value.serializedChars>256);
});

test('a shallow JSON selection survives an unrelated deeply nested subtree',()=>{
  const nested='['.repeat(10000)+'0'+']'.repeat(10000),source='{"answer":42,"nested":'+nested+'}';
  assert.equal(queryStructuredJson(source,[{pointer:'/answer',op:'value'}]).results[0].value,42);
  assert.throws(()=>queryStructuredJson(source.replace(/0\]/u,'1e400]'),[{pointer:'/answer',op:'value'}]),{code:'JSON_NUMBER_UNSAFE'});
});
test('all selector syntax and input limits are checked even for missing data',()=>{
  for(const selectors of [[],[{pointer:'',op:'eval'}],[{pointer:'/missing/~2',op:'value'}],[{pointer:'',op:'value',offset:0}],[{pointer:'',op:'page',limit:0}],[{pointer:'',op:'keys',extra:true}]])
    assert.throws(()=>queryStructuredJson('{}',selectors));
  assert.throws(()=>queryStructuredJson('x'.repeat(2_097_153),[{pointer:'',op:'value'}]),{code:'JSON_INPUT_LIMIT'});
  assert.throws(()=>queryStructuredJson('{}',[{pointer:'',op:'value'}],{format:'csv'}),{code:'INVALID_JSON_OPTIONS'});
});
