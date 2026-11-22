import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildIncomingIndex, incomingLimits, SnapshotInputError } from './incoming-index.mjs';
import { searchReversePaths } from './reverse-paths.mjs';
const [snapshot, idText, optionText, outputPath] = process.argv.slice(2), start = performance.now();
const digest = b => createHash('sha256').update(b).digest('hex');
function decimal(value) { if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new SnapshotInputError('invalid-node-id', 'Expected a decimal nonnegative safe integer'); return Number(value); }
let input = { path: resolve(snapshot), bytes: null, sha256: null }, result;
try {
  const targetId = decimal(idText), options = JSON.parse(optionText);
  if (Array.isArray(options.rootIds)) options.rootIds = options.rootIds.map(decimal);
  const info = await stat(input.path);
  if (!info.isFile() || info.size > incomingLimits.maxInputBytes) throw new SnapshotInputError('input-size-budget', 'Expected a regular file of at most 64 MiB');
  const chunks = []; let size = 0;
  for await (const chunk of createReadStream(input.path)) { size += chunk.length; if (size > incomingLimits.maxInputBytes) throw new SnapshotInputError('input-size-budget', 'Input grew past 64 MiB'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); input = { ...input, bytes: size, sha256: digest(bytes) };
  let heap; try { heap = JSON.parse(bytes.toString('utf8')); } catch { throw new SnapshotInputError('invalid-json', 'Invalid snapshot JSON'); }
  const index = buildIncomingIndex(heap), searchStart = performance.now(), evidence = searchReversePaths(index, targetId, options);
  result = { schemaVersion: '0.1.0', status: evidence.outcome === 'incomplete' ? 'incomplete' : 'completed', capability: 'bounded-literal-reverse-path', input, index: index.stats, searchElapsedMs: performance.now() - searchStart, evidence };
  if (result.status === 'incomplete') process.exitCode = 2;
} catch (error) { result = { schemaVersion: '0.1.0', status: 'failed', capability: 'bounded-literal-reverse-path', input, error: { name: error.name, code: error.code ?? 'worker-error', message: error.message, details: error.details ?? null } }; process.exitCode = 1; }
result.tool = { node: process.version, v8: process.versions.v8, dependencies: 'Node built-ins only; no MemLab', sourceHashes: Object.fromEntries(await Promise.all(['incoming-index.mjs', 'reverse-paths.mjs', 'reverse-worker.mjs', 'path-semantics.mjs'].map(async name => [name, digest(await readFile(new URL(name, import.meta.url)))]))) };
result.resources = { elapsedMs: performance.now() - start, maxRssKiB: process.resourceUsage().maxRSS, currentRssBytes: process.memoryUsage().rss, maxOldSpaceMiB: 512, maxInputBytes: incomingLimits.maxInputBytes };
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
