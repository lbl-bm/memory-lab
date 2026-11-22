import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
export async function runEvidenceCommand(runDir, growthPath, identityPath = null) {
  runDir = resolve(runDir); growthPath = resolve(growthPath);
  const output = resolve(runDir, 'evidence-' + Date.now() + '-' + randomUUID().slice(0, 8)); await mkdir(output);
  const args = ['--expose-gc', '--max-old-space-size=768', fileURLToPath(new URL('./evidence-worker.mjs', import.meta.url)), runDir, growthPath, output, identityPath ? resolve(identityPath) : ''];
  const logPath = resolve(output, 'worker.log'), log = createWriteStream(logPath, { flags: 'wx' });
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false; const watchdog = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
  let exitCode; try { exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(watchdog); await new Promise(resolve => log.end(resolve)); }
  let evidence = null;
  if (!timedOut) { try { evidence = JSON.parse(await readFile(resolve(output, 'evidence.json'), 'utf8')); } catch {} }
  const result = { schemaVersion: '0.1.0', status: evidence?.status ?? 'failed', output, logPath, resultPath: evidence ? resolve(output, 'evidence.json') : null, markdownPath: evidence ? resolve(output, 'evidence.md') : null, exitCode, timedOut, maxOldSpaceMiB: 768, candidateCount: evidence?.candidateCount ?? null, tracedInstances: evidence?.traces.filter(t => t.status === 'completed').length ?? 0, conclusion: { leakVerdict: 'not-determined', sourceLocalization: 'not-implemented' } };
  await writeFile(resolve(output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
