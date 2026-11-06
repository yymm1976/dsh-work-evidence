import test from 'node:test';
import assert from 'node:assert/strict';
import {MODES, MODE_POLICY_VERSION, defaults} from '../runtime.mjs';

function withEnv(overrides, callback) {
  const previous = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('retired settings stay disabled even when enabled in input', () => {
  const config = defaults({
    taskEffort: true,
    nativeReadView: true,
    nativeExecutionEvidence: true
  });

  assert.equal(config.taskEffort, false);
  assert.equal(config.nativeReadView, false);
  assert.equal(config.nativeExecutionEvidence, false);
});

test('retired pruning and compaction values normalize to current values', () => {
  const config = defaults({
    contextPruningPolicy: 'online-batch',
    compactionTiming: 'adaptive'
  });

  assert.equal(config.contextPruningPolicy, 'forecast');
  assert.equal(config.compactionTiming, 'native');
});

test('invalid enum values are rejected', () => {
  assert.throws(() => defaults({mode: 'fast'}), /mode must be/);
  assert.throws(() => defaults({contextPruningPolicy: 'future'}), /contextPruningPolicy/);
  assert.throws(() => defaults({compactionTiming: 'batch'}), /compactionTiming/);
  assert.throws(() => defaults({toolSurface: 'minimal'}), /toolSurface/);
  assert.throws(() => defaults({defaultResponseView: 'summary'}), /defaultResponseView/);
});

test('default mode preserves an omitted or explicit aggressive setting', () => {
  assert.equal(defaults({mode: 'default'}).aggressiveMode, false);
  assert.equal(defaults({mode: 'default', aggressiveMode: false}).aggressiveMode, false);
  assert.equal(defaults({mode: 'default', aggressiveMode: true}).aggressiveMode, true);
  assert.equal(defaults({mode: 'aggressive'}).aggressiveMode, true);
});

test('unknown settings are rejected', () => {
  assert.throws(() => defaults({unknownSetting: true}), /Unknown work-evidence setting/);
});

test('contextPruneMinChars accepts both inclusive bounds', () => {
  assert.equal(defaults({
    contextPruneMinChars: 8000,
    contextPruneHeadChars: 4096,
    contextPruneTailChars: 1024
  }).contextPruneMinChars, 8000);
  assert.equal(defaults({
    contextPruneMinChars: 512000,
    contextPruneHeadChars: 0,
    contextPruneTailChars: 0
  }).contextPruneMinChars, 512000);
});

test('contextPruneMinChars rejects values outside its bounds', () => {
  for (const value of [7999, 512001, 8000.5, '8000']) {
    assert.throws(() => defaults({contextPruneMinChars: value}), /contextPruneMinChars/);
  }
});

test('context pruning head and tail accept zero and their effective maximum', () => {
  assert.equal(defaults({
    contextPruneMinChars: 8000,
    contextPruneHeadChars: 0,
    contextPruneTailChars: 0
  }).contextPruneHeadChars, 0);
  assert.equal(defaults({
    contextPruneMinChars: 512000,
    contextPruneHeadChars: 511744,
    contextPruneTailChars: 0
  }).contextPruneHeadChars, 511744);
  assert.equal(defaults({
    contextPruneMinChars: 512000,
    contextPruneHeadChars: 0,
    contextPruneTailChars: 511744
  }).contextPruneTailChars, 511744);
});

test('context pruning head and tail reject invalid sizes', () => {
  for (const key of ['contextPruneHeadChars', 'contextPruneTailChars']) {
    assert.throws(() => defaults({[key]: -1}), new RegExp(key));
    assert.throws(() => defaults({contextPruneMinChars: 512000, [key]: 512001}), new RegExp(key));
    assert.throws(() => defaults({[key]: 1.5}), new RegExp(key));
  }
});

test('context pruning budget includes the recovery marker', () => {
  const exact = defaults({
    contextPruneMinChars: 8000,
    contextPruneHeadChars: 7000,
    contextPruneTailChars: 744
  });
  assert.equal(exact.contextPruneHeadChars + exact.contextPruneTailChars + 256, 8000);
  assert.throws(() => defaults({
    contextPruneMinChars: 8000,
    contextPruneHeadChars: 7000,
    contextPruneTailChars: 745
  }), /head \+ tail \+ recovery marker/);
});

test('swEvictionSteps accepts both inclusive bounds', () => {
  assert.equal(defaults({swEvictionSteps: 3}).swEvictionSteps, 3);
  assert.equal(defaults({swEvictionSteps: 50}).swEvictionSteps, 50);
});

test('swEvictionSteps rejects values outside its bounds', () => {
  for (const value of [2, 51, 3.5, '3']) {
    assert.throws(() => defaults({swEvictionSteps: value}), /swEvictionSteps/);
  }
});

test('projection step and size settings accept inclusive bounds', () => {
  const accepted = [
    ['projectionMinChars', 16000],
    ['projectionMinChars', 2000000],
    ['projectionRecentSteps', 3],
    ['projectionRecentSteps', 50],
    ['projectionStableSteps', 4],
    ['projectionStableSteps', 100],
    ['projectionHorizonSteps', 1],
    ['projectionHorizonSteps', 64]
  ];

  for (const [key, value] of accepted) {
    assert.equal(defaults({[key]: value})[key], value, `${key}=${value}`);
  }
});

test('projection step and size settings reject values outside their bounds', () => {
  const rejected = [
    ['projectionMinChars', 15999],
    ['projectionMinChars', 2000001],
    ['projectionRecentSteps', 2],
    ['projectionRecentSteps', 51],
    ['projectionStableSteps', 3],
    ['projectionStableSteps', 101],
    ['projectionHorizonSteps', 0],
    ['projectionHorizonSteps', 65],
    ['projectionHorizonSteps', 1.5]
  ];

  for (const [key, value] of rejected) {
    assert.throws(() => defaults({[key]: value}), new RegExp(key), `${key}=${value}`);
  }
});

test('model timeout and token settings accept inclusive bounds', () => {
  const accepted = [
    ['modelTimeoutMs', 1000],
    ['modelTimeoutMs', 60000],
    ['modelMaxTokens', 128],
    ['modelMaxTokens', 4096]
  ];

  for (const [key, value] of accepted) {
    assert.equal(defaults({[key]: value})[key], value, `${key}=${value}`);
  }
});

test('model timeout and token settings reject values outside their bounds', () => {
  const rejected = [
    ['modelTimeoutMs', 999],
    ['modelTimeoutMs', 60001],
    ['modelMaxTokens', 127],
    ['modelMaxTokens', 4097],
    ['modelMaxTokens', 128.5]
  ];

  for (const [key, value] of rejected) {
    assert.throws(() => defaults({[key]: value}), new RegExp(key), `${key}=${value}`);
  }
});

test('projectionPricing accepts a complete route and optional cacheWrite', () => {
  const rows = [
    {
      provider: 'acme',
      model: 'fast',
      input: 1.5,
      cacheRead: 0.25,
      cacheWrite: 2,
      output: 3,
      currency: 'USD'
    }
  ];
  assert.deepEqual(defaults({projectionPricing: rows}).projectionPricing, rows);
});

test('projectionPricing rejects malformed rows', () => {
  const base = {
    provider: 'acme',
    model: 'fast',
    input: 1,
    cacheRead: 0.5,
    output: 2,
    currency: 'USD'
  };
  const invalid = [
    null,
    [],
    {...base, extra: true},
    {...base, provider: ' '},
    {...base, model: ''},
    {...base, currency: ' '},
    {...base, input: -1},
    {...base, cacheRead: Number.POSITIVE_INFINITY},
    {...base, output: Number.NaN},
    {...base, cacheWrite: -1}
  ];

  for (const row of invalid) {
    assert.throws(() => defaults({projectionPricing: [row]}), /projection price/);
  }
});

test('projectionPricing rejects duplicate provider and model routes', () => {
  const first = {
    provider: 'acme',
    model: 'fast',
    input: 1,
    cacheRead: 0.5,
    output: 2,
    currency: 'USD'
  };
  assert.throws(() => defaults({
    projectionPricing: [first, {...first, output: 3}]
  }), /Duplicate projection price route/);
});

test('projectionPricing rejects more than 32 routes', () => {
  const rows = Array.from({length: 33}, (_, index) => ({
    provider: `provider-${index}`,
    model: 'model',
    input: 1,
    cacheRead: 0.5,
    output: 2,
    currency: 'USD'
  }));
  assert.throws(() => defaults({projectionPricing: rows}), /Invalid projectionPricing/);
});

test('hidden experiment environment variables cannot change stable defaults', () => {
  withEnv(
    {
      DSH_EXPERIMENT_DEFER_COMPACTION: '1',
      DSH_EXPERIMENT_STUB_SUMMARY: 'true',
    },
    () => {
      const config = defaults();
      assert.equal(config.deferPressureCompaction, false);
      assert.equal(config.stubSummary, false);
    },
  );
});

test('exported modes and policy version match the current policy format', () => {
  assert.deepEqual(MODES, ['default', 'aggressive', 'quality']);
  assert.equal(MODE_POLICY_VERSION, 'pb001-v39');
  assert.match(MODE_POLICY_VERSION, /^pb001-v\d+$/);
});
