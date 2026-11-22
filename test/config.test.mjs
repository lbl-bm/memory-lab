import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { collectSample, assertSameState, run } from '../src/runner.mjs';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

const good = { url: 'http://127.0.0.1:5173/#docs', scenario: './scenario.mjs' };
test('config bounds cycles and rejects accidental remote or credential-bearing targets', () => {
  assert.equal(validateConfig(good).cycles, 2);
  for (const cycles of [0, 6, 1.5, '2']) assert.throws(() => validateConfig({ ...good, cycles }));
  for (const url of ['https://example.com', 'file:///tmp/a', 'http://user:secret@127.0.0.1', 'http://127.0.0.1.evil.example']) {
    assert.throws(() => validateConfig({ ...good, url }));
  }
  assert.throws(() => validateConfig({ ...good, snapshots: 'false' }));
  assert.equal(validateConfig(good).roundSnapshots, false);
  assert.throws(() => validateConfig({ ...good, roundSnapshots: 'yes' }));
});
test('a changed returned document fails the baseline comparison', () => {
  const before = { documentId: 'doc', textSha256: 'abc' };
  assert.doesNotThrow(() => assertSameState(before, { ...before }));
  assert.throws(() => assertSameState(before, { ...before, textSha256: 'def' }), /does not match/);
});
test('failed runs leave distinct machine-readable reports without overwriting existing evidence', async () => {
  const outRoot = await mkdtemp(join(tmpdir(), 'memory-lab-test-'));
  try {
    const config = validateConfig({ ...good, scenario: join(outRoot, 'missing-scenario.mjs'), outRoot });
    const first = await run(config);
    const original = await readFile(join(first.runDir, 'report.json'), 'utf8');
    const second = await run(config);
    assert.notEqual(first.runDir, second.runDir);
    assert.equal(first.status, 'failed');
    assert.equal(second.status, 'failed');
    assert.equal(first.conclusion.status, 'insufficient-evidence');
    assert.equal(await readFile(join(first.runDir, 'report.json'), 'utf8'), original);
  } finally {
    const resolvedTarget = await realpath(outRoot);
    assert.equal(dirname(resolvedTarget).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(resolvedTarget).startsWith('memory-lab-test-'));
    await rm(resolvedTarget, { recursive: true, force: true });
  }
});
test('measurement awaits both GC passes and propagates failed CDP collection', async () => {
  const commands = [];
  const cdp = { send: async command => { commands.push(command); return command === 'Runtime.getHeapUsage' ? { usedSize: 1234 } : { nodes: 56 }; } };
  const result = await collectSample(cdp, 'back', 2, 0);
  assert.equal(result.heap.usedSize, 1234);
  assert.equal(result.dom.nodes, 56);
  assert.deepEqual(commands, ['HeapProfiler.collectGarbage', 'HeapProfiler.collectGarbage', 'Runtime.getHeapUsage', 'Memory.getDOMCounters']);
  await assert.rejects(collectSample({ send: async () => { throw new Error('CDP disconnected'); } }, 'back', 1, 0), /CDP disconnected/);
});
