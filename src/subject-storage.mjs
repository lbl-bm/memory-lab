import { buildIncomingIndex } from './incoming-index.mjs';

export const subjectStorageLimits = Object.freeze({ maxSubjects: 64, maxEdges: 200000, maxObjects: 1024 });
const kinds = ['BehaviorSubject', 'ReplaySubject', 'AsyncSubject'];
const safeId = id => Number.isSafeInteger(id) && id > 0;

// A narrow storage relation, separate from observer membership and GC retained size.
export function analyzeSubjectStorage(heap, { subjectPrototypeId, subjectKindPrototypeIds = {}, subjectIds, maxEdges = subjectStorageLimits.maxEdges }) {
  const anchors = Object.entries(subjectKindPrototypeIds);
  if (!safeId(subjectPrototypeId) || !subjectIds || !Array.isArray(subjectIds) || subjectIds.length > subjectStorageLimits.maxSubjects || subjectIds.some(id => !safeId(id)) || new Set(subjectIds).size !== subjectIds.length || anchors.some(([kind, id]) => !kinds.includes(kind) || !safeId(id)) || new Set([subjectPrototypeId, ...anchors.map(([, id]) => id)]).size !== anchors.length + 1 || !Number.isSafeInteger(maxEdges) || maxEdges < 0 || maxEdges > subjectStorageLimits.maxEdges) throw Error('invalid-subject-storage-options');
  const index = buildIncomingIndex(heap), meta = heap.snapshot.meta;
  const nf = Object.fromEntries(meta.node_fields.map((key, i) => [key, i])), ef = Object.fromEntries(meta.edge_fields.map((key, i) => [key, i]));
  const nw = meta.node_fields.length, ew = meta.edge_fields.length, edgeTypes = meta.edge_types[ef.type], starts = new Uint32Array(index.stats.nodeCount + 1);
  for (let i = 0; i < index.stats.nodeCount; i++) starts[i + 1] = starts[i] + heap.nodes[i * nw + nf.edge_count];
  let examinedEdges = 0, objectCount = 0, exhausted = false;
  const cache = new Map();
  function edges(id) {
    if (cache.has(id)) return cache.get(id);
    const node = index.describeNode(id), rows = [];
    for (let i = starts[node.nodeIndex]; i < starts[node.nodeIndex + 1]; i++) {
      if (examinedEdges >= maxEdges) { exhausted = true; throw Error('storage-edge-limit'); }
      examinedEdges++;
      const offset = i * ew, type = edgeTypes[heap.edges[offset + ef.type]], raw = heap.edges[offset + ef.name_or_index];
      rows.push({ sourceId: id, targetId: heap.nodes[heap.edges[offset + ef.to_node] + nf.id], type, name: ['element', 'hidden'].includes(type) ? raw : heap.strings[raw], edgeIndex: i });
    }
    cache.set(id, rows); return rows;
  }
  const property = (rows, name) => rows.filter(edge => edge.type === 'property' && edge.name === name);
  const records = [];
  for (const subjectId of subjectIds) {
    const storedObjects = [], unknownReasons = []; let subjectKind = null;
    try {
      if (exhausted) throw Error('storage-edge-limit');
      const node = index.describeNode(subjectId), rows = edges(subjectId), proto = property(rows, '__proto__');
      if (node.type !== 'object' || proto.length !== 1) throw Error('storage-subject-prototype-unconfirmed');
      const anchor = anchors.find(([, id]) => id === proto[0].targetId);
      if (!anchor) throw Error('storage-subject-kind-outside-scope');
      subjectKind = anchor[0];
      const parent = property(edges(anchor[1]), '__proto__');
      if (index.describeNode(anchor[1]).type !== 'object' || index.describeNode(subjectPrototypeId).type !== 'object' || parent.length !== 1 || parent[0].targetId !== subjectPrototypeId) throw Error('storage-kind-prototype-unconfirmed');
      if (!['observers', 'closed', 'isStopped', 'currentObservers'].every(name => property(rows, name).length === 1)) throw Error('storage-subject-shape-unconfirmed');
      const field = subjectKind === 'ReplaySubject' ? '_buffer' : '_value', slots = property(rows, field);
      if (slots.length !== 1) throw Error('storage-field-unconfirmed');
      let candidates = [{ edge: slots[0], witness: [slots[0]] }];
      if (subjectKind === 'ReplaySubject') {
        const buffer = index.describeNode(slots[0].targetId);
        if (buffer.type !== 'object' || buffer.name !== 'Array') throw Error('storage-buffer-unconfirmed');
        const elements = edges(buffer.id).filter(edge => edge.type === 'element');
        if (new Set(elements.map(edge => edge.name)).size !== elements.length) throw Error('storage-buffer-index-ambiguous');
        candidates = elements.map(edge => ({ edge, witness: [slots[0], edge] }));
      }
      const seen = new Set();
      for (const { edge, witness } of candidates) {
        const value = index.describeNode(edge.targetId);
        // Timestamp/primitive entries are outside this object-reference metric.
        if (!['object', 'closure'].includes(value.type) || seen.has(value.id)) continue;
        if (objectCount >= subjectStorageLimits.maxObjects) throw Error('storage-object-limit');
        seen.add(value.id); objectCount++;
        storedObjects.push({ subjectId, valueId: value.id, valueType: value.type, field, edges: witness });
      }
    } catch (error) { unknownReasons.push(error.message); }
    records.push({ subjectId, subjectKind, status: unknownReasons.length ? 'incomplete' : 'completed', objectCount: storedObjects.length, storedObjects, unknownReasons });
  }
  const unknownReasons = [...new Set(records.flatMap(record => record.unknownReasons))];
  return { status: unknownReasons.length ? 'incomplete' : 'completed', records, coverage: { scope: 'bound-primary-Subject-value-and-buffer-object-references', unknownReasons, examinedEdges, indexNodeCount: index.stats.nodeCount, indexEdgeCount: index.stats.edgeCount, limits: { ...subjectStorageLimits, maxEdges }, indexing: 'Full validated index and offsets precede bounded slot reads; indexing cost is not included in examinedEdges.' },
    interpretation: 'Distinct (Subject, object/function) references in BehaviorSubject/AsyncSubject._value or ReplaySubject._buffer element edges at this checkpoint. Primitives, error slots, upstream shared closures and other owners are outside scope. Cancellation/completion does not imply these references are gone; a positive count is not itself a leak.' };
}
