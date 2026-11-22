import { SnapshotInputError } from './incoming-index.mjs';
import { assessPathSemantics } from './path-semantics.mjs';

export const reverseLimits = Object.freeze({ maxDepth: 64, maxNodes: 50000, maxEdges: 200000 });
const fail = (code, message, details = {}) => { throw new SnapshotInputError(code, message, details); };
export function searchReversePaths(index, targetId, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('invalid-search-options', 'Expected an options object');
  const known = ['rootIds', 'edgePolicy', ...Object.keys(reverseLimits)];
  if (Object.keys(options).some(k => !known.includes(k))) fail('invalid-search-options', 'Unknown search option');
  const limits = { ...reverseLimits };
  for (const key of Object.keys(limits)) {
    if (options[key] !== undefined) limits[key] = options[key];
    if (!Number.isSafeInteger(limits[key]) || limits[key] < (key === 'maxNodes' ? 1 : 0) || limits[key] > reverseLimits[key]) fail('invalid-search-limit', `Invalid ${key}; only lower or equal limits are supported`, { key, value: limits[key], cap: reverseLimits[key] });
  }
  const policy = options.edgePolicy ?? 'exclude-weak';
  if (!['exclude-weak', 'all-literal'].includes(policy)) fail('invalid-edge-policy', 'Expected exclude-weak or all-literal');
  if (!Array.isArray(options.rootIds) || !options.rootIds.length || options.rootIds.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(options.rootIds).size !== options.rootIds.length) fail('invalid-root-ids', 'Explicit unique nonnegative safe root IDs are required');
  const target = index.describeNode(targetId);
  const roots = options.rootIds.map(id => {
    try { return index.describeNode(id); } catch (error) { if (error.code === 'target-not-found') fail('root-not-found', 'A declared stopping node is absent', { id }); throw error; }
  });
  const rootIds = new Set(options.rootIds), queue = [targetId], discovered = new Map([[targetId, { depth: 0, nextId: null, edge: null }]]);
  let head = 0;
  const stats = { discoveredNodes: 1, expandedNodes: 0, examinedEdges: 0, explicitWeakSkipped: 0, alreadyVisitedSources: 0, selfEdges: 0, depthPrunedEdges: 0, zeroIncomingNodes: 0, maximumDiscoveredDepth: 0, examinedEdgeTypes: {} };
  function finish(outcome, stopReason, foundRoot = null, stoppedAt = null) {
    let path = null;
    if (foundRoot !== null) {
      const edges = [], nodes = [index.describeNode(foundRoot)]; let current = foundRoot;
      while (current !== targetId) { const r = discovered.get(current); edges.push(r.edge); current = r.nextId; nodes.push(index.describeNode(current)); }
      path = { declaredRootId: foundRoot, targetId, edgeCount: edges.length, nodes, edges, explicitWeakEdges: edges.filter(e => e.type === 'weak').length, edgeTypes: [...new Set(edges.map(e => e.type))], interpretation: 'One shortest literal path under the recorded policy; not a proven GC retaining path or root cause.' };
    }
    const result = { outcome, stopReason, target, declaration: { source: 'caller-supplied', roots, gcRootStatus: 'not-verified' }, policy: { name: policy, excludedTypes: policy === 'exclude-weak' ? ['weak'] : [], nativeEphemeronAndShortcutStrength: 'unknown' }, limits, stats: { ...stats, discoveredNodes: discovered.size, queuedUnexpandedNodes: queue.length - head }, stoppedAt, path, completeness: outcome === 'path-found' ? 'one-shortest-path-only' : outcome === 'no-path-under-policy' ? 'exhausted-reverse-reachable-region-under-policy' : 'incomplete-bounded-prefix', conclusion: { leakVerdict: 'not-determined', rootCause: 'not-determined', retainedSize: 'not-computed', reason: 'A literal path or its absence under one edge policy does not establish GC semantics, business lifetime or a defect.' } };
    return { ...result, semanticAssessment: assessPathSemantics(result) };
  }
  if (rootIds.has(targetId)) return finish('path-found', 'declared-root-reached', targetId);
  while (head < queue.length) {
    const currentId = queue[head++], record = discovered.get(currentId); stats.expandedNodes++;
    if (!index.incomingCount(currentId)) stats.zeroIncomingNodes++;
    for (const edge of index.incomingEdges(currentId)) {
      if (stats.examinedEdges === limits.maxEdges) return finish('incomplete', 'edge-limit', null, { nodeId: currentId, nextEdgeOffset: edge.edgeOffset });
      stats.examinedEdges++; stats.examinedEdgeTypes[edge.type] = (stats.examinedEdgeTypes[edge.type] ?? 0) + 1;
      if (edge.source.id === currentId) stats.selfEdges++;
      if (policy === 'exclude-weak' && edge.type === 'weak') { stats.explicitWeakSkipped++; continue; }
      if (discovered.has(edge.source.id)) { stats.alreadyVisitedSources++; continue; }
      const depth = record.depth + 1;
      if (depth > limits.maxDepth) { stats.depthPrunedEdges++; continue; }
      if (discovered.size === limits.maxNodes) return finish('incomplete', 'node-limit', null, { nodeId: currentId, edgeOffset: edge.edgeOffset, undiscoveredSourceId: edge.source.id });
      discovered.set(edge.source.id, { depth, nextId: currentId, edge }); queue.push(edge.source.id);
      stats.maximumDiscoveredDepth = Math.max(stats.maximumDiscoveredDepth, depth);
      if (rootIds.has(edge.source.id)) return finish('path-found', 'declared-root-reached', edge.source.id);
    }
  }
  return stats.depthPrunedEdges ? finish('incomplete', 'depth-limit') : finish('no-path-under-policy', 'frontier-exhausted');
}
