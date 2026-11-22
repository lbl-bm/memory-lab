import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export async function runResourceHeapCommand(capturePath, outputParent) {
  const output = resolve(outputParent, 'resource-heap-' + Date.now() + '-' + randomUUID().slice(0, 8)); await mkdir(output, { recursive: true });
  const resultPath = resolve(output, 'resource-heap.json'), logPath = resolve(output, 'worker.log'), args = ['--max-old-space-size=512', fileURLToPath(new URL('./resource-heap-worker.mjs', import.meta.url)), resolve(capturePath), resultPath];
  const log = createWriteStream(logPath, { flags: 'wx' }), child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false, spawnError; const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  let exitCode; try { exitCode = await new Promise(done => { child.once('error', error => { spawnError = error.message; }); child.once('close', done); }); } finally { clearTimeout(timer); await new Promise(done => log.end(done)); }
  let report; try { report = JSON.parse(await readFile(resultPath)); } catch {}
  const status = !timedOut && !spawnError && ((exitCode === 0 && report?.status === 'completed') || (exitCode === 2 && report?.status === 'incomplete')) ? report.status : 'failed';
  const result = { status, output, resultPath: report ? resultPath : null, logPath, capturePath: resolve(capturePath), timedOut, exitCode, summary: report?.summary ?? null, error: report?.error ?? (spawnError ? { message: spawnError } : timedOut ? { message: 'resource-heap-deadline' } : null) };
  await writeFile(resolve(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
