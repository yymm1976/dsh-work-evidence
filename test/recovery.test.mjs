import test from 'node:test';
import assert from 'node:assert/strict';
import {
  correctedReadArguments,
  normalizedReadResult,
  recoveredResult,
  recoveryFor,
  recoveryOf,
  withRecovery
} from '../recovery.mjs';

const invalidResult = (code = 'INVALID_ARGUMENT', message = 'invalid arguments') => ({
  value: {error: {info: {code}, message}}
});

test('correctedReadArguments ignores unknown tools and non-object arguments', () => {
  assert.equal(correctedReadArguments('write_file', {path: 'a'}), null);
  assert.equal(correctedReadArguments('read', null), null);
  assert.equal(correctedReadArguments('read', ['a.txt']), null);
});

test('project_evidence infers unambiguous read and archive modes', () => {
  const files = [{path: 'src/main.java', offset: 1, limit: 20}];
  assert.deepEqual(
    correctedReadArguments('project_evidence', {files}),
    {mode: 'read', files}
  );
  assert.deepEqual(
    correctedReadArguments('project_evidence', {
      mode: 'source',
      archive: 'lib/app.jar',
      entry: 'pkg/Main.java'
    }),
    {mode: 'archive', archive: 'lib/app.jar', entry: 'pkg/Main.java'}
  );
  assert.equal(correctedReadArguments('project_evidence', {
    files,
    query: 'Main'
  }), null);
});

test('recoveryFor does nothing for a successful result', () => {
  assert.equal(
    recoveryFor('read', {file_path: 'a.txt'}, {value: {state: 'completed'}}),
    null
  );
});

test('recoveryFor allows one deterministic read-only alias correction', () => {
  const args = {path: 'a.txt', offset: 1, limit: 10};
  const recovery = recoveryFor('read', args, invalidResult());

  assert.deepEqual(recovery.correctedCall, {
    tool: 'read',
    arguments: {file_path: 'a.txt', offset: 1, limit: 10}
  });
  assert.equal(recovery.retry, 'one-read-only-correction');
  assert.equal(recovery.automaticAllowed, true);
  assert.match(recovery.shape, /file_path/);
});

test('recoveryFor leaves conflicting read arguments for input repair', () => {
  const recovery = recoveryFor(
    'read',
    {path: 'a.txt', file_path: 'b.txt'},
    invalidResult()
  );

  assert.equal(recovery.correctedCall, null);
  assert.equal(recovery.retry, 'after-input-change');
  assert.equal(recovery.automaticAllowed, false);
});

test('recoveryFor never guesses corrections for write operations', () => {
  const recovery = recoveryFor(
    'apply_patch',
    {path: 'src/main.js', patch: 'replace'},
    invalidResult()
  );

  assert.equal(recovery.correctedCall, null);
  assert.equal(recovery.automaticAllowed, false);
  assert.equal(recovery.retry, 'after-input-change');
});

test('recoveryFor never retries permission or conflict failures unchanged', () => {
  for (const code of ['APPROVAL_REQUIRED', 'SANDBOX_DENIED', 'STATE_CONFLICT']) {
    const recovery = recoveryFor(
      'read',
      {path: 'a.txt'},
      invalidResult(code)
    );
    assert.equal(recovery.correctedCall, null, code);
    assert.equal(recovery.automaticAllowed, false, code);
    assert.equal(recovery.retry, 'do-not-repeat-unchanged', code);
  }
});

test('recoveryFor reports unavailable results without automatic retry', () => {
  const recovery = recoveryFor(
    'read',
    {file_path: 'missing.java'},
    {value: {state: 'unavailable', nextFactNeeded: 'The path was not found.'}}
  );

  assert.equal(recovery.correctedCall, null);
  assert.equal(recovery.retry, 'after-input-change');
  assert.equal(recovery.automaticAllowed, false);
});

test('recoveredResult records the second attempt and disables a second retry', () => {
  const originalArguments = {path: 'a.txt'};
  const correctedArguments = {file_path: 'a.txt'};
  const result = {
    value: {
      error: {info: {code: 'INVALID_ARGUMENT'}, message: 'unknown field'}
    }
  };
  const recovered = recoveredResult(result, {
    tool: 'read',
    originalArguments,
    correctedArguments,
    originalError: {message: 'unknown field'}
  });

  assert.equal(recovered.value.recovery.applied, true);
  assert.equal(recovered.value.recovery.stage, 'after-error');
  assert.equal(recovered.value.recovery.attempts, 2);
  assert.deepEqual(recovered.value.recovery.originalArguments, originalArguments);
  assert.deepEqual(recovered.value.recovery.correctedArguments, correctedArguments);
  assert.equal(recovered.value.recovery.followup.automaticAllowed, false);
  assert.deepEqual(recovered.content, [{type: 'text', text: JSON.stringify(recovered.value)}]);
});

test('normalizedReadResult records a pre-dispatch normalization', () => {
  const originalArguments = {path: 'a.txt'};
  const correctedArguments = {file_path: 'a.txt'};
  const normalized = normalizedReadResult(
    {value: {value: 'raw text'}, error: {code: 'FAILED'}, meta: {}},
    {tool: 'read', originalArguments, correctedArguments}
  );

  // Native read keeps its closed output schema and host presentation metadata;
  // the normalization receipt belongs to metadata, not to the value.
  assert.equal(normalized.meta.workEvidenceReadRecovery.applied, true);
  assert.equal(normalized.meta.workEvidenceReadRecovery.stage, 'before-dispatch');
  assert.equal(normalized.meta.workEvidenceReadRecovery.attempts, 1);
  assert.equal(normalized.meta.workEvidenceReadRecovery.followup.automaticAllowed, false);
  assert.deepEqual(normalized.meta.workEvidenceReadRecovery.originalArguments, originalArguments);
  assert.deepEqual(normalized.meta.workEvidenceReadRecovery.correctedArguments, correctedArguments);
});

test('withRecovery extends closed provider envelopes inside data and preserves status', () => {
  const recovery = {applied: true};
  const result = {
    value: {status: 'partial', data: {items: [1]}, error: {code: 'PARTIAL'}}
  };
  const extended = withRecovery(result, recovery);

  assert.equal(extended.value.status, 'partial');
  assert.deepEqual(extended.value.data, {
    items: [1],
    workEvidenceRecovery: recovery
  });
  assert.equal(extended.value.recovery, undefined);
  assert.deepEqual(extended.content, [{type: 'text', text: JSON.stringify(extended.value)}]);
});

test('withRecovery adds recovery to ordinary values and non-object results', () => {
  const recovery = {applied: true};
  const ordinary = withRecovery({value: {state: 'completed'}}, recovery);
  assert.deepEqual(ordinary.value, {state: 'completed', recovery});

  const fallback = withRecovery({
    value: 'raw text',
    error: {code: 'FAILED'},
    content: [{type: 'text', text: 'original'}]
  }, recovery);
  assert.deepEqual(fallback.error, {code: 'FAILED', recovery});
  assert.deepEqual(fallback.content, [
    {type: 'text', text: 'original'},
    {type: 'text', text: 'Recovery: ' + JSON.stringify(recovery)}
  ]);
});

test('withRecovery is a no-op without recovery and recoveryOf reads known locations', () => {
  const untouched = {value: {state: 'completed'}};
  assert.equal(withRecovery(untouched, null), untouched);

  const recovery = {applied: true};
  assert.equal(recoveryOf({value: {data: {workEvidenceRecovery: recovery}}}), recovery);
  assert.equal(recoveryOf({value: {recovery}}), recovery);
  assert.equal(recoveryOf({error: {recovery}}), recovery);
  assert.equal(recoveryOf({value: {state: 'completed'}}), null);
});
