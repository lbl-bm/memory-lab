import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateCandidateSeries } from './candidates.mjs';

async function json(path, cap) { if ((await stat(path)).size > cap) throw Error('candidate-input-size-budget'); const bytes = await readFile(path); if (bytes.length > cap) throw Error('candidate-input-size-budget'); return JSON.parse(bytes); }

export async function prepareResourceCandidateSeries(reportPath, caseName, rootIds, outputParent) {
  reportPath = resolve(reportPath); const report = await json(reportPath, 16 * 1024 ** 2);
  if (report.capability !== 'browser-resource-lifecycle-source-evidence' || !['completed', 'incomplete'].includes(report.status) || !Array.isArray(report.points)) throw Error('Expected a finished browser-resources report');
  const selected = report.points.filter(point => point.mode === 'instrumented' && point.case === caseName);
  if (!selected.length || selected.length > 12) throw Error('Expected 1..12 instrumented checkpoints in the requested case');
  let runtime = null;
  const points = [], excludedTargetPhases = [];
  for (const point of selected) {
    if (!point.heap?.capturePath || !point.heap.snapshot?.path || !['completed', 'incomplete'].includes(point.heap.status)) throw Error('Every candidate checkpoint requires usable raw heap evidence');
    const capturePath = resolve(dirname(reportPath), point.heap.capturePath), capture = await json(capturePath, 1024 ** 2);
    if (capture.adapter !== 'browser-resources-heap' || capture.status !== 'captured' || capture.bridge?.handlesReleased !== true || ['epochId', 'targetId', 'frameId', 'scriptId'].some(key => typeof capture.runtime?.[key] !== 'string' || !capture.runtime[key])) throw Error('Candidate capture lacks same-page identity evidence');
    if (runtime && ['epochId', 'targetId', 'frameId', 'scriptId'].some(key => capture.runtime[key] !== runtime[key])) throw Error('Candidate checkpoints must share one page epoch, target, frame and script');
    runtime = capture.runtime;
    const match = /^(target|back|followup)-([1-9][0-9]*)$/.exec(point.phase);
    if (point.phase !== 'baseline' && !match) throw Error('Candidate checkpoints must use baseline, optional target-N, back-N and optional followup-N phases');
    // Mounted targets are useful to three-snapshot analyzers, but growth compares route exits.
    // Validate their capture context above before excluding them from the back series.
    if (match?.[1] === 'target') { excludedTargetPhases.push(point.phase); continue; }
    points.push({ phase: match?.[1] ?? 'baseline', cycle: match ? Number(match[2]) : 0,
      path: resolve(dirname(capturePath), capture.artifacts.snapshot.path),
      ...(point.heap.probeAccountingPath ? { probeAccountingPath: resolve(dirname(capturePath), point.heap.probeAccountingPath) } : {}) });
  }
  const series = { schemaVersion: '0.1.0', identity: { kind: 'same-isolate', asserted: true, statement: 'Resource collector reports one unchanged page epoch, target, frame and script with Inspector handles released. This preparation trusts that collector declaration.', epochId: runtime.epochId }, rootIds, points };
  validateCandidateSeries(series);
  const output = resolve(outputParent, 'candidate-input-' + Date.now() + '-' + randomUUID().slice(0, 8)); await mkdir(output, { recursive: true });
  const seriesPath = resolve(output, 'series.json'); await writeFile(seriesPath, JSON.stringify(series, null, 2) + '\n', { flag: 'wx' });
  return { seriesPath, sourceReport: reportPath, case: caseName, captureStatus: report.status, runtime, excludedTargetPhases };
}
