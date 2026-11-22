import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dominatorLimits } from './dominator.mjs';

export async function runDominatorCommand(snapshot, outputParent, options) {
  const output = resolve(outputParent, 'dominators-' + Date.now() + '-' + randomUUID().slice(0, 8)); await mkdir(output, { recursive: true });
  const resultPath = join(output, 'dominators.json'), logPath = join(output, 'worker.log');
  const args = ['--max-old-space-size=512', fileURLToPath(new URL('./dominator-worker.mjs', import.meta.url)), resolve(snapshot), JSON.stringify(options), resultPath];
  const log = createWriteStream(logPath, { flags: 'wx' }), started = performance.now();
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false, spawnError = null;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, dominatorLimits.timeoutMs);
  let exitCode;
  try { exitCode = await new Promise(done => { child.once('error', error => { spawnError = error.message; }); child.once('close', done); }); }
  finally { clearTimeout(timer); await new Promise(done => log.end(done)); }
  let report = null; try { report = JSON.parse(await readFile(resultPath, 'utf8')); } catch {}
  const status = !timedOut && !spawnError && exitCode === 0 && report?.status === 'completed' ? 'completed' : 'failed';
  const result = { schemaVersion: '0.1.0', status, output, resultPath: report ? resultPath : null, logPath, exitCode, timedOut, elapsedMs: performance.now() - started, limits: dominatorLimits,
    reachableNodeCount: report?.evidence?.summary?.reachableNodeCount ?? null, reachableShallowBytes: report?.evidence?.summary?.reachableShallowBytes ?? null,
    error: report?.error ?? (timedOut ? { code: 'worker-deadline', message: 'Dominator worker exceeded 60 s' } : spawnError ? { code: 'spawn-error', message: spawnError } : status === 'failed' ? { code: 'worker-no-success', message: 'Worker did not return a consistent success report' } : null), invocation: { executable: process.execPath, args } };
  await writeFile(join(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
