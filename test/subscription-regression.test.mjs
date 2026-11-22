import test from 'node:test';
import assert from 'node:assert/strict';
import { measureSubscriptionSubjects, validateRegressionContract } from '../src/regression.mjs';

function analysis() {
  const member = (subjectId, memberId) => ({ subjectId, memberId, observerArrayId: subjectId + 100, subscriberIds: [memberId, 99] });
  return { status: 'completed', coverage: { completeWithinDeclaredScope: true }, input: { weakIdentityProtocol: 'registered-weakref-v1' }, sourceMemberships: { status: 'completed' },
    records: [{ sequence: 1, status: 'observed-reference-path', registration: { siteId: 's' }, heapSubscriptionId: 99, subscriptionResolution: 'resolved', closedAtCheckpoint: false,
      sourceMemberships: { status: 'completed', membershipCount: 3, memberships: [member(10, 20), member(10, 21), member(11, 22)] }, releaseCalls: [] }] };
}
test('multi-source metric counts members rather than Subjects and deduplicates identical registration associations', () => {
  const data = analysis(); data.records.push(structuredClone(data.records[0]));
  data.records.push({ ...structuredClone(data.records[0]), registration: { siteId: 'unrelated' } });
  const result = measureSubscriptionSubjects(data, { selected: ['s'] }).selected;
  assert.equal(result.status, 'measured'); assert.equal(result.value, 3);
  assert.equal(result.witnesses.length, 3);
});
test('only explicit cleared subscriptions or closed zero-membership sinks can contribute zero; open unsupported producers are unknown', () => {
  const data = analysis(), record = data.records[0]; record.sourceMemberships.memberships = []; record.sourceMemberships.membershipCount = 0;
  assert.equal(measureSubscriptionSubjects(data, { selected: ['s'] }).selected.status, 'unknown');
  record.closedAtCheckpoint = true; assert.equal(measureSubscriptionSubjects(data, { selected: ['s'] }).selected.value, 0);
  record.heapSubscriptionId = null; record.closedAtCheckpoint = null; record.subscriptionResolution = 'weak-ref-cleared';
  assert.equal(measureSubscriptionSubjects(data, { selected: ['s'] }).selected.value, 0);
  delete data.input.weakIdentityProtocol;
  assert.equal(measureSubscriptionSubjects(data, { selected: ['s'] }).selected.status, 'unknown');
});
test('partial graph evidence, missing anchors and never-executed sites cannot pass the new metric', () => {
  for (const mutate of [data => { data.sourceMemberships.status = 'unavailable'; }, data => { data.records[0].sourceMemberships.status = 'incomplete'; }, data => { data.records = []; }, data => { data.status = 'incomplete'; }]) {
    const data = analysis(); mutate(data); assert.equal(measureSubscriptionSubjects(data, { selected: ['s'] }).selected.status, 'unknown');
  }
});
test('the new metric is explicit; the primary Subject metric remains accepted', () => {
  for (const metric of ['subject-observer-count', 'subscription-subject-membership-count']) {
    const contract = { schemaVersion: '0.1.0', authority: 'asserted', scenarioId: 's', statement: 'Only the declared membership relation must be zero after exit.', workloadChange: { kind: 'same-entry', statement: 'Same entry.', beforeEntrySha256: 'a'.repeat(64), afterEntrySha256: 'a'.repeat(64) }, rules: [{ id: 'r', metric, expectation: 'bounded-after-back', maxEntries: 0 }] };
    assert.equal(validateRegressionContract(contract).rules[0].metric, metric);
  }
});
