import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeLifecycle } from './lifecycle.mjs';
import { withDeadline } from './deadline.mjs';
const [runDir, identityPath, contractPath, output] = process.argv.slice(2);
try {
  const report = await withDeadline(analyzeLifecycle(runDir, identityPath || null, contractPath || null), 55000, 'Lifecycle analysis');
  await writeFile(resolve(output, 'lifecycle.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(output, 'lifecycle.md'), ['# Conditional lifecycle evidence', '', 'Identity: ' + report.identity.status, '', 'Assessment: ' + report.assessment.verdict, '', report.assessment.detail ?? report.assessment.conditional ?? '', '', 'Leak verdict: not determined. Source localization and repair validation are not implemented.', '', 'Counts of tagged resources: ' + (report.assessment.counts?.join(' / ') ?? 'not compared'), '', 'See lifecycle.json for snapshot hashes, tokens, event boundaries and measured owner routes. Collector truthfulness and lifecycle assertion remain trust inputs.'].join('\n') + '\n', { flag: 'wx' });
  if (report.status !== 'completed') process.exitCode = 1;
} catch (error) {
  await writeFile(resolve(output, 'error.json'), JSON.stringify({ status: 'failed', error: { name: error.name, message: error.message } }, null, 2) + '\n', { flag: 'wx' }); process.exitCode = 1;
}
