import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/incoming-oracle.mjs';
import { analyzeSubscriptionSources } from '../src/subscription-sources.mjs';

const edge = (from, to, name, type = 'property') => ({ from, to, name, type });
function graph({ shared = false, direct = false, reordered = false, shift = 0 } = {}) {
  const nodes = [
    { id: 1, name: 'root', type: 'synthetic' },
    ...[11, 13, 15, 17, 19].map(id => ({ id, name: 'Object' })),
    ...[21, 22].map(id => ({ id, name: 'minified' })),
    ...[31, 32].map(id => ({ id, name: 'Array' })),
    ...[41, 42, 43, 45, 51, 52].map(id => ({ id, name: 'minified' })),
    { id: 91, name: 'false' }, { id: 93, name: 'null' }
  ];
  const edges = [edge(15, 13, '__proto__'), edge(17, 11, '__proto__')];
  for (const [id, array] of [[21, 31], [22, 32]]) edges.push(edge(id, 11, '__proto__'), edge(id, array, 'observers'), edge(id, 91, 'closed'), edge(id, 91, 'isStopped'), edge(id, 93, 'currentObservers'));
  for (const id of [41, 42, 43, 45]) edges.push(edge(id, 15, '__proto__'));
  for (const id of [51, 52]) edges.push(edge(id, 13, '__proto__'));
  edges.push(edge(31, direct ? 51 : 41, 0, 'element'), edge(shared ? 31 : 32, 42, shared ? 1 : 0, 'element'), edge(31, 43, shared ? 2 : 1, 'element'));
  edges.push(edge(41, 45, 'destination'), edge(45, 51, 'destination'), edge(42, 51, 'destination'), edge(43, 52, 'destination'));
  const encode = () => fixture(nodes.map(node => ({ ...node, id: node.id + shift })), edges.map(item => ({ ...item, from: item.from + shift, to: item.to + shift })), reordered);
  return { nodes, edges, encode, options: { subjectPrototypeId: 11 + shift, subscriberPrototypeId: 13 + shift, subscriptionIds: [51 + shift, 52 + shift] } };
}

test('destination-only witnesses find multiple ordinary Subject inputs and exclude another sink', () => {
  const g = graph(), result = analyzeSubscriptionSources(g.encode(), g.options);
  assert.equal(result.status, 'completed');
  const [first, second] = result.records;
  assert.equal(first.membershipCount, 2); assert.equal(first.subjectCount, 2);
  assert.deepEqual(first.memberships.map(row => row.subjectId).sort(), [21, 22]);
  assert.deepEqual(first.memberships.find(row => row.memberId === 41).subscriberIds, [41, 45, 51]);
  assert.deepEqual(first.memberships.find(row => row.memberId === 41).edges.map(item => item.name), ['observers', 0, 'destination', 'destination']);
  assert.equal(second.membershipCount, 1); assert.equal(second.memberships[0].memberId, 43);
  assert.ok(result.coverage.examinedEdges <= result.coverage.limits.maxEdges);
});

test('shared source keeps distinct member identities and direct sink membership works', () => {
  const g = graph({ shared: true, direct: true }), result = analyzeSubscriptionSources(g.encode(), g.options).records[0];
  assert.equal(result.status, 'completed'); assert.equal(result.subjectCount, 1); assert.equal(result.membershipCount, 2);
  assert.deepEqual(result.memberships.find(row => row.memberId === 51).subscriberIds, [51]);
  assert.equal(result.memberships.find(row => row.memberId === 51).edges.length, 2);
});

test('large IDs and reordered snapshot fields retain literal edge witnesses', () => {
  const shift = 2 ** 40, g = graph({ reordered: true, shift }), result = analyzeSubscriptionSources(g.encode(), g.options);
  assert.equal(result.status, 'completed'); assert.equal(result.records[0].membershipCount, 2);
  assert.ok(result.records.flatMap(row => row.memberships).every(row => row.subjectId > shift && row.edges.every(item => item.sourceId > shift && item.targetId > shift)));
});

test('fake source or member names cannot replace prototype evidence; subclasses remain incomplete', () => {
  const g = graph();
  g.edges.find(item => item.from === 21 && item.name === '__proto__').to = 19;
  g.edges.find(item => item.from === 42 && item.name === '__proto__').to = 19;
  const result = analyzeSubscriptionSources(g.encode(), g.options);
  assert.equal(result.records[0].membershipCount, 0);
  g.edges.find(item => item.from === 21 && item.name === '__proto__').to = 17;
  const subclass = analyzeSubscriptionSources(g.encode(), g.options);
  assert.equal(subclass.records[0].status, 'incomplete');
  assert.ok(subclass.records[0].unknownReasons.includes('subject-subclass-outside-scope'));
});

test('ambiguous prototype and destination properties never produce certified zero or forged paths', () => {
  const g = graph(); g.edges.push(edge(42, 19, '__proto__'), edge(41, 52, 'destination'));
  const result = analyzeSubscriptionSources(g.encode(), g.options);
  assert.equal(result.records[0].status, 'incomplete'); assert.equal(result.records[0].membershipCount, 0);
  assert.ok(result.records[0].unknownReasons.includes('prototype-ambiguous'));
  assert.ok(result.records[0].unknownReasons.includes('subscriber-destination-unconfirmed'));
});

test('unsupported Subject shape and sparse or duplicate member arrays preserve incomplete evidence', () => {
  for (const mutate of [g => { g.edges = g.edges.filter(item => !(item.from === 22 && item.name === 'isStopped')); }, g => { g.edges.find(item => item.from === 32 && item.type === 'element').name = 3; }, g => { g.edges.push(edge(32, 42, 1, 'element')); }]) {
    const g = graph();
    // The encoder closes over the original edge array; mutate that array in place.
    const original = g.edges; mutate(g); if (g.edges !== original) original.splice(0, original.length, ...g.edges);
    const result = analyzeSubscriptionSources(g.encode(), g.options);
    assert.equal(result.records[0].status, 'incomplete'); assert.equal(result.records[0].membershipCount, 1);
  }
});

test('cycles terminate and lower depth, edge and node budgets cannot report complete empty results', () => {
  const g = graph(); g.edges.push(edge(51, 45, 'destination'));
  assert.equal(analyzeSubscriptionSources(g.encode(), g.options).records[0].membershipCount, 2);
  for (const limits of [{ maxDepth: 0 }, { maxEdges: 0 }, { maxEdges: 3 }, { maxNodes: 1 }]) {
    const result = analyzeSubscriptionSources(g.encode(), { ...g.options, ...limits });
    assert.equal(result.status, 'incomplete'); assert.equal(result.records[0].status, 'incomplete');
    assert.ok(result.coverage.examinedEdges <= result.coverage.limits.maxEdges);
    assert.ok(result.coverage.discoveredNodes <= result.coverage.limits.maxNodes);
  }
  const prototypeCycle = graph(); prototypeCycle.edges.find(item => item.from === 15).to = 15;
  assert.equal(analyzeSubscriptionSources(prototypeCycle.encode(), prototypeCycle.options).status, 'incomplete');
});

test('missing sinks remain unknown and unsafe identities, limits and malformed heaps are rejected', () => {
  const g = graph();
  const absent = analyzeSubscriptionSources(g.encode(), { ...g.options, subscriptionIds: [999] });
  assert.equal(absent.records[0].status, 'incomplete'); assert.equal(absent.records[0].unknownReasons[0], 'subscription-node-missing');
  for (const extra of [{ maxEdges: 200001 }, { maxNodes: 0 }, { maxDepth: 17 }, { subscriptionIds: [51, 51] }, { subjectPrototypeId: 13 }, { surprise: true }]) assert.throws(() => analyzeSubscriptionSources(g.encode(), { ...g.options, ...extra }));
  const bad = g.encode(); bad.snapshot.edge_count++;
  assert.throws(() => analyzeSubscriptionSources(bad, g.options), /Declared edge_count/);
});

test('bound built-in Subject prototypes enable exact kind membership without relying on names', () => {
  for (const kind of ['BehaviorSubject', 'ReplaySubject', 'AsyncSubject']) {
    const g = graph(); g.edges.find(item => item.from === 21 && item.name === '__proto__').to = 17;
    const options = { ...g.options, subjectKindPrototypeIds: { [kind]: 17 } };
    const result = analyzeSubscriptionSources(g.encode(), options);
    assert.equal(result.status, 'completed'); assert.equal(result.records[0].membershipCount, 2);
    assert.equal(result.records[0].memberships.find(row => row.subjectId === 21).subjectKind, kind);
    assert.equal(result.records[0].memberships.find(row => row.subjectId === 22).subjectKind, 'Subject');
    assert.deepEqual(result.coverage.subjectKinds, ['Subject', kind]);
    assert.equal(result.coverage.scope, 'bound-Subject-kinds-observers-to-returned-Subscriber-destination');
    assert.equal(analyzeSubscriptionSources(g.encode(), g.options).records[0].status, 'incomplete');
  }
});

test('only provided exact kinds are enabled and custom descendants remain outside scope', () => {
  const g = graph(); g.edges.find(item => item.from === 21 && item.name === '__proto__').to = 17;
  g.edges.find(item => item.from === 22 && item.name === '__proto__').to = 19;
  g.edges.push(edge(19, 11, '__proto__'));
  const partial = analyzeSubscriptionSources(g.encode(), { ...g.options, subjectKindPrototypeIds: { BehaviorSubject: 17 } });
  assert.equal(partial.records[0].status, 'incomplete'); assert.equal(partial.records[0].membershipCount, 1);
  const both = analyzeSubscriptionSources(g.encode(), { ...g.options, subjectKindPrototypeIds: { BehaviorSubject: 17, ReplaySubject: 19 } });
  assert.equal(both.records[0].status, 'completed'); assert.equal(both.records[0].membershipCount, 2);
  g.edges.find(item => item.from === 19 && item.name === '__proto__').to = 17;
  const descendant = analyzeSubscriptionSources(g.encode(), { ...g.options, subjectKindPrototypeIds: { BehaviorSubject: 17 } });
  assert.equal(descendant.records[0].status, 'incomplete'); assert.equal(descendant.records[0].membershipCount, 1);
  assert.ok(descendant.records[0].unknownReasons.includes('subject-subclass-outside-scope'));
});

test('kind identities reject unknown keys, duplicates, wrong types and unrelated prototypes', () => {
  const g = graph();
  for (const subjectKindPrototypeIds of [null, [], { CustomSubject: 17 }, { BehaviorSubject: '17' }, { BehaviorSubject: 11 }, { BehaviorSubject: 13 }, { BehaviorSubject: 17, ReplaySubject: 17 }, { BehaviorSubject: 19 }, { BehaviorSubject: 999 }]) {
    assert.throws(() => analyzeSubscriptionSources(g.encode(), { ...g.options, subjectKindPrototypeIds }));
  }
  g.nodes.find(node => node.id === 17).type = 'closure';
  assert.throws(() => analyzeSubscriptionSources(g.encode(), { ...g.options, subjectKindPrototypeIds: { BehaviorSubject: 17 } }), /invalid-subscription-source-prototype/);
});

test('kind anchor verification shares search budgets and does not turn incomplete evidence into zero', () => {
  const g = graph(); g.edges.find(item => item.from === 21 && item.name === '__proto__').to = 17;
  for (const limits of [{ maxEdges: 0 }, { maxNodes: 1 }]) {
    const result = analyzeSubscriptionSources(g.encode(), { ...g.options, subjectKindPrototypeIds: { BehaviorSubject: 17 }, ...limits });
    assert.equal(result.status, 'incomplete'); assert.equal(result.records[0].status, 'incomplete');
    assert.ok(result.coverage.examinedEdges <= result.coverage.limits.maxEdges);
    assert.ok(result.coverage.discoveredNodes <= result.coverage.limits.maxNodes);
  }
  const empty = analyzeSubscriptionSources(g.encode(), { ...g.options, subscriptionIds: [], subjectKindPrototypeIds: { BehaviorSubject: 17 }, maxEdges: 0 });
  assert.equal(empty.status, 'incomplete'); assert.ok(empty.coverage.unknownReasons.includes('edge-limit'));
  assert.deepEqual(empty.records, []);
});

test('supported kinds still require the Subject shape and an unambiguous bounded prototype chain', () => {
  const g = graph(); g.edges.find(item => item.from === 21 && item.name === '__proto__').to = 17;
  g.edges.splice(g.edges.findIndex(item => item.from === 21 && item.name === 'isStopped'), 1);
  const shape = analyzeSubscriptionSources(g.encode(), { ...g.options, subjectKindPrototypeIds: { BehaviorSubject: 17 } });
  assert.equal(shape.records[0].status, 'incomplete'); assert.equal(shape.records[0].membershipCount, 1);
  assert.ok(shape.records[0].unknownReasons.includes('subject-shape-unconfirmed'));
  for (const mutate of [g => g.edges.push(edge(17, 19, '__proto__')), g => { g.edges.find(item => item.from === 17).to = 17; }]) {
    const bad = graph(); mutate(bad);
    assert.throws(() => analyzeSubscriptionSources(bad.encode(), { ...bad.options, subjectKindPrototypeIds: { BehaviorSubject: 17 } }), /invalid-subscription-source-kind-ancestry/);
  }
});
