import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/incoming-oracle.mjs';
import { analyzeSubjectStorage } from '../src/subject-storage.mjs';
import { measureSubjectStorage } from '../src/regression.mjs';

const edge = (from, to, name, type = 'property') => ({ from, to, name, type });
function graph() {
  const nodes = [1, 3, 5, 7, 11, 13, 15, 17, 21, 23, 25, 31].map(id => ({ id, name: id === 17 ? 'Array' : 'Object' }));
  nodes.push({ id: 33, name: 'primitive', type: 'array' });
  const edges = [edge(3, 1, '__proto__'), edge(5, 1, '__proto__'), edge(7, 1, '__proto__'), edge(11, 3, '__proto__'), edge(13, 5, '__proto__'), edge(15, 7, '__proto__'), edge(11, 21, '_value'), edge(13, 17, '_buffer'), edge(15, 25, '_value'),
    edge(17, 23, 0, 'element'), edge(17, 33, 1, 'element'), edge(17, 23, 2, 'element'), edge(17, 33, 3, 'element')];
  for (const id of [11, 13, 15]) for (const name of ['observers', 'closed', 'isStopped', 'currentObservers']) edges.push(edge(id, 31, name));
  return { nodes, edges, encode() { const heap = fixture(nodes, edges, true); heap.snapshot.meta.node_types[4][2] = 'number'; return heap; }, options: { subjectPrototypeId: 1, subjectKindPrototypeIds: { BehaviorSubject: 3, ReplaySubject: 5, AsyncSubject: 7 }, subjectIds: [11, 13, 15] } };
}

test('stored objects survive member cleanup and completion; replay duplicates/timestamps do not inflate object identities', () => {
  const g = graph(), result = analyzeSubjectStorage(g.encode(), g.options);
  assert.equal(result.status, 'completed'); assert.deepEqual(result.records.map(row => row.objectCount), [1, 1, 1]);
  assert.deepEqual(result.records.map(row => row.subjectKind), ['BehaviorSubject', 'ReplaySubject', 'AsyncSubject']);
  assert.deepEqual(result.records[1].storedObjects[0].edges.map(row => row.name), ['_buffer', 0]);
  assert.equal(result.records[1].storedObjects[0].valueId, 23);
});

test('missing/ambiguous storage slots and unknown direct prototypes do not yield certified zero', () => {
  for (const mutate of [g => g.edges.splice(g.edges.findIndex(row => row.name === '_value'), 1), g => g.edges.push(edge(11, 23, '_value')), g => { g.edges.find(row => row.from === 11 && row.name === '__proto__').to = 31; }, g => { g.edges.find(row => row.from === 3 && row.name === '__proto__').to = 31; }]) {
    const g = graph(); mutate(g); const result = analyzeSubjectStorage(g.encode(), g.options);
    assert.equal(result.status, 'incomplete'); assert.equal(result.records[0].status, 'incomplete');
  }
});

test('supported explicit primitive values and empty buffers are zero within the declared storage slots', () => {
  const g = graph();
  for (const row of g.edges) if (row.name === '_value') row.to = 33;
  g.edges.splice(0, g.edges.length, ...g.edges.filter(row => !(row.from === 17 && row.type === 'element')));
  const result = analyzeSubjectStorage(g.encode(), g.options);
  assert.equal(result.status, 'completed'); assert.deepEqual(result.records.map(row => row.objectCount), [0, 0, 0]);
});

test('storage budgets, absent subjects and invalid anchors retain uncertainty or reject the input', () => {
  const g = graph();
  const truncated = analyzeSubjectStorage(g.encode(), { ...g.options, maxEdges: 0 });
  assert.equal(truncated.status, 'incomplete'); assert.equal(truncated.coverage.examinedEdges, 0);
  assert.equal(analyzeSubjectStorage(g.encode(), { ...g.options, subjectIds: [999] }).status, 'incomplete');
  for (const change of [{ maxEdges: 200001 }, { subjectIds: [11, 11] }, { subjectKindPrototypeIds: { BehaviorSubject: 1 } }, { subjectKindPrototypeIds: { Custom: 3 } }]) assert.throws(() => analyzeSubjectStorage(g.encode(), { ...g.options, ...change }));
});

function analysis() {
  const data = { status: 'completed', coverage: { completeWithinDeclaredScope: true }, input: { weakIdentityProtocol: 'registered-weakref-v1' }, records: [] };
  const record = { sequence: 1, status: 'not-observed-in-final-heap', registration: { siteId: 's', file: 'app.ts', line: 4 }, heapSubscriptionId: null, subscriptionResolution: 'weak-ref-cleared', releaseCalls: [{ outcome: 'returned', closedAfter: true }],
    subjectStorage: { status: 'completed', sourceId: 'o1', sourceResolution: 'resolved', heapSubjectId: 11, storedObjects: [{ subjectId: 11, valueId: 21 }] } };
  data.records.push(record, { ...record, sequence: 2 }); return data;
}

test('storage metric ignores cleared subscription and counts the still-live source value once across repeated registration', () => {
  const result = measureSubjectStorage(analysis(), { cache: ['s'] }).cache;
  assert.equal(result.status, 'measured'); assert.equal(result.value, 1); assert.equal(result.releaseCalls.length, 2);
});

test('only explicit bound source clearing supplies zero; missing storage/source identity or selected execution stays unknown', () => {
  const data = analysis();
  for (const record of data.records) record.subjectStorage = { status: 'completed', heapSubjectId: null, sourceResolution: 'weak-ref-cleared', storedObjects: [] };
  assert.equal(measureSubjectStorage(data, { cache: ['s'] }).cache.value, 0);
  for (const mutate of [d => { delete d.input.weakIdentityProtocol; }, d => { d.records[0].subjectStorage.sourceResolution = null; }, d => { d.records[0].subjectStorage.status = 'incomplete'; }, d => { delete d.records[0].subjectStorage; }, d => { d.records = []; }, d => { d.status = 'incomplete'; }]) {
    const modified = structuredClone(data); mutate(modified);
    const measured = measureSubjectStorage(modified, { cache: ['s'] }).cache;
    assert.equal(measured.status, 'unknown'); assert.equal(measured.value, null);
  }
});
