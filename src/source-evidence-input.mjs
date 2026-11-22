import { readFile } from 'node:fs/promises';
import { readBoundJson, sha256 } from './heap-identity.mjs';
import { prepareRetentionEvidence } from './retention-evidence.mjs';

export async function loadSourceEvidence(evidencePath, source) {
  const file = await readBoundJson(evidencePath), evidence = file.value;
  const unknown = code => ({ status: 'unknown', code, input: { path: file.path, sha256: file.sha256 } });
  const invalid = code => ({ status: 'invalid', code, input: { path: file.path, sha256: file.sha256 } });
  if (evidence.status !== 'completed' || !evidence.traces?.some(t => t.status === 'completed')) return unknown('no-complete-retaining-evidence-path');
  if (evidence.runId !== source.runId || evidence.input?.runDir !== source.inputs.runDir || evidence.input.captureReportSha256 !== source.inputs.captureReportSha256 || evidence.input.identity?.sha256 !== source.inputs.identity?.sha256 || evidence.identity?.status !== 'validated-consistency') return invalid('source-evidence-run-binding-mismatch');
  const selectionHash = sha256(await readFile(new URL('./retention-evidence.mjs', import.meta.url))), workerHash = sha256(await readFile(new URL('./evidence-worker.mjs', import.meta.url)));
  if (evidence.tool?.selectionImplementationSha256 !== selectionHash || evidence.tool?.workerImplementationSha256 !== workerHash) return invalid('source-evidence-tool-version-mismatch');
  const recomputed = await prepareRetentionEvidence(source.inputs.runDir, evidence.input.growthPath, source.inputs.identity.path);
  if (recomputed.input.growthSha256 !== evidence.input.growthSha256 || JSON.stringify(recomputed.selections) !== JSON.stringify(evidence.selections)) return invalid('source-evidence-selection-mismatch');
  const selection = recomputed.selections.find(s => s.selected);
  if (!selection) return unknown('no-identity-safe-growth-representative');
  const traces = evidence.traces.filter(t => t.status === 'completed' && t.nodeId === selection.nodeId && t.snapshot === selection.snapshot && t.snapshotSha256 === selection.snapshotSha256);
  if (traces.length !== 1 || !Array.isArray(traces[0].path) || traces[0].path.length < 1 || traces[0].path.length > 100 || traces[0].path.at(-1)?.id !== selection.nodeId) return invalid('source-evidence-path-binding-mismatch');
  const pointIndex = source.inputs.points.findIndex(p => p.path === selection.snapshot && p.sha256 === selection.snapshotSha256);
  if (pointIndex < 0) return invalid('source-evidence-snapshot-mismatch');
  return { status: 'selected', input: { path: file.path, sha256: file.sha256 }, pointIndex, selection, path: traces[0].path, provenance: 'First ranked generic growth representative, independently recomputed; supplied engine path must still match every literal raw edge. Business ownership/lifetime remains unknown for untagged SDK objects.' };
}
