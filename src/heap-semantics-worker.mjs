import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { analyzeHeapSemantics, heapSemanticsLimits } from './heap-semantics.mjs';

const [snapshot, optionText, outputPath] = process.argv.slice(2), started = performance.now();
let result, input = { path: resolve(snapshot) };
try {
  const options = JSON.parse(optionText), chunks = []; let size = 0;
  for await (const chunk of createReadStream(input.path)) { size += chunk.length; if (size > heapSemanticsLimits.maxInputBytes) throw Error('input-size-budget'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); input = { ...input, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') };
  result = { ...analyzeHeapSemantics(JSON.parse(bytes.toString('utf8')), options), input };
} catch (error) { result = { status: 'failed', input, error: { code: error.code ?? 'heap-semantics-worker-error', message: error.message } }; process.exitCode = 1; }
result.tool = { node: process.version, v8: process.versions.v8, dependencies: 'Node built-ins only' };
result.resources = { elapsedMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS, maxOldSpaceMiB: heapSemanticsLimits.maxOldSpaceMiB };
if (result.resources.maxRssKiB > 768 * 1024) { result.status = 'failed'; result.error = { code: 'heap-semantics-rss-budget', message: 'Worker exceeded measured 768 MiB RSS budget' }; process.exitCode = 1; }
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
