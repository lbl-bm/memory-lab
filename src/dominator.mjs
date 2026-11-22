import { buildIncomingIndex, SnapshotInputError } from './incoming-index.mjs';

export const dominatorLimits = Object.freeze({ maxInputBytes: 64 * 1024 ** 2, maxOldSpaceMiB: 512, timeoutMs: 60000, maxNodes: 1000000, maxEdges: 5000000, maxQueries: 128, maxTop: 100 });
const fail = (code, message) => { throw new SnapshotInputError(code, message); };
const uint = value => Number.isSafeInteger(value) && value >= 0;

// Exact dominators of the selected directed graph, not an implementation of V8 GC.
// Simple-link Lengauer-Tarjan with iterative DFS and iterative path compression.
export function buildDominatorTree(heap, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['rootIds', 'edgePolicy'].includes(key))) fail('invalid-dominator-options', 'Explicit rootIds and optional edgePolicy are required');
  const policy = options.edgePolicy ?? 'exclude-weak';
  if (!['exclude-weak', 'all-literal'].includes(policy)) fail('invalid-edge-policy', 'Expected exclude-weak or all-literal');
  if (!Array.isArray(options.rootIds) || !options.rootIds.length || options.rootIds.length > dominatorLimits.maxQueries || options.rootIds.some(id => !uint(id)) || new Set(options.rootIds).size !== options.rootIds.length) fail('invalid-root-ids', 'Expected 1..128 unique nonnegative safe integer root IDs');
  const index = buildIncomingIndex(heap), n = index.stats.nodeCount, m = index.stats.edgeCount;
  if (n > dominatorLimits.maxNodes || m > dominatorLimits.maxEdges) fail('dominator-graph-budget', 'Graph exceeds the declared node/edge budget');
  const meta = heap.snapshot.meta, nf = Object.fromEntries(meta.node_fields.map((field, i) => [field, i])), ef = Object.fromEntries(meta.edge_fields.map((field, i) => [field, i]));
  const nw = meta.node_fields.length, ew = meta.edge_fields.length, types = meta.edge_types[ef.type], nodeTypes = meta.node_types[nf.type];
  const starts = new Uint32Array(n + 1), roots = options.rootIds.map(id => index.describeNode(id).nodeIndex), rootSet = new Set(roots);
  let totalBytes = 0, excludedEdges = 0;
  for (let i = 0; i < n; i++) {
    starts[i + 1] = starts[i] + heap.nodes[i * nw + nf.edge_count]; totalBytes += heap.nodes[i * nw + nf.self_size];
    if (!Number.isSafeInteger(totalBytes)) fail('unsafe-size-total', 'Total shallow bytes exceed safe integer precision');
  }
  const allowed = edge => policy === 'all-literal' || types[heap.edges[edge * ew + ef.type]] !== 'weak';
  for (let edge = 0; edge < m; edge++) if (!allowed(edge)) excludedEdges++;
  const dfs = new Uint32Array(n), vertex = new Uint32Array(n + 2), parent = new Uint32Array(n + 2);
  const stack = new Uint32Array(n), next = new Uint32Array(n);
  let count = 1; // DFS number 1 is a virtual root with zero shallow bytes.
  for (const root of roots) {
    if (dfs[root]) continue;
    dfs[root] = ++count; vertex[count] = root; parent[count] = 1;
    let depth = 1; stack[0] = root; next[0] = starts[root];
    while (depth) {
      const slot = depth - 1, source = stack[slot];
      if (next[slot] >= starts[source + 1]) { depth--; continue; }
      const edge = next[slot]++;
      if (!allowed(edge)) continue;
      const target = heap.edges[edge * ew + ef.to_node] / nw;
      if (dfs[target]) continue;
      dfs[target] = ++count; vertex[count] = target; parent[count] = dfs[source];
      stack[depth] = target; next[depth] = starts[target]; depth++;
    }
  }
  const semi = new Uint32Array(count + 1), ancestor = new Uint32Array(count + 1), label = new Uint32Array(count + 1), idom = new Uint32Array(count + 1);
  const bucket = new Uint32Array(count + 1), bucketNext = new Uint32Array(count + 1), compress = new Uint32Array(count + 1);
  for (let i = 1; i <= count; i++) semi[i] = label[i] = i;
  let predecessorVisits = 0, compressionSteps = 0;
  function evaluate(v) {
    if (!ancestor[v]) return label[v];
    let at = v, depth = 0;
    while (ancestor[ancestor[at]]) { compress[depth++] = at; at = ancestor[at]; }
    while (depth) {
      at = compress[--depth]; const a = ancestor[at];
      if (semi[label[a]] < semi[label[at]]) label[at] = label[a];
      ancestor[at] = ancestor[a]; compressionSteps++;
    }
    return label[v];
  }
  for (let w = count; w >= 2; w--) {
    const node = vertex[w];
    if (rootSet.has(node)) semi[w] = 1; // A virtual edge exists for EVERY declared root, even if already visited.
    const id = heap.nodes[node * nw + nf.id];
    for (const edge of index.incomingEdges(id)) {
      if (policy === 'exclude-weak' && edge.type === 'weak') continue;
      const predecessor = dfs[edge.source.nodeIndex]; if (!predecessor) continue;
      predecessorVisits++;
      const candidate = semi[evaluate(predecessor)]; if (candidate < semi[w]) semi[w] = candidate;
    }
    bucketNext[w] = bucket[semi[w]]; bucket[semi[w]] = w;
    ancestor[w] = parent[w];
    let v = bucket[parent[w]]; bucket[parent[w]] = 0;
    while (v) { const u = evaluate(v); idom[v] = semi[u] < semi[v] ? u : parent[w]; v = bucketNext[v]; }
  }
  for (let w = 2; w <= count; w++) { if (idom[w] !== semi[w]) idom[w] = idom[idom[w]]; if (!idom[w] || idom[w] >= w) fail('invalid-dominator-tree', 'Immediate dominator must be a proper DFS ancestor'); }
  const retained = new Float64Array(count + 1), dominated = new Uint32Array(count + 1);
  for (let i = 2; i <= count; i++) { retained[i] = heap.nodes[vertex[i] * nw + nf.self_size]; dominated[i] = 1; }
  for (let i = count; i >= 2; i--) { retained[idom[i]] += retained[i]; dominated[idom[i]] += dominated[i]; }
  function describe(nodeIndex) {
    const offset = nodeIndex * nw, number = dfs[nodeIndex];
    return { ...index.describeNode(heap.nodes[offset + nf.id]), shallowBytes: heap.nodes[offset + nf.self_size], reachable: number !== 0,
      immediateDominator: !number ? null : idom[number] === 1 ? { kind: 'virtual-root' } : { kind: 'node', id: heap.nodes[vertex[idom[number]] * nw + nf.id] },
      retainedBytes: number ? retained[number] : null, dominatedNodeCount: number ? dominated[number] : null };
  }
  function node(id) { return describe(index.describeNode(id).nodeIndex); }
  function top(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > dominatorLimits.maxTop) fail('invalid-top-limit', 'top must be 1..100');
    const order = new Uint32Array(count - 1); for (let i = 0; i < order.length; i++) order[i] = i + 2;
    order.sort((a, b) => retained[b] - retained[a] || heap.nodes[vertex[a] * nw + nf.id] - heap.nodes[vertex[b] * nw + nf.id]);
    const rows = [];
    for (const number of order) { const i = vertex[number]; if (rootSet.has(i) || nodeTypes[heap.nodes[i * nw + nf.type]] === 'synthetic') continue; rows.push(describe(i)); if (rows.length === limit) break; }
    return rows;
  }
  function removal(nodeIds) {
    if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > dominatorLimits.maxQueries || nodeIds.some(id => !uint(id)) || new Set(nodeIds).size !== nodeIds.length) fail('invalid-cut-ids', 'Expected 1..128 unique node IDs for the graph removal experiment');
    const removed = new Set(nodeIds.map(id => index.describeNode(id).nodeIndex)), reached = new Uint8Array(n), queue = new Uint32Array(n);
    let head = 0, tail = 0;
    for (const root of roots) if (!removed.has(root) && !reached[root]) { reached[root] = 1; queue[tail++] = root; }
    while (head < tail) {
      const source = queue[head++];
      for (let edge = starts[source]; edge < starts[source + 1]; edge++) {
        if (!allowed(edge)) continue;
        const target = heap.edges[edge * ew + ef.to_node] / nw;
        if (!removed.has(target) && !reached[target]) { reached[target] = 1; queue[tail++] = target; }
      }
    }
    let bytes = 0, nodes = 0;
    for (let i = 0; i < n; i++) if (dfs[i] && !reached[i]) { bytes += heap.nodes[i * nw + nf.self_size]; nodes++; }
    return { nodeIds: [...nodeIds], newlyUnreachableNodeCount: nodes, newlyUnreachableBytes: bytes, remainingReachableBytes: retained[1] - bytes,
      interpretation: 'Recomputed reachability after removing these graph vertices and incident edges under the declared policy. Includes jointly retained shared nodes once. Not measured GC reclamation or a safe application intervention.' };
  }
  return { node, top, removal, summary: { algorithm: 'Lengauer-Tarjan; simple linking and iterative path compression', roots: options.rootIds.map(id => node(id)), virtualRoot: { shallowBytes: 0, reachableNodeCount: count - 1, retainedBytes: retained[1] },
    policy: { name: policy, excludedEdgeTypes: policy === 'exclude-weak' ? ['weak'] : [], excludedEdgeCount: excludedEdges, gcSemantics: 'not-established', ephemeronAndShortcutSemantics: 'literal-only' },
    nodeCount: n, edgeCount: m, reachableNodeCount: count - 1, unreachableNodeCount: n - count + 1, totalShallowBytes: totalBytes, reachableShallowBytes: retained[1], unreachableShallowBytes: totalBytes - retained[1], predecessorVisits, compressionSteps,
    interpretation: 'Exact dominance and shallow-byte aggregation for this explicitly rooted directed graph. Neither exclude-weak nor all-literal is a complete V8/DOM GC model. Not a leak verdict or an estimate of process RSS reclaimed.' } };
}

export function analyzeDominators(heap, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['rootIds', 'edgePolicy', 'nodeIds', 'cutIds', 'top'].includes(key))) fail('invalid-dominator-options', 'Unknown dominator options');
  const nodeIds = options.nodeIds ?? [];
  if (!Array.isArray(nodeIds) || nodeIds.length > dominatorLimits.maxQueries || nodeIds.some(id => !uint(id)) || new Set(nodeIds).size !== nodeIds.length) fail('invalid-node-ids', 'nodeIds must contain at most 128 unique safe integers');
  const tree = buildDominatorTree(heap, { rootIds: options.rootIds, edgePolicy: options.edgePolicy });
  return { summary: tree.summary, nodes: nodeIds.map(tree.node), top: tree.top(options.top ?? 20), topScope: 'Reachable nodes excluding declared roots and synthetic nodes; overlapping retained values must not be added.', removal: options.cutIds ? tree.removal(options.cutIds) : null };
}
