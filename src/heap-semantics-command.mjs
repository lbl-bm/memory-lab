import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { heapSemanticsLimits } from './heap-semantics.mjs';

export async function runHeapSemanticsCommand(snapshot, outputParent, options, { signal, timeoutMs = heapSemanticsLimits.timeoutMs } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > heapSemanticsLimits.timeoutMs) throw new RangeError('timeoutMs must be an integer from 1 to 60000');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  const output = resolve(outputParent, 'semantics-' + Date.now() + '-' + randomUUID().slice(0, 8)); await mkdir(output, { recursive: true });
  const resultPath = join(output, 'semantics.json'), logPath = join(output, 'worker.log');
  const args = ['--max-old-space-size=512', fileURLToPath(new URL('./heap-semantics-worker.mjs', import.meta.url)), resolve(snapshot), JSON.stringify(options), resultPath];
  const log = createWriteStream(logPath, { flags: 'wx' }), started = performance.now();
  let timedOut = false, cancelled = Boolean(signal?.aborted), spawnError = null, exitCode = null, workerPid = null;
  if (!cancelled) {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); workerPid = child.pid;
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    const cancel = () => { cancelled = true; child.kill(); }, timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    // Check again after listener registration so a concurrent abort cannot be missed.
    if (signal?.aborted) cancel();
    try { exitCode = await new Promise(done => { child.once('error', error => { spawnError = error.message; }); child.once('close', done); }); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  await new Promise(done => log.end(done));
  let report = null; try { report = JSON.parse(await readFile(resultPath, 'utf8')); } catch {}
  const status = !timedOut && !cancelled && !spawnError && exitCode === 0 && report?.status === 'completed' ? 'completed' : 'failed';
  const result = { schemaVersion: '0.1.0', status, output, resultPath: report ? resultPath : null, logPath, exitCode, timedOut, cancelled, workerPid, timeoutMs, elapsedMs: performance.now() - started,
    summary: report?.summary ?? null, cutEffect: report?.cutEffect ?? null, literalComparison: report?.literalComparison ?? null,
    error: cancelled ? { code: 'worker-cancelled', message: 'Analysis cancelled; worker has exited' } : timedOut ? { code: 'worker-deadline', message: 'Worker exceeded ' + timeoutMs + ' ms' } : report?.error ?? (spawnError ? { code: 'spawn-error', message: spawnError } : status === 'failed' ? { code: 'worker-no-success', message: 'Worker did not return success' } : null) };
  await writeFile(join(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
