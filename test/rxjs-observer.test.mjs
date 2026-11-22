import test from 'node:test';
import assert from 'node:assert/strict';
import rxjs from 'rxjs';
import { createRxjsObserver } from '../src/rxjs-observer.mjs';
const registry = { sites: [{ id: 's', operation: 'subscribe' }, { id: 'u', operation: 'unsubscribe' }] };
const observer = options => createRxjsObserver({ rxjs, version: '7.8.1', registry, epochId: 'e', ...options });

test('RxJS adapter returns the actual subscription and preserves callback identity without added teardown', () => {
  const probe = observer(), subject = new rxjs.Subject(), values = [], next = value => values.push(value);
  const descriptors = Object.getOwnPropertyDescriptors(rxjs.Subscriber.prototype);
  const sub = probe.prepare('s', subject, 'subscribe')(next);
  assert.equal(sub, subject.observers[0]); assert.equal(sub.destination.partialObserver.next, next);
  assert.equal(sub._finalizers.length, 1); subject.next(3);
  assert.equal(probe.prepare('u', sub, 'unsubscribe')(), undefined); subject.next(4);
  assert.deepEqual(values, [3]); assert.equal(subject.observers.length, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptors(rxjs.Subscriber.prototype), descriptors);
  const events = probe.report().events;
  assert.equal(events[0].closedAfter, false); assert.equal(events[1].closedAfter, true);
  assert.equal(events[0].subscriptionId, events[1].subscriptionId);
});

test('RxJS teardown exception keeps original error and records closed without asserting release', () => {
  const probe = observer(), sentinel = Error('teardown'), next = () => {};
  const sub = probe.prepare('s', new rxjs.Observable(() => () => { throw sentinel; }), 'subscribe')(next);
  assert.throws(() => probe.prepare('u', sub, 'unsubscribe')(), error => error.name === 'UnsubscriptionError' && error.errors[0] === sentinel);
  assert.equal(sub.closed, true); assert.equal(sub.destination.partialObserver.next, next);
  const event = probe.report().events[1];
  assert.equal(event.outcome, 'threw'); assert.equal(event.closedBefore, false); assert.equal(event.closedAfter, true);
  assert.equal(probe.report().completeWithinScope, true);
  assert.equal(Object.values(event).includes(sentinel), false);
});

test('automatic completion and producer error are preserved without invented unsubscribe events', () => {
  const probe = observer(), values = [], errors = [];
  const done = probe.prepare('s', rxjs.of(7), 'subscribe')(v => values.push(v));
  const failed = probe.prepare('s', new rxjs.Observable(sub => sub.error('producer')), 'subscribe')({ error: value => errors.push(value) });
  assert.deepEqual(values, [7]); assert.deepEqual(errors, ['producer']);
  assert.equal(done.closed, true); assert.equal(failed.closed, true);
  assert.equal(probe.report().events.length, 2); assert.ok(probe.report().events.every(e => e.closedAfter));
  const source = new rxjs.Subject(), sub = probe.prepare('s', source.pipe(rxjs.take(1)), 'subscribe')(() => {});
  assert.equal(probe.report().events[2].closedAfter, false); source.next(1); assert.equal(sub.closed, true);
  assert.equal(probe.report().events.length, 3);
});

test('nested subscriptions keep invocation order and supplied Subscribers keep their identity', () => {
  const probe = observer(), inner = new rxjs.Subject(); let innerSub;
  const outer = new rxjs.Observable(sub => { innerSub = probe.prepare('s', inner, 'subscribe')(() => {}); sub.complete(); });
  const sink = new rxjs.Subscriber({ next() {}, error() {}, complete() {} });
  assert.equal(probe.prepare('s', outer, 'subscribe')(sink), sink);
  const events = probe.report().events; assert.deepEqual(events.map(e => e.sequence), [1, 2]);
  assert.equal(events[0].closedAfter, true); assert.equal(events[1].closedAfter, false); innerSub.unsubscribe();
});

test('method lookup precedes args and unsupported methods preserve this/return/throw', () => {
  const probe = observer(), sentinel = {}, log = [];
  const target = { get subscribe() { log.push('lookup'); return function(value) { log.push(value); assert.equal(this, target); throw sentinel; }; } };
  assert.throws(() => probe.prepare('s', target, 'subscribe')((log.push('arg'), 8)), e => e === sentinel);
  assert.deepEqual(log, ['lookup', 'arg', 8]); assert.equal(probe.report().unsupported, 1);
  assert.equal(probe.report().events[0].outcome, 'threw');
});

test('event and identity budgets do not stop application subscription or cancellation', () => {
  for (const limits of [{ maxEvents: 0 }, { maxObjects: 1 }]) {
    const probe = observer(limits), subject = new rxjs.Subject();
    const sub = probe.prepare('s', subject, 'subscribe')(() => {});
    assert.equal(subject.observers.length, 1); probe.prepare('u', sub, 'unsubscribe')();
    assert.equal(subject.observers.length, 0); assert.equal(probe.report().completeWithinScope, false);
    assert.ok(probe.report().events.length <= probe.report().limits.maxEvents);
    assert.ok(probe.report().objects.length <= probe.report().limits.maxObjects);
  }
  assert.throws(() => observer({ version: '8.0.0' }), /unsupported-rxjs/);
});

test('weak type anchors identify the installed Subject and Subscriber prototypes without patching them', () => {
  const probe = observer(), source = new rxjs.Subject();
  const subjectDescriptors = Object.getOwnPropertyDescriptors(rxjs.Subject.prototype);
  const subscriberDescriptors = Object.getOwnPropertyDescriptors(rxjs.Subscriber.prototype);
  const subscription = probe.prepare('s', source, 'subscribe')(() => {});
  const report = probe.report();
  assert.equal(report.typeAnchors.status, 'available');
  assert.equal(probe.resolve(report.typeAnchors.subjectPrototypeId), rxjs.Subject.prototype);
  assert.equal(probe.resolve(report.typeAnchors.subscriberPrototypeId), rxjs.Subscriber.prototype);
  assert.equal(report.objects.filter(value => value.roles.includes('type-prototype')).length, 5);
  for (const kind of ['BehaviorSubject', 'ReplaySubject', 'AsyncSubject']) assert.equal(probe.resolve(report.typeAnchors.subjectKindPrototypeIds[kind]), rxjs[kind].prototype);
  report.typeAnchors.subjectKindPrototypeIds.BehaviorSubject = 'changed';
  assert.equal(probe.resolve(probe.report().typeAnchors.subjectKindPrototypeIds.BehaviorSubject), rxjs.BehaviorSubject.prototype);
  report.typeAnchors.status = 'modified'; assert.equal(probe.report().typeAnchors.status, 'available');
  subscription.unsubscribe();
  assert.deepEqual(Object.getOwnPropertyDescriptors(rxjs.Subject.prototype), subjectDescriptors);
  assert.deepEqual(Object.getOwnPropertyDescriptors(rxjs.Subscriber.prototype), subscriberDescriptors);
});
