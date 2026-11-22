import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/incoming-oracle.mjs';
import { buildIncomingIndex } from '../src/incoming-index.mjs';
import { searchReversePaths } from '../src/reverse-paths.mjs';
import { collectCandidateSourceHints } from '../src/candidate-source-hints.mjs';

function graph(reordered = false, shift = 0) {
  const nodes = [{ id: 1, name: 'root', type: 'synthetic' }, { id: 3, name: 'holder', type: 'closure' }, { id: 5, name: 'payload' }, { id: 7, name: 'unrelated', type: 'closure' }].map(node => ({ ...node, id: node.id + shift }));
  const edges = [{ from: 1, to: 3, type: 'property', name: 'callback' }, { from: 3, to: 5, type: 'context', name: 'retained' }, { from: 5, to: 7, type: 'property', name: 'irrelevantMethod' }].map(edge => ({ ...edge, from: edge.from + shift, to: edge.to + shift }));
  const heap = fixture(nodes, edges, reordered), width = heap.snapshot.meta.node_fields.length;
  heap.snapshot.meta.location_fields = ['column', 'script_id', 'object_index', 'line'];
  heap.locations = [8, 42, width, 10, 0, 99, width * 2, 20, 4, 55, width * 3, 30];
  const index = buildIncomingIndex(heap), instances = [{ nodeId: 5 + shift, path: searchReversePaths(index, 5 + shift, { rootIds: [1 + shift] }) }];
  return { heap, index, instances };
}

test('automatic candidate path yields direct V8 definition positions and optional script labels only', () => {
  const { heap, index, instances } = graph();
  const result = collectCandidateSourceHints(heap, instances, { scripts: [{ scriptId: '42', url: 'http://localhost/app.js', startLine: 0, startColumn: 0 }] }, index);
  const row = result.records[0];
  assert.equal(row.status, 'hints'); assert.equal(row.hints.length, 2);
  assert.deepEqual(row.hints.map(hint => hint.nodeId), [3, 5]);
  assert.equal(row.hints[0].generated.url, 'http://localhost/app.js');
  assert.equal(row.hints[0].generated.line, 11); assert.equal(row.hints[0].generated.column, 9);
  assert.equal(row.hints[0].allocationStack, 'not-collected'); assert.equal(row.hints[0].retainingWrite, 'not-observed'); assert.equal(row.hints[0].originalSource, 'not-mapped');
  assert.equal(row.hints[1].scriptMetadata.reason, 'script-id-not-recorded');
  assert.equal(result.coverage.validatedPathEdges, 2); assert.equal(row.coverage.missingLocations, 1);
  assert.ok(!row.hints.some(hint => hint.nodeId === 7), 'Off-path property functions are not candidates');
});

test('metadata order, large object IDs and missing script URLs preserve raw script coordinates', () => {
  const { heap, instances } = graph(true, 2 ** 40);
  const hints = collectCandidateSourceHints(heap, instances, { scripts: [{ scriptId: '42', url: '' }] }).records[0].hints;
  assert.equal(hints[0].nodeId, 2 ** 40 + 3); assert.deepEqual(hints[0].location, { scriptId: '42', line: 10, column: 8 });
  assert.equal(hints[0].scriptMetadata.reason, 'script-url-unavailable'); assert.equal(hints[0].generated.url, null);
});

test('missing paths and missing V8 locations remain unknown instead of fabricated source positions', () => {
  const { heap, instances } = graph();
  assert.equal(collectCandidateSourceHints(heap, [{ ...instances[0], path: { outcome: 'incomplete', path: null } }]).records[0].unknownReasons[0], 'candidate-path-unavailable');
  heap.locations = []; const empty = collectCandidateSourceHints(heap, instances);
  assert.equal(empty.records[0].status, 'unknown'); assert.equal(empty.records[0].unknownReasons[0], 'no-location-on-reported-path');
  delete heap.locations; const absent = collectCandidateSourceHints(heap, instances);
  assert.equal(absent.records[0].unknownReasons[0], 'missing-location-metadata'); assert.equal(absent.records[0].coverage.pathValidated, true);
});

test('a literal witness provides definition hints without promoting an incomplete search to a shortest proof', () => {
  const { heap, instances } = graph();
  const witnessPath = { ...instances[0].path.path, shortestStatus: 'not-proven' };
  instances[0].path = { outcome: 'incomplete', path: null, witnessPath, shortestProof: null, stopReason: 'edge-limit' };
  const result = collectCandidateSourceHints(heap, instances);
  assert.equal(result.records[0].hints.length, 2);
  assert.equal(result.records[0].coverage.pathKind, 'literal-witness-shortest-not-proven');
  assert.equal(result.records[0].coverage.pathValidated, true);
  assert.equal(instances[0].path.outcome, 'incomplete'); assert.equal(instances[0].path.shortestProof, null);
  witnessPath.edges[0].nameOrIndex = 'forged';
  assert.throws(() => collectCandidateSourceHints(heap, instances), /candidate-source-edge-mismatch/);
});

test('stale path nodes, literal edges, weak edges and wrong targets are rejected even without locations', () => {
  for (const mutate of [r => { r.path.path.nodes[1].name = 'forged'; }, r => { r.path.path.edges[0].nameOrIndex = 'other'; }, r => { r.path.path.edges[1].edgeIndex = 0; }, r => { r.path.path.targetId = 3; }, r => { r.path.path.declaredRootId = 999; }, r => { r.path.path.edges[0].type = 'weak'; }]) {
    const { heap, instances } = graph(); delete heap.locations; mutate(instances[0]);
    assert.throws(() => collectCandidateSourceHints(heap, instances), /candidate-source-(node|edge|path)|invalid-candidate-source-path/);
  }
});

test('position caps are explicit and spread output across candidates without borrowing neighboring locations', () => {
  const { heap, index, instances } = graph();
  instances.push({ nodeId: 3, path: searchReversePaths(index, 3, { rootIds: [1] }) });
  const capped = collectCandidateSourceHints(heap, instances, { maxTotalPositions: 2 });
  assert.deepEqual(capped.records.map(row => row.hints.length), [1, 1]); assert.equal(capped.status, 'incomplete'); assert.equal(capped.coverage.omittedPositions, 1);
  const zero = collectCandidateSourceHints(heap, instances, { maxPositionsPerCandidate: 0 });
  assert.equal(zero.status, 'incomplete'); assert.ok(zero.records.every(row => row.status === 'unknown' && row.unknownReasons.includes('source-position-output-limit')));
});

test('duplicate/invalid location and script identities or unsafe limits cannot produce a misleading URL hint', () => {
  for (const mutate of [h => h.locations.push(...h.locations.slice(0, 4)), h => { h.locations[2] = 6; }, h => { h.locations[0] = -1; }, h => { h.snapshot.meta.location_fields = ['script_id']; }]) {
    const { heap, instances } = graph(); mutate(heap); assert.throws(() => collectCandidateSourceHints(heap, instances), /candidate-(node-location|location-metadata)/);
  }
  const { heap, instances } = graph();
  for (const options of [{ scripts: [{ scriptId: '42', url: 'one' }, { scriptId: '42', url: 'two' }] }, { scripts: [{ scriptId: 42, url: 'one' }] }, { maxTotalPositions: 257 }, { maxPositionsPerCandidate: 13 }, { unexpected: true }]) assert.throws(() => collectCandidateSourceHints(heap, instances, options));
  assert.throws(() => collectCandidateSourceHints(heap, [instances[0], instances[0]]), /invalid-candidate-source-instances/);
});
