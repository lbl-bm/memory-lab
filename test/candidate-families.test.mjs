import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/incoming-oracle.mjs';
import { censusCandidateFamilies } from '../src/candidate-families.mjs';

const key = id => JSON.stringify(['object', 'direct-prototype-edge', id]);
const fallback = name => JSON.stringify(['object', 'name-fallback', name]);
const proto = (from, to, type = 'property') => ({ from, to, type, name: '__proto__' });

test('same minified name splits by direct edge target; layout and shape do not define identity', () => {
  for (const reordered of [false, true]) {
    const heap = fixture([{ id: 1, name: 'root', type: 'synthetic' }, { id: 11, name: 'e' }, { id: 13, name: 'e' }, { id: 15, name: 'e' }, { id: 101, name: 'Object' }, { id: 201, name: 'Object' }],
      [proto(11, 101), proto(13, 101), proto(15, 201), { from: 11, to: 201, type: 'internal', name: 'map' }, { from: 13, to: 101, type: 'internal', name: 'map' }], reordered);
    const before = JSON.stringify(heap), result = censusCandidateFamilies(heap, { keys: new Set([key(101), key(201)]) });
    assert.equal(result.groups.get(key(101)).count, 2); assert.equal(result.groups.get(key(201)).count, 1);
    assert.deepEqual([...result.byGroup.get(key(101))], [11, 13]); assert.deepEqual([...result.byGroup.get(key(201))], [15]);
    assert.deepEqual([...result.allIds], [11, 13, 15, 101, 201]);
    assert.equal(result.metadata.resolvedObjectCount, 3); assert.equal(JSON.stringify(heap), before);
  }
});

test('shared prototype-edge targets merge even when display names or constructor properties differ', () => {
  const heap = fixture([{ id: 11, name: 'Alpha' }, { id: 13, name: 'Beta' }, { id: 101, name: 'Shared' }, { id: 201, name: 'CtorA', type: 'closure' }, { id: 203, name: 'CtorB', type: 'closure' }],
    [proto(11, 101), proto(13, 101), { from: 11, to: 201, type: 'property', name: 'constructor' }, { from: 13, to: 203, type: 'property', name: 'constructor' }]);
  const result = censusCandidateFamilies(heap);
  assert.equal(result.groups.get(key(101)).count, 2); assert.equal(result.groups.get(key(101)).name, 'Alpha');
  assert.equal(result.byGroup.size, 0);
  assert.match(result.metadata.interpretation, /does not certify/);
});

test('missing, duplicate, own shadow and non-object targets stay in conservative name fallback', () => {
  const heap = fixture([{ id: 11, name: 'e' }, { id: 13, name: 'e' }, { id: 15, name: 'e' }, { id: 17, name: 'e' }, { id: 101, name: 'Object' }, { id: 201, name: 'null', type: 'synthetic' }],
    [proto(13, 101), proto(13, 101), proto(15, 101), proto(15, 201), proto(17, 201)]);
  const result = censusCandidateFamilies(heap, { keys: new Set([fallback('e')]) });
  assert.equal(result.groups.get(fallback('e')).count, 4);
  assert.deepEqual(result.groups.get(fallback('e')).family.reasonCounts, { missing: 1, multiple: 2, 'non-object-target': 1 });
  assert.deepEqual([...result.byGroup.get(fallback('e'))], [11, 13, 15, 17]);
});

test('only literal property edges qualify; a single own data edge is not asserted to be a JS prototype', () => {
  const heap = fixture([{ id: 11, name: 'OwnData' }, { id: 13, name: 'WeakOnly' }, { id: 15, name: 'InternalOnly' }, { id: 101, name: 'FunctionObject', type: 'closure' }],
    [proto(11, 101), proto(13, 101, 'weak'), proto(15, 101, 'internal')]);
  const result = censusCandidateFamilies(heap);
  assert.equal(result.groups.get(key(101)).count, 1); assert.equal(result.groups.get(fallback('WeakOnly')).count, 1);
  assert.equal(result.groups.get(fallback('InternalOnly')).count, 1);
  assert.equal(result.groups.get(key(101)).family.kind, 'direct-prototype-edge');
});

test('exact exclusions leave raw object identities and same-named business members intact', () => {
  const heap = fixture([{ id: 11, name: 'e' }, { id: 13, name: 'e' }, { id: 101, name: 'Object' }], [proto(11, 101), proto(13, 101)]);
  const result = censusCandidateFamilies(heap, { excludedIds: new Set([11, 101]), keys: new Set([key(101)]) });
  assert.equal(result.groups.get(key(101)).count, 1); assert.deepEqual([...result.byGroup.get(key(101))], [13]);
  assert.deepEqual([...result.allIds], [11, 13, 101]); assert.equal(result.metadata.excludedObjectCount, 2);
  assert.equal(result.rawGroups.get(key(101)).count, 2); assert.equal(result.rawGroups.get(fallback('Object')).count, 1);
  assert.notEqual(result.groups.get(key(101)), result.rawGroups.get(key(101)));
});

test('changed literal prototype edge changes family; same target across snapshots stays stable', () => {
  const nodes = [{ id: 11, name: 'e' }, { id: 101, name: 'Object' }, { id: 201, name: 'Object' }];
  const first = censusCandidateFamilies(fixture(nodes, [proto(11, 101)]));
  const changedName = censusCandidateFamilies(fixture([{ ...nodes[0], name: 'renamed' }, ...nodes.slice(1)], [proto(11, 101)]));
  const changedTarget = censusCandidateFamilies(fixture(nodes, [proto(11, 201)]));
  assert.equal(first.groups.get(key(101)).count, 1); assert.equal(changedName.groups.get(key(101)).count, 1);
  assert.equal(changedTarget.groups.has(key(101)), false); assert.equal(changedTarget.groups.get(key(201)).count, 1);
});

test('malformed graphs fail before grouping rather than guessing edge boundaries', () => {
  const base = fixture([{ id: 11, name: 'e' }, { id: 101, name: 'Object' }], [proto(11, 101)]);
  const mutate = action => { const heap = structuredClone(base); action(heap); assert.throws(() => censusCandidateFamilies(heap)); };
  mutate(heap => { heap.edges[2] = 1; });
  mutate(heap => { heap.nodes[7] = 11; });
  mutate(heap => { heap.nodes[4] = 0; });
  mutate(heap => { heap.snapshot.meta.node_fields[1] = 'type'; });
  mutate(heap => { heap.snapshot.edge_count++; });
});
