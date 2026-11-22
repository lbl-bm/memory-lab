import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { prepareProjectRegression, selectRegistration } from '../src/regression-input.mjs';
import { sha256 } from '../src/heap-identity.mjs';

test('project registration selection uses original file and line, refusing ambiguous source matches', () => {
  const site = { id: 'registration', filename: '../../src/panel.ts', line: 17, operation: 'subscribe' };
  assert.equal(selectRegistration({ sites: [site] }, { file: 'src/panel.ts', line: 17 }), site.id);
  assert.throws(() => selectRegistration({ sites: [site] }, { file: 'panel.ts', line: 18 }), /found 0/);
  assert.throws(() => selectRegistration({ sites: [site, { ...site, filename: 'other/panel.ts' }] }, { file: 'panel.ts', line: 17 }), /found 2/);
  assert.throws(() => selectRegistration({ sites: [{ ...site, operation: 'unsubscribe' }] }, { file: 'panel.ts', line: 17 }), /found 0/);
});

test('project rules create usable series without manual hashes and never infer settled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-lab-project-rules-'));
  try {
    const save = async (name, data) => { const path = join(directory, name); await writeFile(path, JSON.stringify(data)); return path; };
    const scenario = await save('scenario.json', {}), config = await save('config.json', { scenario });
    const registry = await save('registry.json', { sites: [{ id: 'source-site', filename: 'src/panel.ts', line: 17, operation: 'subscribe' }] });
    const capture = await save('capture.json', { artifacts: { registry: { path: registry } } });
    const run = { status: 'completed', configPath: config, build: { entrySha256: 'a'.repeat(64), bundleSha256: 'bundle' }, scenario: { id: 'mount' }, points: [{ phase: 'back', cycle: 1, capture: { path: capture, sha256: 'capture' } }, { phase: 'followup', cycle: 1, capture: { path: capture, sha256: 'capture' } }] };
    const before = await save('before.json', run), after = await save('after.json', run);
    const rules = { schemaVersion: '0.1.0', statement: 'Unmount clears panel observers.', rules: [{ id: 'panel', expectation: 'bounded-after-back', maxEntries: 0, before: { file: 'panel.ts', line: 17 }, after: { file: 'panel.ts', line: 17 } }] };
    const rulesPath = await save('rules.json', rules);
    const first = await prepareProjectRegression(before, after, rulesPath, directory);
    const series = JSON.parse(await readFile(first.after, 'utf8')), contract = JSON.parse(await readFile(first.contract, 'utf8'));
    assert.equal(series.contractSha256, sha256(await readFile(first.contract)));
    assert.deepEqual(series.bindings, { panel: ['source-site'] });
    assert.equal(series.points.at(-1).phase, 'settled');
    assert.equal(series.points.at(-1).settled, false);
    assert.equal(contract.rules[0].metric, 'subject-observer-count');
    rules.settle = { confirmed: true, statement: 'The scenario has awaited the cleanup promise.' }; await save('rules.json', rules);
    const second = await prepareProjectRegression(before, after, rulesPath, directory);
    assert.equal(JSON.parse(await readFile(second.after, 'utf8')).points.at(-1).settled, true);
    await save('after.json', { ...run, build: { ...run.build, entrySha256: 'b'.repeat(64) } });
    await assert.rejects(prepareProjectRegression(before, after, rulesPath, directory), /Entry changed/);
  } finally {
    const actual = await realpath(directory);
    assert.equal(dirname(actual).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(actual).startsWith('memory-lab-project-rules-'));
    await rm(actual, { recursive: true, force: true });
  }
});
