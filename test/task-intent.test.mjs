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
  ['不需要修改 src/a.js。', true, '不需要 is a denial'],
  ['不用修改 src/a.js。', true, '不用 is a denial'],
  ['别改 src/a.js。', true, '别 is a denial'],
  ['严禁修改 src/a.js。', true, '严禁 is a denial'],
  // '动' alone is not in the write-verb list, so this sentence names no request; it is a
  // denial of an action the classifier does not track and the task is not writable either way.
  // '动' is not in the write-verb list, so this sentence names no tracked request. A denial
  // alone no longer decides read-only (see the interpreter-constraint case), so the surface
  // stays writable, which is the harmless direction.
  ['请不要动 src/a.js 的代码。', false, 'an untracked verb plus a denial leaves the surface writable'],
  ['You are not allowed to modify src/a.js.', true, 'not allowed to is a denial'],
  ['Make sure not to modify src/a.js.', true, 'make sure not to is a denial'],
  ['There is no need to edit src/a.js.', true, 'there is no need to is a denial'],
  ['Do not modify src/a.js but review the update to README.md.', true, 'the update is a noun, not an allowance'],
  ['Do not edit src/a.js but explain the patch.', true, 'the patch is a noun, not an allowance'],
  ['Keep the fix as is. Do not touch src/a.js.', false, 'touch is untracked, so the denial cannot decide alone'],
  ['Do not modify anything. Create src/b.js.', false, 'a new sentence after a period still counts'],
  ['Do not modify src/a.js.Create src/b.js.', false, 'a period with no space still ends a sentence'],
  ["Don't forget: do not modify src/a.js.", true, 'a real denial after an idiom still holds'],
  ['Whenever you fix src/a.js, run the tests.', false, 'never inside whenever is not a denial'],
  ['Read-only: summarize the bugfix in README.md.', true, 'fix inside bugfix is not a verb'],
  ['Read-only: explain the prefix in src/a.js.', true, 'fix inside prefix is not a verb'],
  ['Read-only: explain the hotfix in src/a.js.', true, 'fix inside hotfix is not a verb'],
  // The request precedes 'whenever', so it is affirmative regardless of the subclause.
  ['Please implement this whenever you can in src/a.js.', false, 'the request precedes whenever, so it is affirmative'],
  // Round-40 findings. Both were the same defect: an ALL-CAPS target was recognised by one
  // of the two target predicates and not the other, so one sentence was a request in one
  // place and not in the other. A single predicate has to answer both.
  ['Do not modify src/a.js. Please create the README.', false, 'an article before an all-caps target does not hide it'],
  ['Do not run tests, but create README.', false, 'an allowance accepts the same targets as the request test'],
  // Round-41: a test artifact is a write target. Without it the denied first clause of a
  // two-clause task decides the whole request and hides the edit tools.
  ['Do not modify src/a.js. Add regression tests.', false, 'a test suite is a write target'],
  ['Do not modify src/a.js. Write a test for the fix.', false, 'a singular test is a write target too'],
  ['Read-only: do not add tests.', true, 'the denial still governs when the verb is denied'],
  ['Do not write tests for src/a.js.', true, 'the denial still holds at the verb itself'],
  // Round-42: a trailing `instead` is an allowance for the replacement, not for the denied verb.
  ['Do not modify src/a.js, create src/b.js instead.', false, 'a trailing instead allows the replacement'],
  ['Do not modify src/a.js instead.', true, 'a trailing instead with no replacement is still a denial'],
  ['Read-only: do not modify src/a.js; explain it instead.', true, 'explaining is not a write request'],
  // Round-43 Major: an implementation verb states the request by itself. Requiring a named
  // artifact made the second clause invisible and hid the edit tools from real work.
  ['Do not modify README.md. Implement pagination.', false, 'an implementation verb needs no named target'],
  ['Do not implement pagination.', true, 'the same verb is still denied when the denial governs it'],
  ['Do not rewrite the parser.', true, 'rewrite is an implementation verb and its denial decides'],
];

for (const [request, expected, why] of CASES) {
  test('task intent: ' + why, () => {
    assert.equal(isReadOnlyTaskRequest(request), expected, request);
  });
}

test('task intent: a target described at length still counts',()=>{
  // The target sits 40+ characters after the verb; a fixed character limit dropped it and
  // let the denied first sentence decide the whole task.
  assert.equal(isReadOnlyTaskRequest('Do not modify src/a.js; fix the failing authentication regression in src/b.js.'),false);
});

test('task intent: a capitalized verb with an extensionless target still counts',()=>{
  assert.equal(isReadOnlyTaskRequest('Do not modify src/a.js. Create README.'),false);
});

test('task intent: a filename that contains the marker is not a read-only instruction',()=>{
  // `scripts/read-only.sh` is a path, not a permission statement.
  assert.equal(isReadOnlyTaskRequest('Run scripts/read-only.sh and report the output.'),false);
});

test('task intent: an allowance accepts a target-free implementation request',()=>{
  // Both Majors from the round-44 review. The allowance branch used to call only the
  // target-requiring test, so "but implement pagination" was a request at the sentence gate
  // and a non-request here — the denial won and the edit tools were hidden.
  assert.equal(isReadOnlyTaskRequest('Do not run tests, but implement pagination.'),false);
  assert.equal(isReadOnlyTaskRequest('Do not implement pagination.'),true);
  // And `rewrite` had to join the shared verb list, or the sentence gate accepted it via the
  // implementation route and the clause scan then found no verb to judge.
  assert.equal(isReadOnlyTaskRequest('Do not modify README.md. Rewrite the parser.'),false);
  assert.equal(isReadOnlyTaskRequest('Do not rewrite the parser.'),true);
});

test('task intent: a Chinese noun use of an implementation verb is not a request',()=>{
  // Found by adversarial review. 「实现」 is extremely common as a noun ("the implementation"),
  // and the classifier counted it as a write verb, so an explicit 只读 marker never decided.
  //   measured before: `只读分析 src/a.js 的实现。` -> false (writable, edit tools shown)
  assert.equal(isReadOnlyTaskRequest('只读分析 src/a.js 的实现。'),true);
  assert.equal(isReadOnlyTaskRequest('只读分析这个模块的实现。'),true);
  assert.equal(isReadOnlyTaskRequest('严禁修改任何文件；只读分析 src/a.js 的实现。'),true);
  // The verb use must still be a request: a determiner-free 实现 at the start of a clause.
  assert.equal(isReadOnlyTaskRequest('实现分页功能。'),false);
  assert.equal(isReadOnlyTaskRequest('请实现 src/a.js 里的重试。'),false);
  // And a denial of an untracked-verb clause keeps the writable default, which is the
  // harmless direction: no tracked request was named, so nothing proves a write either.
  assert.equal(isReadOnlyTaskRequest('分析 bug，不要修改。'),false);
});

test('task intent: a single-character denial is not matched inside a compound word',()=>{
  // Found by review. 别 matched inside 分别 (separately) and 识别 (recognise), so an
  // affirmative request was read as denied and the edit tools were hidden.
  assert.equal(isReadOnlyTaskRequest('分别修改 src/a.js 和 src/b.js。'),false);
  assert.equal(isReadOnlyTaskRequest('识别并修复 src/a.js 中的问题。'),false);
  // The imperative use must still deny.
  assert.equal(isReadOnlyTaskRequest('别修改 src/a.js。'),true);
  assert.equal(isReadOnlyTaskRequest('请勿修改 src/a.js。'),true);
});

test('task intent: a named execution tool survives a denied write',()=>{
  // 'Do not modify any files.' set sawRequest via the `file` target, and the next sentence's
  // execution request was outside the verb vocabulary, so work_exec was hidden from a task
  // that explicitly asks to run something.
  assert.equal(isReadOnlyTaskRequest('Do not modify any files. Use work_exec to run the Node program console.log(42).'),false);
  // An explicit read-only marker still wins over an execution tool mention.
  assert.equal(isReadOnlyTaskRequest('Read-only: do not modify src/a.js. Use work_exec to run the tests.'),true);
});
