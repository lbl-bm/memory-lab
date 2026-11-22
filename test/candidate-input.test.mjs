import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers/incoming-oracle.mjs';
import { prepareResourceCandidateSeries } from '../src/candidate-input.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'candidate-input-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const points = [], runtime = { epochId: 'epoch', targetId: 'target', frameId: 'frame', scriptId: 'script' };
  for (let stage = 0; stage < 5; stage++) {
    const heap = stage + '.heapsnapshot', capturePath = stage + '-capture.json', nodes = [{ id: 1, name: 'root', type: 'synthetic' }], edges = [];
    for (let i = 1; i <= Math.min(stage, 3); i++) { nodes.push({ id: i * 2 + 1, name: 'Business' }); edges.push({ from: 1, to: i * 2 + 1, type: 'property', name: 'business' + i }); }
    await writeFile(join(dir, heap), JSON.stringify(fixture(nodes, edges)));
    await writeFile(join(dir, capturePath), JSON.stringify({ adapter: 'browser-resources-heap', status: 'captured', bridge: { handlesReleased: true }, runtime, artifacts: { snapshot: { path: heap } } }));
    points.push({ mode: 'instrumented', case: 'scenario', phase: stage === 0 ? 'baseline' : stage === 4 ? 'followup-3' : 'back-' + stage, heap: { status: 'incomplete', capturePath, snapshot: { path: heap } } });
  }
  const report = { capability: 'browser-resource-lifecycle-source-evidence', status: 'incomplete', points }, path = join(dir, 'browser-resources.json');
  await writeFile(path, JSON.stringify(report)); return { dir, path, report };
}

test('public candidates CLI prepares a resource case without requiring a handwritten series', async t => {
  const { dir, path } = await setup(t);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'candidates', '--resource-run', path, '--case', 'scenario', '--root-ids', '1', '--output', dir], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout); assert.equal(result.selectedInstanceCount, 3); assert.equal(result.projectInputs.captureStatus, 'incomplete');
  const series = JSON.parse(await readFile(result.projectInputs.seriesPath)); assert.deepEqual(series.points.map(point => point.phase), ['baseline', 'back', 'back', 'back', 'followup']);
  assert.equal(series.identity.epochId, 'epoch');
});

test('resource preparation refuses missing baseline and different page contexts', async t => {
  const { dir, path, report } = await setup(t);
  await assert.rejects(prepareResourceCandidateSeries(path, 'absent', [1], dir), /checkpoints/);
  const first = report.points.shift(); await writeFile(path, JSON.stringify(report));
  await assert.rejects(prepareResourceCandidateSeries(path, 'scenario', [1], dir), /baseline/);
  report.points.unshift(first); await writeFile(path, JSON.stringify(report));
  const last = join(dir, report.points.at(-1).heap.capturePath), capture = JSON.parse(await readFile(last)); capture.runtime.targetId = 'other-page'; await writeFile(last, JSON.stringify(capture));
  await assert.rejects(prepareResourceCandidateSeries(path, 'scenario', [1], dir), /one page/);
});

test('resource candidates select back checkpoints while retaining target phase provenance', async t => {
  const { dir, path, report } = await setup(t);
  report.points = report.points.flatMap(point => point.phase.startsWith('back-') ? [{ ...point, phase: point.phase.replace('back-', 'target-') }, point] : [point]);
  await writeFile(path, JSON.stringify(report));
  const prepared = await prepareResourceCandidateSeries(path, 'scenario', [1], dir);
  const series = JSON.parse(await readFile(prepared.seriesPath));
  assert.deepEqual(series.points.map(point => [point.phase, point.cycle]), [['baseline', 0], ['back', 1], ['back', 2], ['back', 3], ['followup', 3]]);
  assert.deepEqual(prepared.excludedTargetPhases, ['target-1', 'target-2', 'target-3']);
  // Even excluded target points must come from the same page. A mixed report is not a same-isolate series.
  const targetCapture = JSON.parse(await readFile(join(dir, '1-capture.json')));
  targetCapture.runtime.targetId = 'other-page';
  await writeFile(join(dir, 'target-capture.json'), JSON.stringify(targetCapture));
  report.points[1].heap = { ...report.points[1].heap, capturePath: 'target-capture.json' };
  await writeFile(path, JSON.stringify(report));
  await assert.rejects(prepareResourceCandidateSeries(path, 'scenario', [1], dir), /one page/);
});

test('resource candidate preparation still rejects unknown phase names', async t => {
  const { dir, path, report } = await setup(t);
  report.points.splice(1, 0, { ...report.points[1], phase: 'target-one' });
  await writeFile(path, JSON.stringify(report));
  await assert.rejects(prepareResourceCandidateSeries(path, 'scenario', [1], dir), /phases/);
});
