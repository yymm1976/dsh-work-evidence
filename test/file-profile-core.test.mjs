import test from 'node:test';
import assert from 'node:assert/strict';
import {createFileProfile} from '../file-profile-core.mjs';

function profile(chunks,options={}){const value=createFileProfile(options);for(const chunk of chunks)value.push(chunk);return value.finish();}

test('empty data and trailing newlines do not create a spurious final record',()=>{
  assert.equal(profile([],{format:'csv'}).physicalLines,0);assert.equal(profile([],{format:'csv'}).csv.records,0);
  for(const [text,lines,records,fields]of [['a,b',1,1,2],['a,b\n',1,1,2],['\n',1,1,1],['\n\n',2,2,1],[',',1,1,2],['""',1,1,1]]){
    const value=profile([text],{format:'csv'});assert.equal(value.physicalLines,lines,text);assert.equal(value.csv.records,records,text);
    assert.equal(value.csv.minFields,fields,text);assert.equal(value.csv.valid,true,text);
  }
});

test('quoted multiline records, escaped quotes and split CRLF retain independent physical and CSV counts',()=>{
  const source='a,"b\nc"\r\nx,y\n';
  const value=profile(source.split(''),{format:'csv',sampleLines:1});
  assert.equal(value.utf16Units,13);assert.equal(value.physicalLines,3);assert.deepEqual(value.newlines,{crlf:1,lf:2,cr:0});
  assert.deepEqual(value.ascii,{spaces:0,tabs:0,uppercase:0,lowercase:5,digits:0,nul:0});
  assert.equal(value.csv.records,2);assert.equal(value.csv.valid,true);assert.deepEqual(value.csv.fieldCounts,[{fields:2,count:2}]);
  assert.equal(value.head[0].text,'a,"b');assert.equal(value.tail[0].line,3);assert.equal(value.tail[0].text,'x,y');
  const escaped=profile(['"a"','"b";c\r','\n"d";e'],{format:'csv',delimiter:';'});
  assert.equal(escaped.csv.valid,true);assert.equal(escaped.csv.records,2);assert.deepEqual(escaped.csv.fieldCounts,[{fields:2,count:2}]);
});

test('lone carriage returns, blank rows, tabs and a BOM retain their distinct meanings',()=>{
  const value=profile(['\uFEFFa\tb\r','\nc\td\r','\re\tf'],{format:'csv',delimiter:'\t'});
  assert.equal(value.physicalLines,4);assert.deepEqual(value.newlines,{crlf:1,lf:0,cr:2});assert.equal(value.ascii.tabs,3);
  assert.equal(value.csv.valid,true);assert.equal(value.csv.records,4);assert.deepEqual(value.csv.fieldCounts,[{fields:1,count:1},{fields:2,count:3}]);
  assert.equal(profile(['\uFEFF'],{format:'csv'}).csv.records,0);
});

test('invalid CSV is reported with its first source offset and does not count the invalid record',()=>{
  for(const [source,code,offset]of [['a"b','quote-inside-unquoted-field',1],['"a" b','content-after-closing-quote',3],['"a','unterminated-quoted-field',2]]){
    const value=profile(source.split(''),{format:'csv'}).csv;assert.equal(value.valid,false);assert.equal(value.records,0);
    assert.deepEqual(value.error,{code,offsetUtf16:offset});assert.equal(value.scope,'complete-records-before-first-error');
  }
  assert.equal(profile(['ok\n"bad'],{format:'csv'}).csv.records,1);
});

test('field-shape overflow remains counted and does not claim a complete histogram',()=>{
  const value=profile(['a\na,b\na,b,c\na,b,c\nz\n'],{format:'csv',maxFieldShapes:2}).csv;
  assert.equal(value.records,5);assert.equal(value.minFields,1);assert.equal(value.maxFields,3);
  assert.deepEqual(value.fieldCounts,[{fields:1,count:2},{fields:2,count:1}]);assert.equal(value.overflowRecords,2);
  assert.equal(value.fieldCountDistributionComplete,false);
});

test('bounded previews preserve valid surrogate pairs across chunk boundaries',()=>{
  const value=profile(['A\uD83D','\uDE00long\nZ\nlast'],{sampleLines:1,maxSampleLineChars:2});
  assert.deepEqual(value.head,[{line:1,text:'A',utf16Units:7,truncated:true}]);
  assert.deepEqual(value.tail,[{line:3,text:'la',utf16Units:4,truncated:true}]);assert.equal(value.physicalLines,3);
});

test('analysis is invariant at each single split point and finish has an explicit lifecycle',()=>{
  const text='a,"x""y"\r\nb,c\rd,e\n';
  for(let index=0;index<=text.length;index++){
    const value=profile([text.slice(0,index),text.slice(index)],{format:'csv'});
    assert.equal(value.csv.records,3);assert.equal(value.csv.valid,true);assert.deepEqual(value.newlines,{crlf:1,lf:1,cr:1});
    assert.deepEqual(value.csv.fieldCounts,[{fields:2,count:3}]);
  }
  const parser=createFileProfile();parser.push('one');const value=parser.finish();assert.equal(parser.finish(),value);
  assert.throws(()=>parser.push('two'),/finished/);
});

test('invalid options and non-text chunks are rejected before analysis',()=>{
  for(const options of [null,[],{format:'json'},{delimiter:'::'},{delimiter:'"'},{delimiter:'\uFEFF'},{sampleLines:17},{maxSampleLineChars:0},{maxFieldShapes:0}])assert.throws(()=>createFileProfile(options));
  assert.throws(()=>createFileProfile().push(Buffer.from('a')),/Decoded text/);
  assert.deepEqual(profile(['long\nline'],{sampleLines:0}).head,[]);
});
