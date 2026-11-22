import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCensuses } from '../src/snapshot-growth.mjs';
import { compareSurvivorFamilies } from '../src/survivor-candidates.mjs';

function input(rows, { followup = true, names = {} } = {}) {
  const points = rows.map((_, index) => ({ phase: index === 0 ? 'baseline' : followup && index === rows.length - 1 ? 'followup' : 'back', cycle: index === 0 ? 0 : followup && index === rows.length - 1 ? index - 1 : index }));
  const indexes = rows.map(row => ({ allIds: new Set(Object.values(row).flat()), byGroup: new Map(Object.entries(row).map(([key, ids]) => [key, new Set(ids)])) }));
  const censuses = indexes.map(index => new Map([...index.byGroup].filter(([, ids]) => ids.size).map(([key, ids]) => [key, { familyKey: key, family: { kind: 'direct-prototype-edge', prototypeId: key }, type: 'object', name: names[key] ?? key, count: ids.size, selfSizeBytes: ids.size * 24, exampleNodeIds: [...ids].slice(0, 3) }])));
  return { points, indexes, censuses };
}
const compare = data => compareSurvivorFamilies(data.points, data.indexes, data.censuses);

test('one-time retained allocations and bounded caches are visible as unjudged survivor candidates', () => {
  const data = input([{}, { a: [10] }, { a: [10] }, { a: [10] }, { a: [10] }]);
  assert.equal(compareCensuses(data.points, data.censuses).candidateCount, 0);
  const result = compare(data), group = result.candidates[0];
  assert.equal(result.candidateCount, 1); assert.equal(group.classification, 'stable-new-survivors');
  assert.deepEqual(group.baselineAbsentByPoint, [0, 1, 1, 1, 1]);
  assert.deepEqual(group.survivingNewIds, [10]); assert.equal(group.survivingNewCount, 1);
  assert.deepEqual(group.survivingNewInstances, [{ nodeId: 10, firstObservedCycle: 1, backObservations: 3, followup: 'present' }]);
  assert.equal(result.unresolvedCandidateCount, 1); assert.equal(Object.hasOwn(group, 'leak'), false);
});

test('intermittent accumulation preserves independently surviving cohorts after growth plateaus', () => {
  const data = input([{}, { a: [10] }, { a: [10, 20] }, { a: [10, 20] }, { a: [10, 20] }]);
  assert.equal(compareCensuses(data.points, data.censuses).candidateCount, 0);
  const group = compare(data).candidates[0];
  assert.equal(group.classification, 'accumulating-survivors');
  assert.deepEqual(group.survivingNewIds, [10, 20]);
  assert.deepEqual(group.survivingNewInstances.map(row => row.backObservations), [3, 2]);
});

test('same-family count replacement cannot conceal persistent new identities and single-back additions remain excluded', () => {
  const data = input([{ a: [1, 2, 3] }, { a: [2, 3, 10] }, { a: [3, 10, 20] }, { a: [10, 20, 30] }, { a: [10, 20, 30] }]);
  const group = compare(data).candidates[0];
  assert.deepEqual(group.counts, [3, 3, 3, 3, 3]); assert.equal(group.followupStatus, 'at-or-below-baseline');
  assert.deepEqual(group.survivingNewIds, [10, 20]); assert.deepEqual(group.baselineAbsentByPoint, [0, 1, 2, 3, 3]);
  assert.equal(group.classification, 'accumulating-survivors'); assert.equal(compare(data).unresolvedCandidateCount, 1);
});

test('constant-size replacement with just one qualifying final survivor is still a candidate', () => {
  const data = input([{ a: [1, 2] }, { a: [1, 10] }, { a: [10, 20] }, { a: [20, 30] }, { a: [20, 30] }]);
  const group = compare(data).candidates[0];
  assert.equal(group.classification, 'stable-new-survivors');
  assert.deepEqual(group.survivingNewIds, [20]);
  assert.equal(group.survivingNewInstances[0].backObservations, 2);
  assert.equal(group.survivingNewInstances[0].firstObservedCycle, 2);
});

test('last-back-only objects, early temporary objects and baseline identities moving family do not become new survivors', () => {
  const data = input([{ original: [1, 2] }, { moved: [1, 2], transient: [10] }, { moved: [1, 2] }, { moved: [1, 2], late: [20] }, { moved: [1, 2], late: [20] }]);
  const result = compare(data); assert.equal(result.candidateCount, 0);
  for (const group of result.groups) assert.equal(group.classification, 'none');
  assert.deepEqual(result.groups.find(group => group.familyKey === 'late').baselineAbsentByPoint, [0, 0, 0, 1, 1]);
});

test('followup resolution uses identity rather than group total, including shape changes and delayed release', () => {
  const data = input([{}, { a: [10, 11] }, { a: [10, 11] }, { a: [10, 11] }, { b: [10] }]);
  const group = compare(data).candidates[0];
  assert.equal(group.followupStatus, 'at-or-below-baseline');
  assert.deepEqual(group.survivingNewInstances.map(row => row.followup), ['identity-shape-changed', 'absent']);
  assert.equal(group.candidateIdentityFollowup.status, 'partly-present'); assert.equal(compare(data).unresolvedCandidateCount, 1);
  const released = input([{}, { a: [10] }, { a: [10] }, { a: [10] }, {}]);
  assert.equal(compare(released).candidateCount, 1); assert.equal(compare(released).unresolvedCandidateCount, 0);
});

test('existing continuous-growth candidates keep prior order and eligibility even when their individual IDs turn over', () => {
  const data = input([{}, { z: [10, 11], a: [12], cache: [99], intermittent: [100] }, { z: [20, 21, 22, 23], a: [24, 25], cache: [99], intermittent: [100, 101] }, { z: [30, 31, 32, 33, 34, 35], a: [36, 37, 38], cache: [99], intermittent: [100, 101] }, { z: [30, 31, 32, 33, 34, 35], a: [36, 37, 38], cache: [99], intermittent: [100, 101] }]);
  const result = compare(data), old = compareCensuses(data.points, data.censuses);
  assert.deepEqual(result.candidates.slice(0, old.candidateCount).map(group => group.familyKey), old.candidates.map(group => group.familyKey));
  assert.deepEqual(result.candidates.map(group => group.classification), ['continuous-growth', 'continuous-growth', 'accumulating-survivors', 'stable-new-survivors']);
  assert.equal(result.candidates[0].survivingNewCount, 0); assert.equal(result.candidates[0].candidateIdentityFollowup.eligibleCount, 6);
});

test('without followup the candidate remains unresolved; input objects are unchanged', () => {
  const data = input([{}, { a: [10] }, { a: [10] }, { a: [10] }], { followup: false }), original = structuredClone(data);
  const result = compare(data); assert.equal(result.unresolvedCandidateCount, 1);
  assert.equal(result.candidates[0].candidateIdentityFollowup.status, 'not-measured');
  assert.equal(result.candidates[0].survivingNewInstances[0].followup, 'not-measured');
  assert.deepEqual(data, original);
});

test('partial identity indexes and inconsistent census coverage are rejected rather than counted as zero', () => {
  const data = input([{}, { a: [10] }, { a: [10] }, { a: [10] }, { a: [10] }]);
  assert.throws(() => compareSurvivorFamilies(data.points, data.indexes.slice(1), data.censuses), /index/);
  const partial = structuredClone(data); partial.indexes[2].byGroup.delete('a'); assert.throws(() => compare(partial), /index/);
  const missing = structuredClone(data); missing.indexes[1].allIds.delete(10); assert.throws(() => compare(missing), /index/);
  const noBaseline = structuredClone(data); noBaseline.points[0].phase = 'back'; assert.throws(() => compare(noBaseline), /baseline/);
});
