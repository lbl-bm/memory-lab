import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export async function runGrowthCommand(runDir) {
  runDir = resolve(runDir);
  const output = resolve(runDir, 'growth-' + Date.now() + '-' + randomUUID().slice(0, 8));
  await mkdir(output); // Do not overwrite prior analysis or raw data.
  const args = ['--expose-gc', '--max-old-space-size=512', fileURLToPath(new URL('./growth-worker.mjs', import.meta.url)), runDir, output];
  const logPath = resolve(output, 'worker.log');
  const log = createWriteStream(logPath, { flags: 'wx' });
  const started = performance.now();
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
  let exitCode;
  try { exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
  finally { clearTimeout(timeout); await new Promise(resolve => log.end(resolve)); }
  let result = null;
  if (exitCode === 0 && !timedOut) result = JSON.parse(await readFile(resolve(output, 'growth.json'), 'utf8'));
  const analysis = { schemaVersion: '0.1.0', status: result ? 'completed' : 'failed', method: 'cross-round object count growth', runDir, output, logPath, resultPath: result ? resolve(output, 'growth.json') : null, exitCode, timedOut, elapsedMs: performance.now() - started, maxOldSpaceMiB: 512, candidateCount: result?.candidateCount ?? null, unresolvedCandidateCount: result?.unresolvedCandidateCount ?? null, conclusion: { status: 'requires-review', reason: 'No automatic leak, source-location or repair verdict.' } };
  await writeFile(resolve(output, 'analysis.json'), JSON.stringify(analysis, null, 2) + '\n', { flag: 'wx' });
  return analysis;
}
