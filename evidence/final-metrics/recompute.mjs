import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const plan = JSON.parse(fs.readFileSync(path.join(here, 'plan.json'), 'utf8'));
const readUnit = (file) => JSON.parse(fs.readFileSync(path.join(here, 'units', file), 'utf8'));
const price = plan.pricePerMillionUSD;
const replacements = plan.replacements || {};

function arm(rows) {
  const units = rows.map((original) => {
    const file = replacements[original] || original;
    const u = readUnit(file);
    const input = u.usages.reduce((s, x) => s + x.inputTokens, 0);
    const cacheRead = u.usages.reduce((s, x) => s + x.cacheReadTokens, 0);
    const output = u.usages.reduce((s, x) => s + x.outputTokens, 0);
    const total = u.usages.reduce((s, x) => s + x.totalTokens, 0);
    const cost = (input * price.input + cacheRead * price.cacheRead + output * price.output) / 1e6;
    const problems = [];
    if (u.completeSuccess !== true) problems.push('completeSuccess!=true');
    if (u.delivered !== true) problems.push('delivered!=true');
    if (u.scorerStatus !== 'pass') problems.push(`scorer=${u.scorerStatus}`);
    if (u.identityValid !== true) problems.push('identityValid!=true');
    if (u.reasoningEffort !== 'max') problems.push(`effort=${u.reasoningEffort}`);
    if (Math.abs(u.cost - cost) > 1e-6) problems.push(`cost mismatch ${u.cost} vs ${cost}`);
    return { file, replaced: replacements[original] ? original : null, ...u, input, cacheRead, output, total, cost, problems };
  });
  const successes = units.filter((u) => u.completeSuccess === true).length;
  const cost = units.reduce((s, u) => s + u.cost, 0);
  const sum = (k) => units.reduce((s, u) => s + u[k], 0);
  return { runs: units.length, successes, cost, perSuccess: successes ? cost / successes : null,
    requests: sum('requests'), toolCalls: sum('toolCalls'), input: sum('input'), cacheRead: sum('cacheRead'),
    output: sum('output'), totalTokens: sum('total'), wallMs: sum('wallMs'), units };
}

const groups = {};
for (const [name, g] of Object.entries(plan.groups)) {
  const b0 = arm(g.b0), c = arm(g.c);
  groups[name] = { weight: g.weight, task: g.task, maxTokens: g.maxTokens, qualityOnly: !!g.qualityOnly,
    b0, c, delta: 1 - c.perSuccess / b0.perSuccess };
}

const classes = {
  'Python (dotenv)': { dev: groups['python-dev'].delta, holdout: groups['python-interp-defaults'].delta },
  Picomatch: { dev: groups['picomatch-dev'].delta, holdout: groups['picomatch-capture-negate'].delta },
  'Minecraft (Java)': { dev: groups['java-dev'].delta, holdout: groups['java-holdout'].delta, note: 'quality only; not part of the weighted efficiency metric' },
};
for (const v of Object.values(classes)) { v.complete = Number.isFinite(v.dev) && Number.isFinite(v.holdout); v.noReversal = v.complete && v.dev > 0 && v.holdout > 0; }

const weightedGroups = Object.entries(groups).filter(([, g]) => typeof g.weight === 'number');
const weightSum = weightedGroups.reduce((s, [, g]) => s + g.weight, 0);
const weightedValue = weightedGroups.reduce((s, [, g]) => s + g.weight * g.delta, 0) / weightSum;
const mechanismGroups = weightedGroups.filter(([name]) => name !== 'picomatch-dev');
const mechanismWeighted = mechanismGroups.reduce((s, [, g]) => s + g.delta, 0) / mechanismGroups.length;

const allUnits = Object.values(groups).flatMap((g) => [...g.b0.units, ...g.c.units]);
const problems = allUnits.flatMap((u) => u.problems.map((p) => `${u.file}: ${p}`));

const artifact = {
  schema: 'dsh-work-evidence.final-metrics.1.1.0',
  releasedTag: plan.releasedTag,
  releasedSha: plan.releasedSha,
  acceptanceCandidate: plan.acceptanceCandidate,
  baseline: plan.baseline,
  pricePerMillionUSD: price,
  primaryMetric: plan.primaryMetric,
  derivation: { source: plan.sourceAggregate, replacements, invalidUnits: plan.invalidUnits.length },
  groups, classes,
  weighted: { value: weightedValue, gate: 0.1, pass: weightedValue >= 0.1, groups: weightedGroups.map(([name, g]) => ({ name, weight: g.weight, delta: g.delta })) },
  mechanismOnly: { value: mechanismWeighted, excluded: 'picomatch-dev', reason: 'zero testOutputViews; positive difference is not attributed to the receipt mechanism' },
  checks: {
    unitCount: allUnits.length,
    allCompleteSuccess: allUnits.every((u) => u.completeSuccess === true),
    allDelivered: allUnits.every((u) => u.delivered === true),
    allScorerPass: allUnits.every((u) => u.scorerStatus === 'pass'),
    allIdentityValid: allUnits.every((u) => u.identityValid === true),
    allEffortMax: allUnits.every((u) => u.reasoningEffort === 'max'),
    problems,
  },
};

const out = path.join(here, 'FINAL-METRICS-1.1.0.json');
fs.writeFileSync(out, JSON.stringify(artifact, null, 1) + '\n');
const pct = (x) => `${(x * 100).toFixed(2)}%`;
console.log('weighted', pct(weightedValue), 'mechanism-only', pct(mechanismWeighted), 'units', allUnits.length, 'problems', problems.length);
for (const [name, g] of Object.entries(groups)) console.log(name, pct(g.delta), `${g.b0.successes}/${g.b0.runs}`, `${g.c.successes}/${g.c.runs}`, 'perSuccess', g.b0.perSuccess.toFixed(9), g.c.perSuccess.toFixed(9));
