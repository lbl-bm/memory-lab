import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildIncomingIndex, incomingLimits, SnapshotInputError } from './incoming-index.mjs';

const [snapshotPath, idText, outputPath] = process.argv.slice(2);
const start = performance.now();
const digest = data => createHash('sha256').update(data).digest('hex');
let input = { path: resolve(snapshotPath), bytes: null, sha256: null }, result;
try {
  if (!/^(0|[1-9][0-9]*)$/.test(idText) || !Number.isSafeInteger(Number(idText))) throw new SnapshotInputError('invalid-node-id', 'Node ID must be a decimal nonnegative safe integer');
  const info = await stat(input.path);
  if (!info.isFile() || info.size > incomingLimits.maxInputBytes) throw new SnapshotInputError('input-size-budget', 'Expected a regular file of at most 64 MiB');
  const chunks = []; let bytes = 0;
  for await (const chunk of createReadStream(input.path)) {
    bytes += chunk.length;
    if (bytes > incomingLimits.maxInputBytes) throw new SnapshotInputError('input-size-budget', 'Input grew past 64 MiB while reading');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks); input = { ...input, bytes, sha256: digest(raw) };
  let heap; try { heap = JSON.parse(raw.toString('utf8')); } catch { throw new SnapshotInputError('invalid-json', 'Snapshot is not valid JSON'); }
  const index = buildIncomingIndex(heap), evidence = index.incoming(Number(idText));
  result = { schemaVersion: '0.1.0', status: 'completed', capability: 'literal-incoming-references', input, index: index.stats, evidence };
} catch (error) {
  result = { schemaVersion: '0.1.0', status: 'failed', capability: 'literal-incoming-references', input, error: { name: error.name, code: error.code ?? 'worker-error', message: error.message, details: error.details ?? null } }; process.exitCode = 1;
}
result.tool = { node: process.version, v8: process.versions.v8, dependencies: 'Node built-ins only; no MemLab', implementationSha256: digest(await readFile(new URL('./incoming-index.mjs', import.meta.url))), workerSha256: digest(await readFile(new URL(import.meta.url))) };
result.resources = { elapsedMs: performance.now() - start, maxRssKiB: process.resourceUsage().maxRSS, currentRssBytes: process.memoryUsage().rss, maxOldSpaceMiB: incomingLimits.maxOldSpaceMiB, maxInputBytes: incomingLimits.maxInputBytes };
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
