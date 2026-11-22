import { buildIncomingIndex } from './incoming-index.mjs';

export const receiverSubjectLimits = Object.freeze({ maxReceivers: 64, maxEdges: 50000, maxNodes: 2500, maxDepth: 8, maxSubjects: 128 });
const safeId = id => Number.isSafeInteger(id) && id > 0;
const kinds = ['BehaviorSubject', 'ReplaySubject', 'AsyncSubject'];
const contextNode = node => node.type === 'object' && /^system \/ Context(?: \/ scope @\d+)?$/.test(node.name);

// Positive receiver-local holder hints. This does not classify share operators,
// recover every upstream source, or certify cleanup when no subject is found.
export function analyzeReceiverSubjects(heap, options) {
  if (!options || Object.keys(options).some(key => !['receiverIds', 'subjectPrototypeId', 'subjectKindPrototypeIds', 'maxEdges', 'maxNodes', 'maxDepth'].includes(key))) throw Error('invalid-receiver-subject-options');
  const { receiverIds, subjectPrototypeId } = options, supplied = options.subjectKindPrototypeIds ?? {};
  if (!Array.isArray(receiverIds) || receiverIds.length > receiverSubjectLimits.maxReceivers || receiverIds.some(id => !safeId(id)) || new Set(receiverIds).size !== receiverIds.length || !safeId(subjectPrototypeId)) throw Error('invalid-receiver-subject-identities');
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || ![Object.prototype, null].includes(Object.getPrototypeOf(supplied)) || Object.keys(supplied).some(kind => !kinds.includes(kind))) throw Error('invalid-receiver-subject-kind-identities');
  const entries = Object.entries(supplied), prototypeIds = [subjectPrototypeId, ...entries.map(([, id]) => id)];
  if (!prototypeIds.every(safeId) || new Set(prototypeIds).size !== prototypeIds.length) throw Error('invalid-receiver-subject-kind-identities');
  const kindByPrototype = new Map([[subjectPrototypeId, 'Subject'], ...entries.map(([kind, id]) => [id, kind])]);
  const limits = { ...receiverSubjectLimits };
  for (const key of ['maxEdges', 'maxNodes', 'maxDepth']) if (options[key] !== undefined) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'maxNodes' ? 1 : 0) || options[key] > limits[key]) throw Error('invalid-receiver-subject-limit');
    limits[key] = options[key];
  }
  const index = buildIncomingIndex(heap), meta = heap.snapshot.meta;
  for (const id of prototypeIds) if (index.describeNode(id).type !== 'object') throw Error('invalid-receiver-subject-prototype');
  const nf = Object.fromEntries(meta.node_fields.map((key, i) => [key, i])), ef = Object.fromEntries(meta.edge_fields.map((key, i) => [key, i]));
  const nw = meta.node_fields.length, ew = meta.edge_fields.length, edgeTypes = meta.edge_types[ef.type], starts = new Uint32Array(index.stats.nodeCount + 1);
  for (let i = 0; i < index.stats.nodeCount; i++) starts[i + 1] = starts[i] + heap.nodes[i * nw + nf.edge_count];
  const discovered = new Set(), cache = new Map(); let examinedEdges = 0, stop = null, subjectCount = 0;
  function budget(reason) { stop = reason; const error = Error(reason); error.budget = true; throw error; }
  function touch(id) { if (!discovered.has(id)) { if (discovered.size >= limits.maxNodes) budget('node-limit'); discovered.add(id); } }
  function edges(id) {
    touch(id); const node = index.describeNode(id), count = starts[node.nodeIndex + 1] - starts[node.nodeIndex];
    if (count > limits.maxEdges - examinedEdges) budget('edge-limit'); examinedEdges += count;
    if (cache.has(id)) return cache.get(id);
    const result = [];
    for (let at = starts[node.nodeIndex]; at < starts[node.nodeIndex + 1]; at++) {
      const off = at * ew, type = edgeTypes[heap.edges[off + ef.type]], raw = heap.edges[off + ef.name_or_index];
      result.push({ sourceId: id, targetId: heap.nodes[heap.edges[off + ef.to_node] + nf.id], type, name: ['element', 'hidden'].includes(type) ? raw : heap.strings[raw], edgeIndex: at });
    }
    cache.set(id, result); return result;
  }
  const property = (list, name) => list.filter(edge => edge.type === 'property' && edge.name === name);
  try {
    for (const [, id] of entries) {
      const parent = property(edges(id), '__proto__');
      if (parent.length !== 1 || parent[0].targetId !== subjectPrototypeId) throw Error('invalid-receiver-subject-kind-ancestry');
    }
  } catch (error) { if (!error.budget) throw error; }
  function subject(id) {
    const node = index.describeNode(id); if (node.type !== 'object' || contextNode(node) || prototypeIds.includes(id)) return { kind: null };
    const own = edges(id), prototypes = property(own, '__proto__');
    if (prototypes.length !== 1) return { kind: null, reason: prototypes.some(edge => kindByPrototype.has(edge.targetId)) ? 'ambiguous-prototype' : null };
    const kind = kindByPrototype.get(prototypes[0].targetId); if (!kind) return { kind: null };
    if (!['observers', 'closed', 'isStopped', 'currentObservers'].every(name => property(own, name).length === 1)) return { kind: null, reason: 'subject-shape-unconfirmed' };
    return { kind, prototypeEdge: prototypes[0] };
  }
  const records = [];
  for (const receiverId of receiverIds) {
    const subjects = [], reasons = new Set(), visited = new Set(), queue = [{ id: receiverId, path: [] }];
    if (stop) reasons.add(stop);
    else try {
      let receiver; try { receiver = index.describeNode(receiverId); } catch { reasons.add('receiver-node-missing'); }
      if (receiver && receiver.type !== 'object') reasons.add('receiver-not-object');
      if (receiver?.type === 'object') for (let head = 0; head < queue.length; head++) {
        const current = queue[head]; if (visited.has(current.id)) continue; visited.add(current.id); touch(current.id);
        const node = index.describeNode(current.id), match = subject(current.id);
        if (match.reason) reasons.add(match.reason);
        if (match.kind && current.path.length) {
          if (subjectCount >= limits.maxSubjects) budget('subject-limit'); subjectCount++;
          subjects.push({ subjectId: current.id, kind: match.kind, path: current.path, prototypeEdge: match.prototypeEdge }); continue;
        }
        const own = edges(current.id);
        for (const edge of own) {
          const entry = current.id === receiverId && edge.type === 'property' && ['operator', '_subscribe'].includes(edge.name);
          const closure = node.type === 'closure' && edge.type === 'internal' && edge.name === 'context';
          const context = contextNode(node) && edge.type === 'context';
          if (!entry && !closure && !context) continue;
          const target = index.describeNode(edge.targetId);
          if (entry && target.type !== 'closure') { reasons.add('receiver-entry-not-closure'); continue; }
          if (closure && !contextNode(target)) { reasons.add('closure-context-unrecognized'); continue; }
          if (context && target.type !== 'closure' && !contextNode(target)) {
            const candidate = subject(target.id); if (candidate.reason) reasons.add(candidate.reason); if (!candidate.kind) continue;
          }
          if (visited.has(edge.targetId)) continue;
          if (current.path.length >= limits.maxDepth) { reasons.add('depth-limit'); continue; }
          touch(edge.targetId); queue.push({ id: edge.targetId, path: [...current.path, edge] });
        }
      }
    } catch (error) { if (!error.budget) throw error; reasons.add(error.message); }
    records.push({ receiverId, status: subjects.length ? 'observed' : 'unknown', searchStatus: reasons.size ? 'incomplete' : 'completed', subjects, unknownReasons: [...reasons],
      zeroMeaning: subjects.length ? null : 'No positive holder witness within this supported scope; this is not evidence of release.' });
  }
  const unknownReasons = [...new Set([...(stop ? [stop] : []), ...records.flatMap(record => record.unknownReasons)])];
  return { schemaVersion: '0.1.0', status: unknownReasons.length ? 'incomplete' : 'completed', records,
    coverage: { scope: 'receiver-local-closure-subject-holder-hints', unknownReasons, limits, examinedEdges, discoveredNodes: discovered.size, indexNodeCount: index.stats.nodeCount, indexEdgeCount: index.stats.edgeCount,
      indexing: 'The validated full graph index and edge offsets are prepared before bounded searches; indexing is excluded from examinedEdges. Repeated cached edge inspections are charged.',
      interpretation: 'One representative literal path per matched Subject per receiver, using exact bound Subject-kind prototypes. Only receiver operator/_subscribe closures, their internal contexts and context slot edges are traversed. Parent lexical contexts (internal previous), arbitrary object fields and source edges are excluded. Context slot names are not operator semantics. These positive holder hints do not certify share/reset behavior, complete upstream ownership, GC strength, or global release; zero remains unknown.' } };
}
