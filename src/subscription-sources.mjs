import { buildIncomingIndex } from './incoming-index.mjs';

export const subscriptionSourceLimits = Object.freeze({ maxSubscriptions: 64, maxEdges: 200000, maxNodes: 5000, maxDepth: 16, maxPrototypeDepth: 16, maxMemberships: 256 });
const safeId = value => Number.isSafeInteger(value) && value > 0;
const subjectKinds = ['BehaviorSubject', 'ReplaySubject', 'AsyncSubject'];

// All prototype IDs must come from the collector's bound RxJS 7.8.1 identities.
// This matches one graph relation, not all operator inputs or complete GC semantics.
export function analyzeSubscriptionSources(heap, options) {
  if (!options || Object.keys(options).some(key => !['subjectPrototypeId', 'subscriberPrototypeId', 'subjectKindPrototypeIds', 'subscriptionIds', 'maxEdges', 'maxNodes', 'maxDepth'].includes(key))) throw Error('invalid-subscription-source-options');
  const { subjectPrototypeId, subscriberPrototypeId, subscriptionIds } = options;
  if (![subjectPrototypeId, subscriberPrototypeId].every(safeId) || subjectPrototypeId === subscriberPrototypeId || !Array.isArray(subscriptionIds) || subscriptionIds.length > subscriptionSourceLimits.maxSubscriptions || subscriptionIds.some(id => !safeId(id)) || new Set(subscriptionIds).size !== subscriptionIds.length) throw Error('invalid-subscription-source-identities');
  const kinds = options.subjectKindPrototypeIds === undefined ? {} : options.subjectKindPrototypeIds;
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds) || ![Object.prototype, null].includes(Object.getPrototypeOf(kinds)) || Object.keys(kinds).some(kind => !subjectKinds.includes(kind))) throw Error('invalid-subscription-source-kind-identities');
  const kindEntries = Object.entries(kinds), prototypeIds = [subjectPrototypeId, subscriberPrototypeId, ...kindEntries.map(([, id]) => id)];
  if (!prototypeIds.every(safeId) || new Set(prototypeIds).size !== prototypeIds.length) throw Error('invalid-subscription-source-kind-identities');
  const kindByPrototype = new Map([[subjectPrototypeId, 'Subject'], ...kindEntries.map(([kind, id]) => [id, kind])]);
  const scope = kindEntries.length ? 'bound-Subject-kinds-observers-to-returned-Subscriber-destination' : 'ordinary-Subject-observers-to-returned-Subscriber-destination';
  const limits = { ...subscriptionSourceLimits };
  for (const key of ['maxEdges', 'maxNodes', 'maxDepth']) if (options[key] !== undefined) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'maxNodes' ? 1 : 0) || options[key] > limits[key]) throw Error('invalid-subscription-source-limit');
    limits[key] = options[key];
  }
  const index = buildIncomingIndex(heap), meta = heap.snapshot.meta;
  for (const anchor of prototypeIds) if (index.describeNode(anchor).type !== 'object') throw Error('invalid-subscription-source-prototype');
  const nf = Object.fromEntries(meta.node_fields.map((key, i) => [key, i])), ef = Object.fromEntries(meta.edge_fields.map((key, i) => [key, i]));
  const nw = meta.node_fields.length, ew = meta.edge_fields.length, edgeTypes = meta.edge_types[ef.type];
  const starts = new Uint32Array(index.stats.nodeCount + 1);
  for (let i = 0; i < index.stats.nodeCount; i++) starts[i + 1] = starts[i] + heap.nodes[i * nw + nf.edge_count];
  const inspectedNodes = new Set(), outgoing = new Map(), relations = new Map();
  let examinedEdges = 0, stop = null, totalMemberships = 0;
  const budget = reason => { stop = reason; const error = Error(reason); error.budget = true; throw error; };
  const touch = id => { if (!inspectedNodes.has(id)) { if (inspectedNodes.size >= limits.maxNodes) budget('node-limit'); inspectedNodes.add(id); } };
  const charge = () => { if (examinedEdges >= limits.maxEdges) budget('edge-limit'); examinedEdges++; };
  const compact = edge => ({ sourceId: edge.source.id, targetId: edge.target.id, type: edge.type, name: edge.nameOrIndex, edgeIndex: edge.edgeIndex });
  function edges(id) {
    if (outgoing.has(id)) return outgoing.get(id);
    touch(id); const node = index.describeNode(id), result = [];
    for (let at = starts[node.nodeIndex]; at < starts[node.nodeIndex + 1]; at++) {
      charge(); const off = at * ew, type = edgeTypes[heap.edges[off + ef.type]], raw = heap.edges[off + ef.name_or_index];
      result.push({ sourceId: id, targetId: heap.nodes[heap.edges[off + ef.to_node] + nf.id], type, name: ['element', 'hidden'].includes(type) ? raw : heap.strings[raw], edgeIndex: at });
    }
    outgoing.set(id, result); return result;
  }
  function relation(id, anchor) {
    const key = id + ':' + anchor;
    if (relations.has(key)) return relations.get(key);
    let current = id; const seen = new Set(); let result = { status: 'no-match', depth: null, reason: null };
    for (let depth = 1; depth <= limits.maxPrototypeDepth; depth++) {
      if (seen.has(current)) { result = { status: 'unknown', depth: null, reason: 'prototype-cycle' }; break; }
      seen.add(current);
      if (!['object', 'closure'].includes(index.describeNode(current).type)) break;
      const candidates = edges(current).filter(edge => edge.type === 'property' && edge.name === '__proto__');
      if (!candidates.length) break;
      if (candidates.length !== 1) { result = { status: 'unknown', depth: null, reason: 'prototype-ambiguous' }; break; }
      current = candidates[0].targetId;
      if (current === anchor) { result = { status: 'match', depth, reason: null }; break; }
      if (depth === limits.maxPrototypeDepth) result = { status: 'unknown', depth: null, reason: 'prototype-depth-limit' };
    }
    relations.set(key, result); return result;
  }
  const property = (list, name) => list.filter(edge => edge.type === 'property' && edge.name === name);
  try {
    for (const [, anchor] of kindEntries) if (relation(anchor, subjectPrototypeId).status !== 'match') throw Error('invalid-subscription-source-kind-ancestry');
  } catch (error) { if (!error.budget) throw error; }
  const records = [];
  for (const subscriptionId of subscriptionIds) {
    const memberships = [], reasons = new Set(), seenMemberships = new Set();
    const finish = () => records.push({ subscriptionId, status: reasons.size ? 'incomplete' : 'completed', membershipCount: memberships.length, subjectCount: new Set(memberships.map(row => row.subjectId)).size, memberships, unknownReasons: [...reasons] });
    if (stop) { reasons.add(stop); finish(); continue; }
    try {
      let sink;
      try { sink = index.describeNode(subscriptionId); } catch { reasons.add('subscription-node-missing'); finish(); continue; }
      if (sink.type !== 'object' || subscriptionId === subscriberPrototypeId || relation(subscriptionId, subscriberPrototypeId).status !== 'match') { reasons.add('subscription-prototype-unconfirmed'); finish(); continue; }
      const queue = [subscriptionId], paths = new Map([[subscriptionId, { depth: 0, nextId: null, edge: null }]]);
      function inspectMembership(arrayEdge, memberId) {
        const arrayId = arrayEdge.source.id; touch(arrayId);
        for (const ownerEdge of index.incomingEdges(arrayId)) {
          charge();
          if (ownerEdge.type !== 'property' || ownerEdge.nameOrIndex !== 'observers') continue;
          const subjectId = ownerEdge.source.id, sourceRelation = relation(subjectId, subjectPrototypeId);
          if (sourceRelation.status === 'unknown') { reasons.add(sourceRelation.reason); continue; }
          if (sourceRelation.status !== 'match') continue;
          const subjectEdges = edges(subjectId), observers = property(subjectEdges, 'observers');
          const directPrototype = property(subjectEdges, '__proto__'), subjectKind = directPrototype.length === 1 ? kindByPrototype.get(directPrototype[0].targetId) : null;
          if (!subjectKind) { reasons.add('subject-subclass-outside-scope'); continue; }
          if (ownerEdge.source.type !== 'object' || observers.length !== 1 || observers[0].targetId !== arrayId || !['closed', 'isStopped', 'currentObservers'].every(key => property(subjectEdges, key).length === 1)) { reasons.add('subject-shape-unconfirmed'); continue; }
          const arrayNode = index.describeNode(arrayId), elements = edges(arrayId).filter(edge => edge.type === 'element').sort((a, b) => a.name - b.name);
          if (arrayNode.type !== 'object' || arrayNode.name !== 'Array' || elements.some((edge, i) => edge.name !== i || index.describeNode(edge.targetId).type !== 'object') || new Set(elements.map(edge => edge.targetId)).size !== elements.length) { reasons.add('subject-observers-array-unconfirmed'); continue; }
          const key = subjectId + ':' + memberId;
          if (seenMemberships.has(key)) continue;
          if (totalMemberships >= limits.maxMemberships) budget('membership-limit');
          const subscriberIds = [memberId], witness = [compact(ownerEdge), compact(arrayEdge)];
          let current = memberId;
          while (current !== subscriptionId) { const step = paths.get(current); witness.push(step.edge); current = step.nextId; subscriberIds.push(current); }
          memberships.push({ subjectId, subjectKind, observerArrayId: arrayId, memberId, subscriberIds, edges: witness }); seenMemberships.add(key); totalMemberships++;
        }
      }
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head], path = paths.get(current); touch(current);
        for (const incoming of index.incomingEdges(current)) {
          charge();
          if (incoming.type === 'element') inspectMembership(incoming, current);
          if (incoming.type !== 'property' || incoming.nameOrIndex !== 'destination') continue;
          const memberId = incoming.source.id;
          if (incoming.source.type !== 'object') continue;
          const memberRelation = relation(memberId, subscriberPrototypeId);
          if (memberRelation.status === 'unknown') { reasons.add(memberRelation.reason); continue; }
          if (memberRelation.status !== 'match') continue;
          const destinations = property(edges(memberId), 'destination');
          if (destinations.length !== 1 || destinations[0].targetId !== current) { reasons.add('subscriber-destination-unconfirmed'); continue; }
          if (paths.has(memberId)) continue;
          if (path.depth >= limits.maxDepth) { reasons.add('destination-depth-limit'); continue; }
          touch(memberId); paths.set(memberId, { depth: path.depth + 1, nextId: current, edge: compact(incoming) }); queue.push(memberId);
        }
      }
    } catch (error) { if (!error.budget) throw error; reasons.add(error.message); }
    finish();
  }
  const unknownReasons = [...new Set([...records.flatMap(record => record.unknownReasons), ...(stop ? [stop] : [])])];
  return { schemaVersion: '0.1.0', status: unknownReasons.length ? 'incomplete' : 'completed', records,
    coverage: { unknownReasons, examinedEdges, discoveredNodes: inspectedNodes.size, indexNodeCount: index.stats.nodeCount, indexEdgeCount: index.stats.edgeCount, limits, scope, subjectKinds: [...kindByPrototype.values()],
      indexing: 'One complete validated graph index and node-edge offsets are prepared before budgeted membership searches. Index construction is not included in examinedEdges.',
      interpretation: 'Only Subjects whose direct prototype matches a bound supported kind and whose observer arrays are dense are matched. Optional kind anchors are validated against Subject ancestry within the shared search budget. Subscriber prototype ancestry and destination-only chains witness each relation. Callback bridges, non-Subject sources, unbound subclasses, cached values and other operator ownership are not fully assessed; zero matches never certifies all source cleanup.' } };
}
