import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve, dirname, sep, isAbsolute } from 'node:path';
import { sha256, projectIdentityHeap } from './heap-identity.mjs';
import { buildIncomingIndex } from './incoming-index.mjs';
import { searchReversePaths } from './reverse-paths.mjs';
import { analyzeSubscriptionSources } from './subscription-sources.mjs';
import { analyzeSubjectStorage, subjectStorageLimits } from './subject-storage.mjs';
import { analyzeReceiverSubjects } from './receiver-subjects.mjs';

export const siteEvidenceLimits = Object.freeze({ maxSnapshotBytes: 64 * 1024 ** 2, maxSourceBytes: 1024 ** 2, maxBundleBytes: 16 * 1024 ** 2, maxMetadataBytes: 1024 ** 2, maxRegistrations: 64, maxSearchEdges: 200000, maxNodesPerSearch: 5000, maxEdgesPerSearch: 20000, maxObserverDepth: 8, maxTargetDepth: 4 });
const fail = code => { const error = Error(code); error.code = code; throw error; };
const uint = value => Number.isSafeInteger(value) && value >= 0;
async function readLimited(path, maximum) {
  const chunks = []; let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; if (size > maximum) fail('input-size-budget'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export async function loadSiteCapture(path) {
  const capturePath = await realpath(resolve(path)), base = dirname(capturePath);
  const captureBytes = await readLimited(capturePath, siteEvidenceLimits.maxMetadataBytes), capture = JSON.parse(captureBytes);
  if (!['0.1.0', '0.2.0'].includes(capture.schemaVersion) || capture.status !== 'completed' || capture.adapter !== 'rxjs-7.8.1') fail('unsupported-site-capture');
  const limits = { source: siteEvidenceLimits.maxSourceBytes, registry: siteEvidenceLimits.maxMetadataBytes, bundle: siteEvidenceLimits.maxBundleBytes, observation: siteEvidenceLimits.maxMetadataBytes, identities: siteEvidenceLimits.maxMetadataBytes, snapshot: siteEvidenceLimits.maxSnapshotBytes };
  const bytes = {};
  for (const [key, limit] of Object.entries(limits)) {
    const artifact = capture.artifacts?.[key];
    if (typeof artifact?.path !== 'string' || isAbsolute(artifact.path) || !uint(artifact.bytes) || artifact.bytes > limit) fail('invalid-artifact');
    const actual = await realpath(resolve(base, artifact.path));
    if (!actual.startsWith(base + sep)) fail('artifact-outside-capture');
    bytes[key] = await readLimited(actual, limit);
    if (bytes[key].length !== artifact.bytes || sha256(bytes[key]) !== artifact.sha256) fail('artifact-hash-mismatch');
  }
  return { capture, capturePath, captureSha256: sha256(captureBytes), source: bytes.source.toString('utf8'), bundle: bytes.bundle.toString('utf8'), registry: JSON.parse(bytes.registry), observation: JSON.parse(bytes.observation), identities: JSON.parse(bytes.identities), heap: JSON.parse(bytes.snapshot) };
}

export function analyzeSiteEvidence(input, targetId = null) {
  const { capture, registry, source, bundle, observation, identities, heap } = input;
  if (capture.adapter !== 'rxjs-7.8.1' || capture.dependency?.name !== 'rxjs' || capture.dependency.version !== '7.8.1') fail('unsupported-site-dependency');
  if (typeof capture.epochId !== 'string' || !capture.epochId || typeof capture.anchorToken !== 'string' || !capture.anchorToken) fail('missing-epoch');
  if (capture.runtime?.epochId !== capture.epochId || observation.epochId !== capture.epochId || identities.epochId !== capture.epochId) fail('epoch-mismatch');
  const browser = capture.runtime.kind === 'chromium-main-frame';
  if (!capture.runtime.scriptId || (browser ? !capture.runtime.targetId || !capture.runtime.frameId || !capture.runtime.browserVersion : !uint(capture.runtime.pid) || capture.runtime.pid < 1 || capture.runtime.threadId !== 0)) fail('unsupported-runtime-binding');
  if (capture.loadedScriptSha256 !== sha256(bundle) || capture.artifacts.bundle.sha256 !== sha256(bundle)) fail('loaded-script-mismatch');
  const modules = new Map();
  if (capture.schemaVersion === '0.2.0') {
    if (registry.schemaVersion !== '0.2.0' || capture.artifacts.source.sha256 !== sha256(source)) fail('source-registry-mismatch');
    const pack = JSON.parse(source);
    if (pack.schemaVersion !== '0.2.0' || !Array.isArray(pack.modules) || !pack.modules.length || pack.modules.length > 64) fail('invalid-source-pack');
    for (const module of pack.modules) {
      if (typeof module.filename !== 'string' || !module.filename || typeof module.source !== 'string' || modules.has(module.filename) || sha256(module.source) !== module.sourceSha256) fail('invalid-source-pack');
      modules.set(module.filename, module);
    }
    if (!Array.isArray(registry.modules) || registry.modules.length !== modules.size || new Set(registry.modules.map(module => module.filename)).size !== modules.size || registry.modules.some(module => modules.get(module.filename)?.sourceSha256 !== module.sourceSha256)) fail('source-registry-mismatch');
  } else {
    if (registry.schemaVersion !== '0.1.0' || typeof registry.filename !== 'string' || !registry.filename || registry.sourceSha256 !== sha256(source) || capture.artifacts.source.sha256 !== registry.sourceSha256) fail('source-registry-mismatch');
    modules.set(registry.filename, { filename: registry.filename, source, sourceSha256: registry.sourceSha256 });
  }
  if (identities.snapshotSha256 !== capture.artifacts.snapshot.sha256) fail('identity-snapshot-mismatch');
  if (!capture.bridge?.handlesReleased || capture.bridge.eventsBefore !== capture.bridge.eventsAfter || capture.bridge.eventsAfter !== observation.events?.length) fail('capture-not-quiescent');
  if (observation.adapter !== 'rxjs-7.8.1' || !Array.isArray(registry.sites) || !Array.isArray(registry.skipped) || !Array.isArray(observation.events) || observation.events.length > 512 || !Array.isArray(observation.objects) || observation.objects.length > 256 || !uint(observation.dropped) || !uint(observation.unsupported)) fail('invalid-observation');
  const sites = new Map();
  for (const site of registry.sites) {
    const module = modules.get(site.filename ?? registry.filename);
    if (!module || (capture.schemaVersion === '0.2.0' && site.sourceSha256 !== module.sourceSha256)) fail('site-source-mismatch');
    const original = module.source;
    if (!/^[a-f0-9]{24}$/.test(site.id) || sites.has(site.id) || !['subscribe', 'unsubscribe'].includes(site.operation) || !uint(site.start) || !uint(site.end) || site.end <= site.start || site.end > original.length) fail('invalid-site');
    const prefix = original.slice(0, site.start), lines = prefix.split(/\r\n|[\r\n\u2028\u2029]/);
    if (site.line !== lines.length || site.column !== lines.at(-1).length + 1 || !bundle.includes(site.id)) fail('site-coordinate-mismatch');
    const expected = sha256(JSON.stringify([module.filename, module.sourceSha256, site.start, site.end, site.operation])).slice(0, 24);
    if (site.id !== expected) fail('site-id-mismatch');
    sites.set(site.id, { type: site.operation === 'subscribe' ? 'registration-call' : 'release-call', file: module.filename, line: site.line, column: site.column, sourceSha256: module.sourceSha256, call: original.slice(site.start, site.end), siteId: site.id });
  }
  const objects = new Map();
  for (const object of observation.objects) {
    if (!/^o[1-9][0-9]*$/.test(object.id) || objects.has(object.id) || !Array.isArray(object.roles) || !object.roles.length || new Set(object.roles).size !== object.roles.length || object.roles.some(role => !['source', 'subscription', 'observer', 'type-prototype'].includes(role))) fail('invalid-object-registry');
    objects.set(object.id, object);
  }
  const typeAnchors = observation.typeAnchors;
  if (typeAnchors !== undefined) {
    if (typeAnchors?.schemaVersion !== '0.1.0' || !['available', 'unavailable'].includes(typeAnchors.status) || (typeAnchors.reason !== null && typeof typeAnchors.reason !== 'string')) fail('invalid-type-anchors');
    for (const id of [typeAnchors.subjectPrototypeId, typeAnchors.subscriberPrototypeId]) if (id !== null && !objects.get(id)?.roles.includes('type-prototype')) fail('invalid-type-anchor-role');
    if (typeAnchors.status === 'available' && (!typeAnchors.subjectPrototypeId || !typeAnchors.subscriberPrototypeId || typeAnchors.subjectPrototypeId === typeAnchors.subscriberPrototypeId || typeAnchors.reason !== null)) fail('invalid-type-anchors');
    const kinds = typeAnchors.subjectKindPrototypeIds;
    if (kinds !== undefined) {
      if (!kinds || Array.isArray(kinds) || typeof kinds !== 'object' || Object.keys(kinds).some(kind => !['BehaviorSubject', 'ReplaySubject', 'AsyncSubject'].includes(kind))) fail('invalid-subject-kind-anchors');
      const values = [typeAnchors.subjectPrototypeId, typeAnchors.subscriberPrototypeId, ...Object.values(kinds)];
      if (typeAnchors.status !== 'available' || new Set(values).size !== values.length || Object.values(kinds).some(id => !objects.get(id)?.roles.includes('type-prototype'))) fail('invalid-subject-kind-anchors');
    }
  }
  for (let i = 0; i < observation.events.length; i++) {
    const event = observation.events[i], site = sites.get(event.siteId);
    if (event.sequence !== i + 1 || !site || (site.type === 'registration-call' ? 'subscribe' : 'unsubscribe') !== event.operation || !['supported', 'unsupported'].includes(event.coverage) || !['returned', 'threw'].includes(event.outcome) || !Array.isArray(event.observerIds)) fail('invalid-site-event');
    for (const id of [event.receiverId, event.subscriptionId, ...event.observerIds]) if (id !== null && !objects.has(id)) fail('unregistered-object-id');
    if (event.observerIds.length > 3 || new Set(event.observerIds).size !== event.observerIds.length) fail('invalid-observer-ids');
    for (const [id, role] of [[event.receiverId, event.operation === 'subscribe' ? 'source' : 'subscription'], [event.subscriptionId, 'subscription'], ...event.observerIds.map(id => [id, 'observer'])]) if (id !== null && !objects.get(id).roles.includes(role)) fail('object-role-mismatch');
    for (const flag of ['closedBefore', 'closedAfter']) if (event[flag] !== null && typeof event[flag] !== 'boolean') fail('invalid-closed-state');
    if (event.coverage === 'supported' && event.outcome === 'returned' && (!event.subscriptionId || typeof event.closedAfter !== 'boolean')) fail('missing-subscription-state');
    const lineage = event.sourceLineage;
    if (lineage !== undefined) {
      if (lineage.subjectKind !== undefined && !['Subject', 'BehaviorSubject', 'ReplaySubject', 'AsyncSubject'].includes(lineage.subjectKind)) fail('invalid-lineage-subject-kind');
      if (event.operation !== 'subscribe' || lineage?.schemaVersion !== '0.1.0' || lineage.scope !== 'primary-source-only' || !['observed', 'unconfirmed', 'unsupported'].includes(lineage.status) || !Array.isArray(lineage.sourceIds) || lineage.sourceIds.length > 17 || new Set(lineage.sourceIds).size !== lineage.sourceIds.length || (lineage.reason !== null && typeof lineage.reason !== 'string')) fail('invalid-source-lineage');
      if (lineage.sourceIds.some(id => !objects.get(id)?.roles.includes('source')) || (lineage.sourceIds.length && lineage.sourceIds[0] !== event.receiverId) || (lineage.subjectId !== null && lineage.subjectId !== lineage.sourceIds.at(-1))) fail('invalid-lineage-source-id');
      if (lineage.status === 'observed') {
        const membership = lineage.membership;
        if (event.coverage !== 'supported' || event.outcome !== 'returned' || !lineage.subjectId || lineage.reason !== null || !Array.isArray(membership?.subscriberIds) || !membership.subscriberIds.length || membership.subscriberIds.length > 17 || new Set(membership.subscriberIds).size !== membership.subscriberIds.length || membership.memberId !== membership.subscriberIds[0] || membership.subscriberIds.at(-1) !== event.subscriptionId || membership.subscriberIds.some(id => !objects.get(id)?.roles.includes('subscription'))) fail('invalid-lineage-membership');
      } else if (lineage.membership !== null) fail('invalid-lineage-membership');
    }
  }
  const unsupported = observation.events.filter(event => event.coverage === 'unsupported').length;
  if (unsupported !== observation.unsupported || observation.completeWithinScope !== (unsupported === 0 && observation.dropped === 0)) fail('coverage-mismatch');
  const index = buildIncomingIndex(heap), anchors = projectIdentityHeap(heap).anchors;
  if (anchors.length !== 1 || anchors[0].epoch !== capture.epochId || anchors[0].token !== capture.anchorToken) fail('snapshot-epoch-mismatch');
  if (targetId !== null) { if (!uint(targetId)) fail('invalid-node-id'); index.describeNode(targetId); }
  if (!Array.isArray(identities.objects) || identities.objects.length !== objects.size) fail('incomplete-identity-registry');
  const ids = new Map(), heapIds = new Set();
  if (observation.weakIdentityProtocol !== undefined && observation.weakIdentityProtocol !== 'registered-weakref-v1') fail('unsupported-weak-identity-protocol');
  if (identities.weakIdentityProtocol !== undefined && (identities.weakIdentityProtocol !== 'registered-weakref-v1' || observation.weakIdentityProtocol !== identities.weakIdentityProtocol)) fail('weak-identity-protocol-mismatch');
  for (const entry of identities.objects) {
    if (!objects.has(entry.id) || ids.has(entry.id) || (entry.closed !== null && typeof entry.closed !== 'boolean')) fail('invalid-identity-entry');
    if (entry.heapId !== null) {
      if (!uint(entry.heapId) || entry.heapId === 0 || heapIds.has(entry.heapId)) fail('invalid-heap-identity');
      index.describeNode(entry.heapId); heapIds.add(entry.heapId);
    } else if (entry.closed !== null) fail('invalid-unavailable-state');
    if (identities.weakIdentityProtocol === 'registered-weakref-v1') {
      if (entry.resolution !== (entry.heapId === null ? 'weak-ref-cleared' : 'resolved')) fail('invalid-weak-resolution');
    } else if (entry.resolution !== undefined) fail('unbound-weak-resolution');
    ids.set(entry.id, entry);
  }
  const registrations = observation.events.filter(event => event.operation === 'subscribe');
  const unknown = [];
  if (!observation.completeWithinScope) unknown.push('runtime-observation-incomplete');
  if (registry.skipped.length) unknown.push('static-calls-skipped');
  if (registrations.length > siteEvidenceLimits.maxRegistrations) unknown.push('registration-limit');
  let remainingEdges = siteEvidenceLimits.maxSearchEdges;
  function search(from, to, maxDepth) {
    const result = searchReversePaths(index, to, { rootIds: [from], edgePolicy: 'exclude-weak', maxDepth, maxNodes: siteEvidenceLimits.maxNodesPerSearch, maxEdges: Math.min(remainingEdges, siteEvidenceLimits.maxEdgesPerSearch) });
    remainingEdges -= result.stats.examinedEdges;
    if (result.outcome === 'incomplete') unknown.push('path-search-incomplete');
    return result;
  }
  const records = registrations.slice(0, siteEvidenceLimits.maxRegistrations).map(event => {
    const subscription = ids.get(event.subscriptionId);
    const record = { sequence: event.sequence, registration: sites.get(event.siteId), receiverId: event.receiverId, subscriptionId: event.subscriptionId, heapSubscriptionId: subscription?.heapId ?? null, closedAfterSubscribe: event.closedAfter, closedAtCheckpoint: subscription?.closed ?? null,
      sourceLineage: event.sourceLineage ?? null, subscriptionResolution: subscription?.resolution ?? null,
      releaseCalls: observation.events.filter(e => e.operation === 'unsubscribe' && e.subscriptionId && e.subscriptionId === event.subscriptionId && e.sequence > event.sequence).map(e => ({ position: sites.get(e.siteId), outcome: e.outcome, closedBefore: e.closedBefore, closedAfter: e.closedAfter })),
      status: 'not-observed-in-final-heap', matches: [], searches: [] };
    if (event.coverage !== 'supported') { record.status = 'unsupported-call'; return record; }
    if (!subscription?.heapId) return record;
    if (subscription.closed === null) unknown.push('checkpoint-state-unknown');
    for (const observerId of event.observerIds) {
      const observer = ids.get(observerId); if (!observer?.heapId) continue;
      const toObserver = search(subscription.heapId, observer.heapId, siteEvidenceLimits.maxObserverDepth);
      record.searches.push({ observerId, leg: 'subscription-to-observer', outcome: toObserver.outcome, stopReason: toObserver.stopReason, stats: toObserver.stats });
      if (toObserver.outcome !== 'path-found') continue;
      let toTarget = null;
      if (targetId !== null) {
        toTarget = search(observer.heapId, targetId, siteEvidenceLimits.maxTargetDepth);
        record.searches.push({ observerId, leg: 'observer-to-target', outcome: toTarget.outcome, stopReason: toTarget.stopReason, stats: toTarget.stats });
        if (toTarget.outcome !== 'path-found') continue;
      }
      record.matches.push({ observerId, heapObserverId: observer.heapId, subscriptionToObserver: toObserver.path, observerToTarget: toTarget?.path ?? null });
    }
    record.status = record.matches.length ? subscription.closed === true ? 'closed-with-observed-reference-path' : 'observed-reference-path' : 'no-matching-path-within-scope';
    return record;
  });
  const subjectPrototypeId = typeAnchors?.status === 'available' ? ids.get(typeAnchors.subjectPrototypeId)?.heapId : null;
  const subscriberPrototypeId = typeAnchors?.status === 'available' ? ids.get(typeAnchors.subscriberPrototypeId)?.heapId : null;
  const subjectKindPrototypeIds = Object.fromEntries(Object.entries(typeAnchors?.subjectKindPrototypeIds ?? {}).flatMap(([kind, id]) => ids.get(id)?.heapId ? [[kind, ids.get(id).heapId]] : []));
  const subscriptionIds = [...new Set(records.filter(record => record.status !== 'unsupported-call' && record.heapSubscriptionId).map(record => record.heapSubscriptionId))];
  const sourceMemberships = subjectPrototypeId && subscriberPrototypeId
    ? analyzeSubscriptionSources(heap, { subjectPrototypeId, subscriberPrototypeId, subscriptionIds, ...(Object.keys(subjectKindPrototypeIds).length ? { subjectKindPrototypeIds } : {}) })
    : { status: 'unavailable', records: [], coverage: { unknownReasons: ['type-anchors-unavailable'], scope: 'ordinary-Subject-observers-to-returned-Subscriber-destination' } };
  const sourceRecords = new Map(sourceMemberships.records.map(record => [record.subscriptionId, record]));
  for (const record of records) {
    const cleared = record.status !== 'unsupported-call' && subjectPrototypeId && subscriberPrototypeId && identities.weakIdentityProtocol === 'registered-weakref-v1' && record.subscriptionResolution === 'weak-ref-cleared';
    record.sourceMemberships = sourceRecords.get(record.heapSubscriptionId) ?? { status: cleared ? 'completed' : 'incomplete', membershipCount: 0, subjectCount: 0, memberships: [], unknownReasons: cleared ? [] : ['subscription-or-type-identity-unavailable'] };
  }
  const receiverIds = [...new Set(records.flatMap(record => record.status !== 'unsupported-call' && ids.get(record.receiverId)?.heapId ? [ids.get(record.receiverId).heapId] : []))];
  const holders = subjectPrototypeId
    ? analyzeReceiverSubjects(heap, { receiverIds, subjectPrototypeId, subjectKindPrototypeIds })
    : { status: 'unavailable', records: [], coverage: { unknownReasons: ['receiver-type-anchors-unavailable'] } };
  const holderRecords = new Map(holders.records.map(record => [record.receiverId, record]));
  const storageSource = record => record.status !== 'unsupported-call' && record.sourceLineage?.status === 'observed' ? ids.get(record.sourceLineage.subjectId) : null;
  const storedSubjectIds = [...new Set(records.flatMap(record => {
    const identity = storageSource(record);
    return identity?.heapId && subjectKindPrototypeIds[record.sourceLineage.subjectKind] ? [identity.heapId] : [];
  }))];
  const allStoredSubjectIds = [...new Set([...storedSubjectIds, ...holders.records.flatMap(record => record.subjects.filter(subject => subject.kind !== 'Subject').map(subject => subject.subjectId))])];
  const storage = subjectPrototypeId && Object.keys(subjectKindPrototypeIds).length
    ? analyzeSubjectStorage(heap, { subjectPrototypeId, subjectKindPrototypeIds, subjectIds: allStoredSubjectIds.slice(0, subjectStorageLimits.maxSubjects) })
    : { status: 'unavailable', records: [], coverage: { unknownReasons: ['storage-type-anchors-unavailable'] } };
  storage.coverage.omittedSubjects = Math.max(0, allStoredSubjectIds.length - subjectStorageLimits.maxSubjects);
  if (storage.coverage.omittedSubjects) { storage.status = 'incomplete'; storage.coverage.unknownReasons.push('storage-subject-limit'); }
  const storageRecords = new Map(storage.records.map(record => [record.subjectId, record]));
  for (const record of records) {
    const identity = storageSource(record), subjectKind = record.sourceLineage?.subjectKind;
    const cleared = identity?.resolution === 'weak-ref-cleared' && identities.weakIdentityProtocol === 'registered-weakref-v1' && subjectPrototypeId && subjectKindPrototypeIds[subjectKind];
    record.subjectStorage = { sourceId: record.sourceLineage?.subjectId ?? null, sourceResolution: identity?.resolution ?? null, heapSubjectId: identity?.heapId ?? null,
      ...(storageRecords.get(identity?.heapId) ?? { subjectKind: subjectKind ?? null, status: cleared ? 'completed' : 'incomplete', objectCount: 0, storedObjects: [], unknownReasons: cleared ? [] : ['storage-source-or-type-unavailable'] }) };
    const holder = holderRecords.get(ids.get(record.receiverId)?.heapId);
    record.receiverHolders = holder ? { ...holder, subjects: holder.subjects.map(subject => ({ ...subject, storage: storageRecords.get(subject.subjectId) ?? { status: 'unavailable', unknownReasons: ['holder-storage-outside-scope-or-budget'] } })) }
      : { status: 'unknown', subjects: [], unknownReasons: ['receiver-identity-or-type-unavailable'], zeroMeaning: 'No positive holder witness; receiver absence does not certify upstream cleanup.' };
  }
  // Membership coverage is a separate scope. A supported primary/path analysis
  // must not become incomplete merely because an extra source is unsupported.
  const unknownReasons = [...new Set(unknown)];
  return { schemaVersion: '0.1.0', status: unknownReasons.length ? 'incomplete' : 'completed', capability: 'source-site-subscription-evidence', adapter: capture.adapter,
    input: { capturePath: input.capturePath, captureSha256: input.captureSha256, epochId: capture.epochId, checkpoint: capture.checkpoint, artifacts: capture.artifacts, runtime: capture.runtime, dependency: capture.dependency, weakIdentityProtocol: identities.weakIdentityProtocol ?? null },
    target: targetId === null ? 'recorded-observers' : index.describeNode(targetId), records, sourceMemberships: { status: sourceMemberships.status, coverage: sourceMemberships.coverage }, subjectStorage: { status: storage.status, coverage: storage.coverage }, receiverHolders: { status: holders.status, coverage: holders.coverage },
    coverage: { completeWithinDeclaredScope: unknownReasons.length === 0, unknownReasons, registeredSites: sites.size, skippedCalls: registry.skipped, runtimeEvents: observation.events.length, droppedEvents: observation.dropped, unsupportedEvents: unsupported, registrations: registrations.length, inspectedRegistrations: records.length, examinedEdges: siteEvidenceLimits.maxSearchEdges - remainingEdges, limits: siteEvidenceLimits },
    summary: { matchedRegistrations: records.filter(r => r.matches.length).length, closedWithPaths: records.filter(r => r.status === 'closed-with-observed-reference-path').length },
    interpretation: 'Registration/release call locations plus bounded literal paths from observed subscriptions. Runtime sourceLineage remains primary-only. sourceMemberships matches bound Subject kinds through Subscriber.destination to recorded returned subscriptions. subjectStorage separately reads known primary Subject value/buffer object references. receiverHolders adds positive receiver-local closure/context paths to bound Subjects and their known storage; these hints never certify share semantics or cleanup. Shared callback bridges and arbitrary Observable producers are not fully enumerated. Missing paths/legacy identities do not prove collection; explicit cleared WeakRefs concern only that referent. closed does not prove release. No automatic global leak or repair verdict.' };
}
