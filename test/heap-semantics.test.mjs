import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/incoming-oracle.mjs';
import { analyzeHeapSemantics, createHeapSemantics } from '../src/heap-semantics.mjs';

const version = '13.6.233.17-node.58';
function encoded(nodes, edges, pairs, reordered = false, weakSlots = true) {
  const all = [...edges];
  pairs.forEach((pair, i) => {
    const key = nodes.find(node => node.id === pair.key), value = nodes.find(node => node.id === pair.value);
    const description = ` / part of key (${key.name} @${pair.key}) -> value (${value.name} @${pair.value}) pair in WeakMap (table @${pair.table})`;
    if (weakSlots) all.push({ from: pair.table, to: pair.key, type: 'weak', name: String(i * 2) }, { from: pair.table, to: pair.value, type: 'weak', name: String(i * 2 + 1) });
    all.push({ from: pair.key, to: pair.value, type: 'internal', name: '1' + description }, { from: pair.table, to: pair.value, type: 'internal', name: '3' + description });
  });
  return fixture(nodes, all, reordered);
}
const nodes = Array.from({ length: 12 }, (_, i) => ({ id: i, name: 'node-' + i, type: 'array' }));
// Independent slow logical-rule oracle. It does not decode production edges or
// use the production premise queue: repeatedly scan all rules until unchanged.
function oracle(edges, pairs, roots, cuts) {
  const removed = new Set(cuts), reached = new Set(roots.filter(id => !removed.has(id)));
  let changed;
  do {
    changed = false;
    function add(id) { if (!removed.has(id) && !reached.has(id)) { reached.add(id); changed = true; } }
    for (const edge of edges) if (!['weak', 'shortcut'].includes(edge.type) && reached.has(edge.from)) add(edge.to);
    for (const pair of pairs) if (reached.has(pair.table) && reached.has(pair.key)) add(pair.value);
  } while (changed);
  return reached;
}
function compare(ns, edges, pairs, roots, cuts = [], reordered = false) {
  const result = analyzeHeapSemantics(encoded(ns, edges, pairs, reordered), { v8Version: version, rootIds: roots, cutIds: cuts, nodeIds: ns.map(node => node.id) });
  const after = oracle(edges, pairs, roots, cuts), before = oracle(edges, pairs, roots, []);
  assert.deepEqual(result.nodes.filter(node => node.reachable).map(node => node.id).sort((a, b) => a - b), [...after].sort((a, b) => a - b));
  assert.equal(result.after.reachableNodes, after.size); assert.equal(result.after.reachableShallowBytes, after.size * 24);
  assert.equal(result.cutEffect.newlyUnreachableNodes, [...before].filter(id => !after.has(id)).length);
  assert.equal(result.cutEffect.newlyUnreachableBytes, [...before].filter(id => !after.has(id)).length * 24);
  return result;
}

test('ephemeron needs both table and key; ordinary weak/shortcut edges do not mark targets', () => {
  const edges = [{ from: 1, to: 4, type: 'weak', name: 'target' }, { from: 1, to: 5, type: 'shortcut', name: 'shortcut' }], pairs = [{ table: 1, key: 2, value: 3 }];
  for (const roots of [[1], [2], [1, 2], [0]]) compare(nodes, edges, pairs, roots);
  const result = compare(nodes, edges, pairs, [1, 2], [2]);
  assert.equal(result.nodes[3].reachable, false); assert.equal(result.nodes[3].literalPairEdgesWouldReach, true);
  assert.equal(result.nodes[4].weakIncoming[0].name, 'target');
});

test('verified Chromium profile accepts new pair-only format while legacy Node profile requires weak slots', () => {
  const pairs = [{ table: 1, key: 2, value: 3 }, { table: 4, key: 3, value: 5 }], heap = encoded(nodes, [], pairs, true, false);
  for (const roots of [[1], [2], [1, 2, 4], [1, 4]]) {
    const result = analyzeHeapSemantics(heap, { v8Version: '15.7.112.23', rootIds: roots, nodeIds: nodes.map(node => node.id) });
    assert.deepEqual(result.nodes.filter(node => node.reachable).map(node => node.id).sort((a, b) => a - b), [...oracle([], pairs, roots, [])].sort((a, b) => a - b));
    assert.equal(result.summary.excludedWeakEdges, 0);
  }
  assert.throws(() => createHeapSemantics(heap, { v8Version: version }), error => error.code === 'missing-ephemeron-weak-slots');
  assert.throws(() => createHeapSemantics(heap, { v8Version: '15.7.112.24' }), error => error.code === 'unsupported-semantics-version');
  const missing = encoded(nodes, [], pairs, false, false); missing.strings[missing.strings.findIndex(s => s.startsWith('1 / part of key'))] = 'ordinary';
  assert.throws(() => createHeapSemantics(missing, { v8Version: '15.7.112.23' }), error => error.code === 'incomplete-ephemeron-pair');
});

test('native witness flag propagates through ordinary edges and conditional premises', () => {
  const heap = encoded(nodes, [{ from: 0, to: 6, type: 'internal', name: 'native-owner' }, { from: 6, to: 2, type: 'internal', name: 'key' }], [{ table: 1, key: 2, value: 3 }], false, false);
  heap.snapshot.meta.node_types[0].push('native'); heap.nodes[6 * 5] = 4;
  const result = analyzeHeapSemantics(heap, { v8Version: '15.7.112.23', rootIds: [0, 1], nodeIds: [0, 1, 2, 3, 6] });
  assert.equal(result.summary.nativeNodeCount, 1);
  assert.deepEqual(result.nodes.map(node => node.witnessIncludesNative), [false, false, true, true, true]);
  assert.equal(result.nodes[3].witness.kind, 'ephemeron');
});

test('unseeded ephemeron and value-to-key cycles stay unreachable; a seed activates a chain', () => {
  const pairs = [{ table: 1, key: 2, value: 3 }, { table: 4, key: 3, value: 2 }, { table: 5, key: 3, value: 6 }];
  compare(nodes, [], pairs, [1, 4, 5]);
  const result = compare(nodes, [], pairs, [1, 4, 5, 2]);
  assert.equal(result.nodes[6].reachable, true); assert.equal(result.nodes[6].witness.kind, 'ephemeron');
  compare(nodes, [{ from: 3, to: 2, type: 'property', name: 'back' }], [{ table: 1, key: 2, value: 3 }], [1]);
});

test('alternative WeakMaps retain a shared value until both key holders are removed', () => {
  const pairs = [{ table: 1, key: 2, value: 6 }, { table: 3, key: 4, value: 6 }];
  const one = compare(nodes, [], pairs, [1, 2, 3, 4], [2]);
  assert.equal(one.nodes[6].reachable, true); assert.deepEqual(one.nodes[6].conditionalHolders.map(row => row.active), [false, true]);
  const both = compare(nodes, [], pairs, [1, 2, 3, 4], [2, 4]);
  assert.equal(both.nodes[6].reachable, false); assert.equal(both.cutEffect.newlyUnreachableNodes, 3);
});

test('100 generated conditional graphs match independent fixed-point oracle across roots and cuts', () => {
  for (let seed = 1; seed <= 100; seed++) {
    let state = seed; const next = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
    const ns = nodes.map((node, i) => ({ ...node, id: 2 ** 40 + seed * 100 + i })), id = () => ns[next(ns.length)].id;
    const edges = Array.from({ length: 22 }, (_, i) => ({ from: id(), to: id(), type: ['property', 'weak', 'shortcut', 'internal'][next(4)], name: 'edge-' + i }));
    const unique = new Map();
    for (let i = 0; i < 12; i++) { const pair = { table: id(), key: id(), value: id() }; if (pair.table !== pair.key) unique.set(JSON.stringify(pair), pair); }
    const pairs = [...unique.values()], roots = [...new Set([id(), id(), id()])], cuts = [...new Set([id(), id()])];
    compare(ns, edges, pairs, roots, [], Boolean(seed % 2)); compare(ns, edges, pairs, roots, cuts, Boolean(seed % 2));
  }
});

test('unsupported versions, malformed pair names, absent partners and weak slots fail closed', () => {
  const heap = () => encoded(nodes, [], [{ table: 1, key: 2, value: 3 }]);
  assert.throws(() => createHeapSemantics(heap(), { v8Version: '14.0.0' }), error => error.code === 'unsupported-semantics-version');
  const malformed = heap(); malformed.strings[malformed.strings.findIndex(s => s.startsWith('1 / part of key'))] += ' changed';
  assert.throws(() => createHeapSemantics(malformed, { v8Version: version }), error => error.code === 'unsupported-ephemeron-layout');
  const missingPartner = heap(); missingPartner.strings[missingPartner.strings.findIndex(s => s.startsWith('1 / part of key'))] = 'ordinary';
  assert.throws(() => createHeapSemantics(missingPartner, { v8Version: version }), error => error.code === 'incomplete-ephemeron-pair');
  const weakSlot = heap(), weakType = weakSlot.snapshot.meta.edge_types[0].indexOf('weak');
  const weakOffset = weakSlot.edges.findIndex((value, i) => i % 3 === 0 && value === weakType); weakSlot.edges[weakOffset] = 2;
  assert.throws(() => createHeapSemantics(weakSlot, { v8Version: version }), error => error.code === 'missing-ephemeron-weak-slots');
  assert.throws(() => analyzeHeapSemantics(heap(), { v8Version: version, rootIds: [] }), error => error.code === 'invalid-semantics-roots');
});
