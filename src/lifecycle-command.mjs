import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
export async function runLifecycleCommand(runDir, identityPath = null, contractPath = null) {
  const output = resolve(runDir, 'lifecycle-' + Date.now() + '-' + randomUUID().slice(0, 8)); await mkdir(output);
  const args = ['--expose-gc', '--max-old-space-size=512', fileURLToPath(new URL('./lifecycle-worker.mjs', import.meta.url)), resolve(runDir), identityPath ? resolve(identityPath) : '', contractPath ? resolve(contractPath) : '', output];
  const logPath = resolve(output, 'worker.log'), log = createWriteStream(logPath, { flags: 'wx' });
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  let exitCode; try { exitCode = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); }); }
  finally { clearTimeout(timer); await new Promise(res => log.end(res)); }
  let report = null; try { report = JSON.parse(await readFile(resolve(output, 'lifecycle.json'), 'utf8')); } catch {}
  const result = { schemaVersion: '0.1.0', status: timedOut ? 'failed' : report?.status ?? 'failed', resultPath: report ? resolve(output, 'lifecycle.json') : null, markdownPath: report ? resolve(output, 'lifecycle.md') : null, output, logPath, exitCode, timedOut, identity: report?.identity.status ?? null, assessment: report?.assessment.verdict ?? null };
  await writeFile(resolve(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
