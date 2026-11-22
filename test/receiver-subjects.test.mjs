import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/incoming-oracle.mjs';
import { analyzeReceiverSubjects } from '../src/receiver-subjects.mjs';

const edge = (from, to, name, type = 'property') => ({ from, to, name, type });
function input({ chrome = false, shifted = false, reordered = false } = {}) {
  const nodes = [{ id: 1, name: 'root', type: 'synthetic' }, { id: 3, name: 'minifiedReceiver' }, { id: 5, name: '', type: 'closure' }, { id: 7, name: chrome ? 'system / Context / scope @123' : 'system / Context' }, { id: 9, name: '', type: 'closure' }, { id: 11, name: chrome ? 'system / Context / scope @456' : 'system / Context' }, ...[13, 15, 17, 19, 23, 25, 27].map(id => ({ id, name: 'Object' })), { id: 21, name: 'Array' }];
  const edges = [edge(3, 5, 'operator'), edge(5, 7, 'context', 'internal'), edge(7, 9, chrome ? 'r' : 'init', 'context'), edge(9, 11, 'context', 'internal'), edge(11, 13, chrome ? 'f' : 'subject', 'context'), edge(13, 17, '__proto__'), edge(17, 15, '__proto__'), edge(13, 21, 'observers'), ...['closed', 'isStopped', 'currentObservers'].map(name => edge(13, 19, name))];
  const shift = shifted ? 2 ** 40 : 0;
  return { nodes, edges, encode: () => fixture(nodes.map(node => ({ ...node, id: node.id + shift })), edges.map(item => ({ ...item, from: item.from + shift, to: item.to + shift })), reordered), options: { receiverIds: [3 + shift], subjectPrototypeId: 15 + shift, subjectKindPrototypeIds: { ReplaySubject: 17 + shift } } };
}

test('receiver closure hints preserve exact edges across minification, context formats, large IDs and metadata order', () => {
  for (const args of [{}, { chrome: true, shifted: true, reordered: true }]) {
    const data = input(args), result = analyzeReceiverSubjects(data.encode(), data.options), record = result.records[0];
    assert.equal(result.status, 'completed'); assert.equal(record.status, 'observed'); assert.equal(record.subjects.length, 1);
    assert.equal(record.subjects[0].kind, 'ReplaySubject'); assert.equal(record.subjects[0].path.length, 5);
    assert.deepEqual(record.subjects[0].path.map(value => value.type), ['property', 'internal', 'context', 'internal', 'context']);
    assert.equal(record.subjects[0].prototypeEdge.targetId, data.options.subjectKindPrototypeIds.ReplaySubject);
  }
});

test('a cleared holder slot is unknown rather than released and an empty receiver list proves nothing', () => {
  const data = input(); data.edges.splice(data.edges.findIndex(value => value.from === 11), 1);
  const result = analyzeReceiverSubjects(data.encode(), data.options);
  assert.equal(result.status, 'completed'); assert.equal(result.records[0].status, 'unknown'); assert.equal(result.records[0].searchStatus, 'completed');
  assert.match(result.records[0].zeroMeaning, /not evidence of release/);
  assert.deepEqual(analyzeReceiverSubjects(data.encode(), { ...data.options, receiverIds: [] }).records, []);
});

test('arbitrary object fields, weak edges, source links and fake class names are never followed', () => {
  for (const mutate of [data => { data.edges[0].name = 'source'; }, data => { data.edges[0].type = 'weak'; }, data => { data.nodes.find(value => value.id === 7).name = 'businessContext'; }, data => { data.edges.find(value => value.from === 13 && value.name === '__proto__').to = 23; }, data => { data.nodes.find(value => value.id === 5).type = 'object'; }]) {
    const data = input(); mutate(data); assert.equal(analyzeReceiverSubjects(data.encode(), data.options).records[0].subjects.length, 0);
  }
});

test('multiple literal associations are reported and cycles do not duplicate a subject', () => {
  const data = input(); data.edges.push(edge(11, 25, 'another', 'context'), edge(11, 7, 'cycle', 'context'), edge(25, 15, '__proto__'), edge(25, 21, 'observers'), ...['closed', 'isStopped', 'currentObservers'].map(name => edge(25, 19, name)));
  const result = analyzeReceiverSubjects(data.encode(), data.options);
  assert.equal(result.status, 'completed'); assert.deepEqual(result.records[0].subjects.map(value => value.kind).sort(), ['ReplaySubject', 'Subject']);
});

test('parent lexical contexts do not widen receiver hints into a module-wide search', () => {
  const data = input(); data.edges.find(value => value.from === 7).type = 'internal'; data.edges.find(value => value.from === 7).name = 'previous';
  const result = analyzeReceiverSubjects(data.encode(), data.options);
  assert.equal(result.records[0].status, 'unknown'); assert.equal(result.records[0].subjects.length, 0);
});

test('missing or ambiguous prototype and Subject slots cannot produce trusted holder hints', () => {
  for (const mutate of [data => data.edges.push(edge(13, 23, '__proto__')), data => data.edges.splice(data.edges.findIndex(value => value.from === 13 && value.name === 'closed'), 1)]) {
    const data = input(); mutate(data); const result = analyzeReceiverSubjects(data.encode(), data.options);
    assert.equal(result.records[0].status, 'unknown'); assert.equal(result.records[0].searchStatus, 'incomplete');
  }
});

test('search budgets remain bounded and preserve unknown rather than zero', () => {
  for (const lower of [{ maxDepth: 0 }, { maxDepth: 3 }, { maxEdges: 0 }, { maxEdges: 4 }, { maxNodes: 1 }]) {
    const data = input(), result = analyzeReceiverSubjects(data.encode(), { ...data.options, ...lower });
    assert.equal(result.status, 'incomplete'); assert.equal(result.records[0].status, 'unknown');
    assert.ok(result.coverage.examinedEdges <= result.coverage.limits.maxEdges); assert.ok(result.coverage.discoveredNodes <= result.coverage.limits.maxNodes);
  }
});

test('missing receivers are unknown and invalid identities, options and heaps are rejected', () => {
  const data = input(); assert.equal(analyzeReceiverSubjects(data.encode(), { ...data.options, receiverIds: [999] }).records[0].status, 'unknown');
  for (const extra of [{ receiverIds: [3, 3] }, { subjectKindPrototypeIds: { Arbitrary: 17 } }, { subjectKindPrototypeIds: { ReplaySubject: 15 } }, { subjectKindPrototypeIds: { ReplaySubject: 23 } }, { maxEdges: 50001 }, { maxDepth: 9 }, { maxNodes: 0 }, { unsupported: true }]) assert.throws(() => analyzeReceiverSubjects(data.encode(), { ...data.options, ...extra }));
  const heap = data.encode(); heap.snapshot.edge_count++; assert.throws(() => analyzeReceiverSubjects(heap, data.options), /Declared edge_count/);
});
