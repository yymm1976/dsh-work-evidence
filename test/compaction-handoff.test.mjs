import test from 'node:test';
import assert from 'node:assert/strict';
import {stubCheckpoint, recallHistory, createCompactionHandoff} from '../compaction-handoff.mjs';

const event = (seq, type, data) => ({seq, type, data});

function eventLogAgent(log) {
  const bySeq = new Map(log.map(item => [item.seq, item]));
  return {
    session: {
      id: 'test-session',
      log,
      eventAt(seq) {
        return bySeq.get(seq);
      },
    },
  };
}

function toolResult(seq, name, text, extraMessage = {}) {
  return event(seq, 'tool/result', {
    name,
    message: {
      role: 'tool',
      content: [{type: 'text', text}],
      ...extraMessage,
    },
  });
}

function userMessage(seq, text) {
  return event(seq, 'user/message', {
    message: {
      role: 'user',
      source: {kind: 'user'},
      content: [{type: 'text', text}],
    },
  });
}

function assistantMessage(seq, text) {
  return event(seq, 'assistant/message', {
    message: {
      role: 'assistant',
      content: [{type: 'text', text}],
    },
  });
}

function countOccurrences(text, value) {
  return text.split(value).length - 1;
}

test('stub checkpoints keep problem resolution markers and chronological recovery locators',()=>{
  const agent=eventLogAgent([userMessage(0,'Read a.txt'),
    event(1,'tool/call',{name:'read',callId:'r1',arguments:{file_path:'a.txt'}}),
    toolResult(2,'read','Error: missing a.txt',{isError:true,source:{kind:'tool',callId:'r1'}}),
    event(3,'tool/call',{name:'read',callId:'r2',arguments:{file_path:'a.txt'}}),
    toolResult(4,'read','current source',{source:{kind:'tool',callId:'r2'}})]);
  const checkpoint=stubCheckpoint(agent);
  assert.match(checkpoint.text,/"checked":true/);
  {
    const recent=checkpoint.text.slice(checkpoint.text.indexOf('recent events'));
    const locators=[...recent.matchAll(/kind:"event",seq:(\d+)/g)].map(m=>Number(m[1]));
    assert.deepEqual(locators,[1,2,3,4]);
    assert.ok(checkpoint.text.includes('kind:"event",seq:0'));
    assert.equal(recallHistory(agent,{seq:4,kind:'event'}).status,'observed');
  }
  assert.match(checkpoint.text,/bounded pointers/);assert.ok(!checkpoint.text.includes('cacheOrdered='));
});

test('pressure deferral preserves overflow recovery, disabled behavior and native method cleanup',async()=>{
  const calls=[],original=async(_agent,trigger)=>{calls.push(trigger);return {trigger};};
  const service={config:{thresholdRatio:.8,headroomTokens:65536},compactIfNeeded:original,summarize:async()=>({summary:[]}),regionDependencies:()=>({meter:{measure:()=>({totalTokens:1000})}})};
  let cleanup;
  const ctx={on(){},llm:{resolveModelInfo:async()=>({context:{contextWindow:116000}})},
    inject(_dependencies,callback){callback({compaction:service,effect:fn=>{cleanup=fn();}});return {dispose:async()=>cleanup()};}};
  const config={compressionControl:true,deferPressureCompaction:true};
  const runtime={isEnabled:()=>true,get:()=>({config})};
  const agent={session:{id:'pressure-test',requestHeader:()=>({config:{provider:'p',model:'m',maxTokens:29000}})}};
  const handoff=createCompactionHandoff(ctx,runtime,{});
  assert.equal(await service.compactIfNeeded(agent,'pressure'),null);
  assert.deepEqual(await service.compactIfNeeded(agent,'context-overflow'),{trigger:'context-overflow'});
  config.deferPressureCompaction=false;await service.compactIfNeeded(agent,'pressure');
  assert.deepEqual(calls,['context-overflow','pressure']);
  await handoff.dispose();assert.equal(service.compactIfNeeded,original);
});

test('pressure deferral leaves normal thresholds and exact model overrides to the host',async()=>{
  let window=1000000,hostCalls=0,meterCalls=0,cleanup;
  const service={config:{thresholdRatio:.8,headroomTokens:65536,modelPolicies:[]},
    compactIfNeeded:async()=>{hostCalls++;return 'native';},summarize:async()=>({summary:[]}),
    regionDependencies:()=>({meter:{measure:()=>{meterCalls++;return {totalTokens:1000};}}})};
  const ctx={on(){},llm:{resolveModelInfo:async()=>({context:{contextWindow:window}})},
    inject(_d,callback){callback({compaction:service,effect:fn=>{cleanup=fn();}});return {dispose:async()=>cleanup()};}};
  const runtime={isEnabled:()=>true,get:()=>({config:{compressionControl:true,deferPressureCompaction:true}})};
  const agent={session:{id:'normal-threshold',requestHeader:()=>({config:{provider:'p',model:'m',maxTokens:29000}})}};
  const handoff=createCompactionHandoff(ctx,runtime,{});
  assert.equal(await service.compactIfNeeded(agent,'pressure'),'native');
  window=116000;service.config.modelPolicies=[{provider:'p',model:'m',headroomTokens:1000}];
  assert.equal(await service.compactIfNeeded(agent,'pressure'),'native');
  assert.equal(hostCalls,2);assert.equal(meterCalls,0);
  await handoff.dispose();
});

test('stubCheckpoint retains leading exact paths, commands, and error strings', () => {
  const path = 'src/deep/context-pruning.mjs';
  const command = 'node --test test/context-pruning.test.mjs';
  const log = [
    event(1, 'tool/call', {
      name: 'exec',
      callId: 'call-1',
      arguments: JSON.stringify({path, command}),
    }),
    toolResult(2, 'exec', `TypeError: exact failure at ${path}:128`),
    assistantMessage(3, 'Continue from the failing assertion.'),
  ];
  const stub = stubCheckpoint(eventLogAgent(log));

  assert.equal(stub.events, 3);
  assert.equal(stub.problemRows, 1);
  assert.equal(stub.text.includes(path), true);
  assert.equal(stub.text.includes(command), true);
  assert.equal(stub.text.includes(`TypeError: exact failure at ${path}:128`), true);
  assert.match(
    stub.text,
    /work_recall\(\{kind:"event",seq:2,offset:0\}\)/,
  );
});

test('stubCheckpoint lists an old textual failure regardless of recent-event budget', () => {
  const log = [toolResult(1, 'read', 'FAILED assertion at src/old-file.mjs:17')];
  for (let seq = 2; seq <= 121; seq++) {
    log.push(toolResult(seq, 'read', `success replay ${seq} ${'x'.repeat(260)}`));
  }
  const stub = stubCheckpoint(eventLogAgent(log));

  assert.equal(stub.problemRows, 1);
  assert.equal(stub.text.includes('FAILED assertion at src/old-file.mjs:17'), true);
  assert.match(stub.text, /work_recall\(\{kind:"event",seq:1,offset:0\}\)/);
  assert.equal(stub.text.length <= 20000, true);
});

test('stubCheckpoint bounds its text and keeps the newest event at the tail', () => {
  const log = Array.from(
    {length: 140},
    (_, index) => toolResult(index + 1, 'read', `observation ${index + 1} ${'z'.repeat(400)}`),
  );
  const first = stubCheckpoint(eventLogAgent(log));
  const second = stubCheckpoint(eventLogAgent(log));

  assert.equal(first.text.length <= 20000, true);
  assert.equal(first.rows < first.events, true);
  assert.match(first.text, /work_recall\(\{kind:"event",seq:140,offset:0\}\)/);
  assert.deepEqual(second, first);
});

test('stub continuation path keeps short human text once and links bounded long text', async () => {
  const request = 'EXACT USER REQUEST: do not modify production source.';
  const longRequest = `LONG REQUEST START ${'q'.repeat(5000)} LONG REQUEST END`;
  const log = [
    userMessage(1, request),
    assistantMessage(2, 'Acknowledged.'),
    userMessage(3, longRequest),
  ];
  const agent = eventLogAgent(log);
  agent.session.seq = 3;
  agent.session.requestHeader = () => ({config: null});
  agent.options = {provider: 'test-provider', model: 'test-model'};

  const service = {
    summarize: async () => {
      throw new Error('stub mode must not call the native summarizer');
    },
    regionDependencies: () => ({}),
  };
  const ctx = {
    on() {},
    inject(_dependencies, callback) {
      const cleanup = callback({
        effect(effect) {
          return effect();
        },
        compaction: service,
      });
      return {async dispose() {cleanup?.();}};
    },
  };
  const config = {
    compressionControl: true,
    stubSummary: true,
  };
  const runtimeState = {config, dirty: false};
  const runtime = {
    async init() {},
    isEnabled: () => true,
    get: () => runtimeState,
    activeMode: () => 'default',
    effects: {decide() {}},
  };
  const taskFlow = {
    handoff: () => ({
      artifacts: [],
      phase: 'working',
      unresolvedErrors: [],
      pendingJobs: [],
      executions: [],
      lastMutationSeq: null,
      artifactsEvicted: 0,
    }),
  };
  const handoff = createCompactionHandoff(ctx, runtime, taskFlow);
  try {
    const result = await service.summarize({messages: []}, agent);
    const combined = result.summary.map(block => block.text).join('\n');

    assert.equal(countOccurrences(combined, request), 1);
    assert.equal(countOccurrences(combined, longRequest), 0);
    assert.match(combined, /"humanRequests":/);
    assert.match(
      combined,
      /human requests \(continuation sources may carry text or bounded excerpts; these entries locate the full originals\):/,
    );
    assert.match(combined, /work_recall\(\{kind:"event",seq:1,offset:0\}\)/);
    assert.match(combined, /work_recall\(\{kind:"event",seq:3,offset:0\}\)/);

    const recalled = recallHistory(agent, {seq: 1, kind: 'event', offset: 0, maxChars: 256});
    assert.equal(recalled.text, request);
    const recalledLong = recallHistory(agent, {seq: 3, kind: 'event', offset: 0, maxChars: 16000});
    assert.equal(recalledLong.text, longRequest);
  } finally {
    await handoff.dispose();
  }
});

test('stubCheckpoint tool-call locators recover arguments through recallHistory', () => {
  const path = 'src/needed/file.mjs';
  const command = 'node --test test/needed.test.mjs';
  const argumentsText = JSON.stringify({
    padding: 'x'.repeat(280),
    path,
    command,
  });
  const agent = eventLogAgent([
    event(1, 'tool/call', {name: 'exec', callId: 'call-1', arguments: argumentsText}),
    assistantMessage(2, 'Continue with the recorded command.'),
  ]);
  const stub = stubCheckpoint(agent);

  assert.equal(stub.text.includes(path), false);
  assert.match(stub.text, /work_recall\(\{kind:"event",seq:1,offset:0\}\)/);
  const recalled = recallHistory(agent, {seq: 1, kind: 'event', offset: 0, maxChars: 2048});
  assert.equal(recalled.status, 'observed');
  assert.equal(recalled.text, argumentsText);
  assert.equal(recalled.text.includes(path), true);
  assert.equal(recalled.text.includes(command), true);
});

test('stubCheckpoint treats an isError result as a problem without an error marker', () => {
  const marker = 'Operation halted before completion.';
  const log = [toolResult(1, 'exec', marker, {isError: true})];
  for (let seq = 2; seq <= 121; seq++) {
    log.push(toolResult(seq, 'read', `successful observation ${seq} ${'q'.repeat(260)}`));
  }
  const stub = stubCheckpoint(eventLogAgent(log));

  assert.equal(stub.problemRows, 1);
  assert.equal(stub.text.includes(marker), true);
});

test('stubCheckpoint checked requires the same tool and target', () => {
  const log = [
    event(1, 'tool/call', {
      name: 'read',
      callId: 'read-a-1',
      arguments: JSON.stringify({path: 'src/a.mjs'}),
    }),
    toolResult(2, 'read', '{"error":"read a failed"}', {source: {callId: 'read-a-1'}}),
    event(3, 'tool/call', {
      name: 'read',
      callId: 'read-b-1',
      arguments: JSON.stringify({path: 'src/b.mjs'}),
    }),
    toolResult(4, 'read', '{"error":"read b failed"}', {source: {callId: 'read-b-1'}}),
    event(5, 'tool/call', {
      name: 'write',
      callId: 'write-a-1',
      arguments: JSON.stringify({path: 'src/a.mjs'}),
    }),
    toolResult(6, 'write', '{"error":"write a failed"}', {source: {callId: 'write-a-1'}}),
    event(7, 'tool/call', {
      name: 'read',
      callId: 'read-a-2',
      arguments: JSON.stringify({path: 'src/a.mjs'}),
    }),
    toolResult(8, 'read', '{"ok":true}', {source: {callId: 'read-a-2'}}),
  ];
  const stub = stubCheckpoint(eventLogAgent(log));
  assert.equal(stub.problemRows, 3);
  const rows = [...stub.text.matchAll(/^- (\{"seq":\d+,"kind":"result"[^\n]*,"checked":(?:true|false)\})$/gm)]
    .map(match => JSON.parse(match[1]));
  const checked = new Map(rows.map(row => [row.seq, row.checked]));

  assert.equal(checked.get(2), true);
  assert.equal(checked.get(4), false);
  assert.equal(checked.get(6), false);
});

test('recallHistory event pages use JavaScript string offsets and reassemble exactly', () => {
  const original = `BEGIN-\u{1F642}-${'x'.repeat(280)}-\u{1F642}-END`;
  const agent = eventLogAgent([userMessage(5, original)]);
  let offset = 0;
  let recalled = '';

  while (true) {
    const page = recallHistory(agent, {
      seq: 5,
      kind: 'event',
      offset,
      maxChars: 256,
    });
    assert.equal(page.status, 'observed');
    assert.equal(page.totalChars, original.length);
    assert.equal(page.text, original.slice(offset, offset + 256));
    recalled += page.text;
    if (page.nextOffset === null) {
      assert.equal(page.textComplete, true);
      assert.equal(page.complete, true);
      break;
    }
    assert.equal(Number.isSafeInteger(page.nextOffset), true);
    assert.equal(page.nextOffset, offset + page.text.length);
    assert.equal(page.nextOffset > offset, true);
    offset = page.nextOffset;
  }

  assert.equal(recalled, original);
});

test('recallHistory legacy history pages use JavaScript positions over the complete index', () => {
  const log = [
    userMessage(1, `first human request ${'a'.repeat(180)}`),
    userMessage(2, `second human request ${'b'.repeat(180)}`),
    userMessage(3, `third human request ${'c'.repeat(180)}`),
  ];
  const agent = eventLogAgent(log);
  const full = recallHistory(agent, {
    seq: 1,
    kind: 'history',
    filter: 'human',
    offset: 0,
    maxChars: 64000,
  }).text;
  assert.equal(full.length > 256, true);

  let offset = 1;
  let recalled = '';
  while (true) {
    const page = recallHistory(agent, {
      seq: 1,
      kind: 'history',
      filter: 'human',
      offset,
      maxChars: 256,
    });
    assert.equal(page.status, 'observed');
    assert.equal(page.totalChars, full.length);
    assert.equal(page.text, full.slice(offset, offset + 256));
    recalled += page.text;
    if (page.nextOffset === null) {
      assert.equal(page.textComplete, true);
      assert.equal(page.complete, true);
      break;
    }
    assert.equal(page.nextOffset, offset + page.text.length);
    assert.equal(page.nextOffset > offset, true);
    offset = page.nextOffset;
  }

  assert.equal(recalled, full.slice(1));
});

test('recallHistory marks non-text gaps even when all text was returned', () => {
  const agent = eventLogAgent([event(7, 'user/message', {
    message: {
      role: 'user',
      source: {kind: 'user'},
      content: [
        {type: 'text', text: 'Inspect the attached image.'},
        {type: 'image', data: 'not-reproduced'},
      ],
    },
  })]);
  const result = recallHistory(agent, {seq: 7, kind: 'event', offset: 0, maxChars: 256});

  assert.equal(result.status, 'observed');
  assert.equal(result.textComplete, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.nonTextBlocks, ['image']);
});

test('recallHistory rejects invalid offsets and pages', () => {
  const agent = eventLogAgent([userMessage(1, 'request')]);
  assert.throws(
    () => recallHistory(agent, {seq: 1, kind: 'event', offset: -1, maxChars: 256}),
    /Invalid history seq, offset or maxChars/,
  );
  assert.throws(
    () => recallHistory(agent, {seq: 1, kind: 'event', offset: 0, maxChars: 255}),
    /Invalid history seq, offset or maxChars/,
  );
});
