import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fixture } from './helpers/incoming-oracle.mjs';
import { sha256 } from '../src/heap-identity.mjs';
import { analyzeSiteEvidence, loadSiteCapture } from '../src/site-evidence.mjs';
import { measureSubjectObservers, measureSubscriptionSubjects } from '../src/regression.mjs';

function input(separator = '\n', extraNodes = [], extraEdges = []) {
  const source = 'source.subscribe(callback);' + separator + 'sub.unsubscribe();', filename = 'fixture.mjs', sourceSha256 = sha256(source);
  const sites = [{ start: 0, end: 26, line: 1, column: 1, operation: 'subscribe' }, { start: 28, end: 45, line: 2, column: 1, operation: 'unsubscribe' }];
  for (const site of sites) site.id = sha256(JSON.stringify([filename, sourceSha256, site.start, site.end, site.operation])).slice(0, 24);
  const bundle = sites.map(s => JSON.stringify(s.id)).join(';');
  const heap = fixture([{ id: 1, name: 'root', type: 'synthetic' }, { id: 3, name: 'Subject' }, { id: 5, name: 'Subscriber' }, { id: 7, name: 'callback', type: 'closure' }, { id: 9, name: 'Resource' }, { id: 11, name: 'anchor' }, { id: 13, name: 'epoch', type: 'string' }, { id: 15, name: 'token', type: 'string' }, ...extraNodes], [
    { from: 1, to: 3, name: 'source', type: 'property' }, { from: 1, to: 5, name: 'sub', type: 'property' },
    { from: 5, to: 7, name: 'observer', type: 'property' }, { from: 7, to: 9, name: 'resource', type: 'context' },
    { from: 1, to: 11, name: 'anchor', type: 'property' }, { from: 11, to: 13, name: '__memoryLabEpoch', type: 'property' }, { from: 11, to: 15, name: '__memoryLabAnchor', type: 'property' },
    ...extraEdges,
  ]);
  // The shared oracle only encodes synthetic/object/closure types; this case also needs epoch strings.
  const width = heap.snapshot.meta.node_fields.length, stringType = heap.snapshot.meta.node_types[0].push('string') - 1;
  for (let offset = 0; offset < heap.nodes.length; offset += width) if ([13, 15].includes(heap.nodes[offset + 2])) heap.nodes[offset] = stringType;
  const snapshotSha256 = sha256(JSON.stringify(heap));
  return {
    source, bundle, heap, registry: { schemaVersion: '0.1.0', filename, sourceSha256, sites, skipped: [] },
    capture: { schemaVersion: '0.1.0', status: 'completed', adapter: 'rxjs-7.8.1', dependency: { name: 'rxjs', version: '7.8.1' }, epochId: 'epoch', anchorToken: 'token', runtime: { epochId: 'epoch', scriptId: '7', pid: 123, threadId: 0 }, loadedScriptSha256: sha256(bundle), bridge: { handlesReleased: true, eventsBefore: 1, eventsAfter: 1 }, artifacts: { source: { sha256: sourceSha256 }, bundle: { sha256: sha256(bundle) }, snapshot: { sha256: snapshotSha256 } } },
    observation: { adapter: 'rxjs-7.8.1', epochId: 'epoch', events: [{ sequence: 1, siteId: sites[0].id, operation: 'subscribe', coverage: 'supported', outcome: 'returned', receiverId: 'o1', observerIds: ['o2'], subscriptionId: 'o3', closedBefore: null, closedAfter: false }], objects: [{ id: 'o1', roles: ['source'] }, { id: 'o2', roles: ['observer'] }, { id: 'o3', roles: ['subscription'] }], dropped: 0, unsupported: 0, completeWithinScope: true },
    identities: { epochId: 'epoch', snapshotSha256, objects: [{ id: 'o1', heapId: 3, closed: null }, { id: 'o2', heapId: 7, closed: null }, { id: 'o3', heapId: 5, closed: false }] },
  };
}

test('site evidence joins original registration, subscription and target using literal paths', () => {
  const data = input(), result = analyzeSiteEvidence(data, 9);
  assert.equal(result.status, 'completed'); assert.equal(result.summary.matchedRegistrations, 1);
  assert.equal(result.records[0].registration.line, 1);
  assert.equal(result.records[0].matches[0].observerToTarget.targetId, 9);
  assert.equal(Object.hasOwn(result, 'leak'), false);
});

test('Unicode JavaScript line separators preserve original coordinates', () => {
  for (const separator of ['\u2028', '\u2029']) assert.equal(analyzeSiteEvidence(input(separator)).status, 'completed');
});

test('wrong dependency versions and duplicate or wrongly typed observer identities are refused', () => {
  const version = input(); version.capture.dependency.version = '8.0.0';
  assert.throws(() => analyzeSiteEvidence(version), e => e.code === 'unsupported-site-dependency');
  const duplicate = input(); duplicate.observation.events[0].observerIds.push('o2');
  assert.throws(() => analyzeSiteEvidence(duplicate), e => e.code === 'invalid-observer-ids');
  const role = input(); role.observation.objects[2].roles = ['source'];
  assert.throws(() => analyzeSiteEvidence(role), e => e.code === 'object-role-mismatch');
});

test('closed plus a throwing release is reported with surviving path, never called released', () => {
  const data = input(); data.identities.objects[2].closed = true;
  data.observation.events.push({ sequence: 2, siteId: data.registry.sites[1].id, operation: 'unsubscribe', coverage: 'supported', outcome: 'threw', receiverId: 'o3', subscriptionId: 'o3', observerIds: [], closedBefore: false, closedAfter: true });
  data.capture.bridge.eventsBefore = data.capture.bridge.eventsAfter = 2;
  const result = analyzeSiteEvidence(data);
  assert.equal(result.records[0].status, 'closed-with-observed-reference-path');
  assert.equal(result.records[0].releaseCalls[0].outcome, 'threw');
  assert.equal(result.records[0].releaseCalls[0].position.line, 2);
});

test('epoch, loaded script, original positions, source bytes, identities and checkpoint races are rejected', () => {
  const mutations = [
    [d => d.observation.epochId = 'other', 'epoch-mismatch'],
    [d => d.identities.epochId = 'other', 'epoch-mismatch'],
    [d => d.capture.loadedScriptSha256 = '0', 'loaded-script-mismatch'],
    [d => d.source += ' ', 'source-registry-mismatch'],
    [d => d.registry.sites[0].line++, 'site-coordinate-mismatch'],
    [d => d.identities.snapshotSha256 = 'other', 'identity-snapshot-mismatch'],
    [d => d.identities.objects.pop(), 'incomplete-identity-registry'],
    [d => d.capture.bridge.eventsAfter++, 'capture-not-quiescent'],
    [d => d.heap.strings[d.heap.strings.indexOf('epoch')] = 'wrong-epoch', 'snapshot-epoch-mismatch'],
  ];
  for (const [mutate, code] of mutations) { const data = input(); mutate(data); assert.throws(() => analyzeSiteEvidence(data), e => e.code === code, code); }
});

test('runtime drops and static skipped calls remain visibly incomplete with usable partial evidence', () => {
  const data = input(); data.observation.dropped = 1; data.observation.completeWithinScope = false;
  data.registry.skipped.push({ reason: 'optional-call' });
  const result = analyzeSiteEvidence(data);
  assert.equal(result.status, 'incomplete'); assert.equal(result.summary.matchedRegistrations, 1);
  assert.ok(result.coverage.unknownReasons.includes('runtime-observation-incomplete'));
  assert.ok(result.coverage.unknownReasons.includes('static-calls-skipped'));
});

test('unavailable weak identities are unknown and cannot manufacture a release or GC verdict', () => {
  const data = input(); data.identities.objects[2] = { id: 'o3', heapId: null, closed: null };
  const result = analyzeSiteEvidence(data);
  assert.equal(result.records[0].status, 'not-observed-in-final-heap'); assert.equal(result.records[0].matches.length, 0);
  assert.equal(result.records[0].closedAtCheckpoint, null);
});

test('lineage validates actual registered IDs and membership endpoints while preserving old captures', () => {
  const data = input(), event = data.observation.events[0];
  event.sourceLineage = { schemaVersion: '0.1.0', scope: 'primary-source-only', status: 'observed', sourceIds: ['o1'], subjectId: 'o1', reason: null, membership: { memberId: 'o3', subscriberIds: ['o3'] } };
  assert.equal(analyzeSiteEvidence(data).records[0].sourceLineage.status, 'observed');
  const badSource = structuredClone(data); badSource.observation.events[0].sourceLineage.sourceIds[0] = 'o999';
  assert.throws(() => analyzeSiteEvidence(badSource), error => error.code === 'invalid-lineage-source-id');
  const badMember = structuredClone(data); badMember.observation.events[0].sourceLineage.membership.subscriberIds = ['o2'];
  assert.throws(() => analyzeSiteEvidence(badMember), error => error.code === 'invalid-lineage-membership');
  assert.equal(analyzeSiteEvidence(input()).records[0].sourceLineage, null);
});

test('prototype anchors must reference distinct registered type identities; legacy captures stay explicitly unavailable', () => {
  const data = input();
  data.observation.typeAnchors = { schemaVersion: '0.1.0', status: 'available', subjectPrototypeId: 'o1', subscriberPrototypeId: 'o3', reason: null };
  assert.throws(() => analyzeSiteEvidence(data), error => error.code === 'invalid-type-anchor-role');
  data.observation.objects[0].roles.push('type-prototype'); data.observation.objects[2].roles.push('type-prototype');
  data.observation.typeAnchors.subscriberPrototypeId = 'o1';
  assert.throws(() => analyzeSiteEvidence(data), error => error.code === 'invalid-type-anchors');
  const legacy = analyzeSiteEvidence(input());
  assert.equal(legacy.status, 'completed');
  assert.equal(legacy.sourceMemberships.status, 'unavailable');
  assert.equal(legacy.records[0].sourceMemberships.status, 'incomplete');
  assert.equal(legacy.subjectStorage.status, 'unavailable');
  assert.equal(legacy.records[0].subjectStorage.status, 'incomplete');
});

test('subject kind anchors reject undeclared, repeated and wrongly-role-bound type identities', () => {
  for (const kinds of [{ CustomSubject: 'o2' }, { BehaviorSubject: 'o1' }, { BehaviorSubject: 'o2' }, { BehaviorSubject: 'missing' }]) {
    const data = input();
    data.observation.objects[0].roles.push('type-prototype'); data.observation.objects[2].roles.push('type-prototype');
    data.observation.typeAnchors = { schemaVersion: '0.1.0', status: 'available', subjectPrototypeId: 'o1', subscriberPrototypeId: 'o3', reason: null, subjectKindPrototypeIds: kinds };
    assert.throws(() => analyzeSiteEvidence(data), error => error.code === 'invalid-subject-kind-anchors');
  }
});

test('an unsupported secondary preserves primary measurements while the multi-source metric stays unknown', () => {
  const edge = (from, to, name, type = 'property') => ({ from, to, name, type });
  const data = input('\n', [17, 19, 21, 23, 25, 27, 29, 31].map(id => ({ id, name: [25, 27].includes(id) ? 'Array' : 'Object' })), [
    edge(3, 17, '__proto__'), edge(5, 19, '__proto__'), edge(23, 21, '__proto__'), edge(21, 17, '__proto__'), edge(29, 19, '__proto__'),
    edge(3, 25, 'observers'), edge(23, 27, 'observers'), edge(25, 5, 0, 'element'), edge(27, 29, 0, 'element'), edge(29, 5, 'destination'),
    ...[3, 23].flatMap(id => ['closed', 'isStopped', 'currentObservers'].map(name => edge(id, 31, name))),
  ]);
  data.observation.typeAnchors = { schemaVersion: '0.1.0', status: 'available', subjectPrototypeId: 'o4', subscriberPrototypeId: 'o5', reason: null };
  data.observation.objects.push({ id: 'o4', roles: ['type-prototype'] }, { id: 'o5', roles: ['type-prototype'] });
  data.identities.objects.push({ id: 'o4', heapId: 17, closed: null }, { id: 'o5', heapId: 19, closed: null });
  data.observation.events[0].sourceLineage = { schemaVersion: '0.1.0', scope: 'primary-source-only', status: 'observed', sourceIds: ['o1'], subjectId: 'o1', reason: null, membership: { memberId: 'o3', subscriberIds: ['o3'] } };
  const analysis = analyzeSiteEvidence(data), bindings = { selected: [data.registry.sites[0].id] };
  assert.equal(analysis.sourceMemberships.status, 'incomplete');
  assert.ok(analysis.sourceMemberships.coverage.unknownReasons.includes('subject-subclass-outside-scope'));
  assert.equal(analysis.records[0].sourceMemberships.membershipCount, 1);
  assert.equal(analysis.status, 'completed');
  assert.equal(analysis.summary.matchedRegistrations, 1);
  const primary = measureSubjectObservers(data, analysis, bindings).selected;
  assert.equal(primary.status, 'measured'); assert.equal(primary.value, 1);
  const expanded = measureSubscriptionSubjects(analysis, bindings).selected;
  assert.equal(expanded.status, 'unknown'); assert.equal(expanded.value, null);
});

test('explicit weak resolution rejects forged, inconsistent and unbound cleared states', () => {
  const data = input(); data.observation.weakIdentityProtocol = data.identities.weakIdentityProtocol = 'registered-weakref-v1';
  for (const identity of data.identities.objects) identity.resolution = 'resolved';
  assert.equal(analyzeSiteEvidence(data).input.weakIdentityProtocol, 'registered-weakref-v1');
  const wrong = structuredClone(data); wrong.identities.objects[0].resolution = 'weak-ref-cleared';
  assert.throws(() => analyzeSiteEvidence(wrong), error => error.code === 'invalid-weak-resolution');
  const missing = structuredClone(data); delete missing.identities.objects[0].resolution;
  assert.throws(() => analyzeSiteEvidence(missing), error => error.code === 'invalid-weak-resolution');
  const unbound = structuredClone(data); delete unbound.identities.weakIdentityProtocol;
  assert.throws(() => analyzeSiteEvidence(unbound), error => error.code === 'unbound-weak-resolution');
  const cleared = structuredClone(data); cleared.identities.objects[0].heapId = null; cleared.identities.objects[0].resolution = 'weak-ref-cleared';
  assert.equal(analyzeSiteEvidence(cleared).status, 'completed');
});

test('capture loader binds file bytes and confines artifact reads to its capture directory', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'memory-lab-sites-'));
  t.after(async () => { assert.ok(directory.startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  const data = input();
  for (const key of ['source', 'bundle', 'registry', 'observation', 'identities', 'snapshot']) {
    const value = key === 'snapshot' ? data.heap : data[key], bytes = typeof value === 'string' ? value : JSON.stringify(value);
    data.capture.artifacts[key] = { path: key + '.data', bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
    await writeFile(resolve(directory, key + '.data'), bytes);
  }
  const capturePath = resolve(directory, 'capture.json'); await writeFile(capturePath, JSON.stringify(data.capture));
  assert.equal(analyzeSiteEvidence(await loadSiteCapture(capturePath)).status, 'completed');
  await writeFile(resolve(directory, 'source.data'), data.source + ' ');
  await assert.rejects(loadSiteCapture(capturePath), e => e.code === 'artifact-hash-mismatch');
  data.capture.artifacts.source.path = '../'; await writeFile(capturePath, JSON.stringify(data.capture));
  await assert.rejects(loadSiteCapture(capturePath), e => e.code === 'artifact-outside-capture');
});
