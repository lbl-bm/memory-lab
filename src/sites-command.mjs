import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export async function runSitesCommand(capture, outputParent, nodeId = null) {
  const output = resolve(outputParent, 'sites-' + Date.now() + '-' + randomUUID().slice(0, 8)); await mkdir(output, { recursive: true });
  const resultPath = join(output, 'sites.json'), markdownPath = join(output, 'sites.md'), logPath = join(output, 'worker.log');
  const args = ['--max-old-space-size=512', fileURLToPath(new URL('./sites-worker.mjs', import.meta.url)), resolve(capture), nodeId === null ? '' : String(nodeId), resultPath, markdownPath];
  const log = createWriteStream(logPath, { flags: 'wx' }), child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false, spawnError = null;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  let exitCode;
  try { exitCode = await new Promise(done => { child.once('error', error => { spawnError = error.message; }); child.once('close', done); }); }
  finally { clearTimeout(timer); await new Promise(done => log.end(done)); }
  let report = null; try { report = JSON.parse(await readFile(resultPath, 'utf8')); } catch {}
  const status = !timedOut && !spawnError && ((exitCode === 0 && report?.status === 'completed') || (exitCode === 2 && report?.status === 'incomplete')) ? report.status : 'failed';
  const result = { schemaVersion: '0.1.0', status, output, resultPath: report ? resultPath : null, markdownPath: report ? markdownPath : null, logPath, exitCode, timedOut, summary: report?.summary ?? null, coverage: report?.coverage ?? null, error: report?.error ?? (spawnError ? { message: spawnError } : timedOut ? { message: 'worker-deadline' } : null), invocation: { executable: process.execPath, args } };
  await writeFile(join(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
