import { buildIncomingIndex } from './incoming-index.mjs';

// Snapshot-edge families, not a claim about JS [[Prototype]] or constructor identity.
// V8 can expose an own property and its prototype reference under the same name.
export function censusCandidateFamilies(heap, { excludedIds = new Set(), keys = null, collectIds = false } = {}) {
  if (!(excludedIds instanceof Set) || (keys !== null && !(keys instanceof Set)) || typeof collectIds !== 'boolean') throw Error('Candidate family exclusions/keys must be Sets and collectIds must be boolean');
  // Reuse the strict raw graph validator before decoding edge ranges. The reverse
  // index is temporary and is not retained in the returned per-snapshot census.
  buildIncomingIndex(heap);
  const meta = heap.snapshot.meta;
  const nf = Object.fromEntries(meta.node_fields.map((name, index) => [name, index]));
  const ef = Object.fromEntries(meta.edge_fields.map((name, index) => [name, index]));
  const nw = meta.node_fields.length, ew = meta.edge_fields.length;
  const nt = meta.node_types[nf.type], et = meta.edge_types[ef.type];
  const groups = new Map(), rawGroups = new Map(), byGroup = new Map([...(keys ?? [])].map(key => [key, new Set()])), allIds = new Set();
  const metadata = { method: 'literal-property-prototype-family-v1', objectNodeCount: 0, includedObjectCount: 0, excludedObjectCount: 0, resolvedObjectCount: 0, fallbackObjectCount: 0, familyCount: 0,
    fallbackReasons: { missing: 0, multiple: 0, 'non-object-target': 0 },
    interpretation: 'One direct property __proto__ edge to an object or closure defines a snapshot family. It does not certify JS prototype or constructor identity. Shared targets merge; changed targets split. Missing, multiple or non-object targets fall back to name/type. IDs are comparable only within the declared isolate.' };
  let edgeOffset = 0;
  for (let offset = 0; offset < heap.nodes.length; offset += nw) {
    const edgeEnd = edgeOffset + heap.nodes[offset + nf.edge_count] * ew;
    if (nt[heap.nodes[offset + nf.type]] !== 'object') { edgeOffset = edgeEnd; continue; }
    const id = heap.nodes[offset + nf.id]; allIds.add(id); metadata.objectNodeCount++;
    let matches = 0, targetOffset = null;
    for (; edgeOffset < edgeEnd; edgeOffset += ew) {
      if (et[heap.edges[edgeOffset + ef.type]] === 'property' && heap.strings[heap.edges[edgeOffset + ef.name_or_index]] === '__proto__') {
        matches++; targetOffset = heap.edges[edgeOffset + ef.to_node];
      }
    }
    const name = heap.strings[heap.nodes[offset + nf.name]];
    const reason = matches === 0 ? 'missing' : matches !== 1 ? 'multiple' : !['object', 'closure'].includes(nt[heap.nodes[targetOffset + nf.type]]) ? 'non-object-target' : null;
    const prototypeId = reason === null ? heap.nodes[targetOffset + nf.id] : null;
    const familyKey = JSON.stringify(reason === null ? ['object', 'direct-prototype-edge', prototypeId] : ['object', 'name-fallback', name]);
    function add(collection) {
      let group = collection.get(familyKey);
      if (!group) {
        group = { type: 'object', name, familyKey,
          family: reason === null ? { kind: 'direct-prototype-edge', prototypeId } : { kind: 'name-fallback', reasonCounts: {} },
          count: 0, selfSizeBytes: 0, exampleNodeIds: [] };
        collection.set(familyKey, group);
      }
      group.count++; group.selfSizeBytes += heap.nodes[offset + nf.self_size];
      if (group.exampleNodeIds.length < 3) group.exampleNodeIds.push(id);
      if (reason !== null) group.family.reasonCounts[reason] = (group.family.reasonCounts[reason] ?? 0) + 1;
    }
    add(rawGroups);
    if (excludedIds.has(id)) { metadata.excludedObjectCount++; continue; }
    add(groups);
    if (collectIds && !byGroup.has(familyKey)) byGroup.set(familyKey, new Set());
    byGroup.get(familyKey)?.add(id); metadata.includedObjectCount++;
    if (reason === null) metadata.resolvedObjectCount++;
    else { metadata.fallbackObjectCount++; metadata.fallbackReasons[reason]++; }
  }
  metadata.familyCount = groups.size;
  metadata.rawFamilyCount = rawGroups.size;
  return { groups, rawGroups, byGroup, allIds, metadata };
}
