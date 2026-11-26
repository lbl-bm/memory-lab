import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const serialize = (path, value) => writeFile(path, JSON.stringify(value));
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const invoke = (...args) => spawnSync(process.execPath, [cli, 'handoff', ...args], { encoding: 'utf8' });

async function fixture(t, status = 'completed') {
  const tmp = await mkdtemp(join(tmpdir(), 'handoff tests '));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const path = join(tmp, 'run-a'), report = join(path, 'report.json');
  await mkdir(path);
  const r = { schemaVersion: '0.1.0', runId: 'run-a', status, progress: { stage: 'test-stage' },
    scenario: { name: 'test-scenario' }, errors: status === 'failed' ? [{ message: 'Browser failed to start' }] : [], artifacts: [] };
  for (const phase of ['baseline', 'target', 'final']) {
    const file = join(path, phase + '.heapsnapshot');
    await writeFile(file, '{}');
    r.artifacts.push({ kind: 'heap-snapshot', phase, path: file, bytes: 2 });
  }
  await serialize(report, r);
  return { tmp, path, report, r };
}

test('engineer receives the same run and evidence as the agent, without recapture or writes', async t => {
  const {path, report} = await fixture(t);
  const before = await readFile(report);
  const result = invoke('--run', path, '--json');
  assert.equal(result.status, 0, result.stdout);
  const h = JSON.parse(result.stdout);
  assert.equal(h.kind, 'memory-lab-handoff');
  assert.equal(h.runId, 'run-a');
  assert.equal(h.status, 'ready-for-analysis');
  assert.deepEqual(h.nextActions[0].argv, [process.execPath, cli, 'analyze', '--run', path, '--final-phase', 'final']);
  const human = invoke('--run', path);
  assert.equal(human.status, 0, human.stdout);
  assert.match(human.stdout, /Next command/);
  for (const file of [h.evidence.report, ...Object.values(h.evidence.snapshots)]) assert.ok(human.stdout.includes(file));
  assert.deepEqual(await readFile(report), before);
});

test('failed capture retains stage and error, but never offers an analyzer or claims a result', async t => {
  const {path} = await fixture(t, 'failed');
  const result = invoke('--run', path, '--json'), h = JSON.parse(result.stdout);
  assert.equal(result.status, 2);
  assert.equal(h.status, 'capture-incomplete');
  assert.equal(h.capture.stage, 'test-stage');
  assert.equal(h.capture.firstError, 'Browser failed to start');
  assert.deepEqual(h.nextActions, []);
  assert.equal(h.conclusion.leak, 'not-determined');
});

test('missing or escaping artifacts do not permit reanalysis', async t => {
  const {tmp,path,report,r} = await fixture(t);
  const outside = join(tmp, 'outside'); await writeFile(outside, '{}');
  const final = r.artifacts.at(-1).path;
  await rm(final); await symlink(outside, final, 'file');
  r.samples = [{phase:'followup'}];
  await serialize(report, r);
  const result = invoke('--run', path, '--json'), h = JSON.parse(result.stdout);
  assert.equal(result.status, 2);
  assert.equal(h.capture.finalPhase, 'followup');
  assert.equal(h.evidence.snapshots.final, undefined);
  assert.equal(h.nextActions.length, 0);
});

test('zero candidates remains unconfirmed; analysis from another run is rejected', async t => {
  const {path} = await fixture(t);
  const workDir = join(path, 'analysis');
  await mkdir(workDir);
  const aPath = join(workDir, 'analysis.json'), candidateFile=join(workDir,'candidates.json');
  await serialize(candidateFile, []);
  const analysis = { schemaVersion:'0.1.0', status:'completed', inputRunId:'run-a', inputFinalPhase:'final',
    engine:{name:'memlab', version:'2.0.6'}, workDir, candidateFile, candidateCount:0 };
  await serialize(aPath, analysis);
  const run = invoke('--run', path, '--analysis', aPath, '--json'), h = JSON.parse(run.stdout);
  assert.equal(run.status, 0, run.stdout);
  assert.equal(h.evidence.analysis.candidateCount, 0);
  assert.equal(h.status, 'review-required');
  assert.equal(h.conclusion.repair, 'not-validated');
  assert.deepEqual(h.nextActions, []);
  await serialize(aPath, {...analysis,inputRunId:'another-run'});
  assert.equal(invoke('--run', path, '--analysis', aPath, '--json').status, 1);
});
