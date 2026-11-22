import { buildIncomingIndex } from './incoming-index.mjs';

export const candidateSourceLimits = Object.freeze({ maxCandidates: 64, maxPathNodes: 65, maxPositionsPerCandidate: 12, maxTotalPositions: 256, maxScripts: 4096 });
const uint = value => Number.isSafeInteger(value) && value >= 0;

// Reuse the caller's validated index when this runs inside candidates. Only nodes
// on the actual reported path are inspected; there is no neighbor/name search.
export function collectCandidateSourceHints(heap, instances, options = {}, index = buildIncomingIndex(heap)) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['scripts', 'maxPositionsPerCandidate', 'maxTotalPositions'].includes(key))) throw Error('invalid-candidate-source-options');
  if (!Array.isArray(instances) || instances.length > candidateSourceLimits.maxCandidates || instances.some(row => !uint(row?.nodeId)) || new Set(instances.map(row => row.nodeId)).size !== instances.length) throw Error('invalid-candidate-source-instances');
  const limits = { ...candidateSourceLimits };
  for (const key of ['maxPositionsPerCandidate', 'maxTotalPositions']) if (options[key] !== undefined) {
    if (!uint(options[key]) || options[key] > limits[key]) throw Error('invalid-candidate-source-limit');
    limits[key] = options[key];
  }
  const scripts = options.scripts ?? [], scriptById = new Map();
  if (!Array.isArray(scripts) || scripts.length > limits.maxScripts) throw Error('invalid-candidate-script-metadata');
  for (const script of scripts) {
    if (typeof script?.scriptId !== 'string' || !/^(0|[1-9][0-9]*)$/.test(script.scriptId) || scriptById.has(script.scriptId) || typeof script.url !== 'string' || script.url.length > 16384) throw Error('invalid-candidate-script-metadata');
    scriptById.set(script.scriptId, script);
  }
  const meta = heap.snapshot.meta, nw = meta.node_fields.length, ew = meta.edge_fields.length;
  const nf = Object.fromEntries(meta.node_fields.map((name, i) => [name, i])), ef = Object.fromEntries(meta.edge_fields.map((name, i) => [name, i]));
  const starts = new Uint32Array(index.stats.nodeCount + 1), edgeTypes = meta.edge_types[ef.type];
  for (let i = 0; i < index.stats.nodeCount; i++) starts[i + 1] = starts[i] + heap.nodes[i * nw + nf.edge_count];
  const locations = new Map(), locationMetadata = Array.isArray(meta.location_fields) && Array.isArray(heap.locations);
  if (locationMetadata) {
    const lf = meta.location_fields, offsets = Object.fromEntries(lf.map((name, i) => [name, i]));
    if (!lf.length || new Set(lf).size !== lf.length || ['object_index', 'script_id', 'line', 'column'].some(key => !Number.isInteger(offsets[key])) || heap.locations.length % lf.length) throw Error('invalid-candidate-location-metadata');
    for (let i = 0; i < heap.locations.length; i += lf.length) {
      const offset = heap.locations[i + offsets.object_index], scriptId = heap.locations[i + offsets.script_id], line = heap.locations[i + offsets.line], column = heap.locations[i + offsets.column];
      if (![offset, scriptId, line, column].every(uint) || offset % nw || offset >= heap.nodes.length || locations.has(offset)) throw Error('invalid-candidate-node-location');
      locations.set(offset, { scriptId: String(scriptId), line, column });
    }
  }
  let validatedPathEdges = 0, inspectedPathNodes = 0;
  const prepared = instances.map(instance => {
    const result = { nodeId: instance.nodeId, status: 'unknown', hints: [], unknownReasons: [], coverage: { pathNodes: 0, inspectedNodes: 0, locatedNodes: 0, missingLocations: 0, omittedPositions: 0, pathValidated: false, pathKind: 'unavailable', scope: 'reported-path-nodes-only' } };
    const witness = instance.path?.outcome === 'incomplete' ? instance.path.witnessPath : null;
    if (witness && witness.shortestStatus !== 'not-proven') throw Error('invalid-candidate-witness-status');
    const path = instance.path?.outcome === 'path-found' ? instance.path.path : witness;
    if (!path) { result.unknownReasons.push('candidate-path-unavailable'); return { result, positions: [] }; }
    result.coverage.pathKind = witness ? 'literal-witness-shortest-not-proven' : 'proven-shortest';
    if (path.targetId !== instance.nodeId || !Array.isArray(path.nodes) || !path.nodes.length || path.nodes.length > limits.maxPathNodes || !Array.isArray(path.edges) || path.edges.length !== path.nodes.length - 1 || path.edgeCount !== path.edges.length || path.declaredRootId !== path.nodes[0].id || path.nodes.at(-1).id !== instance.nodeId) throw Error('invalid-candidate-source-path');
    const nodes = path.nodes.map(quoted => {
      const node = index.describeNode(quoted.id);
      if (quoted.name !== node.name || quoted.type !== node.type) throw Error('candidate-source-node-mismatch');
      return node;
    });
    for (let i = 0; i < path.edges.length; i++) {
      const quoted = path.edges[i], from = nodes[i], to = nodes[i + 1], ei = quoted.edgeIndex;
      if (!uint(ei) || ei < starts[from.nodeIndex] || ei >= starts[from.nodeIndex + 1]) throw Error('candidate-source-edge-mismatch');
      const offset = ei * ew, type = edgeTypes[heap.edges[offset + ef.type]], rawName = heap.edges[offset + ef.name_or_index];
      const name = ['element', 'hidden'].includes(type) ? rawName : heap.strings[rawName];
      if (type === 'weak' || quoted.type !== type || quoted.nameOrIndex !== name || quoted.source?.id !== from.id || quoted.target?.id !== to.id || heap.edges[offset + ef.to_node] !== to.nodeOffset) throw Error('candidate-source-edge-mismatch');
      validatedPathEdges++;
    }
    result.coverage.pathValidated = true; result.coverage.pathNodes = nodes.length;
    const positions = [];
    for (let pathNodeIndex = 0; pathNodeIndex < nodes.length; pathNodeIndex++) {
      const node = nodes[pathNodeIndex], location = locations.get(node.nodeOffset);
      inspectedPathNodes++; result.coverage.inspectedNodes++;
      if (!location) { result.coverage.missingLocations++; continue; }
      result.coverage.locatedNodes++;
      const script = scriptById.get(location.scriptId), url = script?.url || null;
      positions.push({ nodeId: node.id, nodeName: node.name, nodeType: node.type, pathNodeIndex, relation: 'direct-reported-path-node-location', location,
        generated: { scriptId: location.scriptId, line: location.line + 1, column: location.column + 1, url, coordinates: '1-based display of V8 script coordinates; not HTML-document coordinates' },
        scriptMetadata: { status: url ? 'collector-url-label' : 'unknown', reason: url ? null : script ? 'script-url-unavailable' : 'script-id-not-recorded', trust: 'Caller-supplied contemporaneous metadata label; loaded/local bytes and original-source mapping are not verified here.' },
        meaning: 'V8 node/constructor or function definition location on this path; not an observed allocation stack, retaining write or repair location.', allocationStack: 'not-collected', retainingWrite: 'not-observed', originalSource: 'not-mapped' });
    }
    if (!locationMetadata) result.unknownReasons.push('missing-location-metadata');
    else if (!positions.length) result.unknownReasons.push('no-location-on-reported-path');
    return { result, positions };
  });
  // A long first path cannot consume every emitted position before later
  // candidates receive one. Missing locations do not consume the output budget.
  let emittedPositions = 0;
  for (let round = 0; round < limits.maxPositionsPerCandidate && emittedPositions < limits.maxTotalPositions; round++) {
    for (const item of prepared) if (item.positions[round] && emittedPositions < limits.maxTotalPositions) {
      item.result.hints.push(item.positions[round]); emittedPositions++;
    }
  }
  for (const { result, positions } of prepared) {
    result.status = result.hints.length ? 'hints' : 'unknown';
    result.coverage.omittedPositions = positions.length - result.hints.length;
    if (result.coverage.omittedPositions) result.unknownReasons.push('source-position-output-limit');
  }
  const records = prepared.map(item => item.result), omittedPositions = records.reduce((sum, row) => sum + row.coverage.omittedPositions, 0);
  return { schemaVersion: '0.1.0', status: omittedPositions ? 'incomplete' : 'completed', records,
    coverage: { scope: 'reported-path-nodes-only', instances: records.length, instancesWithHints: records.filter(row => row.hints.length).length, inspectedPathNodes, validatedPathEdges, indexedLocations: locations.size, emittedPositions, omittedPositions, limits,
      indexing: 'The caller may reuse its validated graph index. Node-edge offsets and all V8 location records are prepared once before bounded path-node inspection; this preparation is outside validatedPathEdges.' },
    interpretation: 'Definition hints on one reported literal path per selected candidate, including explicitly marked witnesses whose shortest distance remains unproven. Zero hints means unknown. No neighboring-function scan, allocation provenance, retaining-write attribution, original-source mapping or automatic root-cause verdict.' };
}
