import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncomingIndex, SnapshotInputError } from '../src/incoming-index.mjs';
import { fixture, generatedFixture, scanIncoming } from './helpers/incoming-oracle.mjs';

const project = e => ({ from: e.source.id, to: e.target.id, type: e.type, name: e.nameOrIndex });
const sorted = edges => edges.map(e => JSON.stringify(e)).sort();
function small() { return fixture([{ id: 1, name: 'root', type: 'synthetic' }, { id: 2 ** 40 + 7, name: 'target' }, { id: 2 ** 40 + 9, name: 'zero' }], [{ from: 1, to: 2 ** 40 + 7, type: 'property', name: 'p' }]); }

test('incoming micrograph: zero/one/many, parallel, self/cyclic, every raw edge type and large IDs', () => {
  const high = 2 ** 52 + 1, nodes = [{ id: 1, name: 'root', type: 'synthetic' }, { id: high, name: '目标' }, { id: high + 2, name: 'isolated' }];
  const edges = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'].map((type, i) => ({ from: 1, to: high, type, name: ['element', 'hidden'].includes(type) ? 2 ** 35 + i : 'edge-' + type }));
  edges.push({ ...edges[2] }, { from: high, to: high, type: 'property', name: 'self' }, { from: high, to: 1, type: 'property', name: 'back' });
  for (const reorder of [false, true]) {
    const heap = fixture(nodes, edges, reorder), index = buildIncomingIndex(heap), oracle = scanIncoming(heap, nodes.map(n => n.id));
    for (const n of nodes) {
      const actual = index.incoming(n.id);
      assert.deepEqual(actual.edges, oracle.get(n.id));
      assert.deepEqual(sorted(actual.edges.map(project)), sorted(edges.filter(e => e.to === n.id)));
      assert.deepEqual(actual, index.incoming(n.id));
    }
    assert.equal(index.incoming(high).explicitWeakCount, 1);
    assert.equal(index.incoming(high).incomingCount, 9);
    assert.equal(index.incoming(high + 2).incomingCount, 0);
    assert.equal(index.incoming(1).incomingCount, 1);
    assert.equal(index.incoming(high).target.id, high);
  }
});

test('incoming generated graph oracle: 40 seeds, field reorder, all 760 node queries agree exactly', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { heap, nodes, edges } = generatedFixture(seed, seed % 2 === 0), index = buildIncomingIndex(heap), scan = scanIncoming(heap, nodes.map(n => n.id));
    for (const n of nodes) {
      const actual = index.incoming(n.id).edges;
      assert.deepEqual(actual, scan.get(n.id), 'independent full-edge scan, seed ' + seed);
      assert.deepEqual(sorted(actual.map(project)), sorted(edges.filter(e => e.to === n.id)), 'logical graph oracle, seed ' + seed);
      // Each full-edge equality includes source, target, type, name and raw offsets.
    }
  }
});

test('incoming rejects malformed graph structure, unsafe IDs, unknown types and offsets with codes', () => {
  const checks = [
    [h => { h.nodes.pop(); }, 'invalid-array-length'],
    [h => { h.edges.push(0); }, 'invalid-array-length'],
    [h => { h.snapshot.node_count++; }, 'count-mismatch'],
    [h => { h.snapshot.edge_count++; }, 'count-mismatch'],
    [h => { h.nodes[7] = 1; }, 'duplicate-node-id'],
    [h => { h.nodes[2] = Number.MAX_SAFE_INTEGER + 1; }, 'invalid-node'],
    [h => { h.nodes[2] = -1; }, 'invalid-node'],
    [h => { h.nodes[0] = 99; }, 'invalid-node'],
    [h => { h.nodes[1] = 99; }, 'invalid-node'],
    [h => { h.nodes[4] = 99; }, 'edge-count-mismatch'],
    [h => { h.nodes[4] = 0; }, 'edge-count-mismatch'],
    [h => { h.nodes[4] = -1; }, 'invalid-node'],
    [h => { h.edges[0] = 99; }, 'invalid-edge-type'],
    [h => { h.edges[1] = 99; }, 'invalid-edge-name'],
    [h => { h.edges[2] = 6; }, 'invalid-target-offset'],
    [h => { h.edges[2] = 15; }, 'invalid-target-offset'],
    [h => { h.edges[2] = -5; }, 'invalid-target-offset'],
    [h => { h.strings[0] = null; }, 'invalid-string-table'],
    [h => { h.snapshot.meta.node_fields[2] = 'name'; }, 'invalid-metadata'],
    [h => { h.snapshot.meta.edge_fields[2] = 'other'; }, 'invalid-metadata'],
    [h => { h.snapshot.meta.edge_types[0].push('unverified'); }, 'unsupported-edge-type'],
    [h => { h.snapshot.meta.node_types[0] = null; }, 'invalid-metadata'],
  ];
  for (const [mutate, code] of checks) { const heap = small(); mutate(heap); assert.throws(() => buildIncomingIndex(heap), e => e instanceof SnapshotInputError && e.code === code, code); }
  assert.throws(() => buildIncomingIndex(null), e => e.code === 'invalid-structure');
  assert.throws(() => buildIncomingIndex(small()).incoming(999), e => e.code === 'target-not-found');
  for (const id of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => buildIncomingIndex(small()).incoming(id), e => e.code === 'invalid-node-id');
});

test('incoming preserves a weak-only edge and a numeric name without implying GC retention', () => {
  const h = fixture([{ id: 1, name: 'a' }, { id: 3, name: 'b' }], [{ from: 1, to: 3, type: 'weak', name: 'w' }, { from: 1, to: 1, type: 'hidden', name: 2 ** 40 }]);
  const index = buildIncomingIndex(h), weak = index.incoming(3);
  assert.equal(weak.incomingCount, 1); assert.equal(weak.explicitWeakCount, 1); assert.equal(Object.hasOwn(weak, 'leak'), false);
  assert.equal(index.incoming(1).edges[0].nameOrIndex, 2 ** 40);
});
