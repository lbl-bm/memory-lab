import { writeFile } from 'node:fs/promises';
import { loadResourceHeapCapture, analyzeResourceHeap } from './resource-heap-evidence.mjs';
const [capturePath, outputPath] = process.argv.slice(2), start = performance.now(); let report;
try { report = analyzeResourceHeap(await loadResourceHeapCapture(capturePath)); if (report.status === 'incomplete') process.exitCode = 2; }
catch (error) { report = { schemaVersion: '0.1.0', status: 'failed', capability: 'resource-heap-source-evidence', error: { code: error.code ?? 'resource-heap-error', message: error.message } }; process.exitCode = 1; }
report.resourcesUsed = { elapsedMs: performance.now() - start, maxRssKiB: process.resourceUsage().maxRSS, maxOldSpaceMiB: 512 };
if (report.resourcesUsed.maxRssKiB > 768 * 1024) { report.status = 'failed'; report.error = { code: 'resource-heap-rss-budget' }; process.exitCode = 1; }
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
