import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/incoming-oracle.mjs';
import { sha256 } from '../src/heap-identity.mjs';
import { analyzeResourceHeap } from '../src/resource-heap-evidence.mjs';
import { selectResourceHeapObjects } from '../src/resource-heap-capture.mjs';
import { loadResourceHeapCapture } from '../src/resource-heap-evidence.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

function input(extraIncoming = 0) {
  const original = 'target.addEventListener("x", callback);\ntarget.removeEventListener("x", callback);', filename = 'fixture.ts', sourceSha256 = sha256(original);
  const sites = ['addEventListener', 'removeEventListener'].map(operation => { const start = original.lastIndexOf('target.', original.indexOf(operation)), end = original.indexOf(';', start), prefix = original.slice(0, start).split('\n'); return { id: sha256(JSON.stringify([filename, sourceSha256, start, end, operation])).slice(0, 24), filename, sourceSha256, start, end, line: prefix.length, column: prefix.at(-1).length + 1, operation }; });
  const source = JSON.stringify({ schemaVersion: '0.1.0', modules: [{ filename, source: original, sourceSha256 }] }), bundle = sites.map(site => JSON.stringify(site.id)).join(';');
  const registry = { schemaVersion: '0.1.0', adapter: 'browser-resources', modules: [{ filename, sourceSha256 }], sites, skipped: [] };
  const nodes = [{ id: 1, name: 'root', type: 'synthetic' }, { id: 3, name: 'Window' }, { id: 9, name: 'BusinessTarget' }, { id: 11, name: 'IndependentArray', type: 'array' }, { id: 15, name: 'anchor' }, { id: 17, name: 'epoch' }, { id: 19, name: 'token' }];
  const edges = [{ from: 1, to: 3, name: 'window', type: 'property' }, { from: 1, to: 11, name: 'owner', type: 'property' }, { from: 11, to: 9, name: 0, type: 'element' }, { from: 1, to: 15, name: 'anchor', type: 'property' }, { from: 15, to: 17, name: '__memoryLabEpoch', type: 'property' }, { from: 15, to: 19, name: '__memoryLabAnchor', type: 'property' }];
  for (let i = 0; i < extraIncoming; i++) { nodes.push({ id: 21 + i * 2, name: 'holder-' + i }); edges.push({ from: 21 + i * 2, to: 9, name: 'item', type: 'property' }); }
  const heap = fixture(nodes, edges), fields = heap.snapshot.meta.node_fields, width = fields.length, stringType = heap.snapshot.meta.node_types[fields.indexOf('type')].push('string') - 1;
  for (let offset = 0; offset < heap.nodes.length; offset += width) if ([17, 19].includes(heap.nodes[offset + fields.indexOf('id')])) heap.nodes[offset + fields.indexOf('type')] = stringType;
  const observation = { adapter: 'browser-resources', epochId: 'epoch', resources: [{ id: 'r1', kind: 'listener', type: 'x', state: 'released', stateCertain: true, registrationSiteId: sites[0].id, releaseSiteId: sites[1].id, endedBy: 'removeEventListener', callbackId: 'o1', targetId: 'o2', wrapperId: 'o3', signalId: null }], objects: [{ id: 'o1', roles: ['callback'] }, { id: 'o2', roles: ['target'] }, { id: 'o3', roles: ['wrapper'] }, { id: 'o4', roles: ['declared-target'] }, { id: 'o5', roles: ['declared-holder'] }], declarations: [{ label: 'business', role: 'target', objectId: 'o4' }, { label: 'other-owner', role: 'holder', objectId: 'o5' }], events: [{}, {}], coverage: { completeWithinScope: true, unsupported: 0, dropped: 0 } };
  const request = { resourceFilter: { kind: 'listener', eventType: 'x' }, targetLabels: ['business'], holderLabels: ['other-owner'] }, snapshotSha256 = sha256(JSON.stringify(heap));
  const identities = { epochId: 'epoch', snapshotSha256, objects: [{ id: 'o1', resolution: 'cleared', heapId: null }, { id: 'o2', resolution: 'resolved', heapId: 3 }, { id: 'o3', resolution: 'cleared', heapId: null }, { id: 'o4', resolution: 'resolved', heapId: 9 }, { id: 'o5', resolution: 'resolved', heapId: 11 }] };
  const capture = { epochId: 'epoch', anchorToken: 'token', runtime: { epochId: 'epoch', scriptId: '2', targetId: 'target', frameId: 'frame', browserVersion: 'test' }, loadedScriptSha256: sha256(bundle), bridge: { handlesReleased: true, eventsBefore: 2, eventsAfter: 2 }, request, selected: selectResourceHeapObjects(observation, request), artifacts: { bundle: { sha256: sha256(bundle) }, source: { sha256: sha256(source) }, registry: { sha256: sha256(JSON.stringify(registry, null, 2) + '\n') }, snapshot: { sha256: snapshotSha256 } } };
  return { capture, heap, source, bundle, registry, observation, identities };
}

test('released registration and independently held live target remain separate facts with original positions', () => {
  const report = analyzeResourceHeap(input()); assert.equal(report.status, 'completed');
  assert.equal(report.resources[0].registrationState, 'released'); assert.equal(report.resources[0].callback.resolution, 'weak-cleared');
  assert.equal(report.resources[0].registration.line, 1); assert.equal(report.resources[0].release.line, 2);
  assert.equal(report.targets[0].resolution, 'present-in-final-heap');
  assert.equal(report.targets[0].pathsFromDeclaredHolders[0].result.path.edgeCount, 1);
  assert.equal(report.summary.declaredHolderPathsFound, 1); assert.equal(Object.hasOwn(report, 'leak'), false);
});

test('weak-cleared, unresolved and bridge identities missing from final heap are distinguished', () => {
  const cleared = input(); cleared.identities.objects[3] = { id: 'o4', resolution: 'cleared', heapId: null };
  assert.equal(analyzeResourceHeap(cleared).targets[0].resolution, 'weak-cleared');
  const unresolved = input(); unresolved.identities.objects[3] = { id: 'o4', resolution: 'unresolved', heapId: null };
  assert.equal(analyzeResourceHeap(unresolved).status, 'incomplete');
  const missing = input(); missing.identities.objects[3].heapId = 10001;
  const report = analyzeResourceHeap(missing); assert.equal(report.targets[0].resolution, 'not-present-in-final-heap'); assert.equal(report.status, 'incomplete');
});

test('incoming edge sampling reports the full count and truncation without calling it all holders', () => {
  const report = analyzeResourceHeap(input(80)), target = report.targets[0];
  assert.equal(target.directIncoming.totalCount, 81); assert.equal(target.directIncoming.sampledCount, 64); assert.equal(target.directIncoming.complete, false);
  assert.equal(report.status, 'incomplete'); assert.ok(report.coverage.unknownReasons.includes('direct-incoming-sample-truncated'));
});

test('epoch, source, script, unreleased Inspector handles, selected identities and snapshot mismatch fail closed', () => {
  const cases = [
    [data => data.capture.runtime.epochId = 'other', 'resource-epoch-mismatch'],
    [data => data.capture.bridge.handlesReleased = false, 'resource-handles-or-quiescence'],
    [data => data.capture.bridge.eventsAfter++, 'resource-handles-or-quiescence'],
    [data => data.capture.loadedScriptSha256 = 'bad', 'resource-script-mismatch'],
    [data => data.source += ' ', 'resource-source-registry-mismatch'],
    [data => data.identities.snapshotSha256 = 'bad', 'resource-identity-snapshot-mismatch'],
    [data => data.identities.objects[4].heapId = 9, 'duplicate-resource-heap-id'],
    [data => data.capture.selected.resourceIds = [], 'resource-selection-mismatch'],
    [data => data.observation.objects[0].roles = ['target'], 'resource-role-or-declaration-mismatch'],
  ];
  for (const [mutate, code] of cases) { const data = input(); mutate(data); assert.throws(() => analyzeResourceHeap(data), error => error.code === code, code); }
});

test('selection includes released registrations and refuses undeclared or duplicate labels', () => {
  const data = input(); assert.deepEqual(selectResourceHeapObjects(data.observation, data.capture.request).resourceIds, ['r1']);
  assert.throws(() => selectResourceHeapObjects(data.observation, { targetLabels: ['missing'] }), /not-declared/);
  assert.throws(() => selectResourceHeapObjects(data.observation, { targetLabels: ['business', 'business'] }), /invalid-resource-object-labels/);
});

test('uncertain selected registration remains incomplete even when weak identities are resolved or cleared', () => {
  const data = input(); data.observation.resources[0].state = 'target-unavailable'; data.observation.resources[0].stateCertain = false;
  const report = analyzeResourceHeap(data); assert.equal(report.status, 'incomplete');
  assert.ok(report.coverage.unknownReasons.includes('selected-resource-state-uncertain'));
});

test('standalone loader verifies captured bytes and confines artifacts to their capture directory', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'resource-heap-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  const data = input(); Object.assign(data.capture, { schemaVersion: '0.1.0', adapter: 'browser-resources-heap', status: 'captured' });
  for (const key of ['source', 'bundle', 'registry', 'snapshot', 'observation', 'identities']) {
    const value = key === 'snapshot' ? data.heap : data[key], text = typeof value === 'string' ? value : key === 'registry' ? JSON.stringify(value, null, 2) + '\n' : JSON.stringify(value);
    data.capture.artifacts[key] = { path: key + '.data', bytes: Buffer.byteLength(text), sha256: sha256(text) };
    await writeFile(resolve(directory, key + '.data'), text);
  }
  const path = resolve(directory, 'capture.json'); await writeFile(path, JSON.stringify(data.capture));
  assert.equal(analyzeResourceHeap(await loadResourceHeapCapture(path)).status, 'completed');
  await writeFile(resolve(directory, 'source.data'), data.source + ' ');
  await assert.rejects(loadResourceHeapCapture(path), error => error.code === 'resource-artifact-mismatch');
  data.capture.artifacts.source.path = '../'; await writeFile(path, JSON.stringify(data.capture));
  await assert.rejects(loadResourceHeapCapture(path), error => error.code === 'resource-artifact-outside-capture');
});
