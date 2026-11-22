import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { incomingLimits } from './incoming-index.mjs';

export async function runIncomingCommand(snapshot, nodeId, outputParent) {
  const output = resolve(outputParent, 'incoming-' + Date.now() + '-' + randomUUID().slice(0, 8));
  await mkdir(output, { recursive: true });
  const resultPath = join(output, 'incoming.json'), logPath = join(output, 'worker.log');
  const args = ['--max-old-space-size=512', fileURLToPath(new URL('./incoming-worker.mjs', import.meta.url)), resolve(snapshot), String(nodeId), resultPath];
  const log = createWriteStream(logPath, { flags: 'wx' }), started = performance.now();
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false, spawnError = null;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, incomingLimits.timeoutMs);
  let exitCode;
  try { exitCode = await new Promise(res => { child.once('error', e => { spawnError = e.message; }); child.once('close', res); }); }
  finally { clearTimeout(timer); await new Promise(res => log.end(res)); }
  let report = null; try { report = JSON.parse(await readFile(resultPath, 'utf8')); } catch {}
  const result = { schemaVersion: '0.1.0', status: !timedOut && exitCode === 0 && report?.status === 'completed' ? 'completed' : 'failed', output, resultPath: report ? resultPath : null, logPath, exitCode, timedOut, elapsedMs: performance.now() - started, limits: incomingLimits, incomingCount: report?.evidence?.incomingCount ?? null, error: report?.error ?? (timedOut ? { code: 'worker-deadline', message: '30 s worker deadline exceeded' } : spawnError ? { code: 'spawn-error', message: spawnError } : !report ? { code: 'worker-no-report', message: 'Worker ended without a readable report' } : null), invocation: { executable: process.execPath, args } };
  await writeFile(join(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
