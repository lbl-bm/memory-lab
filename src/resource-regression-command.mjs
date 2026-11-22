import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export async function runResourceRegressionCommand(beforeRun, afterRun, rulesPath, parent) {
  const output = resolve(parent, 'resource-regression-' + Date.now() + '-' + randomUUID().slice(0, 8));
  await mkdir(output, { recursive: true });
  const args = ['--max-old-space-size=512', fileURLToPath(new URL('./resource-regression-worker.mjs', import.meta.url)), resolve(beforeRun), resolve(afterRun), resolve(rulesPath), output];
  const logPath = resolve(output, 'worker.log'), log = createWriteStream(logPath, { flags: 'wx' });
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false, spawnError = null;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  let exitCode;
  try { exitCode = await new Promise(done => { child.once('error', error => { spawnError = error.message; }); child.once('close', done); }); }
  finally { clearTimeout(timer); await new Promise(done => log.end(done)); }
  let report = null;
  const resultPath = resolve(output, 'resource-regression.json');
  try { report = JSON.parse(await readFile(resultPath, 'utf8')); } catch {}
  const valid = !timedOut && !spawnError && ((exitCode === 0 && report?.status === 'completed' && report.gate === 'pass') || (exitCode === 3 && report?.status === 'completed' && report.gate === 'fail') || (exitCode === 2 && report?.status === 'incomplete'));
  const result = { schemaVersion: '0.1.0', status: valid ? report.status : 'failed', output, resultPath: report ? resultPath : null, logPath, exitCode, timedOut, gate: report?.gate ?? 'inconclusive', scopedGate: report?.scopedGate ?? 'inconclusive', error: report?.error ?? (spawnError ? { message: spawnError } : timedOut ? { message: 'worker-deadline' } : null), invocation: { executable: process.execPath, args } };
  await writeFile(resolve(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
