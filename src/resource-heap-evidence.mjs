import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve, dirname, sep, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256, projectIdentityHeap } from './heap-identity.mjs';
import { buildIncomingIndex } from './incoming-index.mjs';
import { searchReversePaths } from './reverse-paths.mjs';
import { resourceHeapLimits as limits, selectResourceHeapObjects } from './resource-heap-capture.mjs';

const fail = code => { const error = Error(code); error.code = code; throw error; };
const uint = value => Number.isSafeInteger(value) && value >= 0;
async function limited(path, maximum) { const chunks = []; let bytes = 0; for await (const chunk of createReadStream(path)) { bytes += chunk.length; if (bytes > maximum) fail('resource-input-size-budget'); chunks.push(chunk); } return Buffer.concat(chunks); }
export async function loadResourceHeapCapture(path) {
  const capturePath = await realpath(resolve(path)), base = dirname(capturePath), capture = JSON.parse(await limited(capturePath, 1024 ** 2));
  if (capture.schemaVersion !== '0.1.0' || capture.adapter !== 'browser-resources-heap' || capture.status !== 'captured') fail('unsupported-resource-heap-capture');
  const maxima = { snapshot: limits.maxSnapshotBytes, source: 1024 ** 2, bundle: 16 * 1024 ** 2, registry: 1024 ** 2, observation: 4 * 1024 ** 2, identities: 1024 ** 2 }, bytes = {};
  for (const [key, maximum] of Object.entries(maxima)) {
    const artifact = capture.artifacts?.[key];
    if (typeof artifact?.path !== 'string' || isAbsolute(artifact.path) || !uint(artifact.bytes) || artifact.bytes > maximum) fail('invalid-resource-artifact');
    const actual = await realpath(resolve(base, artifact.path)); if (!actual.startsWith(base + sep)) fail('resource-artifact-outside-capture');
    bytes[key] = await limited(actual, maximum); if (bytes[key].length !== artifact.bytes || sha256(bytes[key]) !== artifact.sha256) fail('resource-artifact-mismatch');
  }
  return { capturePath, capture, heap: JSON.parse(bytes.snapshot), source: bytes.source.toString('utf8'), bundle: bytes.bundle.toString('utf8'), registry: JSON.parse(bytes.registry), observation: JSON.parse(bytes.observation), identities: JSON.parse(bytes.identities) };
}

export function analyzeResourceHeap(input) {
  const { capture, heap, source, bundle, registry, observation, identities } = input;
  if (capture.epochId !== observation.epochId || capture.epochId !== identities.epochId || capture.epochId !== capture.runtime?.epochId || !capture.epochId || !capture.anchorToken) fail('resource-epoch-mismatch');
  if (!capture.runtime.scriptId || !capture.runtime.targetId || !capture.runtime.frameId || !capture.runtime.browserVersion) fail('resource-runtime-binding-missing');
  if (capture.loadedScriptSha256 !== sha256(bundle) || capture.artifacts.bundle.sha256 !== sha256(bundle)) fail('resource-script-mismatch');
  if (capture.artifacts.source.sha256 !== sha256(source) || capture.artifacts.registry.sha256 !== sha256(JSON.stringify(registry, null, 2) + '\n')) fail('resource-source-registry-mismatch');
  const pack = JSON.parse(source), modules = new Map();
  if (pack.schemaVersion !== '0.1.0' || !Array.isArray(pack.modules) || pack.modules.length < 1 || pack.modules.length > 64 || registry.adapter !== 'browser-resources' || !Array.isArray(registry.sites) || registry.sites.length > 512) fail('invalid-resource-source-pack');
  for (const module of pack.modules) { if (typeof module.filename !== 'string' || !module.filename || typeof module.source !== 'string' || sha256(module.source) !== module.sourceSha256 || modules.has(module.filename)) fail('invalid-resource-source-module'); modules.set(module.filename, module); }
  if (!Array.isArray(registry.modules) || registry.modules.length !== modules.size || new Set(registry.modules.map(value => value.filename)).size !== modules.size || registry.modules.some(value => modules.get(value.filename)?.sourceSha256 !== value.sourceSha256)) fail('resource-module-list-mismatch');
  const locations = new Map();
  for (const site of registry.sites) {
    const module = modules.get(site.filename);
    if (!module || module.sourceSha256 !== site.sourceSha256 || !['addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].includes(site.operation) || !uint(site.start) || !uint(site.end) || site.end <= site.start || site.end > module.source.length || locations.has(site.id)) fail('invalid-resource-site');
    const lines = module.source.slice(0, site.start).split(/\r\n|[\r\n\u2028\u2029]/);
    if (site.line !== lines.length || site.column !== lines.at(-1).length + 1 || !bundle.includes(site.id) || site.id !== sha256(JSON.stringify([site.filename, site.sourceSha256, site.start, site.end, site.operation])).slice(0, 24)) fail('resource-site-binding-mismatch');
    locations.set(site.id, { file: site.filename, line: site.line, column: site.column, operation: site.operation, call: module.source.slice(site.start, site.end) });
  }
  if (observation.adapter !== 'browser-resources' || !Array.isArray(observation.resources) || observation.resources.length > 512 || !Array.isArray(observation.events) || observation.events.length > 2048 || !Array.isArray(observation.objects) || observation.objects.length > 4096 || !Array.isArray(observation.declarations)) fail('invalid-resource-observation');
  if (!capture.bridge?.handlesReleased || capture.bridge.eventsBefore !== capture.bridge.eventsAfter || capture.bridge.eventsAfter !== observation.events.length) fail('resource-handles-or-quiescence');
  if (identities.snapshotSha256 !== capture.artifacts.snapshot.sha256) fail('resource-identity-snapshot-mismatch');
  const selected = selectResourceHeapObjects(observation, capture.request);
  if (!isDeepStrictEqual(selected, capture.selected)) fail('resource-selection-mismatch');
  const knownObjects = new Set(observation.objects.map(value => value.id)), roles = new Map(observation.objects.map(value => [value.id, value.roles]));
  if (knownObjects.size !== observation.objects.length || new Set(observation.resources.map(value => value.id)).size !== observation.resources.length || !Array.isArray(identities.objects) || identities.objects.length !== selected.objectIds.length) fail('resource-identity-registry-mismatch');
  if (observation.objects.some(value => !/^o[1-9][0-9]*$/.test(value.id) || !Array.isArray(value.roles) || !value.roles.length || value.roles.some(role => !['target', 'callback', 'wrapper', 'signal', 'declared-target', 'declared-holder'].includes(role))) || observation.declarations.length > 64 || new Set(observation.declarations.map(value => value.label)).size !== observation.declarations.length || observation.declarations.some(value => !['target', 'holder'].includes(value.role) || !roles.get(value.objectId)?.includes('declared-' + value.role))) fail('resource-role-or-declaration-mismatch');
  for (const resource of observation.resources) {
    if (!/^r[1-9][0-9]*$/.test(resource.id) || !['listener', 'timeout', 'interval'].includes(resource.kind) || !['active', 'running', 'released', 'completed', 'target-unavailable'].includes(resource.state) || (resource.registrationSiteId !== null && !locations.has(resource.registrationSiteId)) || (resource.releaseSiteId !== null && !locations.has(resource.releaseSiteId))) fail('invalid-resource-record');
    for (const id of [resource.callbackId, resource.targetId, resource.wrapperId, resource.signalId].filter(Boolean)) if (!knownObjects.has(id)) fail('resource-object-id-unknown');
    for (const [id, role] of [[resource.callbackId, 'callback'], [resource.wrapperId, 'wrapper'], [resource.targetId, 'target'], [resource.signalId, 'signal']]) if (id && !roles.get(id)?.includes(role)) fail('resource-role-or-declaration-mismatch');
    if (resource.registrationSiteId !== null && locations.get(resource.registrationSiteId).operation !== (resource.kind === 'listener' ? 'addEventListener' : resource.kind === 'timeout' ? 'setTimeout' : 'setInterval')) fail('resource-registration-site-operation-mismatch');
    if (resource.releaseSiteId !== null && !(resource.kind === 'listener' ? ['removeEventListener'] : ['clearTimeout', 'clearInterval']).includes(locations.get(resource.releaseSiteId).operation)) fail('resource-release-site-operation-mismatch');
  }
  const index = buildIncomingIndex(heap), anchors = projectIdentityHeap(heap).anchors;
  if (anchors.length !== 1 || anchors[0].epoch !== capture.epochId || anchors[0].token !== capture.anchorToken) fail('resource-heap-epoch-mismatch');
  const objects = new Map(), heapIds = new Set(), unknown = [];
  for (const identity of identities.objects) {
    if (!selected.objectIds.includes(identity.id) || objects.has(identity.id) || !['resolved', 'cleared', 'unresolved'].includes(identity.resolution) || (identity.resolution === 'resolved' ? !uint(identity.heapId) || identity.heapId === 0 : identity.heapId !== null)) fail('invalid-resource-heap-identity');
    const result = { id: identity.id, bridgeResolution: identity.resolution, resolution: identity.resolution === 'cleared' ? 'weak-cleared' : 'unresolved', heapId: identity.heapId, node: null, directIncoming: null };
    if (identity.resolution === 'resolved') {
      if (heapIds.has(identity.heapId)) fail('duplicate-resource-heap-id'); heapIds.add(identity.heapId);
      try { result.node = index.describeNode(identity.heapId); } catch (error) { if (error.code !== 'target-not-found') throw error; result.resolution = 'not-present-in-final-heap'; unknown.push('identity-not-in-final-heap'); }
      if (result.node) {
        result.resolution = 'present-in-final-heap'; const totalCount = index.incomingCount(identity.heapId), edges = [];
        for (const edge of index.incomingEdges(identity.heapId)) { if (edges.length === limits.maxIncomingEdges) break; edges.push(edge); }
        result.directIncoming = { totalCount, sampledCount: edges.length, complete: edges.length === totalCount, edges, interpretation: 'Direct literal incoming edges, including explicit weak edges; these are not all transitive holders or certified GC retaining edges.' };
        if (edges.length !== totalCount) unknown.push('direct-incoming-sample-truncated');
      }
    } else if (identity.resolution === 'unresolved') unknown.push('identity-unresolved');
    objects.set(identity.id, result);
  }
  let remainingEdges = limits.maxSearchEdges;
  function path(fromId, toId) {
    const from = objects.get(fromId), to = objects.get(toId);
    if (from?.resolution !== 'present-in-final-heap' || to?.resolution !== 'present-in-final-heap') return { outcome: 'identity-unavailable', fromResolution: from?.resolution ?? 'not-selected', toResolution: to?.resolution ?? 'not-selected', path: null };
    const result = searchReversePaths(index, to.heapId, { rootIds: [from.heapId], edgePolicy: 'exclude-weak', maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxEdges: Math.min(remainingEdges, limits.maxEdgesPerSearch) });
    remainingEdges -= result.stats.examinedEdges; if (result.outcome === 'incomplete') unknown.push('bounded-path-search-incomplete'); return result;
  }
  const resources = observation.resources.filter(value => selected.resourceIds.includes(value.id)).map(resource => ({ resourceId: resource.id, kind: resource.kind, eventType: resource.type ?? null, registrationState: resource.state, stateCertain: resource.stateCertain,
    registration: locations.get(resource.registrationSiteId) ?? null, release: locations.get(resource.releaseSiteId) ?? null, endedBy: resource.endedBy ?? null,
    callback: objects.get(resource.callbackId) ?? null, wrapper: objects.get(resource.wrapperId) ?? null, eventTarget: objects.get(resource.targetId) ?? null,
    paths: [{ leg: 'wrapper-to-callback', result: path(resource.wrapperId, resource.callbackId) }, ...(resource.targetId ? [{ leg: 'event-target-to-wrapper', result: path(resource.targetId, resource.wrapperId) }] : [])],
  }));
  const targets = selected.targets.map(target => ({ ...target, ...objects.get(target.objectId), objectId: target.objectId,
    pathsFromResources: observation.resources.filter(value => selected.resourceIds.includes(value.id)).map(resource => ({ resourceId: resource.id, leg: 'callback-to-declared-target', result: path(resource.callbackId, target.objectId) })),
    pathsFromDeclaredHolders: selected.holders.map(holder => ({ label: holder.label, objectId: holder.objectId, result: path(holder.objectId, target.objectId) })),
  }));
  if (observation.coverage.unsupported || observation.coverage.dropped) unknown.push('resource-observation-incomplete');
  if (resources.some(resource => resource.stateCertain !== true)) unknown.push('selected-resource-state-uncertain');
  const allPaths = [...resources.flatMap(value => value.paths), ...targets.flatMap(value => [...value.pathsFromResources, ...value.pathsFromDeclaredHolders])];
  const unknownReasons = [...new Set(unknown)];
  return { schemaVersion: '0.1.0', capability: 'resource-heap-source-evidence', status: unknownReasons.length ? 'incomplete' : 'completed', input: { capturePath: input.capturePath, epochId: capture.epochId, runtime: capture.runtime, snapshot: capture.artifacts.snapshot, sourceMapsUsed: false },
    objects: [...objects.values()], resources, targets, holders: selected.holders.map(holder => ({ ...holder, ...objects.get(holder.objectId), objectId: holder.objectId })),
    coverage: { unknownReasons, limits, examinedEdges: limits.maxSearchEdges - remainingEdges, pathEnumeration: 'one-shortest-literal-path-per-requested-pair; not all paths or all holders' },
    summary: { selectedResources: resources.length, presentObjects: [...objects.values()].filter(value => value.resolution === 'present-in-final-heap').length, weakClearedObjects: [...objects.values()].filter(value => value.resolution === 'weak-cleared').length, declaredTargetsPresent: targets.filter(value => value.resolution === 'present-in-final-heap').length, declaredTargetsWeakCleared: targets.filter(value => value.resolution === 'weak-cleared').length, pathsFound: allPaths.filter(value => value.result.outcome === 'path-found').length, declaredHolderPathsFound: targets.flatMap(value => value.pathsFromDeclaredHolders).filter(value => value.result.outcome === 'path-found').length },
    interpretation: 'Registration lifecycle, weak-identity availability, final-heap nodes and bounded literal paths are separate observations. A released registration can coexist with a live target held elsewhere. Declared holders are caller-selected objects, not certified GC roots. Missing paths do not prove release, and sampled direct incoming edges do not enumerate all retaining chains.' };
}
