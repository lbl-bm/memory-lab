import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/incoming-oracle.mjs';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../src/heap-identity.mjs';
import { validateRegressionContract, measureSubjectObservers, assessRegressionSeries, compareRegressionAssessments, validateRegressionWorkload, loadRegressionSeriesMetadata } from '../src/regression.mjs';
const contract = (expectation = 'bounded-after-back', maxEntries = 0) => ({ schemaVersion: '0.1.0', authority: 'asserted', scenarioId: 'mount', statement: 'Owned Subject observer membership must obey the stated bound.', workloadChange: { kind: 'same-entry', beforeEntrySha256: 'a'.repeat(64), afterEntrySha256: 'a'.repeat(64), statement: 'The scenario and entry remain the same while application source changes.' }, rules: [{ id: 'panel', metric: 'subject-observer-count', expectation, maxEntries }] });
function points(values, options = {}) { return values.map((value, index) => ({ phase: index === values.length - 1 && options.settle !== false ? 'settled' : 'back', cycle: index === values.length - 1 && options.settle !== false ? index : index + 1, settled: index === values.length - 1 && options.settle !== false, measurements: { panel: { status: value === null ? 'unknown' : 'measured', value, unknownReasons: value === null ? ['missing-evidence'] : [] } } })); }
function graph(count) {
  const nodes = [{ id: 1, name: 'root', type: 'synthetic' }, { id: 3, name: 'Subject' }, { id: 5, name: 'Array' }, { id: 7, name: 'SafeSubscriber' }];
  const edges = ['closed', 'isStopped', 'currentObservers'].map(name => ({ from: 3, to: 1, type: 'property', name }));
  edges.push({ from: 3, to: 5, type: 'property', name: 'observers' });
  for (let i = 0; i < count; i++) edges.push({ from: 5, to: 7, type: 'element', name: i });
  return { heap: fixture(nodes, edges), identities: { objects: [{ id: 'o1', heapId: 3 }] } };
}
const analysis = () => ({ status: 'completed', coverage: { completeWithinDeclaredScope: true }, records: [{ receiverId: 'o1', registration: { siteId: 's' }, matches: [], status: 'not-observed-in-final-heap' }] });

test('measures actual Subject array membership independently of missing subscriber paths', () => {
  for (const count of [0, 1, 3]) {
    const result = measureSubjectObservers(graph(count), analysis(), { panel: ['s'] }).panel;
    assert.equal(result.status, 'measured'); assert.equal(result.value, count); assert.equal(result.witnesses[0].entries.length, count);
    assert.equal(result.retainedPathRegistrations, 0);
  }
});
test('deduplicates receivers and refuses missing identities, wrong structure, sparse arrays and incomplete sites', () => {
  const records = analysis(); records.records.push({ ...records.records[0] });
  assert.equal(measureSubjectObservers(graph(2), records, { panel: ['s'] }).panel.value, 2);
  const missing = graph(0); missing.identities.objects[0].heapId = null;
  assert.equal(measureSubjectObservers(missing, analysis(), { panel: ['s'] }).panel.status, 'unknown');
  const wrong = graph(0); wrong.heap.strings[wrong.heap.strings.indexOf('observers')] = 'another';
  assert.equal(measureSubjectObservers(wrong, analysis(), { panel: ['s'] }).panel.status, 'unknown');
  const sparse = graph(1); sparse.heap.edges[sparse.heap.edges.length - 2] = 1;
  assert.equal(measureSubjectObservers(sparse, analysis(), { panel: ['s'] }).panel.status, 'unknown');
  const incomplete = analysis(); incomplete.status = 'incomplete';
  assert.equal(measureSubjectObservers(graph(0), incomplete, { panel: ['s'] }).panel.status, 'unknown');
});
test('observed primary-source lineage survives a lost pipe receiver; only explicit cleared Subject evidence counts zero', () => {
  const loaded = graph(2), recorded = analysis();
  loaded.identities.objects.push({ id: 'o2', heapId: null }); recorded.records[0].receiverId = 'o2';
  recorded.records[0].sourceLineage = { status: 'observed', subjectId: 'o1', scope: 'primary-source-only', sourceIds: ['o2', 'o1'] };
  assert.equal(measureSubjectObservers(loaded, recorded, { panel: ['s'] }).panel.value, 2);
  loaded.identities.objects[0].heapId = null;
  assert.equal(measureSubjectObservers(loaded, recorded, { panel: ['s'] }).panel.status, 'unknown');
  loaded.identities.objects[0].resolution = 'weak-ref-cleared';
  assert.equal(measureSubjectObservers(loaded, recorded, { panel: ['s'] }).panel.status, 'unknown');
  recorded.input = { weakIdentityProtocol: 'registered-weakref-v1' };
  const cleared = measureSubjectObservers(loaded, recorded, { panel: ['s'] }).panel;
  assert.equal(cleared.value, 0); assert.equal(cleared.witnesses[0].resolution, 'weak-ref-cleared');
  recorded.records[0].sourceLineage.status = 'unconfirmed';
  assert.equal(measureSubjectObservers(loaded, recorded, { panel: ['s'] }).panel.status, 'unknown');
});
test('explicit bounded and settled contracts distinguish growth, caches and asynchronous pending cleanup', () => {
  const growing = assessRegressionSeries(contract(), points([1, 2, 3, 3]));
  assert.equal(growing.assessments[0].verdict, 'violated'); assert.equal(growing.assessments[0].pattern, 'growing-observer-membership');
  const cache = assessRegressionSeries(contract('bounded-after-back', 1), points([1, 1, 1, 1]));
  assert.equal(cache.assessments[0].verdict, 'satisfied');
  const pending = assessRegressionSeries(contract('release-at-settle'), points([1, 2, 3], { settle: false }));
  assert.equal(pending.assessments[0].verdict, 'pending');
  const released = assessRegressionSeries(contract('release-at-settle'), points([1, 2, 3, 0]));
  assert.equal(released.assessments[0].verdict, 'satisfied'); assert.equal(released.assessments[0].observations[0].verdict, 'pending');
});
test('before/after supports only observed contract improvement; unknown or two points cannot confirm it', () => {
  const before = assessRegressionSeries(contract(), points([1, 2, 3, 3])), after = assessRegressionSeries(contract(), points([0, 0, 0, 0]));
  const result = compareRegressionAssessments(before, after);
  assert.equal(result.verdict, 'contract-improvement-supported'); assert.equal(result.repairVerdict, 'not-established');
  assert.equal(compareRegressionAssessments(after, after).verdict, 'no-baseline-violation');
  assert.equal(compareRegressionAssessments(after, before).verdict, 'regression-observed');
  assert.equal(compareRegressionAssessments(before, assessRegressionSeries(contract(), points([0, null, 0, 0]))).verdict, 'inconclusive');
  assert.equal(compareRegressionAssessments(before, assessRegressionSeries(contract(), points([0, 0]))).verdict, 'inconclusive');
});
test('inferred lifecycle assertions and unsupported metrics cannot silently become authoritative contracts', () => {
  const inferred = contract(); inferred.authority = 'inferred'; assert.throws(() => validateRegressionContract(inferred), /unasserted/);
  const weak = contract(); weak.rules[0].metric = 'missing-path-count'; assert.throws(() => validateRegressionContract(weak), /invalid-regression-rule/);
  assert.deepEqual(validateRegressionContract(contract()), contract());
});
test('comparison refuses unrelated workloads, undeclared entry changes and uncontrolled switch inputs', () => {
  const arm = bundleSha256 => ({ scenario: { sha256: 'scenario', workloadSha256: 'workload' }, captureTiming: { cycles: 3, followupMs: 500 }, build: { entry: resolve('entry.ts'), entrySha256: 'a'.repeat(64), bundleSha256, sourceSha256: 'source', dependency: { name: 'rxjs', version: '7.8.1' }, inputs: { 'panel.ts': 'source' } } });
  const before = arm('before'), after = arm('after'); validateRegressionWorkload(contract(), before, after);
  const wrongScenario = structuredClone(after); wrongScenario.scenario.sha256 = 'unrelated'; assert.throws(() => validateRegressionWorkload(contract(), before, wrongScenario), /context-mismatch/);
  const wrongWorkload = structuredClone(after); wrongWorkload.scenario.workloadSha256 = 'unrelated'; assert.throws(() => validateRegressionWorkload(contract(), before, wrongWorkload), /workload-mismatch/);
  const wrongEntry = structuredClone(after); wrongEntry.build.entrySha256 = 'b'.repeat(64); assert.throws(() => validateRegressionWorkload(contract(), before, wrongEntry), /undeclared-entry-change/);
  assert.throws(() => validateRegressionWorkload(contract(), before, before), /no-build-change/);
  const switched = contract(); switched.workloadChange.kind = 'controlled-entry-switch'; switched.workloadChange.afterEntrySha256 = wrongEntry.build.entrySha256;
  validateRegressionWorkload(switched, before, wrongEntry);
  wrongEntry.build.inputs['panel.ts'] = 'unrelated-change'; assert.throws(() => validateRegressionWorkload(switched, before, wrongEntry), /uncontrolled-entry-switch/);
});
test('series binds scenario, workload, captures and settle to hashed collector report/config before heap replay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-lab-regression-'));
  t.after(async () => { assert.ok((await realpath(directory)).startsWith((await realpath(tmpdir())) + sep + 'memory-lab-regression-')); await rm(directory, { recursive: true }); });
  async function save(name, value) { const bytes = typeof value === 'string' ? value : JSON.stringify(value); const path = join(directory, name); await writeFile(path, bytes); return { path, sha256: sha256(bytes) }; }
  const scenario = await save('scenario.mjs', 'export const name = "mount";'), entry = await save('entry.ts', 'export const fixed = true;');
  const config = await save('config.json', { scenario: scenario.path, entry: entry.path, cycles: 1 });
  const capture = await save('capture.json', { epochId: 'epoch', loadedScriptSha256: 'bundle', artifacts: { source: { sha256: 'source' }, snapshot: { sha256: 'snapshot' } } });
  const run = { schemaVersion: '0.1.0', status: 'completed', configSha256: config.sha256, epochId: 'epoch', build: { entry: entry.path, entrySha256: entry.sha256, bundleSha256: 'bundle', sourceSha256: 'source' }, scenario: { id: 'mount', path: scenario.path, moduleSha256: scenario.sha256, workloadSha256: sha256(Buffer.concat([await readFile(scenario.path), await readFile(entry.path)])) }, points: [{ phase: 'back', cycle: 1, capture, snapshot: { sha256: 'snapshot' } }] };
  const runRef = await save('run.json', run), series = { schemaVersion: '0.1.0', contractSha256: 'contract', scenario: { id: 'mount', ...scenario }, captureRun: runRef, captureConfig: config, bindingStatement: 'Explicit population', build: { bundleSha256: 'bundle' }, bindings: { panel: ['s'] }, points: [{ phase: 'back', cycle: 1, settled: false, capture }] };
  async function load(value = series) { const file = await save('series.json', value); return loadRegressionSeriesMetadata(file.path, contract(), 'contract'); }
  assert.equal((await load()).captureRun.sha256, runRef.sha256);
  const wrongScenario = structuredClone(series); wrongScenario.scenario = { id: 'mount', ...await save('wrong-scenario.mjs', 'export const name = "other";') }; await assert.rejects(load(wrongScenario), /collector-context-mismatch/);
  const wrongCapture = structuredClone(series); wrongCapture.points[0].capture = await save('wrong-capture.json', { epochId: 'unrelated' }); await assert.rejects(load(wrongCapture), /capture-provenance-mismatch/);
  const falseSettle = structuredClone(series); falseSettle.points[0].settled = true; await assert.rejects(load(falseSettle), /unasserted-settle/);
  const wrongContract = structuredClone(series); wrongContract.contractSha256 = 'unrelated'; await assert.rejects(load(wrongContract), /series-context-mismatch/);
  const wrongRun = structuredClone(run); wrongRun.scenario.workloadSha256 = '0'.repeat(64); const bad = structuredClone(series); bad.captureRun = await save('wrong-run.json', wrongRun); await assert.rejects(load(bad), /workload-hash-mismatch/);
});
