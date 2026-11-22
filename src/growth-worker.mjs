import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeGrowthRun } from './snapshot-growth.mjs';
const [runDir, output] = process.argv.slice(2);
try {
  const result = await analyzeGrowthRun(runDir);
  await writeFile(resolve(output, 'growth.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, candidateCount: result.candidateCount }));
} catch (error) {
  await writeFile(resolve(output, 'error.json'), JSON.stringify({ status: 'failed', error: { name: error.name, message: error.message } }, null, 2) + '\n', { flag: 'wx' });
  process.exitCode = 1;
}
