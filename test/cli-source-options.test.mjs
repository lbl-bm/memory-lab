import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
test('source CLI forwards all declared native search limits including max-depth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-lab-cli-source-'));
  try {
    const result = spawnSync(process.execPath, [cli, 'source', '--run', directory, '--growth', join(directory, 'missing-growth.json'), '--root-ids', '1', '--max-depth', '4', '--max-nodes', '17', '--max-edges', '99'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const response = JSON.parse(result.stdout);
    // Missing capture data is intentional: verify the public CLI reaches its worker and passes options.
    assert.ok(response.invocation, response.error?.message);
    assert.deepEqual(JSON.parse(response.invocation.args.at(-1)).searchOptions, { rootIds: [1], maxDepth: 4, maxNodes: 17, maxEdges: 99 });
  } finally {
    const actual = await realpath(directory); assert.equal(dirname(actual).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(actual).startsWith('memory-lab-cli-source-')); await rm(actual, { recursive: true, force: true });
  }
});
test('source CLI requires growth when a native depth limit is supplied', () => {
  const result = spawnSync(process.execPath, [cli, 'source', '--run', '.', '--max-depth', '4'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.message, 'Native search options require --growth');
});
