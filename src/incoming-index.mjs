// Literal V8 graph evidence only. No GC-strength, reachability or leak inference.
export const incomingLimits = Object.freeze({ maxInputBytes: 64 * 1024 ** 2, maxOldSpaceMiB: 512, timeoutMs: 30000 });
const edgeKinds = new Set(['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']);

export class SnapshotInputError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'SnapshotInputError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new SnapshotInputError(code, message, details); };
const uint = n => Number.isSafeInteger(n) && n >= 0;

function fields(list, required, label) {
  if (!Array.isArray(list) || !list.length || list.some(x => typeof x !== 'string') || new Set(list).size !== list.length) fail('invalid-metadata', `Invalid ${label} fields`);
  const result = Object.fromEntries(list.map((x, i) => [x, i]));
  for (const key of required) if (!Object.hasOwn(result, key)) fail('invalid-metadata', `Missing ${label} field: ${key}`);
  return result;
}
function typeTable(table, label) {
  if (!Array.isArray(table) || !table.length || table.some(x => typeof x !== 'string' || !x) || new Set(table).size !== table.length) fail('invalid-metadata', `Invalid ${label} type table`);
  return table;
}

export function buildIncomingIndex(heap) {
  const meta = heap?.snapshot?.meta;
  if (!meta || !Array.isArray(heap.nodes) || !Array.isArray(heap.edges) || !Array.isArray(heap.strings)) fail('invalid-structure', 'Expected V8 node/edge/string arrays');
  const nf = fields(meta.node_fields, ['type', 'name', 'id', 'self_size', 'edge_count'], 'node');
  const ef = fields(meta.edge_fields, ['type', 'name_or_index', 'to_node'], 'edge');
  const nw = meta.node_fields.length, ew = meta.edge_fields.length;
  const nt = typeTable(meta.node_types?.[nf.type], 'node'), et = typeTable(meta.edge_types?.[ef.type], 'edge');
  if (et.some(t => !edgeKinds.has(t))) fail('unsupported-edge-type', 'Unknown edge type has no verified name/index interpretation', { types: et.filter(t => !edgeKinds.has(t)) });
  if (heap.nodes.length % nw || heap.edges.length % ew) fail('invalid-array-length', 'Flat array length is not a multiple of metadata width');
  const n = heap.nodes.length / nw, m = heap.edges.length / ew;
  if (heap.nodes.length > 0xffffffff || heap.edges.length > 0xffffffff || n >= 0xffffffff || m >= 0xffffffff) fail('index-capacity', 'Snapshot exceeds 32-bit array-offset capacity; node IDs are not truncated');
  for (const [key, count] of [['node_count', n], ['edge_count', m]]) if (heap.snapshot[key] !== count) fail('count-mismatch', `Declared ${key} differs from the array`, { declared: heap.snapshot[key], actual: count });
  if (heap.strings.some(s => typeof s !== 'string')) fail('invalid-string-table', 'String table contains a non-string');
  const ids = new Map(), starts = new Uint32Array(n + 1), sourceByEdge = new Uint32Array(m);
  let nextEdge = 0;
  for (let i = 0; i < n; i++) {
    const off = i * nw, id = heap.nodes[off + nf.id], t = heap.nodes[off + nf.type], name = heap.nodes[off + nf.name], count = heap.nodes[off + nf.edge_count], size = heap.nodes[off + nf.self_size];
    if (!uint(id) || !uint(t) || t >= nt.length || !uint(name) || name >= heap.strings.length || !uint(count) || !uint(size)) fail('invalid-node', 'Invalid node ID/type/name/edge count/shallow size', { nodeOffset: off });
    if (ids.has(id)) fail('duplicate-node-id', 'Node ID is not unique within this snapshot', { id, nodeOffset: off });
    ids.set(id, i);
    if (count > m - nextEdge) fail('edge-count-mismatch', 'Node edge counts exceed edge array', { nodeOffset: off });
    sourceByEdge.fill(i, nextEdge, nextEdge + count); nextEdge += count;
  }
  if (nextEdge !== m) fail('edge-count-mismatch', 'Node edge counts do not consume the edge array');
  for (let i = 0; i < m; i++) {
    const off = i * ew, t = heap.edges[off + ef.type], name = heap.edges[off + ef.name_or_index], target = heap.edges[off + ef.to_node];
    if (!uint(t) || t >= et.length) fail('invalid-edge-type', 'Edge type index is invalid', { edgeOffset: off });
    if (!uint(target) || target % nw || target >= heap.nodes.length) fail('invalid-target-offset', 'Edge target is not an aligned existing node', { edgeOffset: off, target });
    if (!uint(name) || (!['element', 'hidden'].includes(et[t]) && name >= heap.strings.length)) fail('invalid-edge-name', 'Edge name/index is invalid', { edgeOffset: off });
    starts[target / nw + 1]++;
  }
  for (let i = 1; i <= n; i++) starts[i] += starts[i - 1];
  const cursor = starts.slice(0, n), edgeByIncoming = new Uint32Array(m);
  // Source/edge order makes each incoming list deterministic, including parallel edges.
  for (let i = 0; i < m; i++) { const target = heap.edges[i * ew + ef.to_node] / nw; edgeByIncoming[cursor[target]++] = i; }
  function node(i) {
    const off = i * nw;
    return { id: heap.nodes[off + nf.id], type: nt[heap.nodes[off + nf.type]], name: heap.strings[heap.nodes[off + nf.name]], nodeIndex: i, nodeOffset: off };
  }
  function nodeIndex(nodeId) {
    if (!uint(nodeId)) fail('invalid-node-id', 'Node ID must be a nonnegative safe integer');
    const i = ids.get(nodeId);
    if (i === undefined) fail('target-not-found', 'Target node ID is absent from this snapshot', { nodeId });
    return i;
  }
  function describeNode(nodeId) { return node(nodeIndex(nodeId)); }
  function incomingCount(nodeId) { const i = nodeIndex(nodeId); return starts[i + 1] - starts[i]; }
  function* incomingEdges(nodeId) {
    const i = nodeIndex(nodeId), target = node(i);
    for (let at = starts[i]; at < starts[i + 1]; at++) {
      const edgeIndex = edgeByIncoming[at], off = edgeIndex * ew, typeIndex = heap.edges[off + ef.type], type = et[typeIndex], rawNameOrIndex = heap.edges[off + ef.name_or_index];
      const nameKind = type === 'element' || type === 'hidden' ? 'index' : 'string';
      yield { source: node(sourceByEdge[edgeIndex]), target: { ...target }, edgeIndex, edgeOffset: off, typeIndex, type, nameKind, nameOrIndex: nameKind === 'index' ? rawNameOrIndex : heap.strings[rawNameOrIndex], rawNameOrIndex };
    }
  }
  function incoming(nodeId) {
    const target = describeNode(nodeId), edges = [...incomingEdges(nodeId)];
    return { target, incomingCount: edges.length, explicitWeakCount: edges.filter(e => e.type === 'weak').length, edges, interpretation: 'Literal snapshot references only; weak/shortcut/internal semantics remain explicit. No GC strength, root path, leak, retained-size or source-causality verdict.' };
  }
  return { incoming, incomingEdges, incomingCount, describeNode, stats: { nodeCount: n, edgeCount: m, nodeFieldWidth: nw, edgeFieldWidth: ew, persistentTypedIndexBytes: starts.byteLength + sourceByEdge.byteLength + edgeByIncoming.byteLength, buildCursorBytes: cursor.byteLength, idMapEntries: ids.size, sizeNote: 'Typed-array bytes exclude the ID Map, parsed JSON graph, strings and JS overhead; see process peak RSS.' } };
}
