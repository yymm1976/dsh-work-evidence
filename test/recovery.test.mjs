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
  assert.equal(correctedReadArguments('ops_glob', null), null);
  assert.equal(correctedReadArguments('ops_glob', ['*.js']), null);
});

test('ops_stat accepts one paths item as path and rejects ambiguous forms', () => {
  assert.deepEqual(
    correctedReadArguments('ops_stat', {paths: ['src/main.java']}),
    {path: 'src/main.java'}
  );
  assert.equal(correctedReadArguments('ops_stat', {paths: ['a.java', 'b.java']}), null);
  assert.equal(correctedReadArguments('ops_stat', {paths: []}), null);
  assert.equal(correctedReadArguments('ops_stat', {paths: ['']}), null);
  assert.equal(correctedReadArguments('ops_stat', {path: 'a.java', paths: ['a.java']}), null);
});

test('ops_glob corrects scalar patterns and an identical glob alias', () => {
  assert.deepEqual(
    correctedReadArguments('ops_glob', {path: 'src', pattern: '**/*.js'}),
    {path: 'src', pattern: ['**/*.js']}
  );
  assert.deepEqual(
    correctedReadArguments('ops_glob', {glob: '*.mjs'}),
    {pattern: ['*.mjs']}
  );
  assert.deepEqual(
    correctedReadArguments('ops_glob', {pattern: '*.js', glob: '*.js'}),
    {pattern: ['*.js']}
  );
});

test('ops_glob does not choose between conflicting or malformed aliases', () => {
  assert.equal(correctedReadArguments('ops_glob', {pattern: '*.js', glob: '*.ts'}), null);
  assert.equal(correctedReadArguments('ops_glob', {glob: ''}), null);
  assert.equal(correctedReadArguments('ops_glob', {glob: []}), null);
  assert.equal(correctedReadArguments('ops_glob', {glob: [42]}), null);
});

test('ops_grep aliases normalize output, case, pattern, files-only and limit', () => {
  assert.deepEqual(
    correctedReadArguments('ops_grep', {pattern: 'needle', outputMode: 'files'}),
    {pattern: 'needle', outputMode: 'files_with_matches'}
  );
  assert.deepEqual(
    correctedReadArguments('ops_grep', {pattern: 'needle', output_mode: 'count'}),
    {pattern: 'needle', outputMode: 'count'}
  );
  assert.deepEqual(
    correctedReadArguments('ops_grep', {pattern: 'needle', case_insensitive: true}),
    {pattern: 'needle', caseInsensitive: true}
  );
  assert.deepEqual(
    correctedReadArguments('ops_grep', {pattern: ['foo', 'bar'], outputMode: 'content'}),
    {pattern: '(?:foo)|(?:bar)', outputMode: 'content'}
  );
  assert.deepEqual(
    correctedReadArguments('ops_grep', {pattern: 'needle', files_only: true}),
    {pattern: 'needle', outputMode: 'files_with_matches'}
  );
  assert.deepEqual(
    correctedReadArguments('ops_grep', {pattern: 'needle', maxMatches: 7}),
    {pattern: 'needle', limit: 7}
  );
});

test('ops_grep rejects conflicting aliases instead of choosing one', () => {
  assert.equal(correctedReadArguments('ops_grep', {
    pattern: 'needle',
    outputMode: 'content',
    mode: 'count'
  }), null);
  assert.equal(correctedReadArguments('ops_grep', {
    pattern: 'needle',
    caseInsensitive: true,
    case_insensitive: false
  }), null);
  assert.equal(correctedReadArguments('ops_grep', {
    pattern: 'needle',
    outputMode: 'content',
    files_only: true
  }), null);
  assert.equal(correctedReadArguments('ops_grep', {
    pattern: 'needle',
    maxMatches: 7,
    limit: 7
  }), null);
  assert.equal(correctedReadArguments('ops_grep', {
    pattern: 'needle',
    maxMatches: 0
  }), null);
});

test('ops_grep does not correct when an unsupported alias or value remains', () => {
  assert.equal(correctedReadArguments('ops_grep', {
    pattern: 'needle',
    outputMode: 'files',
    mode: 'bogus'
  }), null);
  assert.equal(correctedReadArguments('ops_grep', {
    pattern: 'needle',
    outputMode: 'bogus',
    mode: 'count'
  }), null);
});

test('ops_read_files wraps a single flat file request', () => {
  assert.deepEqual(
    correctedReadArguments('ops_read_files', {path: 'src/main.java', offset: 4, limit: 20}),
    {files: [{path: 'src/main.java', offset: 4, limit: 20}]}
  );
  assert.equal(correctedReadArguments('ops_read_files', {
    path: 'src/main.java',
    offset: 4,
    unexpected: true
  }), null);
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
    recoveryFor('ops_glob', {pattern: '*.js'}, {value: {state: 'completed'}}),
    null
  );
});

test('recoveryFor allows one deterministic read-only alias correction', () => {
  const args = {path: 'src', glob: '*.js'};
  const recovery = recoveryFor('ops_glob', args, invalidResult());

  assert.deepEqual(recovery.correctedCall, {
    tool: 'ops_glob',
    arguments: {path: 'src', pattern: ['*.js']}
  });
  assert.equal(recovery.retry, 'one-read-only-correction');
  assert.equal(recovery.automaticAllowed, true);
  assert.match(recovery.shape, /pattern/);
});

test('recoveryFor leaves conflicting read arguments for input repair', () => {
  const recovery = recoveryFor(
    'ops_glob',
    {pattern: '*.js', glob: '*.ts'},
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
      'ops_glob',
      {path: 'src', glob: '*.js'},
      invalidResult(code)
    );
    assert.equal(recovery.correctedCall, null, code);
    assert.equal(recovery.automaticAllowed, false, code);
    assert.equal(recovery.retry, 'do-not-repeat-unchanged', code);
  }
});

test('recoveryFor reports unavailable results without automatic retry', () => {
  const recovery = recoveryFor(
    'ops_stat',
    {path: 'missing.java'},
    {value: {state: 'unavailable', nextFactNeeded: 'The path was not found.'}}
  );

  assert.equal(recovery.correctedCall, null);
  assert.equal(recovery.retry, 'after-input-change');
  assert.equal(recovery.automaticAllowed, false);
});

test('recoveredResult records the second attempt and disables a second retry', () => {
  const originalArguments = {glob: '*.js'};
  const correctedArguments = {pattern: ['*.js']};
  const result = {
    value: {
      error: {info: {code: 'INVALID_ARGUMENT'}, message: 'unknown field'}
    }
  };
  const recovered = recoveredResult(result, {
    tool: 'ops_glob',
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
  const originalArguments = {glob: '*.mjs'};
  const correctedArguments = {pattern: ['*.mjs']};
  const normalized = normalizedReadResult(
    {value: {state: 'completed', items: []}},
    {tool: 'ops_glob', originalArguments, correctedArguments}
  );

  assert.equal(normalized.value.recovery.applied, true);
  assert.equal(normalized.value.recovery.stage, 'before-dispatch');
  assert.equal(normalized.value.recovery.attempts, 1);
  assert.equal(normalized.value.recovery.followup, null);
  assert.deepEqual(normalized.value.recovery.originalArguments, originalArguments);
  assert.deepEqual(normalized.value.recovery.correctedArguments, correctedArguments);
});

test('withRecovery extends OPS envelopes inside data and preserves status', () => {
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
