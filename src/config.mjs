import { readFile, access } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const schemaVersion = '0.1.0';
export const hash = value => createHash('sha256').update(value).digest('hex');

export function validateConfig(input, baseDir = process.cwd()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object');
  const url = new URL(input.url);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('This MVP accepts loopback HTTP(S) targets only');
  }
  if (url.username || url.password) throw new Error('Credentials in URLs are unsupported');
  if (typeof input.scenario !== 'string' || !input.scenario) throw new Error('scenario module path is required');
  const cycles = input.cycles ?? 2;
  const warmupCycles = input.warmupCycles ?? 1;
  const settleMs = input.settleMs ?? 1000;
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 5) throw new Error('cycles must be an integer from 1 to 5');
  if (!Number.isInteger(warmupCycles) || warmupCycles < 1 || warmupCycles > 2) throw new Error('warmupCycles must be 1 or 2');
  if (!Number.isInteger(settleMs) || settleMs < 100 || settleMs > 10000) throw new Error('settleMs must be 100..10000');
  if (input.snapshots !== undefined && typeof input.snapshots !== 'boolean') throw new Error('snapshots must be boolean');
  if (input.roundSnapshots !== undefined && typeof input.roundSnapshots !== 'boolean') throw new Error('roundSnapshots must be boolean');
  return {
    url: url.href,
    scenario: resolve(baseDir, input.scenario),
    repo: input.repo ? resolve(baseDir, input.repo) : null,
    outRoot: resolve(baseDir, input.outRoot ?? '../runs'),
    browserExecutable: input.browserExecutable ?? null,
    buildMode: input.buildMode ?? 'unspecified',
    cycles, warmupCycles, settleMs,
    snapshots: input.snapshots ?? false,
    roundSnapshots: input.roundSnapshots ?? false,
    timeoutMs: 120000,
    viewport: { width: 1280, height: 900 },
    maxSnapshotBytes: 256 * 1024 * 1024,
  };
}

export async function loadConfig(file) {
  const configPath = resolve(file);
  const source = await readFile(configPath);
  const config = validateConfig(JSON.parse(source.toString('utf8')), dirname(configPath));
  return { ...config, configPath, configHash: hash(source) };
}

export function repoInfo(repo) {
  if (!repo) return null;
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  return {
    path: repo,
    sha: git(['rev-parse', 'HEAD']),
    trackedDirty: git(['status', '--porcelain', '--untracked-files=no']) !== '',
    packageVersion: JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')).version,
    pnpmLockfileSha256: existsSync(resolve(repo, 'pnpm-lock.yaml')) ? hash(readFileSync(resolve(repo, 'pnpm-lock.yaml'))) : null,
  };
}

export async function findBrowser(configured) {
  const paths = configured ? [configured] : [
    process.env.MEMORY_LAB_CHROME,
    process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : null,
    process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : null,
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const path of paths) {
    try { await access(path); return resolve(path); } catch { /* try the next installed browser */ }
  }
  throw new Error('No installed Chromium browser found; set browserExecutable or MEMORY_LAB_CHROME');
}
