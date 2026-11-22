import { openSync, closeSync, writeSync } from 'node:fs';
import { writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sha256 } from './heap-identity.mjs';

export const resourceHeapLimits = Object.freeze({ maxSnapshotBytes: 64 * 1024 ** 2, maxResources: 32, maxTargets: 8, maxHolders: 8, maxObjects: 160, maxDepth: 8, maxNodes: 5000, maxEdgesPerSearch: 20000, maxSearchEdges: 200000, maxIncomingEdges: 64 });

export function selectResourceHeapObjects(observation, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['resourceFilter', 'targetLabels', 'holderLabels'].includes(key))) throw Error('invalid-resource-heap-request');
  const filter = request.resourceFilter ?? {};
  if (typeof filter !== 'object' || Array.isArray(filter) || Object.keys(filter).some(key => !['kind', 'eventType'].includes(key)) || (filter.kind !== undefined && !['listener', 'timeout', 'interval'].includes(filter.kind)) || (filter.eventType !== undefined && typeof filter.eventType !== 'string')) throw Error('invalid-resource-filter');
  const resources = observation.resources.filter(resource => (filter.kind === undefined || resource.kind === filter.kind) && (filter.eventType === undefined || resource.type === filter.eventType));
  if (resources.length > resourceHeapLimits.maxResources) throw Error('selected-resource-budget');
  const select = (labels, role, maximum) => {
    labels ??= []; if (!Array.isArray(labels) || labels.length > maximum || labels.some(label => typeof label !== 'string' || !label) || new Set(labels).size !== labels.length) throw Error('invalid-resource-object-labels');
    return labels.map(label => { const declaration = observation.declarations?.find(value => value.label === label && value.role === role); if (!declaration) throw Error('resource-object-label-not-declared:' + label); return declaration; });
  };
  const targets = select(request.targetLabels, 'target', resourceHeapLimits.maxTargets), holders = select(request.holderLabels, 'holder', resourceHeapLimits.maxHolders);
  const objectIds = [...new Set([...resources.flatMap(resource => [resource.targetId, resource.callbackId, resource.wrapperId, resource.signalId]), ...targets.map(value => value.objectId), ...holders.map(value => value.objectId)].filter(Boolean))];
  if (objectIds.length > resourceHeapLimits.maxObjects || objectIds.some(id => !observation.objects.some(value => value.id === id))) throw Error('selected-object-budget-or-unregistered-identity');
  return { resourceIds: resources.map(value => value.id), targets, holders, objectIds };
}

export async function captureResourceHeap({ page, cdp, output, prefix, request, runtime, anchorToken, build }) {
  const save = async (name, value) => { const text = JSON.stringify(value, null, 2) + '\n'; await writeFile(resolve(output, name), text, { flag: 'wx' }); return { path: name, bytes: Buffer.byteLength(text), sha256: sha256(text) }; };
  const pause = async () => { await page.waitForTimeout(20); await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(20); await cdp.send('HeapProfiler.collectGarbage'); };
  async function snapshot(name) {
    const fd = openSync(resolve(output, name), 'wx'), hash = createHash('sha256'); let bytes = 0, failure;
    const listener = ({ chunk }) => { bytes += Buffer.byteLength(chunk); if (bytes > resourceHeapLimits.maxSnapshotBytes) { failure = Error('resource-snapshot-budget'); return; } try { writeSync(fd, chunk); hash.update(chunk); } catch (error) { failure = error; } };
    cdp.on('HeapProfiler.addHeapSnapshotChunk', listener);
    try { await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); } finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', listener); closeSync(fd); }
    if (failure) throw failure; return { path: name, bytes, sha256: hash.digest('hex') };
  }
  await pause(); const before = await page.evaluate(() => globalThis.__memoryLabProbe.report()), selected = selectResourceHeapObjects(before, request);
  await snapshot(prefix + '-seed.heapsnapshot');
  const identities = [], ownedObjects = [], objectGroup = 'memory-lab-resource-bridge-' + prefix;
  let ownedSummary, unresolvedOwnedObjects = 0;
  try {
    for (const id of selected.objectIds) {
      const response = await cdp.send('Runtime.evaluate', { expression: `globalThis.__memoryLabProbe.resolve(${JSON.stringify(id)})`, objectGroup, silent: true });
      if (response.exceptionDetails) throw Error('resource-identity-evaluation-failed');
      const identity = { id, resolution: 'cleared', heapId: null };
      if (response.result.objectId) {
        const heapId = Number((await cdp.send('HeapProfiler.getHeapObjectId', { objectId: response.result.objectId })).heapSnapshotObjectId);
        if (Number.isSafeInteger(heapId) && heapId > 0) { identity.resolution = 'resolved'; identity.heapId = heapId; }
        else { identity.resolution = 'unresolved'; identity.reason = 'no-snapshot-object-id'; }
      } else if (response.result.type !== 'undefined') { identity.resolution = 'unresolved'; identity.reason = 'non-object-bridge-result'; }
      identities.push(identity);
    }
    const inventory = await cdp.send('Runtime.evaluate', { expression: 'globalThis.__memoryLabProbe.probeOwnedObjects()', objectGroup, silent: true });
    if (inventory.exceptionDetails || !inventory.result.objectId) throw Error('probe-owned-inventory-failed');
    const summary = await cdp.send('Runtime.callFunctionOn', { objectId: inventory.result.objectId, functionDeclaration: 'function() { return { complete: this.complete, limits: this.limits, kinds: this.objects.map(entry => entry.kind) }; }', returnByValue: true, silent: true });
    ownedSummary = summary.result.value;
    if (summary.exceptionDetails || typeof ownedSummary?.complete !== 'boolean' || !Array.isArray(ownedSummary.kinds) || ownedSummary.kinds.length > 8192) throw Error('invalid-probe-owned-inventory');
    const values = await cdp.send('Runtime.callFunctionOn', { objectId: inventory.result.objectId, functionDeclaration: 'function() { return this.objects.map(entry => entry.value); }', objectGroup, silent: true });
    if (values.exceptionDetails || !values.result.objectId) throw Error('probe-owned-values-failed');
    const properties = await cdp.send('Runtime.getProperties', { objectId: values.result.objectId, ownProperties: true });
    const indexed = new Map(properties.result.filter(value => /^(0|[1-9][0-9]*)$/.test(value.name)).map(value => [Number(value.name), value.value?.objectId]));
    for (let start = 0; start < ownedSummary.kinds.length; start += 16) {
      const batch = await Promise.all(ownedSummary.kinds.slice(start, start + 16).map(async (kind, offset) => {
        const objectId = indexed.get(start + offset);
        const heapId = objectId ? Number((await cdp.send('HeapProfiler.getHeapObjectId', { objectId })).heapSnapshotObjectId) : 0;
        return Number.isSafeInteger(heapId) && heapId > 0 ? { heapId, kind } : null;
      }));
      for (const entry of batch) if (entry) ownedObjects.push(entry); else unresolvedOwnedObjects++;
    }
  } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup }); }
  await pause(); const heap = await snapshot(prefix + '.heapsnapshot'), observation = await page.evaluate(() => globalThis.__memoryLabProbe.report());
  if (JSON.stringify(before.events) !== JSON.stringify(observation.events) || before.coverage.dropped !== observation.coverage.dropped || before.coverage.unsupported !== observation.coverage.unsupported || JSON.stringify(selected) !== JSON.stringify(selectResourceHeapObjects(observation, request))) throw Error('resource-capture-not-quiescent');
  const observationArtifact = await save(prefix + '-observation.json', observation), identityArtifact = await save(prefix + '-identities.json', { epochId: runtime.epochId, snapshotSha256: heap.sha256, objects: identities });
  const probeAccounting = await save(prefix + '-probe-accounting.json', { schemaVersion: '0.1.0', method: 'explicit-owned-slots', epochId: runtime.epochId, snapshotSha256: heap.sha256, complete: ownedSummary.complete && unresolvedOwnedObjects === 0, objects: ownedObjects, limits: { ...ownedSummary.limits, enumeratedObjects: ownedSummary.kinds.length, unresolvedObjects: unresolvedOwnedObjects } });
  const existing = async (path, hash) => ({ path, bytes: (await stat(resolve(output, path))).size, sha256: hash });
  const capture = { schemaVersion: '0.1.0', adapter: 'browser-resources-heap', status: 'captured', epochId: runtime.epochId, anchorToken, runtime, request, selected,
    loadedScriptSha256: build.bundles.instrumented.sha256,
    bridge: { handlesReleased: true, eventsBefore: before.events.length, eventsAfter: observation.events.length, quiescence: 'Stable instrumented event sequence across bridge and final snapshot; does not prove all asynchronous work settled' },
    artifacts: { snapshot: heap, observation: observationArtifact, identities: identityArtifact, probeAccounting, source: await existing('source.json', build.sourceSha256), registry: await existing('registry.json', build.registrySha256), bundle: await existing('instrumented.js', build.bundles.instrumented.sha256) } };
  const artifact = await save(prefix + '-capture.json', capture);
  return { capturePath: resolve(output, artifact.path), capture: artifact, probeAccountingPath: resolve(output, probeAccounting.path), snapshot: { ...heap, path: resolve(output, heap.path) }, observation };
}
