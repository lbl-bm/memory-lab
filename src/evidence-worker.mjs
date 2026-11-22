import { createRequire } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareRetentionEvidence } from './retention-evidence.mjs';
import { withDeadline } from './deadline.mjs';
const [runDir, growthPath, output, identityPath] = process.argv.slice(2);
const start = performance.now();
const startedAt = new Date().toISOString();
async function main() {
  const report = await prepareRetentionEvidence(runDir, growthPath, identityPath || null);
  report.startedAt = startedAt; report.traces = [];
  report.tool = { name: 'retention-evidence', selectionImplementationSha256: createHash('sha256').update(await readFile(new URL('./retention-evidence.mjs', import.meta.url))).digest('hex'), workerImplementationSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') };
  global.gc?.();
  for (const selection of report.selections.filter(s => s.selected)) {
    try {
      const manifest = realpathSync(new URL('../node_modules/memlab/package.json', import.meta.url));
      const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
      if (version !== '2.0.6') throw new Error('Trace engine version is not the verified MemLab 2.0.6');
      const require = createRequire(manifest);
      if (!process.stdout.columns) Object.defineProperty(process.stdout, 'columns', { value: 120 });
      const { getFullHeapFromFile } = require('memlab');
      const { TraceFinder } = require('@memlab/core');
      const raw = await readFile(selection.snapshot);
      if (createHash('sha256').update(raw).digest('hex') !== selection.snapshotSha256) throw new Error('Selected snapshot changed');
      const heap = await getFullHeapFromFile(selection.snapshot);
      const finder = new TraceFinder(); finder.annotateShortestPaths(heap);
      let item = finder.getPathToGCRoots(heap, heap.getNodeById(selection.nodeId));
      const path = [];
      while (item && path.length < 100) { path.push({ id: item.node.id, name: item.node.name, type: item.node.type, edgeToNext: item.edge ? { name: item.edge.name_or_index, type: item.edge.type } : null }); item = item.next; }
      if (!path.length || item || path.at(-1).id !== selection.nodeId) throw new Error('No complete engine path ending at selected node within 100 nodes');
      const trace = { status: 'completed', engine: { name: 'MemLab', version, api: 'getFullHeapFromFile + pinned internal TraceFinder' }, group: selection.group, nodeId: selection.nodeId, snapshot: selection.snapshot, snapshotSha256: selection.snapshotSha256, presentAtFollowup: selection.presentAtFollowup, explicitWeakEdges: path.filter(p => p.edgeToNext?.type === 'weak').length, path, interpretation: 'Measured engine root/stopping-point path for one selected instance. No automatic lifecycle, source or leak verdict.' };
      const pathFile = resolve(output, 'retainer-' + selection.nodeId + '.json');
      await writeFile(pathFile, JSON.stringify(trace, null, 2) + '\n', { flag: 'wx' }); report.traces.push({ ...trace, pathFile });
    } catch (error) { report.traces.push({ status: 'failed', group: selection.group, nodeId: selection.nodeId, error: { name: error.name, message: error.message } }); }
  }
  report.status = report.traces.some(t => t.status === 'failed') || report.selections.some(s => !s.selected) ? 'partial' : 'completed';
  report.conclusion = { status: 'requires-review', identityStatus: report.identity.status, leakVerdict: 'not-determined', sourceLocalization: 'not-implemented', repairValidation: 'not-tested', reason: !report.identity.comparable ? 'Identity is unknown; no cross-snapshot object selection or trace performed.' : report.candidateCount ? 'Growth, followup and representative paths require a lifecycle contract; cache prefill may have the same evidence.' : 'No persistent count-growth pattern in this short object-name series; absence of a leak is not established.' };
  report.resources = { elapsedMs: performance.now() - start, maxRssKiB: process.resourceUsage().maxRSS || null, currentRssBytes: process.memoryUsage().rss, maxOldSpaceMiB: 768 };
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const lines = ['# Memory evidence (requires review)', '', 'Capture: ' + report.captureKind, '', 'Growth candidate groups: ' + report.candidateCount + '; above baseline after followup/not measured: ' + report.unresolvedCandidateCount, '', 'Leak verdict: not determined. Source localization: not implemented.', '', '| Group | Counts (baseline / backs / followup) | Followup |', '| --- | --- | --- |', ...report.candidateGroups.map(g => '| ' + g.name.replaceAll('|', '\\|') + ' | ' + g.counts.join(' / ') + ' | ' + g.followupStatus + ' |'), '', '## Representative paths', ''];
  for (const trace of report.traces) lines.push(trace.status === 'completed' ? '- Node ' + trace.nodeId + '; present at followup: ' + trace.presentAtFollowup + '; explicit weak edges: ' + trace.explicitWeakEdges + '\n\n  `' + trace.path.map(p => p.name || p.type).join(' -> ').replaceAll('`', '') + '`\n' : '- Trace failed: ' + trace.error.message);
  if (!report.traces.length) lines.push('No representative path selected; see evidence.json for selection/coverage.');
  lines.push('', 'Identity status: ' + report.identity.status + '. ' + (report.selectionSuppressedReason ?? ''), '', 'Engine paths may use heuristic stopping roots. One path does not represent every instance or prove a defect.');
  await writeFile(resolve(output, 'evidence.md'), lines.join('\n') + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, traces: report.traces.length, report: resolve(output, 'evidence.json') }));
  if (report.status !== 'completed') process.exitCode = 1;
}
try { await withDeadline(main(), 85000, 'Evidence composition'); }
catch (error) { await writeFile(resolve(output, 'error.json'), JSON.stringify({ status: 'failed', error: { name: error.name, message: error.message } }, null, 2) + '\n', { flag: 'wx' }); process.exitCode = 1; }
