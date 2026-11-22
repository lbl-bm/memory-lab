import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers/incoming-oracle.mjs';

test('source position truncation alone makes the public candidates command incomplete', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'candidate-completeness-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const points = [];
  for (let stage = 0; stage < 5; stage++) {
    // Closures form an existing retaining chain without adding object candidates.
    const nodes = [{ id: 1, type: 'synthetic', name: 'root' }, ...Array.from({ length: 13 }, (_, i) => ({ id: 3 + i * 2, type: 'closure', name: 'holder' + i }))];
    const edges = Array.from({ length: 13 }, (_, i) => ({ from: i ? 1 + i * 2 : 1, to: 3 + i * 2, type: 'property', name: 'next' }));
    if (stage) { nodes.push({ id: 99, name: 'payload' }); edges.push({ from: 27, to: 99, type: 'property', name: 'payload' }); }
    const heap = fixture(nodes, edges), width = heap.snapshot.meta.node_fields.length;
    for (let i = 1; i < nodes.length; i++) heap.locations.push(i * width, 42, i, 0);
    const path = join(dir, stage + '.heapsnapshot');
    await writeFile(path, JSON.stringify(heap));
    points.push({ path, phase: stage === 0 ? 'baseline' : stage === 4 ? 'followup' : 'back', cycle: Math.min(stage, 3) });
  }
  const path = join(dir, 'series.json');
  await writeFile(path, JSON.stringify({ schemaVersion: '0.1.0', identity: { kind: 'same-isolate', asserted: true, statement: 'Deterministic fixture retains one new object through the same holder chain.' }, rootIds: [1], points }));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'candidates', '--series', path, '--output', dir], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const command = JSON.parse(run.stdout), result = JSON.parse(await readFile(command.resultPath, 'utf8'));
  assert.equal(result.candidateGroupCount, 1); assert.equal(result.selectedInstanceCount, 1);
  assert.equal(result.omittedGroupCount, 0); assert.equal(result.omittedInstanceCount, 0);
  assert.equal(result.completeness.selectionTruncated, false); assert.equal(result.completeness.pathIncompleteCount, 0);
  assert.notEqual(result.graphSummary.status, 'incomplete');
  assert.equal(result.groups[0].instances[0].path.outcome, 'path-found');
  assert.equal(result.groups[0].instances[0].path.path.edgeCount, 14);
  assert.equal(result.sourceMapping.coverage.indexedLocations, 14);
  assert.equal(result.sourceMapping.coverage.emittedPositions, 12); assert.equal(result.sourceMapping.coverage.omittedPositions, 2);
  assert.equal(result.sourceMapping.status, 'incomplete');
  assert.equal(run.status, 2, run.stderr || run.stdout);
  assert.equal(command.status, 'incomplete'); assert.equal(result.status, 'incomplete');
  assert.equal(result.completeness.sourcePositionsTruncated, true);
  assert.match(await readFile(command.markdownPath, 'utf8'), /分析状态：incomplete/);
});
