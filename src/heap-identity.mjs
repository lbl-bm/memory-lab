import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { censusObjects } from './snapshot-growth.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const marker = Object.freeze({ epoch: '__memoryLabEpoch', anchor: '__memoryLabAnchor', resource: '__memoryLabResource', owner: '__memoryLabOwner' });
export const routePolicy = Object.freeze({ maxDepth: 8, maxEdges: 50000, allowedEdges: ['property', 'element', 'internal', 'context', 'hidden'] });

// Opt-in string properties only. A token in an observer's string log is not a tagged object.
export function projectIdentityHeap(heap, ownerToken = null) {
  censusObjects(heap);
  const meta = heap.snapshot.meta, nf = meta.node_fields, ef = meta.edge_fields;
  if (!Array.isArray(ef) || !Array.isArray(heap.edges)) throw Error('Heap edges are required for identity/owner evidence');
  const n = Object.fromEntries(nf.map((f, i) => [f, i])), e = Object.fromEntries(ef.map((f, i) => [f, i]));
  if (!Number.isInteger(n.edge_count) || ['type', 'name_or_index', 'to_node'].some(f => !Number.isInteger(e[f]))) throw Error('Unsupported edge metadata');
  const nt = meta.node_types[n.type], et = meta.edge_types?.[e.type];
  if (!Array.isArray(et) || heap.edges.length % ef.length) throw Error('Invalid edge metadata');
  const nodes = [], byOffset = new Map(), byId = new Map(); let edgeOffset = 0;
  for (let o = 0; o < heap.nodes.length; o += nf.length) {
    const count = heap.nodes[o + n.edge_count], id = heap.nodes[o + n.id];
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(id) || byId.has(id)) throw Error('Invalid edge count or duplicate node ID');
    const node = { id, name: heap.strings[heap.nodes[o + n.name]], type: nt[heap.nodes[o + n.type]], edgeOffset, count };
    nodes.push(node); byOffset.set(o, node); byId.set(id, node); edgeOffset += count * ef.length;
  }
  if (edgeOffset !== heap.edges.length) throw Error('Edge counts do not match edge array');
  function* edges(node) {
    for (let o = node.edgeOffset; o < node.edgeOffset + node.count * ef.length; o += ef.length) {
      const type = et[heap.edges[o + e.type]], to = byOffset.get(heap.edges[o + e.to_node]);
      if (!type || !to) throw Error('Invalid edge target/type');
      const rawName = heap.edges[o + e.name_or_index];
      yield { type, name: ['element', 'hidden'].includes(type) ? rawName : heap.strings[rawName], to };
    }
  }
  const stringCache = new Map();
  function stringValue(node, depth = 0) {
    if (stringCache.has(node.id)) return stringCache.get(node.id);
    if (depth > 32) throw Error('Identity string exceeds rope-depth budget');
    let value;
    if (node.type === 'string') value = node.name;
    else if (node.type === 'concatenated string') {
      const parts = [...edges(node)].filter(e => e.type === 'internal' && ['first', 'second'].includes(e.name));
      if (parts.length !== 2 || new Set(parts.map(p => p.name)).size !== 2) throw Error('Unsupported identity rope layout');
      value = stringValue(parts.find(p => p.name === 'first').to, depth + 1) + stringValue(parts.find(p => p.name === 'second').to, depth + 1);
    } else throw Error('Unsupported identity string representation: ' + node.type);
    if (typeof value !== 'string' || value.length > 256) throw Error('Identity string exceeds length budget');
    stringCache.set(node.id, value); return value;
  }
  const anchors = [], resources = [], owners = [], keys = new Set(Object.values(marker));
  for (const node of nodes) {
    if (node.type !== 'object') continue;
    const props = {};
    for (const edge of edges(node)) if (edge.type === 'property' && keys.has(edge.name)) {
      if (props[edge.name] !== undefined) throw Error('Ambiguous identity marker');
      props[edge.name] = stringValue(edge.to);
    }
    if (props[marker.epoch] !== undefined || props[marker.anchor] !== undefined) anchors.push({ id: node.id, epoch: props[marker.epoch], token: props[marker.anchor] });
    if (props[marker.resource] !== undefined) resources.push({ id: node.id, token: props[marker.resource], ownerToken: props[marker.owner] });
    else if (props[marker.owner] !== undefined) owners.push({ id: node.id, token: props[marker.owner] });
  }
  function ownerRoute(from, to) {
    const start = byId.get(from); if (!start) return { status: 'missing-owner' };
    const queue = [{ node: start, path: [{ id: from, name: start.name, type: start.type, edgeToNext: null }] }], seen = new Set([from]); let traversed = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const item = queue[qi];
      if (item.node.id === to) return { status: 'observed', path: item.path, traversedEdges: traversed };
      if (item.path.length > routePolicy.maxDepth) continue;
      for (const edge of edges(item.node)) {
        if (++traversed > routePolicy.maxEdges) return { status: 'budget-exceeded', traversedEdges: traversed };
        if (!routePolicy.allowedEdges.includes(edge.type) || seen.has(edge.to.id)) continue;
        seen.add(edge.to.id);
        const path = item.path.slice(); path[path.length - 1] = { ...path.at(-1), edgeToNext: { name: edge.name, type: edge.type } };
        path.push({ id: edge.to.id, name: edge.to.name, type: edge.to.type, edgeToNext: null }); queue.push({ node: edge.to, path });
      }
    }
    return { status: 'not-observed-within-budget', traversedEdges: traversed };
  }
  const matches = owners.filter(o => o.token === ownerToken);
  for (const r of resources) r.ownerRoute = matches.length === 1 ? ownerRoute(matches[0].id, r.id) : { status: 'ambiguous-or-missing-owner' };
  return { anchors, resources, owners, nodeCount: nodes.length };
}

export async function readBoundJson(path, maxBytes = 256 * 1024) {
  const canonical = await realpath(resolve(path));
  if ((await stat(canonical)).size > maxBytes) throw Error('Sidecar exceeds input budget');
  const raw = await readFile(canonical); return { path: canonical, sha256: sha256(raw), value: JSON.parse(raw) };
}

export async function verifyBoundSource(source, runDir) {
  if (!source?.path || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '')) return false;
  const path = await realpath(resolve(runDir, source.path));
  if (!path.startsWith(runDir + sep) || (await stat(path)).size > 1024 * 1024) return false;
  return sha256(await readFile(path)) === source.sha256;
}

export function validateIdentitySeries(manifest, report, reportHash, points, projections, sourceValid) {
  const fail = (code, detail) => ({ status: 'invalid', comparable: false, code, detail });
  if (!manifest) return { status: 'unknown', comparable: false, code: 'missing-contemporaneous-identity', detail: 'Do not retrofit an epoch or join object IDs from an old series.' };
  if (manifest.schemaVersion !== '0.1.0' || manifest.runId !== report.runId || manifest.captureReportSha256 !== reportHash) return fail('run-binding-mismatch', 'Manifest does not bind this exact capture report');
  if (!sourceValid) return fail('collector-source-mismatch', 'Collector source bytes are missing or differ');
  if (!manifest.epochId || !manifest.anchorToken || !manifest.ownerToken || !Number.isSafeInteger(manifest.runtime?.pid) || manifest.runtime.pid < 1 || manifest.runtime.threadId !== 0 || manifest.runtime.kind !== 'node-main-isolate') return fail('unsupported-runtime', 'Only the explicit Node main-isolate adapter is validated');
  if (!Array.isArray(manifest.points) || manifest.points.length !== points.length || projections.length !== points.length || !Array.isArray(manifest.resources)) return fail('point-count-mismatch', 'Capture series or resource events are incomplete');
  const tokenIds = new Map(), idTokens = new Map(), lastSeen = new Map(), eventTokens = new Set(), eventByToken = new Map();
  for (const event of manifest.resources ?? []) {
    if (!event.token || event.ownerToken !== manifest.ownerToken || eventTokens.has(event.token) || !/^\d+$/.test(event.createdNs ?? '') || (event.closedNs != null && (!/^\d+$/.test(event.closedNs) || BigInt(event.closedNs) < BigInt(event.createdNs)))) return fail('resource-event-invalid', 'Resource tokens/events must be unique and ordered');
    eventTokens.add(event.token); eventByToken.set(event.token, event);
  }
  let anchorId = null, ownerId = null, lastNs = -1n;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], stamp = manifest.points[i], projection = projections[i];
    if (stamp.path !== p.path || stamp.sha256 !== p.sha256 || stamp.phase !== p.phase || stamp.cycle !== p.cycle || stamp.sequence !== i) return fail('snapshot-binding-mismatch', 'Snapshot/order/hash differs at point ' + i);
    if (stamp.epochId !== manifest.epochId || stamp.pid !== manifest.runtime.pid || stamp.threadId !== manifest.runtime.threadId) return fail('runtime-epoch-changed', 'Runtime/epoch changed at point ' + i);
    if (!/^\d+$/.test(stamp.startedNs ?? '') || BigInt(stamp.startedNs) <= lastNs) return fail('capture-clock-invalid', 'Monotonic capture time did not advance');
    lastNs = BigInt(stamp.startedNs);
    const anchor = projection.anchors;
    if (anchor.length !== 1 || anchor[0].epoch !== manifest.epochId || anchor[0].token !== manifest.anchorToken) return fail('anchor-mismatch', 'Exactly one matching heap anchor is required at every point');
    if (anchorId !== null && anchorId !== anchor[0].id) return fail('anchor-id-changed', 'Anchor object ID changed across snapshots');
    anchorId = anchor[0].id;
    const owners = projection.owners.filter(o => o.token === manifest.ownerToken);
    if (owners.length !== 1 || (ownerId !== null && ownerId !== owners[0].id)) return fail('owner-identity-changed', 'Owner token must select one continuous object');
    ownerId = owners[0].id;
    const perPoint = new Set();
    for (const resource of projection.resources) {
      if (!eventTokens.has(resource.token) || resource.ownerToken !== manifest.ownerToken || perPoint.has(resource.token)) return fail('resource-token-invalid', 'Missing event, foreign owner or duplicate resource token');
      if (BigInt(eventByToken.get(resource.token).createdNs) > BigInt(stamp.startedNs)) return fail('resource-created-after-capture', 'Creation event is later than the resource observation');
      perPoint.add(resource.token);
      if (tokenIds.has(resource.token) && tokenIds.get(resource.token) !== resource.id) return fail('resource-id-changed', 'Same token has a different object ID');
      if (idTokens.has(resource.id) && idTokens.get(resource.id) !== resource.token) return fail('resource-id-reused', 'Same object ID has a different resource token');
      if (lastSeen.has(resource.token) && lastSeen.get(resource.token) !== i - 1) return fail('resource-reappeared', 'A missing resource token reappeared');
      tokenIds.set(resource.token, resource.id); idTokens.set(resource.id, resource.token); lastSeen.set(resource.token, i);
    }
  }
  return { status: 'validated-consistency', comparable: true, anchorId, ownerId, trackedResourceTokens: tokenIds.size, trust: 'Conditional on truthful, unmodified collector and explicit token protocol. No independent execution attestation or authenticity guarantee.' };
}
