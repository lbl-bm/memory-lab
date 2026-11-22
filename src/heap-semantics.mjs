import { buildIncomingIndex, SnapshotInputError } from './incoming-index.mjs';

export const heapSemanticsLimits = Object.freeze({ maxInputBytes: 64 * 1024 ** 2, maxNodes: 1000000, maxEdges: 5000000, maxQueries: 128, maxOldSpaceMiB: 512, timeoutMs: 60000 });
export const heapSemanticsProfile = Object.freeze({ id: 'v8-13.6-paired-ephemerons', verifiedV8Versions: ['13.6.233.17-node.58'], requiresWeakSlots: true, evidence: 'Node v24.22.1 generator + marking visitor and live/dead controls', ordinaryEdgeTypes: ['context', 'element', 'property', 'internal', 'hidden'] });
export const heapSemanticsProfiles = Object.freeze([heapSemanticsProfile, Object.freeze({ id: 'v8-15.7-browser-paired-ephemerons', verifiedV8Versions: ['15.7.112.23'], requiresWeakSlots: false,
  evidence: 'V8 15.7.112.23 CreateEphemeronEdges omits legacy weak slots; actual Chrome 157.0.8103.39 controls', ordinaryEdgeTypes: ['context', 'element', 'property', 'internal', 'hidden'] })]);
const fail = (code, message) => { throw new SnapshotInputError(code, message); };
const uint = value => Number.isSafeInteger(value) && value >= 0;
const pairName = /^\d+ \/ part of key \(([\s\S]*) @(\d+)\) -> value \(([\s\S]*) @(\d+)\) pair in WeakMap \(table @(\d+)\)$/;

// The pair is an AND rule: reachable(table) AND reachable(key) => reachable(value).
// Do not pass either of the two descriptive V8 edges to an ordinary dominator tree.
export function createHeapSemantics(heap, { v8Version } = {}) {
  const profile = heapSemanticsProfiles.find(profile => profile.verifiedV8Versions.includes(v8Version));
  if (!profile) fail('unsupported-semantics-version', 'No verified partial profile for V8 ' + v8Version);
  // Refuse oversized flat arrays before allocating the incoming index. Structural
  // validation remains the index's responsibility for all accepted-size input.
  const raw = heap?.snapshot?.meta;
  if ((Array.isArray(heap?.nodes) && raw?.node_fields?.length > 0 && heap.nodes.length / raw.node_fields.length > heapSemanticsLimits.maxNodes) ||
      (Array.isArray(heap?.edges) && raw?.edge_fields?.length > 0 && heap.edges.length / raw.edge_fields.length > heapSemanticsLimits.maxEdges)) fail('semantics-graph-budget', 'Graph exceeds node/edge budget');
  const index = buildIncomingIndex(heap), n = index.stats.nodeCount, m = index.stats.edgeCount;
  if (n > heapSemanticsLimits.maxNodes || m > heapSemanticsLimits.maxEdges) fail('semantics-graph-budget', 'Graph exceeds node/edge budget');
  const meta = heap.snapshot.meta, nf = Object.fromEntries(meta.node_fields.map((v, i) => [v, i])), ef = Object.fromEntries(meta.edge_fields.map((v, i) => [v, i]));
  const nw = meta.node_fields.length, ew = meta.edge_fields.length, et = meta.edge_types[ef.type];
  const starts = new Uint32Array(n + 1), kinds = new Uint8Array(m), groups = new Map();
  let weakCount = 0, shortcutCount = 0, totalBytes = 0, nativeNodeCount = 0;
  const nativeNodes = new Uint8Array(n);
  const idAt = i => heap.nodes[i * nw + nf.id], targetAt = edge => heap.edges[edge * ew + ef.to_node] / nw;
  for (let i = 0; i < n; i++) {
    if (meta.node_types[nf.type][heap.nodes[i * nw + nf.type]] === 'native') { nativeNodes[i] = 1; nativeNodeCount++; }
    starts[i + 1] = starts[i] + heap.nodes[i * nw + nf.edge_count]; totalBytes += heap.nodes[i * nw + nf.self_size];
    if (!Number.isSafeInteger(totalBytes)) fail('unsafe-size-total', 'Shallow byte total exceeds safe integer precision');
    for (let edge = starts[i]; edge < starts[i + 1]; edge++) {
      const type = et[heap.edges[edge * ew + ef.type]];
      if (type === 'weak') { kinds[edge] = 1; weakCount++; continue; }
      if (type === 'shortcut') { kinds[edge] = 2; shortcutCount++; continue; }
      if (type !== 'internal') continue;
      const name = heap.strings[heap.edges[edge * ew + ef.name_or_index]];
      if (!name.includes('part of key (') && !name.includes(' pair in WeakMap ')) continue;
      const match = pairName.exec(name);
      if (!match) fail('unsupported-ephemeron-layout', 'Unrecognized ephemeron edge spelling');
      const [keyId, valueId, tableId] = [match[2], match[4], match[5]].map(Number);
      if (![keyId, valueId, tableId].every(uint)) fail('invalid-ephemeron-ids', 'Ephemeron IDs must be safe integers');
      const key = index.describeNode(keyId), value = index.describeNode(valueId), table = index.describeNode(tableId);
      if (key.name !== match[1] || value.name !== match[3] || table.type !== 'array' || targetAt(edge) !== value.nodeIndex || (i !== key.nodeIndex && i !== table.nodeIndex)) fail('invalid-ephemeron-edge', 'Paired edge IDs, names or endpoints disagree');
      const groupId = `${tableId}/${keyId}/${valueId}`;
      if (!groups.has(groupId)) groups.set(groupId, { tableId, keyId, valueId, table: table.nodeIndex, key: key.nodeIndex, value: value.nodeIndex, keyEdges: [], tableEdges: [] });
      const group = groups.get(groupId); (i === table.nodeIndex ? group.tableEdges : group.keyEdges).push(edge); kinds[edge] = 3;
    }
  }
  const pairs = [...groups.values()], weakTargets = new Map();
  for (const { table } of pairs) if (!weakTargets.has(table)) {
    const targets = new Set();
    for (let edge = starts[table]; edge < starts[table + 1]; edge++) if (kinds[edge] === 1) targets.add(targetAt(edge));
    weakTargets.set(table, targets);
  }
  for (const pair of pairs) {
    if (pair.keyEdges.length !== 1 || pair.tableEdges.length !== 1) fail('incomplete-ephemeron-pair', 'Expected exactly one key edge and one table edge');
    if (profile.requiresWeakSlots && (!weakTargets.get(pair.table).has(pair.key) || !weakTargets.get(pair.table).has(pair.value))) fail('missing-ephemeron-weak-slots', 'This V8 profile requires table weak slots for key and value');
  }
  // Indexed premise watchers process each ordinary edge and each premise once.
  // This computes the least fixed point, so unseeded cycles cannot mark themselves.
  const heads = new Int32Array(n).fill(-1), next = new Int32Array(pairs.length * 2);
  pairs.forEach((pair, p) => { for (const [slot, node] of [[2 * p, pair.table], [2 * p + 1, pair.key]]) { next[slot] = heads[node]; heads[node] = slot; } });
  function indices(ids, label, required = false) {
    if (!Array.isArray(ids) || (required && !ids.length) || ids.length > heapSemanticsLimits.maxQueries || ids.some(id => !uint(id)) || new Set(ids).size !== ids.length) fail('invalid-semantics-' + label, label + ' must be unique safe IDs, at most 128');
    return ids.map(id => index.describeNode(id).nodeIndex);
  }
  function traverse(roots, removed, literal = false) {
    const reached = new Uint8Array(n), nativeWitness = new Uint8Array(n), remaining = new Uint8Array(pairs.length).fill(2), activated = new Uint8Array(pairs.length), queue = new Uint32Array(n);
    const reason = new Int32Array(n).fill(-1), source = new Int32Array(n).fill(-1); let head = 0, tail = 0, bytes = 0;
    function mark(node, why, from) { if (reached[node] || removed.has(node)) return; reached[node] = 1; queue[tail++] = node; reason[node] = why; source[node] = from;
      nativeWitness[node] = nativeNodes[node] || (from >= 0 ? nativeWitness[from] : why <= -3 ? nativeWitness[pairs[-3 - why].table] || nativeWitness[pairs[-3 - why].key] : 0);
      bytes += heap.nodes[node * nw + nf.self_size]; }
    roots.forEach(root => mark(root, -2, -1));
    while (head < tail) {
      const node = queue[head++];
      for (let edge = starts[node]; edge < starts[node + 1]; edge++) if (kinds[edge] === 0 || (literal && kinds[edge] === 3)) mark(targetAt(edge), edge, node);
      if (!literal) for (let slot = heads[node]; slot !== -1; slot = next[slot]) {
        const p = Math.floor(slot / 2);
        if (--remaining[p] === 0 && !removed.has(pairs[p].value)) { activated[p] = 1; mark(pairs[p].value, -3 - p, -1); }
      }
    }
    return { reached, activated, reason, source, nativeWitness, count: tail, bytes };
  }
  const summary = { profile, v8Version, nodeCount: n, edgeCount: m, nativeNodeCount, ephemeronCount: pairs.length, excludedWeakEdges: weakCount, excludedShortcutEdges: shortcutCount,
    semantics: 'Least fixed point of ordinary literal edges and recognized (table AND key) => value rules, from caller-declared roots.',
    limitations: ['A local WeakMap/WeakRef snapshot model, not a complete V8/DOM/native GC model.', 'Shortcut edges are excluded. Other non-weak edges retain their literal meaning.', 'A witness involving native nodes is literal snapshot evidence, not certified native GC ownership. DOM attachment mutations are not modeled by deleting unrelated JS holders.', 'WeakRef deref job liveness, finalization scheduling and concurrent GC are outside this model.', 'Only the declared V8 version and paired edge layout are supported; provenance of the version is asserted by the caller.', 'A counterfactual cut removes graph vertices and incident edges, not application code; bytes are not measured memory reclamation.'] };
  function evaluate(options) {
    if (!options || Object.keys(options).some(key => !['rootIds', 'nodeIds', 'cutIds'].includes(key))) fail('invalid-semantics-options', 'Expected rootIds, optional nodeIds and cutIds');
    const roots = indices(options.rootIds, 'roots', true), queries = indices(options.nodeIds ?? [], 'queries'), cuts = indices(options.cutIds ?? [], 'cuts');
    const baseline = traverse(roots, new Set()), current = cuts.length ? traverse(roots, new Set(cuts)) : baseline;
    const literal = traverse(roots, new Set(cuts), true);
    const counts = result => ({ reachableNodes: result.count, reachableShallowBytes: result.bytes, activeEphemerons: result.activated.reduce((sum, v) => sum + v, 0) });
    let newlyUnreachableNodes = 0, newlyUnreachableBytes = 0, literalOnlyNodes = 0;
    for (let i = 0; i < n; i++) { if (baseline.reached[i] && !current.reached[i]) { newlyUnreachableNodes++; newlyUnreachableBytes += heap.nodes[i * nw + nf.self_size]; } if (literal.reached[i] && !current.reached[i]) literalOnlyNodes++; }
    const publicPair = (pair, p) => ({ tableId: pair.tableId, keyId: pair.keyId, valueId: pair.valueId, active: Boolean(current.activated[p]), tableReachable: Boolean(current.reached[pair.table]), keyReachable: Boolean(current.reached[pair.key]), valueRemoved: cuts.includes(pair.value), keyEdgeIndex: pair.keyEdges[0], tableEdgeIndex: pair.tableEdges[0] });
    const nodes = queries.map(i => {
      const why = current.reason[i];
      const witness = why === -1 ? null : why === -2 ? { kind: 'declared-root' } : why <= -3 ? { kind: 'ephemeron', ...publicPair(pairs[-3 - why], -3 - why) } : { kind: 'ordinary-edge', edgeIndex: why, sourceId: idAt(current.source[i]) };
      const conditionalHolders = [], weakIncoming = []; let conditionalHolderCount = 0, weakIncomingCount = 0;
      pairs.forEach((pair, p) => { if (pair.value === i) { conditionalHolderCount++; if (conditionalHolders.length < 128) conditionalHolders.push(publicPair(pair, p)); } });
      for (const edge of index.incomingEdges(idAt(i))) if (edge.type === 'weak') { weakIncomingCount++; if (weakIncoming.length < 128) weakIncoming.push({ sourceId: edge.source.id, sourceName: edge.source.name, name: edge.nameOrIndex, edgeIndex: edge.edgeIndex }); }
      return { ...index.describeNode(idAt(i)), reachable: Boolean(current.reached[i]), reachableBeforeCut: Boolean(baseline.reached[i]), literalPairEdgesWouldReach: Boolean(literal.reached[i]), witness, witnessIncludesNative: Boolean(current.nativeWitness[i]),
        conditionalHolders, conditionalHolderCount, weakIncoming, weakIncomingCount, evidenceTruncated: conditionalHolderCount > 128 || weakIncomingCount > 128,
        interpretation: current.reached[i] ? 'Reachable under the declared partial model; not a leak verdict.' : 'Not reachable under the declared partial model; not proof of actual GC collection.' };
    });
    return { schemaVersion: '0.1.0', status: 'completed', capability: 'conditional-heap-reachability', summary, roots: [...options.rootIds], cutIds: [...(options.cutIds ?? [])], before: counts(baseline), after: counts(current),
      cutEffect: { newlyUnreachableNodes, newlyUnreachableBytes }, literalComparison: { policy: 'Same graph except paired ephemeron edges treated as independent ordinary edges; weak and shortcut excluded.', reachableNodes: literal.count, literalOnlyNodes }, nodes };
  }
  return { summary, evaluate };
}

export function analyzeHeapSemantics(heap, options) {
  if (!options || Object.keys(options).some(key => !['v8Version', 'rootIds', 'nodeIds', 'cutIds'].includes(key))) fail('invalid-semantics-options', 'Expected v8Version, rootIds, optional nodeIds and cutIds');
  const { v8Version, ...query } = options; return createHeapSemantics(heap, { v8Version }).evaluate(query);
}
