import test from 'node:test';
import assert from 'node:assert/strict';
import {finalJsonSyntaxIssue} from '../final-json.mjs';
import {startHost,text} from './helpers/host.mjs';

const JSON_REQUEST = '请只返回 JSON 代码块。';
const RAW_FINAL_REQUEST = 'Return one JSON object directly as the final assistant text, with no prose or Markdown fence.';
const EXPLANATION_REQUEST = 'Explain whether returning bare JSON directly as the final assistant text is appropriate. Give a prose recommendation.';
const EDIT_REQUEST = 'Edit final-json.mjs so it returns bare JSON instead of a Markdown code block, then explain the behavior in prose.';
const EXACT_FINAL_REQUEST = 'The final assistant response must be exactly one JSON value, with no surrounding Markdown.';

test('invalid JSON in a json-labeled code block is reported', () => {
  const issue = finalJsonSyntaxIssue(
    '```json\n{"answer": 42,}\n```',
    JSON_REQUEST
  );

  assert.ok(issue);
  assert.match(issue.raw, /"answer"/);
  assert.equal(typeof issue.error, 'string');
  assert.notEqual(issue.error, '');
});

test('valid JSON in a json-labeled code block is accepted', () => {
  assert.equal(
    finalJsonSyntaxIssue('```json\n{"answer": 42}\n```', JSON_REQUEST),
    null
  );
});

test('all JSON-labeled blocks are checked and the first invalid block is reported', () => {
  const issue = finalJsonSyntaxIssue(
    '```json\n{"first": true}\n```\n```json\n{"second":}\n```',
    JSON_REQUEST
  );

  assert.ok(issue);
  assert.match(issue.raw, /second/);
});

test('multiple valid JSON-labeled blocks are accepted', () => {
  assert.equal(
    finalJsonSyntaxIssue(
      '```json\n{"first": true}\n```\n```json\n[1, 2, 3]\n```',
      JSON_REQUEST
    ),
    null
  );
});

test('the json fence label is case-insensitive', () => {
  const issue = finalJsonSyntaxIssue('```JSON\n{"broken":}\n```', JSON_REQUEST);
  assert.ok(issue);
});

test('invalid JSON is ignored when the user did not request final JSON', () => {
  assert.equal(
    finalJsonSyntaxIssue('```json\n{"broken":}\n```', '请说明这段文字。'),
    null
  );
});

test('an explicit malformed JSON example is not treated as final JSON', () => {
  assert.equal(
    finalJsonSyntaxIssue(
      '```json\n{"broken":}\n```',
      '请说明这个故意无效 JSON 示例。'
    ),
    null
  );
});

test('strict top-level JSON output is parsed without a fence', () => {
  assert.ok(finalJsonSyntaxIssue('{"answer":}', '只返回 JSON'));
  assert.equal(finalJsonSyntaxIssue('{"answer": 42}', '只返回 JSON'), null);
});

test('raw final JSON rejects a valid fenced answer and accepts bare JSON', () => {
  const issue = finalJsonSyntaxIssue('```json\n{"answer": 42}\n```', RAW_FINAL_REQUEST);
  assert.ok(issue);
  assert.equal(issue.rawFinal, true);
  assert.match(issue.raw, /"answer"/);
  assert.equal(finalJsonSyntaxIssue('{"answer": 42}\n', RAW_FINAL_REQUEST), null);
  assert.equal(finalJsonSyntaxIssue('```json\n{"answer":42}\n```', '请直接返回一个 JSON 对象。'), null);
  assert.ok(finalJsonSyntaxIssue(
    '```json\n{"answer":42}\n```',
    '以下 JSON 原样作为最终助手文本，不要围栏。'
  ));
});

test('raw final JSON rejects prose, multiple values, and empty text without enforcing a shape', () => {
  const request = '请输出原始 JSON 作为最终助手文本，不得使用 Markdown 围栏。';
  for (const answer of [
    'Here is the result:\n{"answer":42}',
    '{"first":true}\n{"second":true}',
    '',
    '   \n'
  ]) {
    const issue = finalJsonSyntaxIssue(answer, request);
    assert.ok(issue, JSON.stringify(answer));
    assert.equal(issue.rawFinal, true);
  }
  assert.equal(finalJsonSyntaxIssue('true', request), null);
});

test('explicit no-fence final requests retain both language forms without requiring Markdown wording',()=>{
  for(const request of ['Return the final answer as JSON with no code fences.','请返回最终 JSON，不要代码围栏。',
    'Return the final response as JSON without a code block.','请输出最终 JSON，不使用代码块。']){
    assert.equal(finalJsonSyntaxIssue('{"answer":42}',request),null,request);
    assert.equal(finalJsonSyntaxIssue('```json\n{"answer":42}\n```',request)?.rawFinal,true,request);
  }
});

test('a request that permits a code block keeps existing fenced behavior', () => {
  for (const request of [
    '请只返回 JSON 代码块，不要写说明。',
    'Return a JSON object with no prose, but use a Markdown code block.'
  ]) {
    assert.equal(
      finalJsonSyntaxIssue(
        '```json\n{"answer":42}\n```\n```json\n[1,2]\n```',
        request
      ),
      null,
      request
    );
  }
});

test('requests that explain, translate, or edit JSON instructions do not activate the guard', () => {
  const malformed = '```json\n{"broken":}\n```';
  for (const request of [
    '请解释以下要求：Return one JSON object directly as the final assistant text, with no prose or Markdown fence.',
    '请把 README.md 中写着 Return one JSON object directly as the final assistant text 的段落翻译成中文。',
    '请修改 README.md，保留文件内的说明“Return one JSON object directly as the final assistant text”。',
    '请分析 final-json.mjs 如何识别 JSON 代码块。',
    '请编辑 final-json.mjs 以处理最终 JSON 解析。',
    'Edit final-json.mjs to handle final JSON parsing.'
  ]) {
    assert.equal(finalJsonSyntaxIssue(malformed, request), null, request);
  }
});

test('prose recommendations and implementation reports that discuss bare JSON stay prose', () => {
  const prose = 'Bare JSON is appropriate here, but this answer is prose and intentionally not JSON.';
  for (const request of [
    EXPLANATION_REQUEST,
    EDIT_REQUEST,
    'Describe the function that returns bare JSON directly as the final assistant text.',
    'The parser returns bare JSON directly as the final assistant text.',
    '该方案以裸 JSON 作为最终助手输出。'
  ]) {
    assert.equal(finalJsonSyntaxIssue(prose, request), null, request);
  }
});

test('later assistant-output clauses remain authoritative after explanation or edit context', () => {
  const fenced = '```json\n{"answer":42}\n```';
  for (const request of [
    'Explain the result, then return only JSON as the final answer.',
    'Edit the parser. Return only raw JSON in your final response.'
  ]) {
    const issue = finalJsonSyntaxIssue(fenced, request);
    assert.ok(issue, request);
    assert.equal(issue.rawFinal, true, request);
  }
});

test('exact final JSON requirements reject Markdown surroundings and accept bare JSON', () => {
  const issue = finalJsonSyntaxIssue('```json\n{"answer":42}\n```', EXACT_FINAL_REQUEST);
  assert.ok(issue);
  assert.equal(issue.rawFinal, true);
  assert.equal(finalJsonSyntaxIssue('{"answer":42}\n', EXACT_FINAL_REQUEST), null);
});

test('valid unlabeled fenced JSON is accepted when JSON is requested', () => {
  assert.equal(
    finalJsonSyntaxIssue('```\n{"answer": 42}\n```', JSON_REQUEST),
    null
  );
});

test('invalid unlabeled fenced JSON is reported when JSON is requested', () => {
  const issue = finalJsonSyntaxIssue('```\n{"answer":}\n```', JSON_REQUEST);
  assert.ok(issue);
});

test('invalid unlabeled fenced JSON arrays are also reported', () => {
  const issue = finalJsonSyntaxIssue('```\n[1,]\n```', JSON_REQUEST);
  assert.ok(issue);
});

test('mixed labeled and unlabeled blocks do not hide an invalid block', () => {
  const issue = finalJsonSyntaxIssue(
    '```json\n{"first": true}\n```\n```\n{"second":}\n```',
    JSON_REQUEST
  );
  assert.ok(issue);
});

test('unlabeled shell command blocks are not treated as JSON', () => {
  assert.equal(finalJsonSyntaxIssue(
    '```json\n{"first": true}\n```\n' +
      '```\n[ -f package.json ] && echo present\n```\n' +
      '```\n[ "$MODE" = production ] && echo production\n```',
    JSON_REQUEST
  ), null);
});

test('non-json labeled fenced blocks are ignored', () => {
  assert.equal(
    finalJsonSyntaxIssue('```js\n{answer: 42}\n```', JSON_REQUEST),
    null
  );
});

test('native host does not steer prose recommendations or implementation reports', async () => {
  for (const [request, answer] of [
    [EXPLANATION_REQUEST, 'Bare JSON is appropriate here, but this answer is prose and intentionally not JSON.'],
    [EDIT_REQUEST, 'The file now preserves behavior.']
  ]) {
    const host = await startHost({
      pluginConfig: {finalJsonGuard: true},
      script: () => [text(answer)]
    });
    try {
      const agent = await host.createAgent();
      await host.send(agent, request);
      assert.equal(host.requests.length, 1);
      assert.equal(host.events.filter(event =>
        event.type === 'user/message' &&
        (event.data?.message ?? event.data)?.source?.kind === 'work-evidence-final-json'
      ).length, 0);
      const assistant = host.events.find(event => event.type === 'assistant/message');
      assert.equal(assistant?.data?.message?.content?.find(block => block.type === 'text')?.text, answer);
    } finally {
      await host.close();
    }
  }
});

test('native host steers one fenced exact-final answer and preserves its original event', async () => {
  const fenced = '```json\n{"answer":42}\n```';
  const host = await startHost({
    pluginConfig: {finalJsonGuard: true},
    script: (options, n) => {
      if (n === 1) return [text(fenced)];
      assert.equal(n, 2);
      const correction = options.messages.findLast(
        message => message.source?.finalJson?.kind === 'syntax-repair'
      );
      assert.ok(correction);
      const correctionText = correction.content
        .map(block => block.text ?? '')
        .join('\n');
      assert.match(correctionText, /final assistant text/iu);
      assert.match(correctionText, /Markdown fence/iu);
      return [text('{"answer":42}')];
    }
  });
  try {
    const agent = await host.createAgent();
    await host.send(agent, EXACT_FINAL_REQUEST);
    assert.equal(host.requests.length, 2);
    const repairEvents = host.events.filter(event =>
      event.type === 'user/message' &&
      (event.data?.message ?? event.data)?.source?.kind === 'work-evidence-final-json'
    );
    assert.equal(repairEvents.length, 1);
    assert.equal((repairEvents[0].data.message ?? repairEvents[0].data).source.finalJson.kind, 'syntax-repair');
    const assistantEvents = host.events.filter(event => event.type === 'assistant/message');
    assert.equal(
      assistantEvents[0].data.message.content.find(block => block.type === 'text')?.text,
      fenced
    );
    assert.deepEqual(
      JSON.parse(assistantEvents.at(-1).data.message.content.find(block => block.type === 'text')?.text),
      {answer: 42}
    );
  } finally {
    await host.close();
  }
});

test('native host steers a fenced raw-final answer without changing the original response', async () => {
  const fenced = '```json\n{"answer":42}\n```';
  const host = await startHost({
    pluginConfig: {finalJsonGuard: true},
    script: (options, n) => {
      if (n === 1) return [text(fenced)];
      assert.equal(n, 2);
      const correction = options.messages.findLast(
        message => message.source?.finalJson?.kind === 'syntax-repair'
      );
      assert.ok(correction);
      const correctionText = correction.content
        .map(block => block.text ?? '')
        .join('\n');
      assert.match(correctionText, /final assistant text/iu);
      assert.match(correctionText, /Markdown fence/iu);
      return [text('{"answer":42}')];
    }
  });
  try {
    const agent = await host.createAgent();
    await host.send(agent, RAW_FINAL_REQUEST);
    assert.equal(host.requests.length, 2);
    const answers = host.events
      .filter(event => event.type === 'assistant/message')
      .map(event => event.data.message.content.find(block => block.type === 'text')?.text)
      .filter(Boolean);
    assert.equal(answers[0], fenced);
    assert.deepEqual(JSON.parse(answers.at(-1)), {answer: 42});
  } finally {
    await host.close();
  }
});
