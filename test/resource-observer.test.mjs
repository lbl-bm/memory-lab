import test from 'node:test';
import assert from 'node:assert/strict';
import { installResourceObserver, resourceOperations } from '../src/resource-observer.mjs';

function setup(options = {}) {
  let handle = 0; const pending = new Map();
  const realm = { EventTarget: class extends EventTarget {}, AbortSignal, setTimeout(callback, delay, ...args) { Number(delay); pending.set(++handle, { callback, args, interval: false }); return handle; }, setInterval(callback, delay, ...args) { Number(delay); pending.set(++handle, { callback, args, interval: true }); return handle; }, clearTimeout(id) { pending.delete(id); }, clearInterval(id) { pending.delete(id); } };
  const registry = { sites: resourceOperations.map((operation, i) => ({ id: 'site' + i, operation })) };
  const probe = installResourceObserver({ realm, registry, epochId: 'test', ...options });
  const call = (receiver, operation, ...args) => probe.prepare(registry.sites.find(site => site.operation === operation).id, receiver, operation)(...args);
  const fire = id => { const task = pending.get(id); if (!task) return; if (!task.interval) pending.delete(id); return Reflect.apply(task.callback, realm, task.args); };
  return { realm, probe, call, fire, pending };
}

test('native listener identity includes capture, ignores duplicate option changes and supports mixed removal', () => {
  const { realm, probe, call } = setup(), target = new realm.EventTarget(); let count = 0;
  function listener() { assert.equal(this, target); count++; }
  call(target, 'addEventListener', 'tick', listener);
  call(target, 'addEventListener', 'tick', listener, { once: true });
  call(target, 'addEventListener', 'tick', listener, { capture: true });
  target.dispatchEvent(new Event('tick')); assert.equal(count, 2);
  target.removeEventListener('tick', listener, false);
  target.dispatchEvent(new Event('tick')); assert.equal(count, 3);
  call(target, 'removeEventListener', 'tick', listener, { capture: true });
  target.dispatchEvent(new Event('tick')); assert.equal(count, 3);
  const report = probe.report(); assert.equal(report.resources.length, 2); assert.ok(report.resources.every(resource => resource.state === 'released'));
  assert.equal(report.events.filter(event => event.outcome === 'duplicate-ignored').length, 1); assert.equal(report.coverage.unknownSourceCalls, 1); probe.restore();
});

test('once releases before a reentrant re-registration and object listeners keep dynamic handleEvent', () => {
  const { realm, probe, call } = setup(), target = new realm.EventTarget(); let count = 0;
  const listener = { handleEvent() { assert.equal(this, listener); count++; if (count === 1) call(target, 'addEventListener', 'tick', listener, { once: true }); } };
  call(target, 'addEventListener', 'tick', listener, { once: true });
  target.dispatchEvent(new Event('tick')); target.dispatchEvent(new Event('tick')); target.dispatchEvent(new Event('tick'));
  assert.equal(count, 2); assert.ok(probe.report().resources.every(resource => resource.endedBy === 'once-before-callback')); probe.restore();
});

test('pre-aborted and abort after registration follow native removal even if abort listeners stop propagation', () => {
  const { realm, probe, call } = setup(), target = new realm.EventTarget(), controller = new AbortController(); let count = 0;
  controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
  call(target, 'addEventListener', 'tick', () => count++, { signal: controller.signal });
  controller.abort(); target.dispatchEvent(new Event('tick'));
  assert.equal(count, 0); assert.equal(probe.report().resources[0].endedBy, 'abort-signal-observed');
  call(target, 'addEventListener', 'tick', () => count++, { signal: controller.signal });
  assert.equal(probe.report().resources.length, 1); assert.equal(probe.report().resources[0].releaseSiteId, null); probe.restore();
});

test('timeout completion, timer args/this, cross-clearing shared IDs, and interval self-release are tracked', () => {
  const { realm, probe, call, fire } = setup(); const received = [];
  const timeout = call(realm, 'setTimeout', function (...args) { assert.equal(this, realm); received.push(args); }, 0, 1, 'x');
  fire(timeout); assert.deepEqual(received, [[1, 'x']]);
  const interval = call(realm, 'setInterval', () => call(realm, 'clearTimeout', interval), 0); fire(interval);
  const canceled = call(realm, 'setTimeout', () => assert.fail(), 0); call(realm, 'clearInterval', canceled); fire(canceled);
  const report = probe.report(); assert.deepEqual(report.resources.map(resource => resource.state), ['completed', 'released', 'released']);
  assert.deepEqual(report.resources.map(resource => resource.endedBy), ['timeout-callback-completed', 'clearTimeout', 'clearInterval']); probe.restore();
});

test('throwing timeout still completes; unsupported operations keep uncertainty visible', () => {
  const { realm, probe, call, fire } = setup(); const failure = Error('callback-failure');
  const timeout = call(realm, 'setTimeout', () => { throw failure; }, 0); assert.throws(() => fire(timeout), error => error === failure);
  call(realm, 'clearTimeout', 'unknown');
  const report = probe.report(); assert.equal(report.resources[0].state, 'completed'); assert.equal(report.resources[0].stateCertain, false); assert.equal(report.coverage.completeWithinScope, false); probe.restore();
});

test('capture getter is read once and still removes the translated listener; thrown getter preserves failure identity', () => {
  const { realm, probe, call } = setup(), target = new realm.EventTarget(); let calls = 0, gets = 0;
  const listener = () => calls++, failure = Error('capture-getter');
  call(target, 'addEventListener', 'tick', listener, { capture: true });
  assert.throws(() => call(target, 'removeEventListener', 'tick', listener, { get capture() { gets++; throw failure; } }), error => error === failure);
  assert.equal(gets, 1); target.dispatchEvent(new Event('tick')); assert.equal(calls, 1);
  call(target, 'removeEventListener', 'tick', listener, { get capture() { gets++; return true; } });
  target.dispatchEvent(new Event('tick')); assert.equal(calls, 1); assert.equal(gets, 2);
  const report = probe.report(); assert.equal(report.resources[0].state, 'released');
  assert.equal(report.events.find(event => event.outcome === 'threw').siteId, 'site1');
  probe.restore();
});

test('timer delay coercion reentrancy keeps distinct resource identities and release associations', () => {
  const { realm, probe, call } = setup(); let nested;
  const outer = call(realm, 'setTimeout', () => {}, { valueOf() { nested = call(realm, 'setTimeout', () => {}, 1000); return 1000; } });
  call(realm, 'clearTimeout', outer);
  const records = probe.report().resources;
  assert.equal(new Set(records.map(record => record.id)).size, 2);
  assert.equal(records.find(record => record.handle === nested).state, 'active');
  assert.equal(records.find(record => record.handle === outer).state, 'released');
  call(realm, 'clearTimeout', nested); probe.restore();
});

test('in-flight timer registrations reserve their resource budget during native coercion', () => {
  const { realm, probe, call, pending } = setup({ maxResources: 1 }); let nested;
  const outer = call(realm, 'setTimeout', () => {}, { valueOf() { nested = call(realm, 'setTimeout', () => {}, 1000); return 1000; } });
  const report = probe.report(); assert.equal(report.resources.length, 1); assert.equal(report.coverage.completeWithinScope, false);
  assert.ok(report.events.some(event => event.reason === 'resource-budget')); assert.equal(pending.size, 2);
  call(realm, 'clearTimeout', outer); call(realm, 'clearTimeout', nested); assert.equal(pending.size, 0); probe.restore();
});

test('declared targets and holders use weak identities without mutating business objects', () => {
  const { probe } = setup(), target = {}, holder = [target];
  const id = probe.trackObject(target, 'target-1', 'target'); assert.equal(probe.trackObject(target, 'target-1', 'target'), id);
  probe.trackObject(holder, 'owner', 'holder'); assert.deepEqual(Object.keys(target), []);
  assert.equal(probe.resolve(id), target); assert.equal(probe.report().declarations.length, 2);
  assert.throws(() => probe.trackObject({}, 'target-1', 'target'), /label-reused/); probe.restore();
});

test('private accounting uses explicit slots without excluding same-named business containers or callback wrappers', () => {
  const { realm, probe, call } = setup(), target = new realm.EventTarget(), businessMap = new Map(), businessSet = new Set(), businessWeakRef = new WeakRef(target), callback = () => {};
  for (const [label, value] of [['map', businessMap], ['set', businessSet], ['weak-ref', businessWeakRef]]) probe.trackObject(value, label);
  call(target, 'addEventListener', 'tick', callback);
  const before = probe.report(), wrapper = probe.resolve(before.resources[0].wrapperId), first = probe.probeOwnedObjects(), second = probe.probeOwnedObjects();
  assert.equal(first.complete, true); assert.equal(new Set(first.objects.map(entry => entry.value)).size, first.objects.length);
  assert.deepEqual(first.objects, second.objects); assert.deepEqual(before, probe.report());
  for (const value of [target, businessMap, businessSet, businessWeakRef, callback, wrapper, realm]) assert.equal(first.objects.some(entry => entry.value === value), false);
  assert.ok(first.objects.some(entry => entry.value instanceof Map)); assert.ok(first.objects.some(entry => entry.value instanceof Set)); assert.ok(first.objects.some(entry => entry.value instanceof WeakRef));
  assert.equal(first.objects.some(entry => typeof entry.value === 'function'), false);
  call(target, 'removeEventListener', 'tick', callback); probe.restore();
});

test('private accounting stops at 8192 exact identities and never registers its temporary inventory', () => {
  const { realm, probe, call } = setup(), live = [];
  for (let i = 0; i < 512; i++) {
    const target = new realm.EventTarget(), callback = () => {};
    call(target, 'addEventListener', 'tick', callback); call(target, 'removeEventListener', 'tick', callback); live.push([target, callback]);
  }
  const before = probe.report(), first = probe.probeOwnedObjects(), second = probe.probeOwnedObjects();
  assert.equal(first.complete, false); assert.equal(first.objects.length, 8192); assert.equal(first.limits.maxObjects, 8192);
  assert.deepEqual(first.objects, second.objects); assert.deepEqual(before, probe.report());
  assert.equal(before.objects.length, 1536); assert.equal(before.resources.length, 512); probe.restore();
});
