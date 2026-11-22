import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers/incoming-oracle.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
test('dominators CLI preserves shared ownership and union-removal counts through its worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-lab-cli-dominators-'));
  try {
    const nodes = [1, 3, 5, 7, 9].map(id => ({ id, name: 'node-' + id }));
    const edges = [[1, 3], [1, 5], [3, 7], [5, 7], [7, 9]].map(([from, to]) => ({ from, to, type: 'property', name: 'ref' }));
    const snapshot = join(directory, 'diamond.heapsnapshot');
    await writeFile(snapshot, JSON.stringify(fixture(nodes, edges)));
    const result = spawnSync(process.execPath, [cli, 'dominators', '--snapshot', snapshot, '--root-ids', '1', '--node-ids', '3,5,7', '--cut-ids', '3,5', '--top', '2', '--output', directory], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const response = JSON.parse(result.stdout), report = JSON.parse(await readFile(response.resultPath, 'utf8'));
    assert.equal(response.status, 'completed');
    assert.deepEqual(report.evidence.nodes.map(node => node.retainedBytes), [24, 24, 48]);
    assert.equal(report.evidence.nodes[2].immediateDominator.id, 1);
    assert.equal(report.evidence.removal.newlyUnreachableBytes, 96);
    assert.equal(report.evidence.removal.newlyUnreachableNodeCount, 4);
    assert.equal(report.evidence.summary.policy.gcSemantics, 'not-established');
  } finally {
    const actual = await realpath(directory);
    assert.equal(dirname(actual).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(actual).startsWith('memory-lab-cli-dominators-'));
    await rm(actual, { recursive: true, force: true });
  }
});

test('dominators CLI rejects ambiguous and unsafe root IDs before spawning its worker', () => {
  for (const roots of ['1,,2', '-1', '1e3', '9007199254740992']) {
    const result = spawnSync(process.execPath, [cli, 'dominators', '--snapshot', 'missing', '--root-ids', roots, '--output', '.'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error.message, /safe node IDs/);
  }
});
