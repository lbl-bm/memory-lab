import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { analyzeDominators, dominatorLimits } from './dominator.mjs';

const [snapshot, optionText, outputPath] = process.argv.slice(2), started = performance.now();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let input = { path: resolve(snapshot) }, result;
try {
  const options = JSON.parse(optionText), chunks = []; let size = 0;
  for await (const chunk of createReadStream(input.path)) { size += chunk.length; if (size > dominatorLimits.maxInputBytes) throw Error('input-size-budget'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); input = { ...input, bytes: size, sha256: hash(bytes) };
  const evidence = analyzeDominators(JSON.parse(bytes.toString('utf8')), options);
  result = { schemaVersion: '0.1.0', status: 'completed', capability: 'declared-graph-dominators', input, evidence };
} catch (error) { result = { schemaVersion: '0.1.0', status: 'failed', capability: 'declared-graph-dominators', input, error: { code: error.code ?? 'dominator-worker-error', message: error.message } }; process.exitCode = 1; }
result.tool = { node: process.version, v8: process.versions.v8, dependencies: 'Node built-ins only; no MemLab', hashes: Object.fromEntries(await Promise.all(['dominator.mjs', 'dominator-worker.mjs', 'incoming-index.mjs'].map(async name => [name, hash(await readFile(new URL(name, import.meta.url)))]))) };
result.resources = { elapsedMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS, maxOldSpaceMiB: dominatorLimits.maxOldSpaceMiB };
if (result.resources.maxRssKiB > 768 * 1024) { result.status = 'failed'; result.error = { code: 'dominator-rss-budget', message: 'Worker exceeded 768 MiB measured max RSS' }; process.exitCode = 1; }
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
