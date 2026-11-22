import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture } from './helpers/incoming-oracle.mjs';
import { analyzeSiteEvidence } from '../src/site-evidence.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

// Two modules deliberately have identical source bytes and offsets. Their names,
// call IDs, subscriptions and callbacks must still remain distinct.
function browserInput() {
  const original = 'stream.subscribe(onNext);', sourceSha256 = hash(original);
  const modules = ['first/panel.ts', 'second/panel.ts'].map(filename => ({ filename, source: original, sourceSha256 }));
  const sites = modules.map(module => {
    const start = 0, end = original.indexOf(';'), operation = 'subscribe';
    return { id: hash(JSON.stringify([module.filename, sourceSha256, start, end, operation])).slice(0, 24), filename: module.filename, sourceSha256, start, end, operation, line: 1, column: 1 };
  });
  // This is a validation fixture, not proof of actual browser execution.
  const bundle = sites.map(site => JSON.stringify(site.id)).join(';');
  const source = JSON.stringify({ schemaVersion: '0.2.0', modules });
  const heap = fixture([
    { id: 1, name: 'root', type: 'synthetic' },
    { id: 3, name: 'SubjectA' }, { id: 5, name: 'SubscriberA' }, { id: 7, name: 'callbackA', type: 'closure' },
    { id: 9, name: 'SubjectB' }, { id: 11, name: 'SubscriberB' }, { id: 13, name: 'callbackB', type: 'closure' },
    { id: 15, name: 'anchor' }, { id: 17, name: 'epoch' }, { id: 19, name: 'token' },
  ], [
    ...[3, 5, 9, 11, 15].map(to => ({ from: 1, to, name: 'root-' + to, type: 'property' })),
    { from: 5, to: 7, name: 'observer', type: 'property' }, { from: 11, to: 13, name: 'observer', type: 'property' },
    { from: 15, to: 17, name: '__memoryLabEpoch', type: 'property' }, { from: 15, to: 19, name: '__memoryLabAnchor', type: 'property' },
  ]);
  const fields = heap.snapshot.meta.node_fields, width = fields.length, typeField = fields.indexOf('type'), idField = fields.indexOf('id');
  const stringType = heap.snapshot.meta.node_types[typeField].push('string') - 1;
  for (let offset = 0; offset < heap.nodes.length; offset += width) if ([17, 19].includes(heap.nodes[offset + idField])) heap.nodes[offset + typeField] = stringType;
  const snapshotSha256 = hash(JSON.stringify(heap));
  const objects = [], identities = [], events = [];
  for (let i = 0; i < 2; i++) {
    const receiverId = 'o' + (3 * i + 1), subscriptionId = 'o' + (3 * i + 2), observerId = 'o' + (3 * i + 3);
    objects.push({ id: receiverId, roles: ['source'] }, { id: subscriptionId, roles: ['subscription'] }, { id: observerId, roles: ['observer'] });
    identities.push({ id: receiverId, heapId: 3 + 6 * i, closed: null }, { id: subscriptionId, heapId: 5 + 6 * i, closed: false }, { id: observerId, heapId: 7 + 6 * i, closed: null });
    events.push({ sequence: i + 1, siteId: sites[i].id, operation: 'subscribe', coverage: 'supported', outcome: 'returned', receiverId, subscriptionId, observerIds: [observerId], closedBefore: null, closedAfter: false });
  }
  return {
    source, bundle, heap,
    registry: { schemaVersion: '0.2.0', modules: modules.map(({ filename, sourceSha256 }) => ({ filename, sourceSha256 })), sites, skipped: [] },
    capture: { schemaVersion: '0.2.0', status: 'completed', adapter: 'rxjs-7.8.1', dependency: { name: 'rxjs', version: '7.8.1' }, epochId: 'epoch', anchorToken: 'token',
      runtime: { kind: 'chromium-main-frame', epochId: 'epoch', scriptId: '8', targetId: 'target', frameId: 'frame', browserVersion: 'fixture-browser' },
      loadedScriptSha256: hash(bundle), bridge: { handlesReleased: true, eventsBefore: 2, eventsAfter: 2 }, artifacts: { source: { sha256: hash(source) }, bundle: { sha256: hash(bundle) }, snapshot: { sha256: snapshotSha256 } } },
    observation: { adapter: 'rxjs-7.8.1', epochId: 'epoch', events, objects, dropped: 0, unsupported: 0, completeWithinScope: true },
    identities: { epochId: 'epoch', snapshotSha256, objects: identities },
  };
}

test('0.2 browser source sites distinguish identical source and offsets across modules', () => {
  const data = browserInput(), result = analyzeSiteEvidence(data);
  assert.notEqual(data.registry.sites[0].id, data.registry.sites[1].id);
  assert.equal(result.status, 'completed'); assert.equal(result.summary.matchedRegistrations, 2);
  assert.deepEqual(result.records.map(record => ({ file: record.registration.file, line: record.registration.line, column: record.registration.column, call: record.registration.call, subscription: record.heapSubscriptionId, observer: record.matches[0].heapObserverId })), [
    { file: 'first/panel.ts', line: 1, column: 1, call: 'stream.subscribe(onNext)', subscription: 5, observer: 7 },
    { file: 'second/panel.ts', line: 1, column: 1, call: 'stream.subscribe(onNext)', subscription: 11, observer: 13 },
  ]);
});

test('0.2 source pack rejects incorrect version or module hash even with a valid outer artifact hash', () => {
  for (const [label, mutate] of [
    ['incorrect module hash', pack => { pack.modules[1].sourceSha256 = '0'.repeat(64); }],
    ['incorrect pack version', pack => { pack.schemaVersion = '0.1.0'; }],
  ]) {
    const data = browserInput(), pack = JSON.parse(data.source);
    mutate(pack); data.source = JSON.stringify(pack); data.capture.artifacts.source.sha256 = hash(data.source);
    assert.throws(() => analyzeSiteEvidence(data), error => error.code === 'invalid-source-pack', label);
  }
});

test('0.2 call site rejects a hash for a different module version', () => {
  const data = browserInput(); data.registry.sites[1].sourceSha256 = '0'.repeat(64);
  assert.throws(() => analyzeSiteEvidence(data), error => error.code === 'site-source-mismatch');
});

test('0.2 registry module list must agree with its source pack', () => {
  for (const [label, mutate] of [
    ['incorrect module hash', registry => { registry.modules[1].sourceSha256 = '0'.repeat(64); }],
    ['duplicate module', registry => { registry.modules[1] = { ...registry.modules[0] }; }],
    ['missing module', registry => { registry.modules.pop(); }],
    ['missing module list', registry => { delete registry.modules; }],
    ['extra module', registry => { registry.modules.push({ filename: 'extra/panel.ts', sourceSha256: registry.modules[0].sourceSha256 }); }],
  ]) {
    const data = browserInput(); mutate(data.registry);
    assert.throws(() => analyzeSiteEvidence(data), label + ' must be rejected');
  }
});

test('browser capture requires both targetId and frameId', () => {
  for (const field of ['targetId', 'frameId']) {
    const data = browserInput(); delete data.capture.runtime[field];
    assert.throws(() => analyzeSiteEvidence(data), error => error.code === 'unsupported-runtime-binding', field);
  }
});
