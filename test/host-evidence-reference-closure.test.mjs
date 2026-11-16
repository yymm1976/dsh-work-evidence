import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startHost,text,tool} from './helpers/host.mjs';

// P2 of the F2-C attribution: a rewrite may only pay off when a later identical read can
// be answered by a reference instead of the full body again. The mechanism already exists
// (evidenceView current-request-proof); this pins it so a future prune change cannot
// silently break the closure and turn every hidden body into another full re-read.

const JAVA='package demo;\npublic class Calc {\n  public int add(int a, int b) {\n    return a + b;\n  }\n}\n';
const ask={mode:'source',query:'Calc',member:'add'};

test('a repeated identical evidence read is answered by a reference, not the body again',async()=>{
  // toolSurface goes through `workspace`: startHost drops a top-level toolSurface option, so
  // the test ran on the default compact surface where project_evidence may be hidden.
  const host=await startHost({workspace:{toolSurface:'full'},script:(_o,n)=>
    n===1?[tool('project_evidence',ask)]:n===2?[tool('project_evidence',ask)]:[text('完成。')]});
  try{
    await fs.mkdir(path.join(host.cwd,'src'));
    await fs.writeFile(path.join(host.cwd,'src','Calc.java'),JAVA);
    const agent=await host.createAgent('max');
    await host.send(agent,'读取 Calc.add，然后再读一次同一范围');
    const decisions=((await host.command(agent,'detail')).detail.observability?.decisions??[])
      .filter(item=>item.feature==='evidenceView');
    assert.equal(decisions.filter(item=>item.status==='applied'&&item.reason==='current-request-proof').length,1,
      'the second identical read resolves through the current request proof');
    const bodies=host.requests.map(request=>request.messages??[]).flat()
      .filter(message=>message.role==='tool').map(message=>(message.content??[]).map(block=>block.text??'').join(''));
    assert.ok(bodies.some(body=>body.includes('return a + b')),'the first read delivered the body');
    assert.ok(bodies.some(body=>/reference|receipt/i.test(body)),'the repeat delivered a reference');
  }finally{await host.close();}
});
