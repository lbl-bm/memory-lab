import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// MemLab's interactive help formatter loops at undefined width in non-TTY pipes.
// Use its documented SILENT API, with a finite fallback width for trace output.
if (!process.stdout.columns) Object.defineProperty(process.stdout, 'columns', { value: 120 });
if (!process.stdout.rows) Object.defineProperty(process.stdout, 'rows', { value: 40 });
try {
  const [baseline, target, final, workDir] = process.argv.slice(2);
  if (![baseline, target, final, workDir].every(Boolean)) throw new Error('Expected three snapshots and a work directory');
  const { findLeaksBySnapshotFilePaths } = await import('memlab');
  const candidates = await findLeaksBySnapshotFilePaths(baseline, target, final, { workDir, consoleMode: 'SILENT' });
  await writeFile(join(workDir, 'candidates.json'), JSON.stringify(candidates, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'completed', candidateCount: candidates.length }));
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
