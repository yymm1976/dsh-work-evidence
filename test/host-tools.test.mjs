import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {crc32} from 'node:zlib';
import {startHost,text,tool} from './helpers/host.mjs';

const full={toolSurface:'full'};

function buildZip(entries){
  const localParts=[];
  const centralParts=[];
  let offset=0;

  for(const item of entries){
    const name=Buffer.from(item.name,'utf8');
    const source=Buffer.from(item.data);
    const checksum=crc32(source);
    const flags=0x0800;

    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt16LE(flags,6);
    local.writeUInt16LE(0,8);
    local.writeUInt32LE(checksum,14);
    local.writeUInt32LE(source.length,18);
    local.writeUInt32LE(source.length,22);
    local.writeUInt16LE(name.length,26);
    localParts.push(local,name,source);

    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);
    central.writeUInt16LE(20,4);
    central.writeUInt16LE(20,6);
    central.writeUInt16LE(flags,8);
    central.writeUInt16LE(0,10);
    central.writeUInt32LE(checksum,16);
    central.writeUInt32LE(source.length,20);
    central.writeUInt32LE(source.length,24);
    central.writeUInt16LE(name.length,28);
    central.writeUInt32LE(offset,42);
    centralParts.push(central,name);

    offset+=local.length+name.length+source.length;
  }

  const centralDirectory=Buffer.concat(centralParts);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(centralDirectory.length,12);
  end.writeUInt32LE(offset,16);
  return Buffer.concat([...localParts,centralDirectory,end]);
}

async function writeFile(root,file,content){
  const target=path.join(root,file);
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,content);
}

function resultOf(event){
  const text=event.data?.message?.content?.map(block=>block.text??'').join('')??'';
  let json;
  try{json=JSON.parse(text);}catch{}
  return {isError:event.data?.message?.isError===true,text,json};
}

function results(host){
  return host.events.filter(event=>event.type==='tool/result').map(resultOf);
}

function lastResult(host){
  return results(host).at(-1);
}

function scripted(tasks){
  return (_options,n)=>tasks[n-1]??[text('Done.')];
}

async function withHost(t,options,run){
  const host=await startHost({workspace:full,...options});
  try{await run(host);}finally{await host.close();}
}

test('project_evidence entry and locate return the manifest, main entry and source windows', async t=>{
  await withHost(t,{
    script:scripted([
      [tool('project_evidence',{mode:'entry'})],
      [tool('project_evidence',{mode:'locate',query:'WidgetMarker'})],
      [tool('project_evidence',{mode:'locate',query:'UNIQUE_NEEDLE_42'})],
    ]),
  },async host=>{
    await writeFile(host.cwd,'package.json',JSON.stringify({
      name:'entry-fixture',
      version:'1.0.0',
      main:'src/main.js',
      scripts:{start:'node src/main.js',check:'node --check src/main.js'},
    },null,2));
    await writeFile(host.cwd,'src/main.js','export const entry = true;\n');
    await writeFile(host.cwd,'src/WidgetMarker.js','export class WidgetMarker {\n  value = 1;\n}\n');
    await writeFile(host.cwd,'src/util.js','export function helper(){\n  return "UNIQUE_NEEDLE_42";\n}\n');

    const agent=await host.createAgent('max');
    await host.send(agent,'Inspect the project entry and symbols.');
    const [entry,byName,byLiteral]=results(host);

    assert.equal(entry.isError,false,entry.text);
    assert.equal(entry.json.kind,'node');
    assert.deepEqual(entry.json.declaredScripts,{start:'node src/main.js',check:'node --check src/main.js'});
    assert.ok(entry.json.sources.some(source=>source.path.endsWith('package.json')));
    assert.ok(entry.json.sources.some(source=>source.path.endsWith(path.join('src','main.js'))));

    assert.equal(byName.json.search.state,'observed');
    assert.ok(byName.json.sources.some(source=>source.path.endsWith('WidgetMarker.js')));

    assert.equal(byLiteral.json.search.state,'observed');
    const literalLines=byLiteral.json.sources.flatMap(source=>source.lines??[]);
    assert.ok(literalLines.some(line=>line.text.includes('UNIQUE_NEEDLE_42')));
  });
});

test('project_evidence read and archive return requested line numbers and continuation data', async t=>{
  await withHost(t,{
    script:scripted([
      [tool('project_evidence',{mode:'read',files:[
        {path:'alpha.txt',offset:2,limit:2},
        {path:'beta.txt',offset:1,limit:1},
      ]})],
      [tool('project_evidence',{mode:'archive',archive:'fixture.jar',entry:'pkg/Widget.java',offset:2,limit:2})],
    ]),
  },async host=>{
    await writeFile(host.cwd,'alpha.txt','one\ntwo\nthree\nfour\nfive\n');
    await writeFile(host.cwd,'beta.txt','red\ngreen\nblue\n');
    await fs.writeFile(path.join(host.cwd,'fixture.jar'),buildZip([{
      name:'pkg/Widget.java',
      data:'package pkg;\nclass Widget {\n  int value = 2;\n  void run() {}\n}\n',
    }]));

    const agent=await host.createAgent('max');
    await host.send(agent,'Read the requested ranges.');
    const [read,archive]=results(host);

    assert.equal(read.isError,false,read.text);
    const [alpha,beta]=read.json.sources;
    assert.deepEqual(alpha.lines.map(line=>line.line),[2,3]);
    assert.deepEqual(alpha.lines.map(line=>line.text),['two','three']);
    assert.equal(alpha.observedRange.first,2);
    assert.equal(alpha.observedRange.last,3);
    assert.equal(alpha.fileHasMore,true);
    assert.equal(alpha.observedRange.last+1,4);
    assert.deepEqual(beta.lines.map(line=>line.line),[1]);
    assert.equal(beta.fileHasMore,true);
    assert.equal(beta.observedRange.last+1,2);

    assert.equal(archive.isError,false,archive.text);
    assert.equal(archive.json.mode,'archive');
    const source=archive.json.sources[0];
    assert.equal(source.state,'observed');
    assert.ok(source.archive.endsWith('fixture.jar'));
    assert.equal(source.entry,'pkg/Widget.java');
    assert.deepEqual(source.lines.map(line=>line.line),[2,3]);
    assert.deepEqual(source.lines.map(line=>line.text),['class Widget {','  int value = 2;']);
    assert.equal(source.returnedThrough,3);
    assert.equal(source.hasMore,true);
    assert.equal(source.fileHasMore,true);
  });
});

test('project_evidence failure and npm source recover local source by locator and member', async t=>{
  await withHost(t,{
    script:scripted([
      [tool('project_evidence',{mode:'failure',error_text:'boom at src/broken.js:3'})],
      [tool('project_evidence',{mode:'source',query:'fixture-pkg',member:'NeedleClass',entryKind:'runtime'})],
    ]),
  },async host=>{
    await writeFile(host.cwd,'src/broken.js','const before = 1;\nthrow new Error("boom");\nconst after = 2;\n');
    await writeFile(host.cwd,'package.json',JSON.stringify({
      name:'source-fixture',
      version:'1.0.0',
      dependencies:{'fixture-pkg':'1.0.0'},
    },null,2));
    await writeFile(host.cwd,'node_modules/fixture-pkg/package.json',JSON.stringify({
      name:'fixture-pkg',
      version:'1.0.0',
      main:'index.js',
      types:'index.d.ts',
    },null,2));
    await writeFile(host.cwd,'node_modules/fixture-pkg/index.js','export class NeedleClass {\n  value = 42;\n}\n');
    await writeFile(host.cwd,'node_modules/fixture-pkg/index.d.ts','export declare class NeedleClass {\n  value: number;\n}\n');

    const agent=await host.createAgent('max');
    await host.send(agent,'Recover the failure source and package member.');
    const [failure,source]=results(host);

    assert.equal(failure.isError,false,failure.text);
    assert.ok(failure.json.candidateLocators.some(locator=>locator.file==='src/broken.js'&&locator.line===3));
    const failureLines=failure.json.sources.flatMap(item=>item.lines??[]);
    assert.ok(failureLines.some(line=>line.text.includes('throw new Error("boom")')));

    assert.equal(source.isError,false,source.text);
    assert.equal(source.json.sourceResolution.kind,'npm');
    assert.equal(source.json.selectionState,'selected');
    assert.equal(source.json.sources[0].memberState,'observed');
    const memberLines=source.json.sources[0].matches.flatMap(match=>match.lines);
    assert.ok(memberLines.some(line=>line.text.includes('export class NeedleClass')));
  });
});

test('work_probe compares JSON pointer cases and preserves mismatch and nonzero exits', async t=>{
  await withHost(t,{
    script:scripted([
      [tool('work_probe',{
        mode:'execute',
        question:'Does the command return a=42?',
        tool:'pwsh',
        arguments:{command:'node -e "console.log(JSON.stringify({a:42}))"'},
        cases:[{name:'a',pointer:'/a',expectedJson:'42'}],
      })],
      [tool('work_probe',{
        mode:'execute',
        question:'Does the mismatch remain visible?',
        tool:'pwsh',
        arguments:{command:'node -e "console.log(JSON.stringify({a:42}))"'},
        cases:[{name:'a',pointer:'/a',expectedJson:'41'}],
      })],
      [tool('work_probe',{
        mode:'execute',
        question:'Does a nonzero exit remain unresolved?',
        tool:'pwsh',
        arguments:{command:'node -e "process.exit(7)"'},
        cases:[{name:'a',pointer:'/a',expectedJson:'42'}],
      })],
    ]),
  },async host=>{
    const agent=await host.createAgent('max');
    await host.send(agent,'Run three probes.');
    const [matched,mismatched,failed]=results(host);

    assert.equal(matched.json.status,'observed');
    assert.equal(matched.json.executionState,'success');
    assert.equal(matched.json.cases[0].status,'matched');
    assert.equal(matched.json.cases[0].actualJson,'42');

    assert.equal(mismatched.json.status,'different');
    assert.equal(mismatched.json.cases[0].status,'different');
    assert.equal(mismatched.json.cases[0].expectedJson,'41');

    assert.equal(failed.json.status,'failed');
    assert.equal(failed.json.executionState,'failed');
    assert.ok(Number.isInteger(failed.json.exitCode)&&failed.json.exitCode!==0);
    assert.equal(failed.json.cases[0].status,'unresolved');
  });
});

test('work_probe recall pages a saved record by its returned id', async t=>{
  let host;
  let probeId;
  await withHost(t,{
    script:(_options,n)=>{
      if(n===1)return [tool('work_probe',{
        mode:'execute',
        question:'Create a large saved probe record.',
        tool:'pwsh',
        arguments:{command:'node -e "console.log(JSON.stringify({a:42,pad:\'x\'.repeat(3000)}))"'},
        cases:[{name:'a',pointer:'/a',expectedJson:'42'}],
      })];
      if(n===2){
        probeId=lastResult(host).json.id;
        return [tool('work_probe',{mode:'recall',id:probeId,offset:0,maxChars:1024})];
      }
      if(n>=3){
        const previous=lastResult(host).json;
        if(previous.complete)return [text('Done.')];
        return [tool('work_probe',{mode:'recall',id:probeId,offset:previous.nextOffset,maxChars:1024})];
      }
      return [text('Done.')];
    },
  },async current=>{
    host=current;
    const agent=await host.createAgent('max');
    await host.send(agent,'Save and recall a probe.');
    const [probe,...pages]=results(host);

    assert.match(probe.json.id,/^probe-[0-9a-f-]{36}$/);
    assert.equal(probe.json.evidenceSaved,true);
    assert.ok(pages.length>1);
    let offset=0;
    for(const page of pages){
      assert.equal(page.json.status,'observed');
      assert.equal(page.json.id,probe.json.id);
      assert.equal(page.json.offset,offset);
      assert.ok(page.json.text.length>0);
      offset=page.json.nextOffset;
    }
    const lastPage=pages.at(-1).json;
    assert.equal(lastPage.complete,true);
    assert.equal(lastPage.nextOffset,null);
    assert.equal(pages.map(page=>page.json.text).join('').length,lastPage.totalChars);
  });
});

test('ptc_fastpath runs a read and grep chain, then removes the saved definition', async t=>{
  const definition={
    name:'read-grep-chain',
    description:'Read a file and find a marker.',
    inputs:[{name:'file',type:'string',required:true,description:'File to inspect.'}],
    steps:[
      {id:'source',tool:'read',arguments:{file_path:'$input.file'}},
      {id:'marker',tool:'grep',arguments:{path:'$steps.source.path',pattern:'needle'}},
    ],
  };
  await withHost(t,{
    script:scripted([
      [tool('ptc_fastpath',{mode:'define',name:'read-grep-chain',definition})],
      [tool('ptc_fastpath',{mode:'run',name:'read-grep-chain',inputs:{file:'fixture.txt'}})],
      [tool('ptc_fastpath',{mode:'list'})],
      [tool('ptc_fastpath',{mode:'remove',name:'read-grep-chain'})],
      [tool('ptc_fastpath',{mode:'list'})],
    ]),
  },async host=>{
    await writeFile(host.cwd,'fixture.txt','alpha\nneedle here\nomega\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'Define and run the read-only chain.');
    const [defined,run,beforeRemove,removed,afterRemove]=results(host);

    assert.equal(defined.json.status,'defined');
    assert.deepEqual(defined.json.steps.map(step=>step.tool),['read','grep']);

    assert.equal(run.isError,false,run.text);
    assert.equal(run.json.status,'completed');
    assert.equal(run.json.steps[0].status,'completed');
    assert.equal(run.json.steps[1].status,'completed');
    assert.ok(run.json.steps[1].summary.matches.some(match=>match.line==='needle here'));

    assert.ok(beforeRemove.json.definitions.some(item=>item.name==='read-grep-chain'));
    assert.equal(removed.json.status,'removed');
    assert.ok(!afterRemove.json.definitions.some(item=>item.name==='read-grep-chain'));
  });
});

test('ptc_fastpath missing input file returns deopt', async t=>{
  const definition={
    name:'read-missing-file',
    description:'Read an explicitly requested file.',
    inputs:[{name:'file',type:'string',required:true,description:'File to inspect.'}],
    steps:[{id:'source',tool:'read',arguments:{file_path:'$input.file'}}],
  };
  await withHost(t,{
    script:scripted([
      [tool('ptc_fastpath',{mode:'define',name:'read-missing-file',definition})],
      [tool('ptc_fastpath',{mode:'run',name:'read-missing-file',inputs:{file:'missing.txt'}})],
    ]),
  },async host=>{
    const agent=await host.createAgent('max');
    await host.send(agent,'Run the chain against a missing file.');
    const run=results(host)[1];

    assert.equal(run.isError,false,run.text);
    assert.equal(run.json.status,'deopt');
    assert.equal(run.json.step,'source');
  });
});

test('work_state records a stage, summarizes it and clears observed state', async t=>{
  await withHost(t,{
    script:scripted([
      [tool('work_state',{mode:'stage',phase:'investigate',focus:['src/tool.js']})],
      [tool('work_state',{mode:'summary'})],
      [tool('work_state',{mode:'clear'})],
      [tool('work_state',{mode:'summary'})],
    ]),
  },async host=>{
    const agent=await host.createAgent('max');
    await host.send(agent,'Exercise the evidence state tools.');
    const [stage,summary,cleared,afterClear]=results(host);

    assert.deepEqual(stage.json,{
      status:'recorded',
      phase:'investigate',
      focus:['src/tool.js'],
      note:'A stage signal for the next complete exchange boundary; this does not establish completion or authorize execution.',
    });
    assert.equal(summary.json.status,'observed');
    assert.equal(summary.json.taskFlow.phase.name,'investigate');
    assert.deepEqual(summary.json.taskFlow.phase.focus,['src/tool.js']);

    assert.deepEqual(cleared.json,{status:'cleared'});
    assert.equal(afterClear.json.status,'observed');
    assert.equal(afterClear.json.counts.observations,0);
  });
});

test('work_report writes the report under the workspace evidence directory', async t=>{
  await withHost(t,{
    script:scripted([
      [tool('work_report',{
        status:'partial',
        summary:'The host integration report was requested.',
        observed:['The report tool completed.'],
        unverified:['No external service was checked.'],
        remaining:['Connect the remaining service later.'],
      })],
    ]),
  },async host=>{
    const agent=await host.createAgent('max');
    await host.send(agent,'Save a work report.');
    const report=results(host)[0].json;

    assert.equal(report.saved,true);
    assert.equal(report.claimedStatus,'partial');
    assert.equal(report.nativeCompletionUnchanged,true);
    assert.equal(path.dirname(report.path),path.join(host.cwd,'.dsh','work-evidence'));
    const body=await fs.readFile(report.path,'utf8');
    assert.match(body,/# 本次工作记录/u);
    assert.match(body,/The host integration report was requested\./u);
    assert.match(body,/## 仍未验证/u);
  });
});

test('evidence_index returns no unlearned match, learns a source entry and skips stale source', async t=>{
  const actions=[
    [tool('evidence_index',{mode:'query',query:'WidgetToken'})],
    [tool('evidence_index',{mode:'learn',query:'WidgetToken',file:'src/widget.js',line:1})],
    [tool('evidence_index',{mode:'query',query:'WidgetToken'})],
  ];
  await withHost(t,{
    workspace:{toolSurface:'full',selfIndex:true},
    script:(_options,n)=>actions.length?actions.shift():[text('Done.')],
  },async host=>{
    await writeFile(host.cwd,'src/widget.js','export class WidgetToken {\n  value = 1;\n}\n');
    const agent=await host.createAgent('max');
    await host.send(agent,'Query, learn and query the index.');
    const [before,learned,hit]=results(host);

    assert.deepEqual(before.json.matches,[]);
    assert.equal(learned.json.saved,true);
    assert.equal(learned.json.entry.query,'WidgetToken');
    assert.equal(learned.json.entry.path,path.join('src','widget.js'));
    assert.equal(hit.json.matches.length,1);
    assert.ok(hit.json.matches[0].path.endsWith(path.join('src','widget.js')));

    await writeFile(host.cwd,'src/widget.js','export class OtherThing {\n}\n');
    actions.push([tool('evidence_index',{mode:'query',query:'WidgetToken'})]);
    await host.send(agent,'Query the old entry after source changed.');
    const stale=results(host).at(-1);
    assert.deepEqual(stale.json.matches,[]);
  });
});
