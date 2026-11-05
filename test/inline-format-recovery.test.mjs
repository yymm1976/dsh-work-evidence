import test from 'node:test';
import assert from 'node:assert/strict';
import {inlineFormatRecovery} from '../inline-exec.mjs';
const failure={exitCode:1,stderr:{text:'file:///[eval1]:1\nconst fs=require("node:fs");\nReferenceError: require is not defined in ES module scope, you can use import instead\n    at file:///[eval1]:1:10'}};
test('CommonJS advice preserves explicit format, ESM syntax and incomplete execution boundaries',()=>{
  const script={runtime:'node',code:'const fs=require("node:fs"); console.log(42);'};
  assert.deepEqual(inlineFormatRecovery(script,failure,'ref').arguments,{scriptRef:'ref',format:'commonjs'});
  for(const input of [{...script,format:'module'},{...script,format:'commonjs'},{...script,code:'import fs from "node:fs"; require("node:assert");'},
    {...script,code:'await Promise.resolve(); require("node:assert");'},{...script,runtime:'python'}])assert.equal(inlineFormatRecovery(input,failure,'ref'),null);
  for(const value of [{...failure,exitCode:0},{...failure,truncated:true},{...failure,aborted:true},{...failure,complete:false},
    {...failure,stderr:'file:///[eval1]:1\nTypeError: unrelated exception'}])assert.equal(inlineFormatRecovery(script,value,'ref'),null);
  assert.equal(inlineFormatRecovery(script,failure,null),null);
  assert.equal(inlineFormatRecovery({...script,code:'import("./dependent-module.js");'},failure,'ref'),null);
});
