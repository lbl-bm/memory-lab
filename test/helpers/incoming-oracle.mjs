// Test-only full-edge scan. No production index/decoder imports or reverse index.
export function scanIncoming(heap, targetIds) {
  const nfields = heap.snapshot.meta.node_fields, efields = heap.snapshot.meta.edge_fields;
  const nw = nfields.length, ew = efields.length;
  const nf = key => nfields.indexOf(key), ef = key => efields.indexOf(key);
  const nt = heap.snapshot.meta.node_types[nf('type')], et = heap.snapshot.meta.edge_types[ef('type')];
  const describe = off => ({ id: heap.nodes[off + nf('id')], type: nt[heap.nodes[off + nf('type')]], name: heap.strings[heap.nodes[off + nf('name')]], nodeIndex: off / nw, nodeOffset: off });
  const found = new Map(targetIds.map(id => [id, []]));
  let edgeOffset = 0;
  for (let nodeOffset = 0; nodeOffset < heap.nodes.length; nodeOffset += nw) {
    const count = heap.nodes[nodeOffset + nf('edge_count')];
    for (let local = 0; local < count; local++, edgeOffset += ew) {
      const target = describe(heap.edges[edgeOffset + ef('to_node')]);
      if (!found.has(target.id)) continue;
      const typeIndex = heap.edges[edgeOffset + ef('type')], type = et[typeIndex], rawNameOrIndex = heap.edges[edgeOffset + ef('name_or_index')];
      const nameKind = type === 'element' || type === 'hidden' ? 'index' : 'string';
      found.get(target.id).push({ source: describe(nodeOffset), target, edgeIndex: edgeOffset / ew, edgeOffset, typeIndex, type, nameKind, nameOrIndex: nameKind === 'index' ? rawNameOrIndex : heap.strings[rawNameOrIndex], rawNameOrIndex });
    }
  }
  return found;
}

// Logical source/target records form a separate oracle, before any flat encoding.
export function fixture(nodes, edges, reordered = false) {
  const strings = [], intern = s => { let at = strings.indexOf(s); if (at === -1) { at = strings.length; strings.push(s); } return at; };
  const nodeFields = reordered ? ['edge_count', 'id', 'name', 'self_size', 'type'] : ['type', 'name', 'id', 'self_size', 'edge_count'];
  const edgeFields = reordered ? ['to_node', 'name_or_index', 'type'] : ['type', 'name_or_index', 'to_node'];
  const nodeTypes = ['synthetic', 'object', 'array', 'closure'], edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'];
  const data = { snapshot: { meta: { node_fields: nodeFields, node_types: nodeFields.map(k => k === 'type' ? nodeTypes : k === 'name' ? 'string' : 'number'), edge_fields: edgeFields, edge_types: edgeFields.map(k => k === 'type' ? edgeTypes : k === 'to_node' ? 'node' : 'string_or_number'), location_fields: ['object_index', 'script_id', 'line', 'column'] }, node_count: nodes.length, edge_count: edges.length }, nodes: [], edges: [], strings, locations: [] };
  const ordered = [];
  for (const n of nodes) {
    const outgoing = edges.filter(e => e.from === n.id), row = { type: nodeTypes.indexOf(n.type ?? 'object'), name: intern(n.name), id: n.id, self_size: 24, edge_count: outgoing.length };
    data.nodes.push(...nodeFields.map(f => row[f])); ordered.push(...outgoing);
  }
  for (const e of ordered) {
    const row = { type: edgeTypes.indexOf(e.type), name_or_index: typeof e.name === 'number' ? e.name : intern(e.name), to_node: nodes.findIndex(n => n.id === e.to) * nodeFields.length };
    data.edges.push(...edgeFields.map(f => row[f]));
  }
  return data;
}

export function generatedFixture(seed, reordered = false) {
  let state = seed;
  const next = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const nodes = Array.from({ length: 19 }, (_, i) => ({ id: 2 ** 40 + i * 2 + seed * 100, name: 'n-' + i, type: i ? 'object' : 'synthetic' }));
  const kinds = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'];
  const edges = Array.from({ length: 113 }, (_, i) => { const type = kinds[next(kinds.length)]; return { from: nodes[next(nodes.length)].id, to: nodes[next(nodes.length)].id, type, name: ['element', 'hidden'].includes(type) ? 2 ** 33 + i : 'edge-' + next(7) }; });
  return { heap: fixture(nodes, edges, reordered), nodes, edges };
}
