import { writeFile } from 'node:fs/promises';
import { analyzeCandidateSeries } from './candidates.mjs';
import { renderCandidateReport } from './candidate-report.mjs';
const [series, output, markdown] = process.argv.slice(2);
const started = performance.now();
let result;
try {
  result = await analyzeCandidateSeries(series);
  if (result.resources.maxRssKiB > 768 * 1024) { result.status = 'failed'; result.error = { code: 'candidate-rss-budget', message: 'Candidate worker exceeded 768 MiB measured max RSS; computed evidence is retained but this run did not pass the resource limit.' }; }
} catch (error) { result = { schemaVersion: '0.1.0', status: 'failed', error: { code: error.code ?? 'candidate-analysis-failed', message: error.message }, resources: { elapsedMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS } }; }
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
if (markdown) await writeFile(markdown, renderCandidateReport(result), { flag: 'wx' });
process.exitCode = result.status === 'completed' ? 0 : result.status === 'incomplete' ? 2 : 1;
