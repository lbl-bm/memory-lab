import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeResourceRegression } from './resource-regression.mjs';
const [before, after, rules, output] = process.argv.slice(2);
let report;
try {
  report = await analyzeResourceRegression(before, after, rules);
  if (process.resourceUsage().maxRSS > 768 * 1024) throw Error('resource-regression-rss-budget');
  process.exitCode = report.status === 'incomplete' ? 2 : report.gate === 'fail' ? 3 : 0;
} catch (error) { report = { schemaVersion: '0.1.0', status: 'failed', gate: 'inconclusive', error: { message: error.message } }; process.exitCode = 1; }
await writeFile(resolve(output, 'resource-regression.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
