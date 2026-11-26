// One bounded breadth-first traversal serves all candidate instances sharing roots.
// The incoming index must have validated this heap before this function is called.
function forwardSearch(heap, index, targetIds, rootIds, options = {}) {
  const limits = { maxDepth: 64, maxNodes: 50000, maxEdges: 200000, ...options };
  for (const [name, value] of Object.entries(limits)) if (!['maxDepth', 'maxNodes', 'maxEdges'].includes(name) || !Number.isSafeInteger(value) || value < (name === 'maxNodes' ? 1 : 0) || value > ({ maxDepth: 64, maxNodes: 50000, maxEdges: 200000 })[name]) throw Error('Invalid batch path limit: ' + name);
  const nf = Object.fromEntries(heap.snapshot.meta.node_fields.map((key, i) => [key, i])), ef = Object.fromEntries(heap.snapshot.meta.edge_fields.map((key, i) => [key, i]));
  const nw = heap.snapshot.meta.node_fields.length, ew = heap.snapshot.meta.edge_fields.length, et = heap.snapshot.meta.edge_types[ef.type], n = index.stats.nodeCount;
  const starts = new Uint32Array(n + 1), parent = new Int32Array(n).fill(-1), parentEdge = new Int32Array(n).fill(-1), depths = new Uint16Array(n), queue = [];
  for (let node = 0; node < n; node++) starts[node + 1] = starts[node] + heap.nodes[node * nw + nf.edge_count];
  const roots = rootIds.map(id => index.describeNode(id)), targets = targetIds.map(id => index.describeNode(id)), pending = new Set(targets.map(node => node.nodeIndex));
  if (roots.length > limits.maxNodes) throw Error('Roots exceed batch path node limit');
  for (const root of roots) if (parent[root.nodeIndex] === -1) { parent[root.nodeIndex] = root.nodeIndex; queue.push(root.nodeIndex); pending.delete(root.nodeIndex); }
  const stats = { examinedEdges: 0, discoveredNodes: queue.length, expandedNodes: 0, explicitWeakSkipped: 0, depthPrunedEdges: 0 };
  let head = 0, stopReason = null, completeRadius = 0;
  search: while (head < queue.length && pending.size) {
    const current = queue[head++]; stats.expandedNodes++; completeRadius = depths[current];
    for (let edge = starts[current]; edge < starts[current + 1]; edge++) {
      if (stats.examinedEdges === limits.maxEdges) { stopReason = 'edge-limit'; break search; }
      stats.examinedEdges++;
      const offset = edge * ew, type = et[heap.edges[offset + ef.type]], next = heap.edges[offset + ef.to_node] / nw;
      if (type === 'weak') { stats.explicitWeakSkipped++; continue; }
      if (parent[next] !== -1) continue;
      if (depths[current] === limits.maxDepth) { stats.depthPrunedEdges++; continue; }
      if (queue.length === limits.maxNodes) { stopReason = 'node-limit'; break search; }
      parent[next] = current; parentEdge[next] = edge; depths[next] = depths[current] + 1; queue.push(next); pending.delete(next);
      if (!pending.size) { stopReason = 'all-targets-reached'; break search; }
    }
  }
  stats.discoveredNodes = queue.length;
  stopReason ??= pending.size ? stats.depthPrunedEdges ? 'depth-limit' : 'frontier-exhausted' : 'all-targets-reached';
  const describe = node => index.describeNode(heap.nodes[node * nw + nf.id]);
  const results = new Map(targets.map(target => {
    const found = parent[target.nodeIndex] !== -1;
    let path = null;
    if (found) {
      const nodes = [target], edges = []; let node = target.nodeIndex;
      while (parent[node] !== node) {
        const source = parent[node], edgeIndex = parentEdge[node], edgeOffset = edgeIndex * ew, typeIndex = heap.edges[edgeOffset + ef.type], type = et[typeIndex], rawNameOrIndex = heap.edges[edgeOffset + ef.name_or_index];
        const nameKind = ['element', 'hidden'].includes(type) ? 'index' : 'string';
        edges.push({ source: describe(source), target: describe(node), edgeIndex, edgeOffset, typeIndex, type, nameKind, nameOrIndex: nameKind === 'index' ? rawNameOrIndex : heap.strings[rawNameOrIndex], rawNameOrIndex });
        node = source; nodes.push(describe(node));
      }
      nodes.reverse(); edges.reverse();
      path = { declaredRootId: nodes[0].id, targetId: target.id, edgeCount: edges.length, nodes, edges, interpretation: 'One shortest literal path from the declared root set; not a GC retaining proof or all holders.' };
    }
    return [target.id, { outcome: found ? 'path-found' : stopReason === 'frontier-exhausted' ? 'no-path-under-policy' : 'incomplete', target, path,
      stopReason: found ? 'declared-root-path-found' : stopReason, policy: { name: 'exclude-weak', gcSemantics: 'not-established' }, completeness: found ? 'one-shortest-path-only' : stopReason === 'frontier-exhausted' ? 'exhausted-forward-region-under-policy' : 'incomplete-bounded-prefix' }];
  }));
  return { result: { results, stats, limits, stopReason, traversal: 'shared-forward-breadth-first' }, state: { parent, parentEdge, depths, completeRadius } };
}

export function searchCandidatePaths(heap, index, targetIds, rootIds, options = {}) {
  return forwardSearch(heap, index, targetIds, rootIds, options).result;
}

export function searchCandidatePathsWithFallback(heap, index, targetIds, rootIds, options = {}) {
  // Reserve most of the global edge budget for target-directed work. The
  // fraction is independent of constructor names, application and fixture.
  const maxEdges = options.maxEdges ?? 200000;
  if (!Number.isSafeInteger(maxEdges) || maxEdges < 0 || maxEdges > 200000) throw Error('Invalid batch path limit: maxEdges');
  const prefixBudget = Math.floor(maxEdges / 4);
  const { result, state: front } = forwardSearch(heap, index, targetIds, rootIds, { ...options, maxEdges: prefixBudget });
  result.limits = { ...result.limits, maxEdges };
  const forward = { ...result.stats, completeRadius: front.completeRadius, edgeBudget: prefixBudget }, fallback = { searches: 0, examinedEdges: 0, certifiedPaths: 0, witnessPaths: 0, maximumDiscoveredNodes: 0 };
  const nf = Object.fromEntries(heap.snapshot.meta.node_fields.map((key, i) => [key, i])), ef = Object.fromEntries(heap.snapshot.meta.edge_fields.map((key, i) => [key, i]));
  const nw = heap.snapshot.meta.node_fields.length, ew = heap.snapshot.meta.edge_fields.length, et = heap.snapshot.meta.edge_types[ef.type];
  const describe = node => index.describeNode(heap.nodes[node * nw + nf.id]);
  const roots = new Set(rootIds.map(id => index.describeNode(id).nodeIndex));
  const states = [...result.results.values()].filter(row => row.outcome === 'incomplete').map(row => ({ target: row.target, records: new Map([[row.target.nodeIndex, { depth: 0, next: -1, edge: -1 }]]), queue: [row.target.nodeIndex], head: 0, layerEnd: 1, completeRadius: 0, best: null, done: false, depthPruned: false }));
  function edgeRecord(source, target, edgeIndex) {
    const edgeOffset = edgeIndex * ew, typeIndex = heap.edges[edgeOffset + ef.type], type = et[typeIndex], rawNameOrIndex = heap.edges[edgeOffset + ef.name_or_index], nameKind = ['element', 'hidden'].includes(type) ? 'index' : 'string';
    return { source: describe(source), target: describe(target), edgeIndex, edgeOffset, typeIndex, type, nameKind, nameOrIndex: nameKind === 'index' ? rawNameOrIndex : heap.strings[rawNameOrIndex], rawNameOrIndex };
  }
  function buildPath(state, interpretation) {
    const edges = []; let node = state.best.node;
    while (front.parent[node] !== node) { const source = front.parent[node]; edges.push(edgeRecord(source, node, front.parentEdge[node])); node = source; }
    edges.reverse(); const nodes = [describe(node), ...edges.map(edge => edge.target)]; node = state.best.node;
    while (node !== state.target.nodeIndex) { const record = state.records.get(node); edges.push(edgeRecord(node, record.next, record.edge)); node = record.next; nodes.push(describe(node)); }
    return { declaredRootId: nodes[0].id, targetId: state.target.id, edgeCount: edges.length, nodes, edges, interpretation };
  }
  function finish(state, outcome, reason) {
    state.done = true; fallback.maximumDiscoveredNodes = Math.max(fallback.maximumDiscoveredNodes, state.records.size);
    const path = outcome === 'path-found' ? buildPath(state, 'One proven shortest literal path from the declared root set; not a GC retaining proof or all holders.') : null;
    const witnessPath = outcome === 'incomplete' && state.best ? { ...buildPath(state, 'One verified literal path; shortest distance is not proven. Not a GC retaining proof or all holders.'), shortestStatus: 'not-proven' } : null;
    if (path) fallback.certifiedPaths++;
    if (witnessPath) fallback.witnessPaths++;
    result.results.set(state.target.id, { outcome, target: state.target, path, stopReason: reason, policy: { name: 'exclude-weak', gcSemantics: 'not-established' },
      ...(witnessPath ? { witnessPath } : {}),
      completeness: outcome === 'path-found' ? 'one-shortest-path-only' : outcome === 'no-path-under-policy' ? 'exhausted-reverse-region-under-policy' : 'incomplete-bounded-prefix',
      shortestProof: outcome === 'path-found' ? { kind: reason, forwardCompleteRadius: front.completeRadius, reverseCompleteRadius: state.completeRadius, distance: state.best.distance } : null });
  }
  // Complete BFS balls of radii F and R intersect every root-to-target path of
  // length <= F+R. A meeting path no longer than that bound is therefore shortest.
  // A meeting without a shortest proof stays incomplete; its literal witness
  // is retained separately so consumers cannot mistake it for a shortest path.
  const prove = state => state.best && state.best.distance <= front.completeRadius + state.completeRadius;
  // Yield even within one high-degree node, while preserving each BFS cursor.
  const sliceEdges = 32;
  let active = states.length;
  while (active && result.stats.examinedEdges < maxEdges) {
    for (const state of states) {
      if (state.done || result.stats.examinedEdges === maxEdges) continue;
      if (!state.started) { state.started = true; fallback.searches++; }
      const current = state.queue[state.head], record = state.records.get(current);
      state.incoming ??= index.incomingEdges(describe(current).id)[Symbol.iterator]();
      let exhausted = false;
      for (let slice = 0; slice < sliceEdges && result.stats.examinedEdges < maxEdges; slice++) {
        const { value: edge, done } = state.incoming.next();
        if (done) { exhausted = true; break; }
        result.stats.examinedEdges++; fallback.examinedEdges++;
        if (edge.type === 'weak' || state.records.has(edge.source.nodeIndex)) continue;
        if (record.depth === result.limits.maxDepth) { state.depthPruned = true; continue; }
        if (state.records.size === result.limits.maxNodes) { finish(state, 'incomplete', 'node-limit'); break; }
        const source = edge.source.nodeIndex, depth = record.depth + 1;
        state.records.set(source, { depth, next: current, edge: edge.edgeIndex }); state.queue.push(source);
        if (front.parent[source] !== -1) {
          const distance = front.depths[source] + depth;
          if (distance <= result.limits.maxDepth && (!state.best || distance < state.best.distance)) state.best = { node: source, distance };
        }
        // A root encountered by reverse BFS independently proves a shortest path.
        if (roots.has(source)) { finish(state, 'path-found', 'reverse-root-shortest'); break; }
      }
      if (state.done) { active--; continue; }
      // An edge-budget stop may occur in the middle of a node. Do not declare
      // the layer complete in that case, even if its last examined edge met.
      if (!exhausted) continue;
      state.incoming = null;
      state.head++;
      if (state.head === state.layerEnd) {
        state.completeRadius = Math.min(record.depth + 1, result.limits.maxDepth);
        if (prove(state)) { finish(state, 'path-found', 'bidirectional-distance-bound'); active--; continue; }
        state.layerEnd = state.queue.length;
      }
      if (state.head === state.queue.length) { finish(state, state.depthPruned ? 'incomplete' : 'no-path-under-policy', state.depthPruned ? 'depth-limit' : 'frontier-exhausted'); active--; }
    }
  }
  for (const state of states) if (!state.done) finish(state, 'incomplete', 'edge-limit');
  return { ...result, traversal: 'shared-prefix-with-certified-bidirectional-search', forward, fallback };
}
