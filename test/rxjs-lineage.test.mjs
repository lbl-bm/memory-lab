import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import rxjs from 'rxjs';
import { createRxjsObserver } from '../src/rxjs-observer.mjs';
const observer = () => createRxjsObserver({ rxjs, version: '7.8.1', registry: { sites: [{ id: 's', operation: 'subscribe' }] }, epochId: 'lineage' });
const lineage = probe => probe.report().events.at(-1).sourceLineage;

test('built-in Subject kinds preserve synchronous delivery and bind the actual primary source', () => {
  for (const kind of ['BehaviorSubject', 'ReplaySubject', 'AsyncSubject']) {
    const probe = observer(), source = kind === 'BehaviorSubject' ? new rxjs[kind](7) : new rxjs[kind](), values = [];
    const sub = probe.prepare('s', source.pipe(rxjs.map(value => value * 2)), 'subscribe')(value => values.push(value));
    assert.equal(lineage(probe).status, 'observed'); assert.equal(lineage(probe).subjectKind, kind);
    assert.equal(probe.resolve(lineage(probe).subjectId), source);
    source.next(11); if (kind === 'AsyncSubject') source.complete();
    assert.deepEqual(values, kind === 'BehaviorSubject' ? [14, 22] : [22]);
    sub.unsubscribe(); assert.equal(source.observers.length, 0);
  }
});

test('synchronous pipes record actual primary Subject and destination membership without changing values', () => {
  const probe = observer(), subject = new rxjs.Subject(), values = [];
  const pipe = subject.pipe(rxjs.filter(value => value > 0), rxjs.map(value => value * 2));
  const sub = probe.prepare('s', pipe, 'subscribe')(value => values.push(value));
  subject.next(-1); subject.next(3);
  const result = lineage(probe);
  assert.equal(result.status, 'observed'); assert.equal(result.scope, 'primary-source-only');
  assert.equal(result.sourceIds.length, 3); assert.equal(probe.resolve(result.subjectId), subject);
  assert.equal(probe.resolve(result.membership.memberId), subject.observers[0]);
  assert.equal(probe.resolve(result.membership.subscriberIds.at(-1)), sub);
  assert.deepEqual(values, [6]); sub.unsubscribe(); assert.equal(subject.observers.length, 0);
});
test('bufferTime/filter/map preserves scheduled delivery and records the same membership path', () => {
  const probe = observer(), scheduler = new rxjs.VirtualTimeScheduler(undefined, 20), subject = new rxjs.Subject(), values = [];
  const pipe = subject.pipe(rxjs.bufferTime(10, undefined, Infinity, scheduler), rxjs.filter(batch => batch.length > 0), rxjs.map(batch => batch.reduce((a, b) => a + b, 0)));
  const sub = probe.prepare('s', pipe, 'subscribe')(value => values.push(value));
  subject.next(2); subject.next(3); assert.deepEqual(values, []); scheduler.flush();
  assert.deepEqual(values, [5]); assert.equal(lineage(probe).status, 'observed');
  assert.equal(lineage(probe).sourceIds.length, 4); assert.equal(lineage(probe).membership.subscriberIds.length, 4);
  sub.unsubscribe(); assert.equal(subject.observers.length, 0); assert.equal(scheduler.actions.length, 0);
});
test('deferred subscribe and synchronous completion remain unconfirmed instead of invented source membership', () => {
  const probe = observer(), scheduler = new rxjs.VirtualTimeScheduler(), subject = new rxjs.Subject();
  const delayed = probe.prepare('s', subject.pipe(rxjs.subscribeOn(scheduler)), 'subscribe')(() => {});
  assert.equal(lineage(probe).status, 'unconfirmed'); assert.equal(subject.observers.length, 0);
  scheduler.flush(); assert.equal(subject.observers.length, 1); delayed.unsubscribe();
  probe.prepare('s', subject.pipe(rxjs.take(0)), 'subscribe')(() => {});
  assert.equal(lineage(probe).status, 'unsupported'); assert.equal(lineage(probe).membership, null);
  subject.complete(); probe.prepare('s', subject, 'subscribe')(() => {});
  assert.equal(lineage(probe).status, 'unconfirmed');
});
test('multiple-source operators expose primary scope and never certify all branch cleanup', () => {
  const probe = observer(), primary = new rxjs.Subject(), secondary = new rxjs.Subject(), values = [];
  const sub = probe.prepare('s', primary.pipe(rxjs.withLatestFrom(secondary)), 'subscribe')(value => values.push(value));
  const result = lineage(probe);
  assert.equal(result.status, 'observed'); assert.equal(result.scope, 'primary-source-only');
  assert.equal(probe.resolve(result.subjectId), primary);
  assert.ok(result.sourceIds.every(id => probe.resolve(id) !== secondary));
  secondary.next('b'); primary.next('a'); assert.deepEqual(values, [['a', 'b']]);
  assert.equal(primary.observers.length, 1); assert.equal(secondary.observers.length, 1); sub.unsubscribe();
  const merged = probe.prepare('s', rxjs.merge(primary, secondary), 'subscribe')(() => {});
  assert.equal(lineage(probe).status, 'unsupported'); assert.equal(lineage(probe).membership, null); merged.unsubscribe();
});
test('zero primary members does not imply an active secondary branch has released', () => {
  const probe = observer(), primary = new rxjs.Subject(), secondary = new rxjs.Subject();
  const sub = probe.prepare('s', primary.pipe(rxjs.concatMap(() => secondary)), 'subscribe')(() => {});
  assert.equal(lineage(probe).status, 'observed'); primary.next(1); primary.complete();
  assert.equal(primary.observers.length, 0); assert.equal(secondary.observers.length, 1); assert.equal(sub.closed, false);
  assert.equal(lineage(probe).scope, 'primary-source-only');
  assert.equal(probe.resolve(lineage(probe).subjectId), primary); sub.unsubscribe();
});
test('custom source decorations cannot manufacture an actual Subject association', () => {
  const probe = observer(), alleged = new rxjs.Subject(), actual = new rxjs.Subject(), custom = new rxjs.Observable();
  custom.source = alleged; custom.operator = function () { actual.subscribe(this); };
  const sub = probe.prepare('s', custom, 'subscribe')(() => {});
  assert.equal(lineage(probe).status, 'unconfirmed'); assert.equal(lineage(probe).reason, 'no-membership-at-subscribe-return');
  assert.equal(alleged.observers.length, 0); assert.equal(actual.observers.length, 1); sub.unsubscribe();
});
test('lineage never evaluates accessors and refuses proxy, custom prototype and source cycles', () => {
  const probe = observer(), source = new rxjs.Subject(), custom = new rxjs.Observable(); let reads = 0;
  Object.defineProperty(custom, 'source', { get() { reads++; return source; } }); custom.operator = function () { this.complete(); };
  probe.prepare('s', custom, 'subscribe')(() => {});
  assert.equal(reads, 1, 'Only the original RxJS subscribe reads the getter');
  assert.equal(lineage(probe).reason, 'lineage-accessor-source');
  const cyclic = new rxjs.Observable(); cyclic.source = cyclic; cyclic.operator = function () { this.complete(); };
  probe.prepare('s', cyclic, 'subscribe')(() => {}); assert.equal(lineage(probe).reason, 'lineage-nonordinary-or-cyclic-source');
  class CustomSubject extends rxjs.Subject {}
  const customSource = new CustomSubject(), customSub = probe.prepare('s', customSource, 'subscribe')(() => {});
  assert.equal(lineage(probe).reason, 'lineage-unsupported-prototype'); customSub.unsubscribe();
  const proxied = new Proxy(source, {}), proxySub = probe.prepare('s', proxied, 'subscribe')(() => {});
  assert.equal(probe.report().events.at(-1).coverage, 'unsupported'); proxySub.unsubscribe();
  assert.throws(() => probe.resolve('o99999'), /unregistered-weak-id/);
});
test('WeakRef lineage does not retain released Subjects; a deliberately pinned Subject remains resolvable', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', '--max-old-space-size=128', fileURLToPath(new URL('../scripts/rxjs-lineage-gc-control.mjs', import.meta.url))], { windowsHide: true, timeout: 10000 });
  const result = JSON.parse(stdout); assert.equal(result.released, 'weak-ref-cleared'); assert.equal(result.pinned, 'resolved'); assert.equal(result.lineage, 'observed');
});
