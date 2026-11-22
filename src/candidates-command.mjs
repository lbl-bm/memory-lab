import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { candidateLimits } from './candidates.mjs';

export async function runCandidatesCommand(series, outputParent) {
  const output = resolve(outputParent, 'candidates-' + Date.now() + '-' + randomUUID().slice(0, 8)); await mkdir(output, { recursive: true });
  const resultPath = join(output, 'candidates.json'), markdownPath = join(output, 'candidates.md'), logPath = join(output, 'worker.log');
  const args = ['--expose-gc', '--max-old-space-size=512', fileURLToPath(new URL('./candidates-worker.mjs', import.meta.url)), resolve(series), resultPath, markdownPath];
  const log = createWriteStream(logPath, { flags: 'wx' }), started = performance.now();
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false, spawnError = null;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, candidateLimits.timeoutMs);
  let exitCode;
  try { exitCode = await new Promise(done => { child.once('error', error => { spawnError = error.message; }); child.once('close', done); }); }
  finally { clearTimeout(timer); await new Promise(done => log.end(done)); }
  let report = null; try { report = JSON.parse(await readFile(resultPath, 'utf8')); } catch {}
  const consistent = !timedOut && !spawnError && ((exitCode === 0 && report?.status === 'completed') || (exitCode === 2 && report?.status === 'incomplete'));
  const result = { schemaVersion: '0.1.0', status: consistent ? report.status : 'failed', output, resultPath: report ? resultPath : null, markdownPath: report ? markdownPath : null, logPath, exitCode, timedOut,
    candidateGroupCount: report?.candidateGroupCount ?? null, selectedInstanceCount: report?.selectedInstanceCount ?? null, completeness: report?.completeness ?? null,
    resources: report?.resources ?? null, elapsedMs: performance.now() - started, limits: candidateLimits,
    probeAccounting: report?.probeAccounting ? { applied: report.probeAccounting.applied, completeWithinDeclaredSlots: report.probeAccounting.completeWithinDeclaredSlots, rawCandidateGroupCount: report.probeAccounting.rawCandidateGroupCount, excludedObjectCounts: report.probeAccounting.points.map(point => point.excludedObjectCount) } : null,
    error: report?.error ?? (timedOut ? { code: 'worker-deadline', message: 'Candidate worker exceeded 60 s' } : spawnError ? { code: 'spawn-error', message: spawnError } : !consistent ? { code: 'worker-no-result', message: 'Worker did not return a consistent result' } : null) };
  await writeFile(join(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
