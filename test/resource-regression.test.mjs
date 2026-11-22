import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/heap-identity.mjs';
import { validateResourceRules, measureResourcePoint, assessResourceSeries, analyzeResourceRegression } from '../src/resource-regression.mjs';
import { runResourceRegressionCommand } from '../src/resource-regression-command.mjs';

const registry = { adapter: 'browser-resources', sites: [{ id: 's1', filename: 'app.ts', line: 3, column: 4, operation: 'addEventListener' }] };
const selector = { file: 'app.ts', line: 3, column: 4, kind: 'listener', eventType: 'resize' };
const rule = { id: 'resize', metric: 'resource-active-count', expectation: 'bounded-after-back', maxCount: 0, before: selector, after: selector };
const targetRule = { id: 'payload', metric: 'declared-target-alive-count', expectation: 'release-at-settle', maxCount: 0, before: { labels: ['payload'] }, after: { labels: ['payload'] } };
const rules = () => ({ schemaVersion: '0.1.0', statement: 'Resize registrations end on route exit.', beforeCase: 'leaking', afterCase: 'fixed', workload: { kind: 'controlled-case-switch', statement: 'Same workload with explicit consumer cleanup.' }, settle: { confirmed: true, statement: 'The disposal transaction completed.' }, rules: [rule] });
const runtime = { epochId: 'epoch', targetId: 'target', frameId: 'frame', scriptId: 'script', browserVersion: 'Chrome/test' };
const snapshot = { path: join(tmpdir(), 'snapshot.heapsnapshot'), sha256: 'a'.repeat(64), bytes: 1234 };
function point(state = 'active') {
  return { phase: 'back-1', runtime, observation: { adapter: 'browser-resources', epochId: 'epoch', resources: [{ id: 'r1', registrationSiteId: 's1', kind: 'listener', type: 'resize', state, stateCertain: true }], declarations: [{ label: 'payload', role: 'target', objectId: 'o1' }], objects: [{ id: 'o1', roles: ['declared-target'] }], coverage: { completeWithinScope: true, unsupported: 0, dropped: 0 } }, heap: { capturePath: join(tmpdir(), 'capture.json'), snapshot, status: 'completed' } };
}
function heap(resolution = 'present-in-final-heap') {
  return { status: 'completed', capability: 'resource-heap-source-evidence', input: { epochId: 'epoch', capturePath: join(tmpdir(), 'capture.json'), snapshot }, targets: [{ label: 'payload', objectId: 'o1', heapId: resolution === 'weak-cleared' ? null : 41, resolution, node: resolution === 'weak-cleared' ? null : { id: 41 }, bridgeResolution: resolution === 'weak-cleared' ? 'cleared' : 'resolved' }] };
}
const measured = value => ({ status: 'measured', value, lifecycle: { established: 3, released: 3 - value, retained: value, unknown: false }, witnesses: [] });
const series = counts => counts.map((value, index) => ({ phase: index === counts.length - 1 ? 'followup-' + index : 'back-' + (index + 1), measurement: measured(value) }));

test('source selection distinguishes active and released; missing sites and never established are unknown', () => {
  const active = measureResourcePoint(point(), rule, selector, registry);
  assert.equal(active.value, 1); assert.equal(active.lifecycle.established, 1);
  assert.equal(measureResourcePoint(point('released'), rule, selector, registry).value, 0);
  assert.equal(measureResourcePoint(point(), rule, { ...selector, line: 4 }, registry).status, 'unknown');
  assert.equal(measureResourcePoint(point(), rule, selector, { sites: [...registry.sites, ...registry.sites] }).status, 'unknown');
  const empty = point(); empty.observation.resources = [];
  const zero = measureResourcePoint(empty, rule, selector, registry);
  assert.equal(zero.value, 0);
  assert.equal(assessResourceSeries(series([0, 0, 0, 0]).map(p => ({ ...p, measurement: zero })), rule, true).verdict, 'unknown');
});
test('unrelated state and path truncation do not contaminate a selected metric, but missing observations do', () => {
  const value = point(); value.observation.coverage.completeWithinScope = false;
  value.observation.resources.push({ id: 'r2', registrationSiteId: 's1', kind: 'listener', type: 'scroll', state: 'target-unavailable', stateCertain: false });
  assert.equal(measureResourcePoint(value, rule, selector, registry).value, 1);
  value.observation.resources[0].stateCertain = false;
  assert.equal(measureResourcePoint(value, rule, selector, registry).status, 'unknown');
  value.observation.resources[0].stateCertain = true; value.observation.coverage.dropped = 1;
  assert.equal(measureResourcePoint(value, rule, selector, registry).status, 'unknown');
  const truncated = heap(); truncated.status = 'incomplete'; truncated.coverage = { unknownReasons: ['direct-incoming-sample-truncated'] };
  assert.equal(measureResourcePoint(point('released'), targetRule, targetRule.before, registry, truncated).value, 1);
});
test('target collection requires registered identity and explicit weak-clear; release is independent of target survival', () => {
  assert.equal(measureResourcePoint(point('released'), targetRule, targetRule.before, registry, heap()).value, 1);
  assert.equal(measureResourcePoint(point('released'), targetRule, targetRule.before, registry, heap('weak-cleared')).value, 0);
  for (const resolution of ['unresolved', 'not-present-in-final-heap']) assert.equal(measureResourcePoint(point(), targetRule, targetRule.before, registry, heap(resolution)).status, 'unknown');
  const missing = heap(); missing.targets = [];
  assert.equal(measureResourcePoint(point(), targetRule, targetRule.before, registry, missing).status, 'unknown');
  const wrong = heap(); wrong.targets[0].objectId = 'o2';
  assert.equal(measureResourcePoint(point(), targetRule, targetRule.before, registry, wrong).status, 'unknown');
  assert.equal(measureResourcePoint(point(), targetRule, targetRule.before, registry).status, 'unknown');
  const noHeapId = heap(); noHeapId.targets[0].heapId = null;
  assert.equal(measureResourcePoint(point(), targetRule, targetRule.before, registry, noHeapId).status, 'unknown');
  const otherSnapshot = heap(); otherSnapshot.input.snapshot = { ...snapshot, sha256: 'b'.repeat(64) };
  assert.equal(measureResourcePoint(point(), targetRule, targetRule.before, registry, otherSnapshot).status, 'unknown');
});
test('bounds distinguish leaks, allowed caches and declared delayed release; missing settle never passes', () => {
  assert.equal(assessResourceSeries(series([1, 2, 3, 3]), rule, true).verdict, 'violated');
  assert.equal(assessResourceSeries(series([1, 1, 1, 0]), { ...rule, maxCount: 1 }, true).verdict, 'satisfied');
  assert.equal(assessResourceSeries(series([1, 2, 3, 0]), { ...rule, expectation: 'release-at-settle' }, true).verdict, 'satisfied');
  assert.equal(assessResourceSeries(series([0, 0, 0, 0]), rule, false).verdict, 'unknown');
  assert.equal(assessResourceSeries(series([0, 0, 0]), rule, true).verdict, 'unknown');
  const bad = series([0, 0, 0, 0]); bad[1].phase = 'back-3';
  assert.equal(assessResourceSeries(bad, rule, true).verdict, 'unknown');
});
test('establishment must precede the first back for every selected target; late setup cannot certify empty cycles', () => {
  const empty = series([0, 0, 0, 0]).map(p => ({ ...p, measurement: { ...measured(0), lifecycle: { established: 0, released: 0, retained: 0, unknown: false } } }));
  empty.push({ phase: 'cleanup-3', measurement: measured(1) });
  assert.equal(assessResourceSeries(empty, rule, true).verdict, 'unknown');
  empty.splice(3, 0, { phase: 'target-late', measurement: measured(1) });
  assert.equal(assessResourceSeries(empty, rule, true).verdict, 'unknown');
  const firstOnly = series([0, 0, 0, 0]);
  firstOnly.unshift({ phase: 'target-1', measurement: { ...measured(1), witnesses: [{ label: 'payload', resolution: 'present-in-final-heap' }] } });
  assert.equal(assessResourceSeries(firstOnly, targetRule, true).verdict, 'satisfied');
  assert.equal(assessResourceSeries(firstOnly, targetRule, true, [], { labels: ['payload', 'other'] }).verdict, 'unknown');
});
test('observed resource history cannot disappear and declared labels cannot change object identities', () => {
  const empty = point(); empty.observation.resources = [];
  const points = series([0, 0, 0, 0]).map(p => ({ ...p, measurement: measureResourcePoint(empty, rule, selector, registry) }));
  points.unshift({ phase: 'target-1', measurement: measureResourcePoint(point(), rule, selector, registry) });
  const missing = assessResourceSeries(points, rule, true);
  assert.equal(missing.verdict, 'unknown'); assert.ok(missing.reasons.includes('resource-history-missing'));
  for (const p of points.slice(1)) p.measurement = measureResourcePoint(point('released'), rule, selector, registry);
  assert.equal(assessResourceSeries(points, rule, true).verdict, 'satisfied');
  const targets = series([0, 0, 0, 0]).map(p => ({ ...p, measurement: measureResourcePoint(point(), targetRule, targetRule.before, registry, heap('weak-cleared')) }));
  targets.unshift({ phase: 'target-1', measurement: measureResourcePoint(point(), targetRule, targetRule.before, registry, heap()) });
  assert.equal(assessResourceSeries(targets, targetRule, true).verdict, 'satisfied');
  targets.at(-1).measurement.witnesses[0].objectId = 'o2';
  const rebound = assessResourceSeries(targets, targetRule, true);
  assert.equal(rebound.verdict, 'unknown'); assert.ok(rebound.reasons.includes('declared-target-identity-changed'));
});
test('rules reject ambiguous business scope and invalid target or source selectors', () => {
  assert.doesNotThrow(() => validateResourceRules(rules()));
  for (const change of [r => { r.workload.kind = 'same-case'; }, r => { r.settle = null; }, r => { r.rules = [{ ...rule, before: { ...selector, eventType: '' } }]; }, r => { r.rules = [{ ...targetRule, after: { labels: [] } }]; }, r => { r.rules = [{ ...rule, expectation: 'release-at-settle', maxCount: 1 }]; }]) {
    const copy = structuredClone(rules()); change(copy); assert.throws(() => validateResourceRules(copy));
  }
  assert.throws(() => validateResourceRules({ ...rules(), rules: [{ ...rule, after: { file: 'app.ts', line: 3, kind: 'timeout' } }] }), /same kind/);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'resource-regression-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registryText = JSON.stringify(registry); await writeFile(join(directory, 'registry.json'), registryText);
  const run = { capability: 'browser-resource-lifecycle-source-evidence', status: 'completed', scenario: { name: 'route' }, build: { registrySha256: sha256(registryText) }, points: [], comparisons: [] };
  for (const name of ['leaking', 'fixed']) {
    run.comparisons.push({ case: name, sameBehavior: true, expectedErrors: true });
    for (const phase of ['target-1', 'back-1', 'back-2', 'back-3', 'followup-3']) run.points.push({ ...point(name === 'leaking' || phase === 'target-1' ? 'active' : 'released'), case: name, mode: 'instrumented', phase });
  }
  const runPath = join(directory, 'browser-resources.json'), rulesPath = join(directory, 'rules.json');
  await writeFile(runPath, JSON.stringify(run)); await writeFile(rulesPath, JSON.stringify(rules()));
  return { directory, run, runPath, rulesPath, save: () => writeFile(runPath, JSON.stringify(run)) };
}
test('replays two cases, preserves overall incomplete and rejects workload/epoch/behavior mismatch', async t => {
  const f = await fixture(t);
  let result = await analyzeResourceRegression(f.runPath, f.runPath, f.rulesPath);
  assert.equal(result.status, 'completed'); assert.equal(result.gate, 'pass'); assert.equal(result.rules[0].verdict, 'contract-improvement-supported');
  f.run.status = 'incomplete'; await f.save();
  result = await analyzeResourceRegression(f.runPath, f.runPath, f.rulesPath);
  assert.equal(result.status, 'incomplete'); assert.equal(result.gate, 'inconclusive'); assert.equal(result.scopedGate, 'pass');
  f.run.points.at(-1).runtime = { ...runtime, epochId: 'other' }; await f.save();
  result = await analyzeResourceRegression(f.runPath, f.runPath, f.rulesPath);
  assert.equal(result.scopedGate, 'inconclusive');
  f.run.points.at(-1).runtime = runtime; f.run.comparisons[1].sameBehavior = false; await f.save();
  assert.equal((await analyzeResourceRegression(f.runPath, f.runPath, f.rulesPath)).scopedGate, 'inconclusive');
});
test('worker exit codes preserve known fail and incomplete rather than masking them as success', async t => {
  const f = await fixture(t);
  let result = await runResourceRegressionCommand(f.runPath, f.runPath, f.rulesPath, f.directory);
  assert.equal(result.exitCode, 0); assert.equal(result.gate, 'pass');
  const reversed = rules(); reversed.beforeCase = 'fixed'; reversed.afterCase = 'leaking';
  await writeFile(f.rulesPath, JSON.stringify(reversed));
  result = await runResourceRegressionCommand(f.runPath, f.runPath, f.rulesPath, f.directory);
  assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 3); assert.equal(result.gate, 'fail');
  f.run.status = 'incomplete'; await f.save();
  result = await runResourceRegressionCommand(f.runPath, f.runPath, f.rulesPath, f.directory);
  assert.equal(result.exitCode, 2); assert.equal(result.status, 'incomplete'); assert.equal(result.scopedGate, 'fail');
  assert.equal((JSON.parse(await readFile(result.resultPath))).gate, 'inconclusive');
});

test('public resource-regression CLI returns 0, 3, 2 and 1 for the documented outcomes', async t => {
  const f = await fixture(t);
  const invoke = () => spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'resource-regression', '--before-run', f.runPath, '--after-run', f.runPath, '--rules', f.rulesPath, '--output', f.directory], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  let run = invoke(); assert.equal(run.status, 0, run.stdout + run.stderr); assert.equal(JSON.parse(run.stdout).gate, 'pass');
  const reversed = rules(); reversed.beforeCase = 'fixed'; reversed.afterCase = 'leaking';
  await writeFile(f.rulesPath, JSON.stringify(reversed));
  run = invoke(); assert.equal(run.status, 3, run.stdout + run.stderr); assert.equal(JSON.parse(run.stdout).gate, 'fail');
  f.run.status = 'incomplete'; await f.save();
  run = invoke(); assert.equal(run.status, 2, run.stdout + run.stderr); assert.equal(JSON.parse(run.stdout).gate, 'inconclusive');
  await writeFile(f.rulesPath, '{}');
  run = invoke(); assert.equal(run.status, 1, run.stdout + run.stderr); assert.equal(JSON.parse(run.stdout).status, 'failed');
});
