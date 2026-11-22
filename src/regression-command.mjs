import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
export async function runRegressionCommand(before, after, contract, parent) {
  const output = resolve(parent, 'regression-' + Date.now() + '-' + randomUUID().slice(0, 8)); await mkdir(output, { recursive: true });
  const args = ['--expose-gc', '--max-old-space-size=512', fileURLToPath(new URL('./regression-worker.mjs', import.meta.url)), resolve(before), resolve(after), resolve(contract), output];
  const logPath = resolve(output, 'worker.log'), log = createWriteStream(logPath, { flags: 'wx' }), child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); let timedOut = false, spawnError = null;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000); let exitCode;
  try { exitCode = await new Promise(done => { child.once('error', error => { spawnError = error.message; }); child.once('close', done); }); }
  finally { clearTimeout(timer); await new Promise(done => log.end(done)); }
  let report = null; try { report = JSON.parse(await readFile(resolve(output, 'regression.json'), 'utf8')); } catch {}
  const status = !timedOut && !spawnError && ((exitCode === 0 && report?.status === 'completed') || (exitCode === 2 && report?.status === 'incomplete')) ? report.status : 'failed';
  const result = { schemaVersion: '0.1.0', status, output, resultPath: report ? resolve(output, 'regression.json') : null, markdownPath: report ? resolve(output, 'regression.md') : null, logPath, exitCode, timedOut, verdict: report?.conclusion?.verdict ?? null, gate: report?.gate ?? null, error: report?.error ?? (spawnError ? { message: spawnError } : timedOut ? { message: 'worker-deadline' } : null), invocation: { executable: process.execPath, args } };
  await writeFile(resolve(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
