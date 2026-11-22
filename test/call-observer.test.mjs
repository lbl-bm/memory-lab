import test from 'node:test';
import assert from 'node:assert/strict';
import { observeOwnMethods, readTaggedArrayView, cutTaggedArrayView } from '../src/call-observer.mjs';
const resource = token => ({ __memoryLabOwner: 'o', __memoryLabResource: token });
const context = { windowId: 'w', cycle: 1, epochId: 'e', pid: 1, threadId: 0 };
test('observer preserves calls/returns/throws and restores exact descriptors without resource logs', () => {
  const owner = { list: [], add(r) { this.list.push(r); return 7; }, idle() { return this.list.length; }, fail() { throw sentinel; } }, sentinel = Error('sentinel');
  const before = Object.getOwnPropertyDescriptors(owner), events = [], view = () => readTaggedArrayView(owner, 'list', 'o');
  const scope = observeOwnMethods(owner, ['add', 'idle', 'fail'], view, context, e => events.push(e));
  assert.equal(owner.add(resource('r1')), 7); assert.equal(owner.idle(), 1); assert.throws(() => owner.fail(), e => e === sentinel);
  assert.deepEqual(events[0].added, ['r1']); assert.deepEqual(events[1].added, []); assert.equal(events[2].status, 'threw');
  assert.equal(scope.restore().restored, true); assert.deepEqual(Object.getOwnPropertyDescriptors(owner), before);
  assert.equal(JSON.stringify(events).includes('__memoryLabResource'), false); assert.equal(events[0].after.tokens[0], 'r1');
  const cut = cutTaggedArrayView(owner, 'list', 'o'); assert.deepEqual(cut.after.tokens, []); assert.equal(cut.kind, 'cut');
});
test('nested calls, async returns, alternate receivers and missing views stay nonexclusive', async () => {
  const owner = { list: [], inner(r) { this.list.push(r); }, outer(r) { return this.inner(r); }, async asyncMethod() { return 1; }, promise() { return Promise.resolve(2); } }, events = [];
  const scope = observeOwnMethods(owner, ['inner', 'outer', 'asyncMethod', 'promise'], () => readTaggedArrayView(owner, 'list', 'o'), context, e => events.push(e));
  owner.outer(resource('r1')); assert.equal(events[0].nestedDepth, 1); assert.equal(events[1].childCalls, 1);
  assert.equal(await owner.promise(), 2); assert.equal(events[2].status, 'unsupported-nonprimitive-result');
  const other = { list: [] }; owner.inner.call(other, resource('r2')); assert.equal(events[3].status, 'unsupported-receiver');
  const restored = scope.restore(); assert.equal(restored.unsupported[0].code, 'unsupported-method-descriptor-or-async');
  const missing = observeOwnMethods(owner, ['inner'], () => ({ status: 'unknown', tokens: null }), context, e => events.push(e)); owner.inner(resource('r3')); assert.equal(events.at(-1).status, 'unknown-view'); missing.restore();
});
test('unsafe views and restoration conflicts are explicit; getters are not invoked', () => {
  let reads = 0; const owner = { list: [resource('r1')], fn() {} }; Object.defineProperty(owner, 'unsafe', { get() { reads++; return []; } });
  assert.equal(readTaggedArrayView(owner, 'unsafe', 'o').status, 'unknown'); assert.equal(reads, 0);
  const sham = cutTaggedArrayView(owner, 'list', 'o', 'sham'); assert.deepEqual(sham.before.tokens, sham.after.tokens);
  const scope = observeOwnMethods(owner, ['fn'], () => readTaggedArrayView(owner, 'list', 'o'), context, () => {}); const replacement = () => 3; owner.fn = replacement;
  assert.equal(scope.restore().restored, false); assert.equal(owner.fn, replacement);
});
