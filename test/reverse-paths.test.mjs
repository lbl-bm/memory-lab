import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncomingIndex } from '../src/incoming-index.mjs';
import { searchReversePaths } from '../src/reverse-paths.mjs';
import { fixture, scanIncoming } from './helpers/incoming-oracle.mjs';
const graph = (ids, edges, reorder = false) => fixture(ids.map((id, i) => ({ id, name: 'node-' + id, type: i ? 'object' : 'synthetic' })), edges.map(e => ({ type: 'property', name: 'p', ...e })), reorder);
const search = (heap, target, options = {}) => searchReversePaths(buildIncomingIndex(heap), target, { rootIds: [1], ...options });
function validatePath(heap, result) {
  const p = result.path;
  if (!p) return;
  assert.equal(p.nodes.length, p.edges.length + 1);
  assert.equal(p.nodes[0].id, p.declaredRootId); assert.equal(p.nodes.at(-1).id, p.targetId);
  assert.ok(result.declaration.roots.some(n => n.id === p.declaredRootId));
  assert.equal(new Set(p.nodes.map(n => n.id)).size, p.nodes.length);
  const raw = scanIncoming(heap, p.nodes.map(n => n.id));
  p.edges.forEach((e, i) => { assert.equal(e.source.id, p.nodes[i].id); assert.equal(e.target.id, p.nodes[i + 1].id); assert.deepEqual(e, raw.get(e.target.id).find(r => r.edgeOffset === e.edgeOffset)); });
}

test('reverse paths choose one shortest path, deterministic parallel-edge tie, multiple declared stops', () => {
  const h = graph([1, 2, 3, 4, 5], [{ from: 1, to: 2 }, { from: 1, to: 3, name: 'first' }, { from: 1, to: 3, name: 'parallel' }, { from: 2, to: 5 }, { from: 5, to: 4 }, { from: 3, to: 4 }], true);
  const r = search(h, 4); assert.equal(r.outcome, 'path-found'); assert.deepEqual(r.path.nodes.map(n => n.id), [1, 3, 4]); assert.equal(r.path.edges[0].nameOrIndex, 'first'); validatePath(h, r);
  assert.deepEqual(r, search(h, 4));
  const arbitrary = search(h, 4, { rootIds: [1, 3] }); assert.equal(arbitrary.path.declaredRootId, 3); assert.equal(arbitrary.declaration.gcRootStatus, 'not-verified');
  const zero = search(h, 4, { rootIds: [4], maxDepth: 0, maxNodes: 1, maxEdges: 0 }); assert.equal(zero.path.edgeCount, 0); assert.equal(zero.stats.examinedEdges, 0);
});

test('reverse paths terminate on self-loops, cycles, parallel branches and absent reachability', () => {
  const h = graph([1, 2, 3, 4], [{ from: 2, to: 3 }, { from: 2, to: 3 }, { from: 3, to: 2 }, { from: 3, to: 3 }]);
  const r = search(h, 3); assert.equal(r.outcome, 'no-path-under-policy'); assert.equal(r.stopReason, 'frontier-exhausted'); assert.equal(r.stats.discoveredNodes, 2); assert.equal(r.stats.examinedEdges, 4); assert.equal(r.stats.selfEdges, 1); assert.equal(r.stats.alreadyVisitedSources, 3);
  const isolated = search(h, 4, { maxDepth: 0, maxNodes: 1, maxEdges: 0 }); assert.equal(isolated.outcome, 'no-path-under-policy'); assert.equal(isolated.stats.zeroIncomingNodes, 1);
  const loop = graph([1, 2], [{ from: 2, to: 2 }]); assert.equal(search(loop, 2, { maxDepth: 0, maxEdges: 1 }).outcome, 'no-path-under-policy');
  const connected = graph([1, 2, 3], [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 2 }]); const found = search(connected, 3); assert.equal(found.path.edgeCount, 2); validatePath(connected, found);
});

test('reverse budgets distinguish exact boundary completion from unknown truncated results', () => {
  const h = graph([1, 2, 3], [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
  const exact = search(h, 3, { maxDepth: 2, maxNodes: 3, maxEdges: 2 }); assert.equal(exact.outcome, 'path-found'); validatePath(h, exact);
  for (const [option, value, reason] of [['maxDepth', 1, 'depth-limit'], ['maxNodes', 2, 'node-limit'], ['maxEdges', 1, 'edge-limit']]) {
    const r = search(h, 3, { [option]: value }); assert.equal(r.outcome, 'incomplete'); assert.equal(r.stopReason, reason); assert.equal(r.path, null); assert.equal(r.completeness, 'incomplete-bounded-prefix');
  }
  const dead = graph([1, 2, 3], [{ from: 2, to: 3 }]); assert.equal(search(dead, 3, { maxDepth: 1, maxNodes: 2, maxEdges: 1 }).outcome, 'no-path-under-policy');
  const mixed = graph([1, 2, 3, 4, 5], [{ from: 2, to: 3 }, { from: 3, to: 4 }, { from: 5, to: 4 }]);
  const bounded = search(mixed, 4, { maxDepth: 1 }); assert.equal(bounded.outcome, 'incomplete'); assert.equal(bounded.stopReason, 'depth-limit'); assert.equal(bounded.stats.zeroIncomingNodes, 1);
  assert.equal(search(mixed, 4).outcome, 'no-path-under-policy');
});

test('reverse edge policy preserves raw categories and explicitly marks weak-only paths', () => {
  for (const type of ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']) {
    const h = graph([1, 3], [{ from: 1, to: 3, type, name: ['element', 'hidden'].includes(type) ? 2 ** 40 : 'edge' }], true), excluded = search(h, 3), all = search(h, 3, { edgePolicy: 'all-literal' });
    assert.equal(all.outcome, 'path-found'); assert.equal(all.path.edges[0].type, type); validatePath(h, all);
    assert.equal(all.policy.nativeEphemeronAndShortcutStrength, 'unknown');
    if (type === 'weak') { assert.equal(excluded.outcome, 'no-path-under-policy'); assert.equal(excluded.stats.explicitWeakSkipped, 1); assert.equal(all.path.explicitWeakEdges, 1); }
    else assert.equal(excluded.outcome, 'path-found');
  }
});

test('reverse high fan-in consumes lazy parents within budget and never calls materializing incoming', () => {
  const parents = Array.from({ length: 300 }, (_, i) => i + 10), h = graph([1, ...parents, 1001], parents.map(from => ({ from, to: 1001 }))), index = buildIncomingIndex(h);
  index.incoming = () => { throw new Error('Must not materialize incoming parents'); };
  let yields = 0; const iterator = index.incomingEdges; index.incomingEdges = function* (id) { for (const e of iterator(id)) { yields++; yield e; } };
  const r = searchReversePaths(index, 1001, { rootIds: [1], maxEdges: 3 }); assert.equal(r.stopReason, 'edge-limit'); assert.equal(r.stats.examinedEdges, 3); assert.equal(yields, 4); assert.equal(r.stats.discoveredNodes, 4);
  const nodes = search(h, 1001, { maxNodes: 3 }); assert.equal(nodes.stopReason, 'node-limit'); assert.equal(nodes.stats.discoveredNodes, 3);
});

test('reverse invalid declarations/options fail explicitly instead of guessing a root', () => {
  const h = graph([1, 3], [{ from: 1, to: 3 }]), index = buildIncomingIndex(h);
  for (const rootIds of [undefined, [], [1, 1], [-1], [1.1], ['1'], [Number.MAX_SAFE_INTEGER + 1]]) assert.throws(() => searchReversePaths(index, 3, { rootIds }), e => e.code === 'invalid-root-ids');
  assert.throws(() => search(h, 3, { rootIds: [999] }), e => e.code === 'root-not-found');
  assert.throws(() => search(h, 999), e => e.code === 'target-not-found');
  assert.throws(() => search(h, 3, { edgePolicy: 'strong' }), e => e.code === 'invalid-edge-policy');
  assert.throws(() => search(h, 3, { guessedRoot: 1 }), e => e.code === 'invalid-search-options');
  for (const options of [{ maxDepth: 65 }, { maxDepth: -1 }, { maxDepth: 1.5 }, { maxNodes: 0 }, { maxNodes: 50001 }, { maxEdges: -1 }, { maxEdges: 200001 }, { maxEdges: NaN }]) assert.throws(() => search(h, 3, options), e => e.code === 'invalid-search-limit');
});

test('reverse generated logical-graph Floyd-Warshall oracle agrees for 448 policy/target queries', () => {
  for (let seed = 1; seed <= 32; seed++) {
    let state = seed; const next = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
    const ids = Array.from({ length: 7 }, (_, i) => 2 ** 40 + seed * 100 + i), edges = Array.from({ length: 15 }, (_, i) => ({ from: ids[next(7)], to: ids[next(7)], type: next(3) === 0 ? 'weak' : i % 2 ? 'internal' : 'property', name: 'e-' + i }));
    const h = graph(ids, edges, seed % 2 === 0);
    for (const policy of ['exclude-weak', 'all-literal']) {
      const d = ids.map((_, i) => ids.map((__, j) => i === j ? 0 : Infinity));
      for (const e of edges) if (policy === 'all-literal' || e.type !== 'weak') { const a = ids.indexOf(e.from), b = ids.indexOf(e.to); d[a][b] = Math.min(d[a][b], 1); }
      for (let k = 0; k < 7; k++) for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) d[i][j] = Math.min(d[i][j], d[i][k] + d[k][j]);
      for (let j = 0; j < 7; j++) {
        const expected = Math.min(d[0][j], d[3][j]), r = search(h, ids[j], { rootIds: [ids[0], ids[3]], edgePolicy: policy });
        assert.equal(r.outcome, Number.isFinite(expected) ? 'path-found' : 'no-path-under-policy');
        if (Number.isFinite(expected)) { assert.equal(r.path.edgeCount, expected); validatePath(h, r); }
      }
    }
  }
});
