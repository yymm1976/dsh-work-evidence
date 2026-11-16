import test from 'node:test';
import assert from 'node:assert/strict';
import {isReadOnlyTaskRequest} from '../task-intent.mjs';

// The clause classifier decides whether work_exec/verified_exec stay visible. Six
// successive review rounds found a new hole in it, so the whole invariant is pinned
// here as one table instead of one host scenario per finding. Each row is either a
// denial that must survive (true) or an affirmative request that must win (false).
const CASES = [
  ['只读 README.md，不得修改文件。', true, 'baseline Chinese denial'],
  ['Read-only: review the edits in src/a.js.', true, 'a described edit is still a read'],
  ['Do not modify src/a.js. Create src/b.js.', false, 'a denial is scoped to its sentence'],
  ['Modify src/a.js, but do not delete src/b.js.', false, 'but separates the two decisions'],
  ['Read src/a.js, but do not modify src/b.js.', true, 'a read plus a denial stays read-only'],
  ['修改 src/a.js，但不要删除 src/b.js。', false, 'Chinese conjunction scopes the denial'],
  ['Read-only: you must not modify src/a.js.', true, 'modal denial'],
  ['You may not delete src/a.js.', true, 'may not is a denial'],
  ['You must not modify src/a.js but create src/b.js.', false, 'the must of must-not is not an allowance'],
  ['不能修改 src/a.js。', true, '不能 is a denial'],
  ['请勿修改 src/a.js。', true, '请勿 is a denial'],
  ['Refactor src/a.js. Do not modify src/b.js.', false, 'refactor is a write verb'],
  ['Update src/a.js. Do not delete src/b.js.', false, 'update is a write verb'],
  ['Fix src/a.js, do not modify src/b.js.', false, 'the prefix before the denial counts'],
  ['Edit src/a.js and do not delete src/b.js.', false, 'and does not create an allowance'],
  ["Don't forget to update docs/a.md.", false, 'forget introduces a request, not a denial'],
  ['Read-only: do not modify, create, or delete src/a.js.', true, 'a comma list inherits the denial'],
  ['Read-only: 不要修改 src/a.js，或者创建 src/b.js', true, 'Chinese list conjunction inherits the denial'],
  ['Read-only: explain the patch in src/a.js.', true, 'the patch is a noun'],
  ['Read-only: summarize the update to README.md.', true, 'the update is a noun'],
  ["Please don't modify files. Explain the fix in src/a.js.", true, 'the fix is a noun in a second sentence'],
  ['Fix the function in src/a.js and explain the change.', false, 'a verb used as a verb is a request'],
  ['Read-only: do not touch src/a.js, only rename src/b.js.', false, 'a later rename is an affirmative request'],
  ['不要改代码。', true, 'standalone 改 is a write verb in the initial gate'],
  ['Do not modify src/b.js. Explain the patch and fix src/a.js.', false, 'a verb after a rejected noun match still counts'],
  ['Do not modify src/a.js! Create src/b.js.', false, 'an exclamation mark ends a clause'],
  ['Do not modify src/a.js? Create src/b.js.', false, 'a question mark ends a clause'],
  ['Do not modify src/a.js. Fix src/never.js.', false, 'never inside a path is not a denial'],
  ['Do not modify src/can-edit.js.', true, 'can inside a path is not an allowance'],
];

for (const [request, expected, why] of CASES) {
  test('task intent: ' + why, () => {
    assert.equal(isReadOnlyTaskRequest(request), expected, request);
  });
}
