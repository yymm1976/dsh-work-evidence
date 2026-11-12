import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createVerifiedExec} from '../verified-exec.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
async function fixture(body,validation={status:'completed',exitCode:0,stdout:{text:'PASS: complete'}}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'verified-boundary-'));
  await fs.writeFile(path.join(root,'source.txt'),body);
  const record={root,dir:path.join(root,'.dsh'),id:'boundary',config:{},metrics:{verifiedExecDeopts:0,verifiedExecPreviews:0,verifiedExecApplies:0,verifiedExecPartial:0,verifiedExecValidationFailures:0}};
  let writes=0;
  const runtime={init:async()=>record,save:async()=>{},execFor:()=>({})};
  const service=createVerifiedExec({on(){},tools:{get:name=>['ops_stat','ops_edit_file','pwsh'].includes(name)?{name}:null}},runtime,async(name,args)=>{
    const text=await fs.readFile(path.join(root,'source.txt'),'utf8');
    if(name==='ops_stat')return {value:{status:'completed',exists:true,revision:hash(text),bytes:Buffer.byteLength(text)},isError:false};
    if(name==='ops_edit_file'){
      assert.equal(args.expectedRevision,hash(text));let after=text;
      for(const edit of args.edits)after=after.replace(edit.oldText,edit.newText);
      await fs.writeFile(path.join(root,'source.txt'),after);writes++;
      return {isError:false,value:{status:'completed',data:{revision:hash(after),bytes:Buffer.byteLength(after),changed:true}}};
    }
    if(name==='pwsh')return {isError:false,value:validation};
    throw new Error('Unexpected tool '+name);
  });
  return {root,service,writes:()=>writes,close:()=>fs.rm(root,{recursive:true,force:true})};
}

test('verified edits reject overlapping occurrences in preview and apply before mutation',async()=>{
  for(const apply of [false,true]){
    const f=await fixture('aaa');
    try{
      const result=await f.service.execute({}, {summary:'Require one unambiguous match',apply,edits:[{file:'source.txt',mode:'replace_exact',old_text:'aa',new_text:'bb'}]},AbortSignal.timeout(10000));
      assert.equal(result.status,'deopt');assert.equal(result.reason,'edit-target-not-unique');
      assert.equal(f.writes(),0);assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'aaa');
    }finally{await f.close();}
  }
});

test('verified validation retains an explicit failed check even when its process exits zero',async()=>{
  const f=await fixture('before',{status:'completed',exitCode:0,stdout:{text:"FAILURES: ['case']"},stderr:{text:''}});
  try{
    const result=await f.service.execute({}, {summary:'Retain the real validation outcome',apply:true,
      edits:[{file:'source.txt',mode:'replace_exact',old_text:'before',new_text:'after'}],validations:[{command:'requested-check',description:'Check the explicit result',tool:'pwsh'}]},AbortSignal.timeout(10000));
    assert.equal(result.status,'partial');assert.equal(result.reason,'validation-failed');assert.equal(result.effectState,'applied');
    assert.equal(result.validation.passed,false);assert.equal(result.validation.reportedChecks.status,'reported-failed');
    assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'after');
  }finally{await f.close();}
});

test('incomplete zero-exit validation cannot certify an applied edit',async()=>{
  for(const flag of [{partial:true},{outputPartial:true},{lossy:true},{complete:false},{signal:'SIGTERM'},{stopped:true}]){
    const f=await fixture('before',{status:'completed',exitCode:0,stdout:{text:'PASS: first case'},...flag});
    try{
      const result=await f.service.execute({}, {summary:'Keep incomplete validation inconclusive',apply:true,
        edits:[{file:'source.txt',mode:'replace_exact',old_text:'before',new_text:'after'}],validations:[{command:'requested-check',description:'Check all output',tool:'pwsh'}]},AbortSignal.timeout(10000));
      assert.equal(result.status,'partial',JSON.stringify(flag));assert.equal(result.validation.passed,false);
    }finally{await f.close();}
  }
});
