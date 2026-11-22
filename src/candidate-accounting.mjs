import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function loadProbeAccounting(path, snapshotBytes) {
  if ((await stat(path)).size > 1024 ** 2) throw Error('probe-accounting-size-budget');
  const bytes = await readFile(path);
  if (bytes.length > 1024 ** 2) throw Error('probe-accounting-size-budget');
  const value = JSON.parse(bytes);
  if (value.schemaVersion !== '0.1.0' || value.method !== 'explicit-owned-slots' || typeof value.epochId !== 'string' || !value.epochId || typeof value.complete !== 'boolean' || !Array.isArray(value.objects) || value.objects.length > 8192) throw Error('invalid-probe-accounting');
  if (value.snapshotSha256 !== createHash('sha256').update(snapshotBytes).digest('hex')) throw Error('probe-accounting-snapshot-mismatch');
  const ids = new Set();
  for (const entry of value.objects) {
    if (!Number.isSafeInteger(entry.heapId) || entry.heapId < 1 || typeof entry.kind !== 'string' || !entry.kind || entry.kind.length > 128 || ids.has(entry.heapId)) throw Error('invalid-probe-owned-id');
    ids.add(entry.heapId);
  }
  return { ids, epochId: value.epochId, complete: value.complete, path, declaredCount: ids.size, limits: value.limits ?? null };
}

// Only the candidate census is filtered. The raw graph, baselines' all-ID sets,
// paths and retained-size analysis keep every node, including probe ownership.
export function subtractProbeOwned(heap, rawCensus, accounting) {
  const nf = Object.fromEntries(heap.snapshot.meta.node_fields.map((name, i) => [name, i])), width = heap.snapshot.meta.node_fields.length, types = heap.snapshot.meta.node_types[nf.type];
  const groups = new Map(), present = new Set(), excludedByGroup = new Map();
  for (let offset = 0; offset < heap.nodes.length; offset += width) {
    const id = heap.nodes[offset + nf.id], type = types[heap.nodes[offset + nf.type]], excluded = accounting.ids.has(id);
    if (excluded) present.add(id);
    if (type !== 'object') continue;
    const name = heap.strings[heap.nodes[offset + nf.name]], key = JSON.stringify([type, name]), size = heap.nodes[offset + nf.self_size];
    if (excluded) {
      const row = excludedByGroup.get(key) ?? { type, name, count: 0, shallowBytes: 0 }; row.count++; row.shallowBytes += size; excludedByGroup.set(key, row); continue;
    }
    if (!rawCensus.has(key)) throw Error('probe-accounting-census-mismatch');
    const row = groups.get(key) ?? { type, name, count: 0, selfSizeBytes: 0, exampleNodeIds: [] }; row.count++; row.selfSizeBytes += size;
    if (row.exampleNodeIds.length < 3) row.exampleNodeIds.push(id); groups.set(key, row);
  }
  return { groups, summary: { path: accounting.path, epochId: accounting.epochId, complete: accounting.complete, declaredCount: accounting.declaredCount,
    presentPrivateNodeCount: present.size, absentDeclaredNodeCount: accounting.ids.size - present.size,
    excludedObjectCount: [...excludedByGroup.values()].reduce((sum, row) => sum + row.count, 0), excludedByGroup: [...excludedByGroup.values()] } };
}
