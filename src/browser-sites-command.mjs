import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export function runBrowserSitesCommand(configPath, options) {
  return runBrowserCaptureCommand(configPath, './browser-sites-worker.mjs', 'browser-sites.json', options);
}

export async function runBrowserCaptureCommand(configPath, workerFile, reportName, { deadlineMs = 180000 } = {}) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 180000) throw Error('invalid-capture-deadline');
  configPath = resolve(configPath); const config = JSON.parse(await readFile(configPath, 'utf8'));
  const output = resolve(dirname(configPath), config.outRoot ?? 'browser-sites-runs', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
  await mkdir(output, { recursive: true });
  const args = ['--max-old-space-size=512', fileURLToPath(new URL(workerFile, import.meta.url)), configPath, output], logPath = resolve(output, 'worker.log');
  const log = createWriteStream(logPath, { flags: 'wx' }), child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, detached: process.platform !== 'win32' }); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false, spawnError = null, forceTimer, forceCompletion;
  const cleanup = { gracefulStopRequested: false, forcedProcessTreeStop: false };
  const timer = setTimeout(() => {
    timedOut = true; cleanup.gracefulStopRequested = true;
    if (child.connected) child.send({ type: 'abort-capture', reason: 'worker-deadline' }, () => {});
    forceTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      cleanup.forcedProcessTreeStop = true;
      if (process.platform === 'win32') forceCompletion = new Promise(done => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => { cleanup.forceError = error?.message ?? null; done(); }));
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { cleanup.forceError = error.message; } }
    }, 5000);
  }, deadlineMs);
  let exitCode; try { exitCode = await new Promise(done => { child.once('error', error => { spawnError = error.message; }); child.once('close', done); }); } finally { clearTimeout(timer); clearTimeout(forceTimer); await forceCompletion; await new Promise(done => log.end(done)); }
  let report = null; try { report = JSON.parse(await readFile(resolve(output, reportName), 'utf8')); } catch {}
  const result = { schemaVersion: '0.1.0', status: !timedOut && exitCode === 0 && report?.status === 'completed' ? 'completed' : !timedOut && exitCode === 2 && report?.status === 'incomplete' ? 'incomplete' : 'failed', output, reportPath: report ? resolve(output, reportName) : null, logPath, exitCode, timedOut, cleanup, error: spawnError, points: report?.points ?? [], invocation: { executable: process.execPath, args, deadlineMs } };
  await writeFile(resolve(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
