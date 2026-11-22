import test from 'node:test';
import assert from 'node:assert/strict';
import { SortedSnapshotIds } from '../src/snapshot-id-set.mjs';

test('snapshot IDs retain exact large values and iterate in numeric order', () => {
  const source = new Set([Number.MAX_SAFE_INTEGER, 2 ** 40 + 7, 3, 0, 2 ** 32, 11]);
  const ids = new SortedSnapshotIds(source);
  assert.equal(ids.size, source.size);
  assert.deepEqual([...ids], [...source].sort((a, b) => a - b));
  for (const id of source) assert.equal(ids.has(id), true);
  for (const id of [1, 7, 2 ** 32 + 1, 2 ** 40 + 6, Number.MAX_SAFE_INTEGER - 1]) assert.equal(ids.has(id), false);
  source.clear(); source.add(1);
  assert.equal(ids.size, 6); assert.equal(ids.has(1), false); assert.equal(ids.has(3), true);
  assert.equal(ids.add, undefined); assert.equal(ids.delete, undefined); assert.equal(ids.clear, undefined);
});

test('empty and singleton snapshot ID collections preserve membership boundaries', () => {
  const empty = new SortedSnapshotIds(new Set());
  assert.equal(empty.size, 0); assert.deepEqual([...empty], []); assert.equal(empty.has(0), false);
  const single = new SortedSnapshotIds(new Set([17]));
  assert.equal(single.size, 1); assert.deepEqual([...single], [17]);
  assert.equal(single.has(16), false); assert.equal(single.has(17), true); assert.equal(single.has(18), false);
});

test('invalid constructors are rejected and invalid membership queries return false', () => {
  for (const input of [undefined, null, [], [1, 1], new Map(), '123']) assert.throws(() => new SortedSnapshotIds(input), /must be a Set/);
  const invalid = [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null, undefined, 3n, {}];
  for (const id of invalid) assert.throws(() => new SortedSnapshotIds(new Set([id])), /safe integers/);
  const ids = new SortedSnapshotIds(new Set([0, 3]));
  for (const id of invalid) assert.equal(ids.has(id), false);
});

test('deterministic generated collections match an independent Set membership oracle', () => {
  let state = 0x5eed;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (let round = 0; round < 40; round++) {
    const source = new Set();
    for (let i = 0; i < round; i++) source.add((i % 2 ? 2 ** 40 : 0) + next());
    const ids = new SortedSnapshotIds(source);
    assert.equal(ids.size, source.size); assert.deepEqual([...ids], [...source].sort((a, b) => a - b));
    for (const id of source) for (const query of [id - 1, id, id + 1]) assert.equal(ids.has(query), source.has(query));
    for (let i = 0; i < 40; i++) {
      const query = (i % 2 ? 2 ** 40 : 0) + next();
      assert.equal(ids.has(query), source.has(query));
    }
  }
});
