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
test('validation needs an observed zero exit and accepts both native exit fields',async()=>{
  for(const validation of [{status:'completed',stdout:{text:'finished'}},{status:'completed',exit_code:0,stdout:{text:'PASS: complete'}}]){
    const f=await fixture('before',validation);
    try{
      const result=await f.service.execute({}, {summary:'Use an actual process exit',apply:true,
        edits:[{file:'source.txt',mode:'replace_exact',old_text:'before',new_text:'after'}],validations:[{command:'requested-check',description:'Observe the exit',tool:'pwsh'}]},AbortSignal.timeout(10000));
      assert.equal(result.status,validation.exit_code===0?'validated':'partial');
      if(validation.exit_code===0)assert.equal(result.validations[0].exitCode,0);
    }finally{await f.close();}
  }
});

test('duplicate missing create targets through a directory alias reject before any tool dispatch',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'verified-create-alias-'));
  try{
    await fs.symlink(root,path.join(root,'alias'),process.platform==='win32'?'junction':'dir');
    const record={root,dir:path.join(root,'.dsh'),id:'alias-boundary',config:{},metrics:{verifiedExecDeopts:0}};
    let calls=0;
    const service=createVerifiedExec({on(){},tools:{get:()=>({})}},
      {init:async()=>record,save:async()=>{},execFor:()=>({})},async()=>{calls++;return {isError:false,value:{status:'completed',exists:false}};});
    for(const file of ['new.txt','missing/nested/new.txt'])for(const apply of [false,true]){
      const result=await service.execute({}, {summary:'Reject duplicate creates before writes',apply,edits:[
        {file,mode:'create',content:'first'},{file:'alias/'+file,mode:'create',content:'second'}]},AbortSignal.timeout(10000));
      assert.equal(result.status,'deopt');assert.equal(result.reason,'invalid-plan');
      assert.match(result.error,/More than one create operation/u);assert.equal(result.effectState,'none');
      assert.equal(calls,0);await assert.rejects(fs.stat(path.join(root,file)),error=>error.code==='ENOENT');
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('missing-target case aliases follow the actual directory and an unknown empty directory cannot certify distinctness',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'verified-case-volume-'));
  try{
    await fs.writeFile(path.join(root,'case-probe.txt'),'probe');
    const caseSensitive=await fs.lstat(path.join(root,'CASE-PROBE.txt')).then(()=>false,error=>{if(error.code!=='ENOENT')throw error;return true;});
    const record={root,dir:path.join(root,'.dsh'),id:'volume-boundary',config:{},metrics:{verifiedExecDeopts:0,verifiedExecPreviews:0}};
    const service=createVerifiedExec({on(){},tools:{get:()=>({})}},
      {init:async()=>record,save:async()=>{},execFor:()=>({})},async()=>({isError:false,value:{status:'completed',exists:false}}));
    const plan={summary:'Resolve the directory case behavior',edits:[{file:'new.txt',mode:'create',content:'one'},{file:'NEW.txt',mode:'create',content:'two'}]};
    const result=await service.execute({},plan,AbortSignal.timeout(10000));
    assert.equal(result.status,caseSensitive?'previewed':'deopt');
    if(caseSensitive)assert.equal(result.files.length,2);else assert.match(result.error,/More than one create operation/u);
    if(caseSensitive){
      await fs.mkdir(path.join(root,'hardlink-names'));await fs.writeFile(path.join(root,'hardlink-names','a'),'same inode');
      await fs.link(path.join(root,'hardlink-names','a'),path.join(root,'hardlink-names','A'));
      const linked=await service.execute({}, {...plan,edits:plan.edits.map(edit=>({...edit,file:'hardlink-names/'+edit.file}))},AbortSignal.timeout(10000));
      assert.equal(linked.status,'previewed');assert.equal(linked.files.length,2,'exact case-distinct hard-link entries do not imply a case-insensitive directory');
    }
    await fs.mkdir(path.join(root,'empty'));
    const uncertain=await service.execute({}, {...plan,apply:true,edits:plan.edits.map(edit=>({...edit,file:'empty/'+edit.file}))},AbortSignal.timeout(10000));
    assert.equal(uncertain.status,'deopt');assert.match(uncertain.error,/Cannot establish/u);assert.equal(uncertain.effectState,'none');
    assert.deepEqual(await fs.readdir(path.join(root,'empty')),[]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
