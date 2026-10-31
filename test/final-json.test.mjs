import test from 'node:test';
import assert from 'node:assert/strict';
import {finalJsonSyntaxIssue} from '../final-json.mjs';

const JSON_REQUEST = '请只返回 JSON 代码块。';

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
