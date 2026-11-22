import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers/incoming-oracle.mjs';
import { analyzeCandidateSeries, validateCandidateSeries, selectCandidateInstances } from '../src/candidates.mjs';

async function setup(t, selection) {
  const dir = await mkdtemp(join(tmpdir(), 'memory-lab-candidates-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const points = [];
  for (let stage = 0; stage <= 4; stage++) {
    const nodes = [{ id: 1, type: 'synthetic', name: 'root' }, { id: 3, name: 'SameName' }], edges = [{ from: 1, to: 3, type: 'property', name: 'baseline' }];
    for (let cycle = 1; cycle <= Math.min(stage, 3); cycle++) {
      for (const [offset, name] of [[0, 'SameName'], [2, 'SecondLeak'], [4, 'Delayed']]) {
        if (stage === 4 && name === 'Delayed') continue;
        const id = cycle * 10 + offset; nodes.push({ id, name }); edges.push({ from: 1, to: id, type: 'property', name: name + cycle });
      }
    }
    // Legitimate cache grows once, then stays bounded.
    if (stage) { nodes.push({ id: 99, name: 'BoundedCache' }); edges.push({ from: 1, to: 99, type: 'property', name: 'cache' }); }
    const path = join(dir, stage + '.heapsnapshot'); await writeFile(path, JSON.stringify(fixture(nodes, edges)));
    points.push({ path, phase: stage === 0 ? 'baseline' : stage === 4 ? 'followup' : 'back', cycle: Math.min(stage, 3) });
  }
  const series = { schemaVersion: '0.1.0', identity: { kind: 'same-isolate', asserted: true, statement: 'Deterministic fixture uses stable unique IDs per instance.' }, rootIds: [1], points, ...(selection ? { selection } : {}) };
  const path = join(dir, 'series.json'); await writeFile(path, JSON.stringify(series)); return { dir, path, series };
}

test('multiple groups and late cohorts are selected; baseline names are not substituted', async t => {
  const { path } = await setup(t), result = await analyzeCandidateSeries(path);
  assert.equal(result.status, 'completed'); assert.equal(result.candidateGroupCount, 4); assert.equal(result.selectedInstanceCount, 10);
  const same = result.groups.find(group => group.name === 'SameName');
  assert.deepEqual(same.instances.map(row => row.nodeId), [10, 20, 30]);
  assert.deepEqual(same.instances.map(row => row.firstObservedCycle), [1, 2, 3]);
  assert.deepEqual(same.instances.map(row => row.survivesEveryBack), [true, false, false]);
  assert.ok(same.instances.every(row => row.path.outcome === 'path-found' && row.declaredGraph.reachable));
  assert.equal(result.groups.find(group => group.name === 'BoundedCache').classification, 'stable-new-survivors');
  assert.equal(result.groups.find(group => group.name === 'BoundedCache').instances[0].observedBackCount, 3);
  assert.ok(result.groups.every(group => !Object.hasOwn(group, 'survivingNewIds') && !Object.hasOwn(group, 'survivingNewInstances')));
  assert.ok(result.groups.find(group => group.name === 'Delayed').instances.every(row => row.followup === 'absent'));
  assert.equal(result.conclusion.leakVerdict, 'not-determined');
});

test('group, per-group and global truncation are explicit and CLI exits 2', async t => {
  const { path, dir } = await setup(t, { maxGroups: 2, maxInstancesPerGroup: 2, maxInstances: 2 });
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'candidates', '--series', path, '--output', dir], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(run.status, 2, run.stderr || run.stdout);
  const command = JSON.parse(run.stdout), result = JSON.parse(await readFile(command.resultPath, 'utf8'));
  const markdown = await readFile(command.markdownPath, 'utf8');
  assert.match(markdown, /分析状态：incomplete/);
  assert.match(markdown, /泄漏结论：尚未判定/);
  assert.equal(result.status, 'incomplete'); assert.equal(result.omittedGroupCount, 2); assert.equal(result.selectedInstanceCount, 2); assert.equal(result.omittedInstanceCount, 4);
  assert.equal(result.completeness.selectionTruncated, true);
  assert.deepEqual(result.groups.map(group => group.selectedInstanceCount), [1, 1]);
});

test('public candidate report joins automatic paths to script definition hints without requiring a target ID', async t => {
  const { dir, path, series } = await setup(t);
  for (const point of series.points) {
    const heap = JSON.parse(await readFile(point.path, 'utf8'));
    const width = heap.snapshot.meta.node_fields.length;
    const idOffset = heap.snapshot.meta.node_fields.indexOf('id');
    for (let offset = 0; offset < heap.nodes.length; offset += width) {
      if ([10, 20, 30].includes(heap.nodes[offset + idOffset])) heap.locations.push(offset, 42, 10, 8);
    }
    await writeFile(point.path, JSON.stringify(heap));
  }
  series.scripts = [{ scriptId: '42', url: 'http://localhost/bundle.js' }];
  await writeFile(path, JSON.stringify(series));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'candidates', '--series', path, '--output', dir], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const command = JSON.parse(run.stdout), result = JSON.parse(await readFile(command.resultPath, 'utf8'));
  assert.equal(result.sourceMapping.coverage.instancesWithHints, 3);
  const hints = result.groups.find(group => group.name === 'SameName').instances.map(instance => instance.sourceHints.hints[0]);
  assert.ok(hints.every(hint => hint.generated.url === series.scripts[0].url && hint.generated.line === 11 && hint.generated.column === 9));
  assert.ok(hints.every(hint => hint.retainingWrite === 'not-observed' && hint.originalSource === 'not-mapped'));
  assert.match(await readFile(command.markdownPath, 'utf8'), /http:\/\/localhost\/bundle\.js:11:9/);
  assert.equal(result.conclusion.leakVerdict, 'not-determined');
});

test('cross-isolate, missing baseline and unsafe selection limits are rejected', async t => {
  const { series } = await setup(t);
  assert.throws(() => validateCandidateSeries({ ...series, identity: { kind: 'different-isolates', asserted: true, statement: 'not comparable' } }), /same-isolate/);
  assert.throws(() => validateCandidateSeries({ ...series, points: series.points.slice(1) }), /baseline/);
  assert.throws(() => validateCandidateSeries({ ...series, selection: { maxInstances: 100000 } }), /limit/);
  assert.throws(() => validateCandidateSeries({ ...series, selection: { targetName: 'SameName' } }), /limit/);
});

test('per-group budgets sample observed cohorts instead of letting early or small IDs dominate', () => {
  const points = [{ phase: 'baseline', cycle: 0 }, ...[1, 2, 3].map(cycle => ({ phase: 'back', cycle }))];
  const key = JSON.stringify(['object', 'minified']), cohorts = [[100, 102, 104], [2, 4, 6], [50, 52, 54]];
  const indexes = points.map((_, index) => { const ids = new Set(cohorts.slice(0, index).flat()); return { allIds: ids, byGroup: new Map([[key, ids]]) }; });
  const result = selectCandidateInstances(points, { candidates: [{ type: 'object', name: 'minified' }] }, indexes, { maxGroups: 1, maxInstancesPerGroup: 3, maxInstances: 3 });
  assert.deepEqual(result.groups[0].instances.map(instance => instance.firstObservedCycle), [1, 2, 3]);
  assert.deepEqual(result.groups[0].instances.map(instance => instance.nodeId), [100, 2, 50]);
  assert.equal(result.omittedInstanceCount, 6);
  assert.deepEqual(result.groups[0].cohorts, [1, 2, 3].map(firstObservedCycle => ({ firstObservedCycle, eligibleInstanceCount: 3, selectedInstanceCount: 1 })));
});
