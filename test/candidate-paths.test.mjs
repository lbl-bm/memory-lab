import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, generatedFixture } from './helpers/incoming-oracle.mjs';
import { buildIncomingIndex } from '../src/incoming-index.mjs';
import { searchCandidatePaths, searchCandidatePathsWithFallback } from '../src/candidate-paths.mjs';

test('batch paths share a traversal and match independent full-edge shortest distances', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const { heap, nodes, edges } = generatedFixture(seed, seed % 2 === 0), roots = [nodes[0].id, nodes[5].id];
    const distances = new Map(roots.map(id => [id, 0])), queue = [...roots];
    for (let head = 0; head < queue.length; head++) for (const edge of edges) if (edge.from === queue[head] && edge.type !== 'weak' && !distances.has(edge.to)) { distances.set(edge.to, distances.get(edge.from) + 1); queue.push(edge.to); }
    const result = searchCandidatePaths(heap, buildIncomingIndex(heap), nodes.map(node => node.id), roots);
    assert.ok(result.stats.examinedEdges <= edges.length, 'Each literal edge is examined at most once');
    for (const node of nodes) {
      const actual = result.results.get(node.id);
      assert.equal(actual.outcome, distances.has(node.id) ? 'path-found' : 'no-path-under-policy');
      if (actual.path) { assert.equal(actual.path.edgeCount, distances.get(node.id)); assert.ok(roots.includes(actual.path.nodes[0].id)); assert.equal(actual.path.nodes.at(-1).id, node.id); }
    }
  }
});

test('batch search reports edge, node and depth bounds without calling absent paths releases', () => {
  const nodes = [1, 3, 5, 7].map(id => ({ id, name: 'n' + id })), edges = [{ from: 1, to: 3, type: 'property', name: 'a' }, { from: 3, to: 5, type: 'property', name: 'b' }, { from: 1, to: 7, type: 'weak', name: 'weak' }];
  const heap = fixture(nodes, edges), index = buildIncomingIndex(heap);
  for (const limits of [{ maxEdges: 0 }, { maxNodes: 1 }, { maxDepth: 0 }]) assert.equal(searchCandidatePaths(heap, index, [5], [1], limits).results.get(5).outcome, 'incomplete');
  const result = searchCandidatePaths(heap, index, [1, 3, 5, 7], [1]);
  assert.equal(result.results.get(1).path.edgeCount, 0); assert.equal(result.results.get(7).outcome, 'no-path-under-policy');
  assert.throws(() => searchCandidatePaths(heap, index, [5], [1], { maxEdges: 200001 }), /limit/);
});

test('broad-root node cap falls back within the same edge budget', () => {
  const nodes = [1, 3, 5, 7].map(id => ({ id, name: 'n' + id }));
  const heap = fixture(nodes, [{ from: 1, to: 3, type: 'property', name: 'noise' }, { from: 1, to: 5, type: 'property', name: 'owner' }, { from: 5, to: 7, type: 'property', name: 'value' }]), index = buildIncomingIndex(heap);
  const limited = searchCandidatePaths(heap, index, [7], [1], { maxNodes: 3, maxEdges: 10 });
  assert.equal(limited.results.get(7).outcome, 'incomplete');
  const fallback = searchCandidatePathsWithFallback(heap, index, [7], [1], { maxNodes: 3, maxEdges: 10 });
  assert.equal(fallback.results.get(7).outcome, 'path-found'); assert.equal(fallback.results.get(7).path.edgeCount, 2);
  assert.equal(fallback.fallback.searches, 1); assert.equal(fallback.stats.examinedEdges, 3);
  const exhausted = searchCandidatePathsWithFallback(heap, index, [7], [1], { maxNodes: 3, maxEdges: 1 });
  assert.equal(exhausted.results.get(7).outcome, 'incomplete'); assert.equal(exhausted.stats.examinedEdges, 1); assert.equal(exhausted.fallback.searches, 1);
});

test('a meeting path without a shortest-distance proof stays incomplete when budget expires', () => {
  const nodes = Array.from({ length: 13 }, (_, i) => ({ id: i + 1, name: 'node-' + i }));
  // Forward prefix reaches B (3) at depth 2, but does not expand X (12).
  // Reverse sees B -> target before the shorter X -> target behind weak noise.
  const edges = [{ from: 1, to: 2, type: 'property', name: 'a' }, { from: 1, to: 12, type: 'property', name: 'x' },
    { from: 2, to: 3, type: 'property', name: 'b' }, { from: 3, to: 13, type: 'property', name: 'long' },
    ...Array.from({ length: 8 }, (_, i) => ({ from: i + 4, to: 13, type: 'weak', name: 'weak' })), { from: 12, to: 13, type: 'property', name: 'short' }];
  const heap = fixture(nodes, edges), index = buildIncomingIndex(heap);
  const stopped = searchCandidatePathsWithFallback(heap, index, [13], [1], { maxEdges: 12 });
  assert.equal(stopped.forward.completeRadius, 1); assert.equal(stopped.results.get(13).outcome, 'incomplete'); assert.equal(stopped.results.get(13).path, null);
  assert.equal(stopped.stats.examinedEdges, 12);
  const witness = stopped.results.get(13).witnessPath;
  assert.equal(witness.edgeCount, 3); assert.equal(witness.shortestStatus, 'not-proven');
  assert.deepEqual(witness.nodes.map(node => node.id), [1, 2, 3, 13]);
  assert.equal(stopped.results.get(13).shortestProof, null);
  assert.equal(stopped.fallback.certifiedPaths, 0); assert.equal(stopped.fallback.witnessPaths, 1);
  for (const edge of witness.edges) assert.ok(edges.some(original => original.from === edge.source.id && original.to === edge.target.id && original.type === edge.type && original.name === edge.nameOrIndex && original.type !== 'weak'));
  const proved = searchCandidatePathsWithFallback(heap, index, [13], [1], { maxEdges: 15 });
  assert.equal(proved.results.get(13).path.edgeCount, 2); assert.equal(proved.results.get(13).shortestProof.kind, 'bidirectional-distance-bound');
  assert.equal(proved.results.get(13).witnessPath, undefined); assert.equal(proved.fallback.witnessPaths, 0);
});

test('bounded edge slices give a direct-root target a turn behind a high-degree target', () => {
  const nodes = Array.from({ length: 133 }, (_, i) => ({ id: i + 1, name: 'node-' + i }));
  const edges = [...Array.from({ length: 32 }, (_, i) => ({ from: 1, to: i + 4, type: 'weak', name: 'rootNoise' + i })),
    { from: 1, to: 3, type: 'property', name: 'direct' },
    ...Array.from({ length: 130 }, (_, i) => ({ from: i + 4, to: 2, type: 'weak', name: 'incomingNoise' + i }))];
  const heap = fixture(nodes, edges), index = buildIncomingIndex(heap);
  for (const targets of [[2, 3], [3, 2]]) {
    const result = searchCandidatePathsWithFallback(heap, index, targets, [1], { maxEdges: 128 });
    assert.equal(result.results.get(3).outcome, 'path-found');
    assert.equal(result.results.get(3).path.edgeCount, 1);
    assert.equal(result.results.get(2).outcome, 'incomplete');
    assert.equal(result.fallback.searches, 2);
    assert.equal(result.stats.examinedEdges, 128);
    assert.equal(result.forward.examinedEdges, 32); assert.equal(result.fallback.examinedEdges, 96);
  }
});

test('bidirectional results and total budget match independent oracle across 2100 bounded cases', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const { heap, nodes, edges } = generatedFixture(seed, Boolean(seed % 2)), roots = [nodes[0].id, nodes[5].id], index = buildIncomingIndex(heap);
    const distance = new Map(roots.map(id => [id, 0])), queue = [...roots];
    for (let head = 0; head < queue.length; head++) for (const edge of edges) if (edge.from === queue[head] && edge.type !== 'weak' && !distance.has(edge.to)) { distance.set(edge.to, distance.get(edge.from) + 1); queue.push(edge.to); }
    for (const maxEdges of [0, 1, 7, 15, 40, 100, 200]) for (const maxNodes of [2, 5, 19]) {
      const maxDepth = seed % 6, result = searchCandidatePathsWithFallback(heap, index, nodes.map(node => node.id), roots, { maxEdges, maxNodes, maxDepth });
      assert.ok(result.stats.examinedEdges <= maxEdges); assert.equal(result.stats.examinedEdges, result.forward.examinedEdges + result.fallback.examinedEdges);
      assert.ok(result.fallback.maximumDiscoveredNodes <= maxNodes);
      assert.equal(result.fallback.witnessPaths, [...result.results.values()].filter(row => row.witnessPath).length);
      for (const [id, row] of result.results) {
        if (row.outcome === 'path-found') {
          assert.equal(row.path.edgeCount, distance.get(id)); assert.ok(row.path.edgeCount <= maxDepth);
          assert.ok(roots.includes(row.path.nodes[0].id)); assert.equal(row.path.nodes.at(-1).id, id);
          for (const edge of row.path.edges) assert.ok(edges.some(original => original.from === edge.source.id && original.to === edge.target.id && original.type === edge.type && original.type !== 'weak'));
        }
        if (row.outcome === 'no-path-under-policy') assert.equal(distance.has(id), false);
        if (row.witnessPath) {
          const path = row.witnessPath;
          assert.equal(row.outcome, 'incomplete'); assert.equal(row.path, null); assert.equal(row.shortestProof, null);
          assert.equal(path.shortestStatus, 'not-proven');
          assert.ok(distance.has(id)); assert.ok(path.edgeCount >= distance.get(id)); assert.ok(path.edgeCount <= maxDepth);
          assert.equal(path.nodes.length, path.edges.length + 1); assert.equal(path.edgeCount, path.edges.length);
          assert.equal(new Set(path.nodes.map(node => node.id)).size, path.nodes.length);
          assert.ok(roots.includes(path.nodes[0].id)); assert.equal(path.nodes.at(-1).id, id);
          path.edges.forEach((edge, i) => {
            assert.equal(edge.source.id, path.nodes[i].id); assert.equal(edge.target.id, path.nodes[i + 1].id);
            assert.ok(edges.some(original => original.from === edge.source.id && original.to === edge.target.id && original.type === edge.type && original.name === edge.nameOrIndex && original.type !== 'weak'));
          });
        }
      }
    }
  }
});
