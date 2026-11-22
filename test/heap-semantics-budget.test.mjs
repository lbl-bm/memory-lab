import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers/incoming-oracle.mjs';
import { createHeapSemantics } from '../src/heap-semantics.mjs';
import { runHeapSemanticsCommand } from '../src/heap-semantics-command.mjs';

const options = { v8Version: '15.7.112.23', rootIds: [1], nodeIds: [1] };
test('semantics worker enforces deadline, explicit cancellation, input budget and success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'semantics-budget-'));
  try {
    const input = join(dir, 'tiny.heapsnapshot'); await writeFile(input, JSON.stringify(fixture([{ id: 1, name: 'root' }], [])));
    const success = await runHeapSemanticsCommand(input, dir, options); assert.equal(success.status, 'completed');
    const deadline = await runHeapSemanticsCommand(input, dir, options, { timeoutMs: 1 });
    assert.equal(deadline.status, 'failed'); assert.equal(deadline.error.code, 'worker-deadline'); assert.equal(deadline.timedOut, true);
    assert.throws(() => process.kill(deadline.workerPid, 0), error => error.code === 'ESRCH');
    const controller = new AbortController(); controller.abort();
    const cancelled = await runHeapSemanticsCommand(input, dir, options, { signal: controller.signal });
    assert.equal(cancelled.status, 'failed'); assert.equal(cancelled.error.code, 'worker-cancelled'); assert.equal(cancelled.workerPid, null);
    const active = new AbortController(), pending = runHeapSemanticsCommand(input, dir, options, { signal: active.signal });
    setTimeout(() => active.abort(), 5); const stopped = await pending;
    assert.equal(stopped.error.code, 'worker-cancelled');
    if (stopped.workerPid !== null) assert.throws(() => process.kill(stopped.workerPid, 0), error => error.code === 'ESRCH');
    const huge = join(dir, 'oversized.heapsnapshot'), fd = await open(huge, 'wx'); await fd.truncate(64 * 1024 ** 2 + 1); await fd.close();
    const refused = await runHeapSemanticsCommand(huge, dir, options); assert.equal(refused.status, 'failed'); assert.equal(refused.error.message, 'input-size-budget');
    await assert.rejects(() => runHeapSemanticsCommand(input, dir, options, { timeoutMs: 60001 }), RangeError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('graph budget is checked before building an index', () => {
  // Sparse arrays intentionally cannot be decoded; budget refusal must precede indexing.
  const nodes = fixture([{ id: 1, name: 'root' }], []); nodes.nodes.length = 1000001 * 5;
  assert.throws(() => createHeapSemantics(nodes, options), error => error.code === 'semantics-graph-budget');
  const edges = fixture([{ id: 1, name: 'root' }], []); edges.edges.length = 5000001 * 3;
  assert.throws(() => createHeapSemantics(edges, options), error => error.code === 'semantics-graph-budget');
});
