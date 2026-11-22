import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from './helpers/incoming-oracle.mjs';
import { analyzeCandidateSeries } from '../src/candidates.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'memory-lab-accounting-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const points = [];
  for (let stage = 0; stage < 5; stage++) {
    const nodes = [{ id: 1, type: 'synthetic', name: 'root' }], edges = [], owned = [];
    for (let cycle = 1; cycle <= Math.min(stage, 3); cycle++) {
      for (const [part, name] of ['Map', 'Set', 'WeakRef'].entries()) {
        const privateId = 100 + cycle * 10 + part, businessId = 200 + cycle * 10 + part;
        nodes.push({ id: privateId, name }, { id: businessId, name });
        edges.push({ from: 1, to: privateId, type: 'property', name: 'probe' + privateId }, { from: privateId, to: businessId, type: 'property', name: 'business' });
        owned.push({ heapId: privateId, kind: 'private-' + name });
      }
      const id = 300 + cycle; nodes.push({ id, name: 'ProbeRecord' }); edges.push({ from: 1, to: id, type: 'property', name: 'record' + cycle }); owned.push({ heapId: id, kind: 'record' });
    }
    const path = join(dir, stage + '.heapsnapshot'), bytes = JSON.stringify(fixture(nodes, edges)); await writeFile(path, bytes);
    const probeAccountingPath = join(dir, stage + '-accounting.json');
    await writeFile(probeAccountingPath, JSON.stringify({ schemaVersion: '0.1.0', method: 'explicit-owned-slots', epochId: 'one-runtime', snapshotSha256: createHash('sha256').update(bytes).digest('hex'), complete: true, objects: owned }));
    points.push({ phase: stage === 0 ? 'baseline' : stage === 4 ? 'followup' : 'back', cycle: Math.min(stage, 3), path, probeAccountingPath });
  }
  const series = { schemaVersion: '0.1.0', identity: { kind: 'same-isolate', asserted: true, statement: 'Test fixture has stable unique identities.' }, rootIds: [1], points }, path = join(dir, 'series.json');
  await writeFile(path, JSON.stringify(series)); return { dir, series, path };
}

test('exact private IDs leave same-named business instances and their graph holders intact', async t => {
  const { path, series, dir } = await setup(t), accounted = await analyzeCandidateSeries(path);
  assert.equal(accounted.status, 'completed'); assert.equal(accounted.candidateGroupCount, 3); assert.equal(accounted.probeAccounting.rawCandidateGroupCount, 4);
  for (const group of accounted.groups) {
    assert.deepEqual(group.counts, [0, 1, 2, 3, 3]);
    assert.ok(group.instances.every(instance => instance.nodeId >= 200 && instance.nodeId < 300));
    for (const instance of group.instances) {
      assert.equal(instance.path.outcome, 'path-found'); assert.equal(instance.path.path.edgeCount, 2);
      assert.ok(instance.declaredGraph.immediateDominator.id >= 100 && instance.declaredGraph.immediateDominator.id < 200, 'Private holder stays in the graph');
    }
  }
  const unfilteredPath = join(dir, 'unfiltered.json'); await writeFile(unfilteredPath, JSON.stringify({ ...series, points: series.points.map(({ probeAccountingPath, ...point }) => point) }));
  const raw = await analyzeCandidateSeries(unfilteredPath);
  assert.equal(raw.candidateGroupCount, 4); assert.equal(raw.probeAccounting.applied, false);
  for (const group of accounted.groups) for (const row of group.instances) assert.equal(row.declaredGraph.retainedBytes, raw.groups.find(value => value.name === group.name).instances.find(value => value.nodeId === row.nodeId).declaredGraph.retainedBytes);
});

test('partial private accounting stays incomplete instead of certifying clean business growth', async t => {
  const { path, series } = await setup(t), last = series.points.at(-1).probeAccountingPath, data = JSON.parse(await readFile(last));
  data.complete = false; data.objects.push({ heapId: 99999, kind: 'already-collected-record' }); await writeFile(last, JSON.stringify(data));
  const result = await analyzeCandidateSeries(path);
  assert.equal(result.status, 'incomplete'); assert.equal(result.probeAccounting.completeWithinDeclaredSlots, false);
  assert.equal(result.probeAccounting.points.at(-1).absentDeclaredNodeCount, 1);
});

test('wrong snapshot, mixed epoch, duplicate IDs and missing accounting points are rejected', async t => {
  const { path, series } = await setup(t), changed = series.points.at(-1).probeAccountingPath, original = JSON.parse(await readFile(changed));
  for (const [patch, expected] of [[{ snapshotSha256: 'wrong' }, /snapshot-mismatch/], [{ epochId: 'different' }, /epoch-mismatch/], [{ objects: [...original.objects, original.objects[0]] }, /owned-id/]]) {
    await writeFile(changed, JSON.stringify({ ...original, ...patch })); await assert.rejects(analyzeCandidateSeries(path), expected);
  }
  await writeFile(changed, JSON.stringify(original)); delete series.points[0].probeAccountingPath; await writeFile(path, JSON.stringify(series));
  await assert.rejects(analyzeCandidateSeries(path), /every point/);
});
