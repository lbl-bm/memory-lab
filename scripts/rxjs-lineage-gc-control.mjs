import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import rxjs from 'rxjs';
import { createRxjsObserver } from '../src/rxjs-observer.mjs';

assert.equal(typeof globalThis.gc, 'function', 'Run with --expose-gc');
const probe = createRxjsObserver({ rxjs, version: '7.8.1', epochId: 'gc-control',
  registry: { sites: [{ id: 's', operation: 'subscribe' }] } });
function observablySubscribe(subject) {
  const subscription = probe.prepare('s', subject.pipe(rxjs.map(x => x)), 'subscribe')(() => {});
  const lineage = probe.report().events.at(-1).sourceLineage;
  assert.equal(lineage.status, 'observed');
  assert.equal(probe.resolve(lineage.subjectId), subject);
  subscription.unsubscribe();
  assert.equal(subject.observers.length, 0);
  return lineage.subjectId;
}
const releasedId = observablySubscribe(new rxjs.Subject());
const pinned = new rxjs.Subject();
const pinnedId = observablySubscribe(pinned);
let released = false;
for (let i = 0; i < 30; i++) {
  // Deref extends liveness through the current job. Cross a turn before GC.
  await nextTurn();
  globalThis.gc();
  if (probe.resolve(releasedId) === undefined) { released = true; break; }
}
assert.equal(probe.resolve(pinnedId), pinned);
assert.ok(released, 'Released Subject remained resolvable after 30 GC opportunities');
process.stdout.write(JSON.stringify({ released: 'weak-ref-cleared', pinned: 'resolved', lineage: 'observed' }) + '\n');
