import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers/incoming-oracle.mjs';
import { analyzeCandidateSeries } from '../src/candidates.mjs';

async function series(t, moving = false) {
  const directory = await mkdtemp(join(tmpdir(), 'candidate-family-series-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const points = [];
  for (let stage = 0; stage < 5; stage++) {
    const cycle = Math.min(stage, 3);
    const nodes = [{ id: 1, type: 'synthetic', name: 'root' }, { id: 1001, name: 'Object' }, { id: 1003, name: 'Object' }];
    const edges = [1001, 1003].map(to => ({ from: 1, to, name: 'prototype-' + to, type: 'property' }));
    for (let slot = 1; slot <= 3; slot++) {
      const growing = slot <= cycle, id = moving || !growing ? 10 + slot : 100 + slot;
      nodes.push({ id, name: 'e' });
      edges.push({ from: 1, to: id, type: 'property', name: 'slot-' + slot }, { from: id, to: growing ? 1003 : 1001, type: 'property', name: '__proto__' });
    }
    const path = join(directory, stage + '.heapsnapshot'); await writeFile(path, JSON.stringify(fixture(nodes, edges, stage % 2 === 1)));
    points.push({ path, phase: stage === 0 ? 'baseline' : stage === 4 ? 'followup' : 'back', cycle });
  }
  const path = join(directory, 'series.json');
  await writeFile(path, JSON.stringify({ schemaVersion: '0.1.0', identity: { kind: 'same-isolate', asserted: true, statement: 'Logical fixture preserves IDs across snapshots.' }, rootIds: [1], points }));
  return path;
}

test('a declining same-name family cannot mask another family growing under the same name', async t => {
  const result = await analyzeCandidateSeries(await series(t));
  const group = result.groups.find(value => value.instances.some(instance => instance.nodeId === 101));
  assert.ok(group, 'The aggregate name remains 3/3/3/3, but a separate edge-defined family grows');
  assert.deepEqual(group.counts, [0, 1, 2, 3, 3]);
  assert.deepEqual(group.instances.map(instance => instance.nodeId), [101, 102, 103]);
  assert.ok(group.instances.every(instance => instance.path.outcome === 'path-found'));
});

test('moving baseline objects to another prototype family does not create newly allocated candidates', async t => {
  const result = await analyzeCandidateSeries(await series(t, true));
  assert.equal(result.selectedInstanceCount, 0);
  assert.ok(result.groups.some(group => group.name === 'e' && group.netGrowth === 3));
  assert.ok(result.groups.every(group => group.instances.length === 0));
});
