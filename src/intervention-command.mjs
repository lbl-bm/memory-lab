import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
export async function runInterventionCommand(runDir, identity = null, scripts = null, contract = null, observations = null) {
  runDir = resolve(runDir); const output = resolve(runDir, 'intervention-' + Date.now() + '-' + randomUUID().slice(0, 8)); await mkdir(output);
  const args = ['--expose-gc', '--max-old-space-size=512', fileURLToPath(new URL('./intervention-worker.mjs', import.meta.url)), runDir, ...[identity, scripts, contract, observations].map(p => p ? resolve(p) : ''), output];
  const logPath = resolve(output, 'worker.log'), log = createWriteStream(logPath, { flags: 'wx' }), child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  let exitCode; try { exitCode = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); }); } finally { clearTimeout(timer); await new Promise(res => log.end(res)); }
  let report = null; try { report = JSON.parse(await readFile(resolve(output, 'intervention.json'), 'utf8')); } catch {}
  const result = { schemaVersion: '0.1.0', status: timedOut ? 'failed' : report?.status ?? 'failed', resultPath: report ? resolve(output, 'intervention.json') : null, markdownPath: report ? resolve(output, 'intervention.md') : null, output, logPath, exitCode, timedOut, observationStatus: report?.observationValidation.status, interventionResult: report?.assessment.intervention.result ?? null };
  await writeFile(resolve(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
