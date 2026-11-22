import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, generatedFixture } from './helpers/incoming-oracle.mjs';
import { buildDominatorTree, analyzeDominators } from '../src/dominator.mjs';

// An independent oracle: remove a vertex, run ordinary reachability, count what disappears.
// It never imports or reimplements the dominator algorithm or production adjacency index.
function oracle(nodes, edges, roots, policy) {
  function reachable(cut = []) {
    const removed = new Set(cut), seen = new Set(), queue = roots.filter(id => !removed.has(id));
    for (const id of queue) seen.add(id);
    for (let head = 0; head < queue.length; head++) for (const edge of edges) {
      if (edge.from !== queue[head] || (policy === 'exclude-weak' && edge.type === 'weak') || removed.has(edge.to) || seen.has(edge.to)) continue;
      seen.add(edge.to); queue.push(edge.to);
    }
    return seen;
  }
  const base = reachable(), dominated = new Map();
  for (const node of nodes) if (base.has(node.id)) { const after = reachable([node.id]); dominated.set(node.id, new Set([...base].filter(id => !after.has(id)))); }
  function record(id) {
    if (!base.has(id)) return { reachable: false, retainedBytes: null, dominatedNodeCount: null, immediateDominator: null };
    const strict = [...dominated].filter(([owner, children]) => owner !== id && children.has(id)).map(([owner]) => owner);
    const nearest = strict.find(owner => strict.every(other => owner === other || dominated.get(other).has(owner)));
    const children = dominated.get(id);
    return { reachable: true, retainedBytes: nodes.filter(n => children.has(n.id)).reduce((sum, n) => sum + (n.size ?? 24), 0), dominatedNodeCount: children.size, immediateDominator: nearest === undefined ? { kind: 'virtual-root' } : { kind: 'node', id: nearest } };
  }
  function removal(cuts) { const after = reachable(cuts), gone = nodes.filter(n => base.has(n.id) && !after.has(n.id)); return { newlyUnreachableNodeCount: gone.length, newlyUnreachableBytes: gone.reduce((sum, n) => sum + (n.size ?? 24), 0) }; }
  return { record, removal, base };
}
function encode(nodes, edges, reordered = false) {
  const heap = fixture(nodes, edges, reordered), nf = heap.snapshot.meta.node_fields;
  for (let i = 0; i < nodes.length; i++) heap.nodes[i * nf.length + nf.indexOf('self_size')] = nodes[i].size ?? 24;
  return heap;
}
function compare(nodes, edges, roots, policy, reordered = false) {
  const tree = buildDominatorTree(encode(nodes, edges, reordered), { rootIds: roots, edgePolicy: policy }), reference = oracle(nodes, edges, roots, policy);
  for (const node of nodes) {
    const actual = tree.node(node.id), expected = reference.record(node.id);
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]])), expected, 'node ' + node.id);
    if (actual.reachable) assert.equal(tree.removal([node.id]).newlyUnreachableBytes, actual.retainedBytes);
  }
  for (const cuts of [[nodes[0].id], nodes.slice(1, 3).map(n => n.id), nodes.slice(-2).map(n => n.id)]) {
    const result = tree.removal(cuts), expected = reference.removal(cuts);
    assert.deepEqual({ newlyUnreachableNodeCount: result.newlyUnreachableNodeCount, newlyUnreachableBytes: result.newlyUnreachableBytes }, expected);
  }
  return tree;
}
const edge = (from, to, type = 'property', name = 'ref') => ({ from, to, type, name });

test('dominator diamond: shared resources belong to common dominator; joint removal counts once', () => {
  const nodes = [{ id: 1, name: 'root', type: 'synthetic', size: 0 }, { id: 3, name: 'holder-a', size: 10 }, { id: 5, name: 'holder-b', size: 20 }, { id: 7, name: 'shared', size: 100 }, { id: 9, name: 'child', size: 200 }];
  const tree = compare(nodes, [edge(1, 3), edge(1, 5), edge(3, 7), edge(5, 7), edge(7, 9)], [1], 'exclude-weak');
  assert.equal(tree.node(3).retainedBytes, 10); assert.equal(tree.node(5).retainedBytes, 20);
  assert.equal(tree.node(7).immediateDominator.id, 1);
  assert.equal(tree.removal([3, 5]).newlyUnreachableBytes, 330);
  assert.equal(tree.top(1)[0].id, 7);
});

test('multiple roots, a root reachable from another root, cycles, self edges and unreachable nodes', () => {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ id: i, name: 'n' + i, size: i + 1 }));
  const edges = [edge(0, 1), edge(1, 2), edge(2, 1), edge(2, 3), edge(3, 3), edge(4, 3), edge(5, 6), edge(6, 5)];
  for (const roots of [[0], [0, 1], [0, 4], [4, 0], [0, 4, 5]]) compare(nodes, edges, roots, 'exclude-weak', true);
});

test('weak versus literal edges change the graph without silently applying ephemeron semantics', () => {
  const nodes = [1, 3, 5].map(id => ({ id, name: 'n' + id })), edges = [edge(1, 3), edge(1, 5, 'weak'), edge(3, 5, 'internal')];
  const weak = compare(nodes, edges, [1], 'exclude-weak'), literal = compare(nodes, edges, [1], 'all-literal');
  assert.equal(weak.node(5).immediateDominator.id, 3); assert.equal(literal.node(5).immediateDominator.id, 1);
  assert.equal(weak.summary.policy.gcSemantics, 'not-established'); assert.equal(weak.summary.policy.excludedEdgeCount, 1);
});

test('80 deterministic graphs with reordered metadata and large IDs match deletion-reachability oracle', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const { nodes, edges } = generatedFixture(seed);
    nodes.forEach((node, i) => { node.size = (i * 7 + seed) % 41; });
    for (const policy of ['exclude-weak', 'all-literal']) compare(nodes, edges, [nodes[0].id, nodes[5].id], policy, seed % 2 === 0);
  }
});

test('all 4-node directed graphs without self edges agree with deletion oracle for one and two roots', () => {
  const nodes = [0, 1, 2, 3].map(id => ({ id, name: 'n' + id, size: id + 1 })), possible = [];
  for (const from of nodes) for (const to of nodes) if (from.id !== to.id) possible.push(edge(from.id, to.id));
  for (let mask = 0; mask < 2 ** possible.length; mask++) {
    const edges = possible.filter((_, bit) => mask & (1 << bit));
    for (const roots of [[0], [0, 1]]) {
      const tree = buildDominatorTree(encode(nodes, edges), { rootIds: roots }), reference = oracle(nodes, edges, roots, 'exclude-weak');
      for (const node of nodes) {
        const actual = tree.node(node.id), expected = reference.record(node.id);
        assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]])), expected, 'mask ' + mask + ' node ' + node.id);
      }
    }
  }
});

test('50,000-node deep chain has no recursion limit and preserves near-max-safe node IDs', () => {
  const count = 50000, nw = 5, heap = { snapshot: { meta: { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'], node_types: [['object'], 'string', 'number', 'number', 'number'], edge_fields: ['type', 'name_or_index', 'to_node'], edge_types: [['property'], 'string', 'node'] }, node_count: count, edge_count: count - 1 }, nodes: [], edges: [], strings: ['node', 'next'] };
  for (let i = 0; i < count; i++) { heap.nodes.push(0, 0, Number.MAX_SAFE_INTEGER - count + i, 8, i + 1 < count ? 1 : 0); if (i + 1 < count) heap.edges.push(0, 1, (i + 1) * nw); }
  const rootId = heap.nodes[2], tree = buildDominatorTree(heap, { rootIds: [rootId] });
  assert.equal(tree.node(rootId).retainedBytes, count * 8);
  assert.equal(tree.node(rootId + count - 1).immediateDominator.id, rootId + count - 2);
  assert.equal(tree.node(rootId + count - 1).retainedBytes, 8);
});

test('invalid roots, policies, queries, malformed graph and unsafe byte sums are refused', () => {
  const nodes = [{ id: 1, name: 'a' }, { id: 3, name: 'b' }], heap = encode(nodes, [edge(1, 3)]);
  for (const rootIds of [[], [1, 1], [1.2], [-1], ['1'], [Number.MAX_SAFE_INTEGER + 1]]) assert.throws(() => buildDominatorTree(heap, { rootIds }), e => e.code === 'invalid-root-ids');
  assert.throws(() => buildDominatorTree(heap, { rootIds: [9] }), e => e.code === 'target-not-found');
  assert.throws(() => buildDominatorTree(heap, { rootIds: [1], edgePolicy: 'gc' }), e => e.code === 'invalid-edge-policy');
  assert.throws(() => analyzeDominators(heap, { rootIds: [1], nodeIds: [1, 1] }), e => e.code === 'invalid-node-ids');
  assert.throws(() => analyzeDominators(heap, { rootIds: [1], top: 101 }), e => e.code === 'invalid-top-limit');
  assert.throws(() => analyzeDominators(heap, { rootIds: [1], cutIds: [1, 1] }), e => e.code === 'invalid-cut-ids');
  const malformed = structuredClone(heap); malformed.edges[2] = 999;
  assert.throws(() => buildDominatorTree(malformed, { rootIds: [1] }), e => e.code === 'invalid-target-offset');
  const unsafe = encode([{ id: 1, name: 'a', size: Number.MAX_SAFE_INTEGER }, { id: 3, name: 'b', size: 1 }], []);
  assert.throws(() => buildDominatorTree(unsafe, { rootIds: [1] }), e => e.code === 'unsafe-size-total');
});
