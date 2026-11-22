import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectVerificationConfig, runProjectVerification } from '../src/project-verification.mjs';

test('project paths resolve beside config and malformed projects retain a failed report', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'memory-lab-project-'))), path = join(root, 'project.json');
  try {
    await writeFile(path, JSON.stringify({ schemaVersion: '0.1.0', before: 'before.json', after: 'after.json', rules: 'rules.json' }));
    const config = await loadProjectVerificationConfig(path);
    assert.equal(config.before, join(root, 'before.json')); assert.equal(config.rules, join(root, 'rules.json'));
    await writeFile(path, JSON.stringify({ schemaVersion: '0.1.0', before: 'before.json', after: '', rules: 'rules.json' }));
    const result = await runProjectVerification(path, root);
    assert.equal(result.status, 'failed'); assert.equal(result.gate, null); assert.deepEqual(result.steps, []);
    assert.match(result.error.message, /requires schemaVersion/); assert.equal(JSON.parse(await readFile(result.resultPath, 'utf8')).status, 'failed');
  } finally { assert.equal(dirname(root).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(root).startsWith('memory-lab-project-')); await rm(root, { recursive: true, force: true }); }
});
