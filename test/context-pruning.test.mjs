import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {
  planContextPrune,
  prunableMessage,
  hasPruneProblem,
  readDispatch,
} from '../context-pruning.mjs';

const textMessage = text => ({
  isError: false,
  content: [{type: 'text', text}],
});

const options = (overrides = {}) => ({
  seq: 41,
  thresholdChars: 8000,
  headChars: 4096,
  tailChars: 1024,
  dedupStats: [],
  ...overrides,
});

function generated(length, seed) {
  let value = seed >>> 0;
  let text = '';
  for (let index = 0; index < length; index++) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    text += String.fromCharCode(97 + (value >>> 0) % 26);
  }
  return text;
}

function historyReferences(text) {
  return [...text.matchAll(/\[work-evidence history (\{[^\n]*\})\]/g)]
    .map(match => JSON.parse(match[1]));
}

function dedupMarkers(text) {
  return [...text.matchAll(
    /\[work-evidence history (\{[^\n]*\})\]\n\[(\d+) characters identical to earlier content/g,
  )].map(match => ({reference: JSON.parse(match[1]), chars: Number(match[2])}));
}

test('prunableMessage rejects errors and hasPruneProblem marks failure text', () => {
  const body = generated(9000, 3);
  const errorResult = {isError: true, content: [{type: 'text', text: body}]};
  assert.equal(prunableMessage(errorResult), false);
  assert.equal(planContextPrune(errorResult, [], options()), null);

  const problemLines = [
    'TypeError: exact failure',
    'exitCode: 1',
    '{"passed":false,"name":"assertion"}',
    'FAILED assertion in test/example.test.mjs',
    'NOT_FOUND',
  ];
  for (const line of problemLines) {
    const text = `${body}\n${line}`;
    assert.equal(hasPruneProblem([{type: 'text', text}]), true, line);
    assert.equal(prunableMessage(textMessage(text)), false, line);
    assert.equal(planContextPrune(textMessage(text), [], options()), null, line);
  }
});

test('positive line-leading failure counts block pruning while zero counts remain ordinary output', () => {
  const body = generated(10000, 5);
  for (const line of ['1 failed, 10 passed in 12.34s', '2 failures, 9 passed in 12.34s']) {
    const text = `${body.slice(0, 5000)}\n${line}\n${body.slice(5000)}`;
    assert.equal(hasPruneProblem([{type: 'text', text}]), true, line);
    assert.equal(prunableMessage(textMessage(text)), false, line);
    assert.equal(planContextPrune(textMessage(text), [], options({dedupSegments: false})), null, line);
  }

  const zeroText = `${body.slice(0, 5000)}\n0 failed, 10 passed in 12.34s\n${body.slice(5000)}`;
  assert.equal(hasPruneProblem([{type: 'text', text: zeroText}]), false);
  assert.equal(prunableMessage(textMessage(zeroText)), true);
  assert.ok(planContextPrune(textMessage(zeroText), [], options({dedupSegments: false})));
});

test('prunableMessage requires a non-empty text-only result', () => {
  assert.equal(prunableMessage(textMessage('ordinary text')), true);
  assert.equal(prunableMessage({isError: false, content: []}), false);
  assert.equal(prunableMessage({isError: false, content: [{type: 'image'}]}), false);
  assert.equal(prunableMessage({isError: false, content: [{type: 'text'}, {type: 'image'}]}), false);
});

test('head and tail excerpt budgets keep an exact JavaScript-string recovery offset', () => {
  const text = `\u{1F642}HEAD-${generated(9000, 7)}-TAIL\u{1F642}`;
  const result = planContextPrune(textMessage(text), [], options({dedupSegments: false}));

  assert.ok(result);
  assert.equal(result.content.length, 1);
  const output = result.content[0].text;
  const head = Array.from(text).slice(0, 4096).join('');
  const tail = Array.from(text).slice(-1024).join('');
  assert.equal(output.startsWith(head), true);
  assert.equal(output.endsWith(tail), true);

  const [reference] = historyReferences(output);
  assert.ok(reference);
  assert.equal(reference.seq, 41);
  assert.equal(reference.offset, head.length);
  assert.equal(text.slice(0, reference.offset), head);
  assert.equal(result.charsBefore, Array.from(text).length);
  assert.equal(result.charsAfter < 8000, true);
});

test('read-window pruning keeps its source path and original-string offset within budget', () => {
  const rows = Array.from({length: 250}, (_, index) => {
    const line = index + 1;
    return {
      line,
      text: `const symbol_${line} = "payload_${String(line).padStart(4, '0')}_${'x'.repeat(20)}";`,
    };
  });
  const text = rows.map(row => `${row.line}: ${row.text}`).join('\n');
  const read = readDispatch({
    name: 'read',
    arguments: '{"file_path":"src/large-file.mjs"}',
    value: {path: 'src/large-file.mjs', lines: rows},
    callId: 'call-read-1',
  });

  const result = planContextPrune(textMessage(text), [read], options({dedupSegments: false}));
  assert.ok(result);
  assert.equal(result.content.length, 1);
  assert.deepEqual(result.ranges, [{
    path: 'src/large-file.mjs',
    offset: 0,
    end: text.length,
    startLine: 1,
    endLine: 250,
  }]);

  const [reference] = historyReferences(result.content[0].text);
  assert.ok(reference);
  assert.equal(reference.path, 'src/large-file.mjs');
  assert.equal(reference.offset, Array.from(text).slice(0, 4096).join('').length);
  assert.equal(result.content[0].text.endsWith(Array.from(text).slice(-1024).join('')), true);
  assert.equal(result.charsAfter < 8000, true);
});

test('repeated-line folding keeps every locator at the original repeated lines', () => {
  const lineA = 'A repeated payload \u{1F642} 012345\n';
  const lineB = 'B repeated payload 9876543210\n';
  const text = `HEAD\n${lineA.repeat(200)}MIDDLE\n${lineB.repeat(200)}TAIL`;
  const result = planContextPrune(textMessage(text), [], options({dedupSegments: false}));

  assert.ok(result);
  const references = historyReferences(result.content[0].text);
  assert.deepEqual(references.map(reference => reference.offset), [
    'HEAD\n'.length + lineA.length,
    'HEAD\n'.length + lineA.length * 200 + 'MIDDLE\n'.length + lineB.length,
  ]);
  assert.equal(text.slice(references[0].offset, references[0].offset + lineA.length), lineA);
  assert.equal(text.slice(references[1].offset, references[1].offset + lineB.length), lineB);
  assert.equal(result.charsAfter < 8000, true);
});

test('multi-block repeated-line locators include the resultText separator in their offset', () => {
  const first = Array.from(
    {length: 300},
    (_, index) => `unique-first-${index}\n`,
  ).join('');
  const line = 'BLOCK_REPEAT_PAYLOAD\n';
  const second = line.repeat(300);
  const message = {
    isError: false,
    content: [{type: 'text', text: first}, {type: 'text', text: second}],
  };
  const joined = `${first}\n${second}`;
  const result = planContextPrune(message, [], options({dedupSegments: false}));

  assert.ok(result);
  assert.equal(result.content[0].text, first);
  const [reference] = historyReferences(result.content[1].text);
  assert.ok(reference);
  assert.equal(reference.offset, first.length + 1 + line.length);
  assert.equal(joined.slice(reference.offset, reference.offset + line.length), line);
});

test('long-segment dedup is enabled by default and locates the later original duplicate', () => {
  const prefix = `\u{1F642}${generated(2046, 23)}`;
  const segment = generated(3000, 29);
  const middle = generated(1200, 31);
  const tail = generated(1000, 37);
  const text = `${prefix}${segment}${middle}${segment}${tail}`;

  const result = planContextPrune(textMessage(text), [], options());
  assert.ok(result);
  assert.equal(result.dedupStats.length, 1);
  assert.equal(result.dedupStats[0].seq, 41);
  assert.equal(result.dedupStats[0].segments, 1);
  assert.equal(result.content[0].text.includes('characters identical to earlier content'), true);

  const [marker] = dedupMarkers(result.content[0].text);
  assert.ok(marker);
  const repeated = text.slice(marker.reference.offset, marker.reference.offset + marker.chars);
  const source = text.lastIndexOf(repeated, marker.reference.offset - 1);
  assert.equal(source >= 0, true);
  assert.equal(text.slice(source, source + marker.chars), repeated);
  assert.equal(result.charsAfter < 8000, true);
});

test('dedupSegments false disables long-segment dedup', () => {
  const prefix = generated(2048, 41);
  const segment = generated(3000, 43);
  const middle = generated(1200, 47);
  const tail = generated(1000, 53);
  const text = `${prefix}${segment}${middle}${segment}${tail}`;

  const disabledByOption = planContextPrune(
    textMessage(text),
    [],
    options({dedupSegments: false}),
  );
  assert.ok(disabledByOption);
  assert.equal(disabledByOption.dedupStats, undefined);
  assert.equal(
    disabledByOption.content[0].text.includes('characters identical to earlier content'),
    false,
  );

});

test('dedup triggers for an unaligned internal duplicate of exactly 2048 characters', () => {
  const prefix = generated(100, 59);
  const segment = generated(2048, 61);
  const middle = generated(2400, 67);
  const tail = generated(1600, 71);
  const text = `${prefix}${segment}${middle}${segment}${tail}`;

  const result = planContextPrune(
    textMessage(text),
    [],
    options({dedupSegments: true}),
  );
  assert.ok(result);
  assert.equal(result.dedupStats?.[0]?.segments, 1);
  const [marker] = dedupMarkers(result.content[0].text);
  assert.ok(marker);
  const repeated = text.slice(marker.reference.offset, marker.reference.offset + marker.chars);
  assert.equal(repeated.length >= 2048, true);
  assert.equal(text.lastIndexOf(repeated, marker.reference.offset - 1) >= 0, true);
});

test('dedup scans a 200K-character result in under one second', () => {
  const prefix = generated(637, 73);
  const segment = generated(2048, 79);
  const middle = generated(50000, 83);
  const repeatedLength = prefix.length + segment.length + middle.length + segment.length;
  const suffix = generated(200000 - repeatedLength, 89);
  const text = `${prefix}${segment}${middle}${segment}${suffix}`;
  assert.equal(text.length, 200000);

  const started = performance.now();
  const result = planContextPrune(textMessage(text), [], options({dedupSegments: true}));
  const elapsedMs = performance.now() - started;

  assert.ok(result);
  assert.equal(elapsedMs < 1000, true, `dedup scan took ${elapsedMs.toFixed(1)}ms`);
});

test('readDispatch normalizes read calls and ignores non-read calls', () => {
  const value = {path: 'src/example.mjs', lines: [{line: 1, text: 'export const value = 1;'}]};
  const dispatch = readDispatch({
    name: 'read',
    arguments: '{"file_path":"src/example.mjs"}',
    content: [{type: 'text', text: '{"different":true}'}],
    value,
    subCallId: 'sub-call-1',
    callId: 'outer-call-1',
    isError: true,
    meta: {source: 'native'},
  });
  assert.deepEqual(dispatch, {
    name: 'read',
    arguments: {file_path: 'src/example.mjs'},
    callId: 'sub-call-1',
    isError: true,
    value,
    meta: {source: 'native'},
  });
  assert.equal(readDispatch({name: 'edit', arguments: {}}), null);
});
