import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { censusObjects, loadRunPoints } from './snapshot-growth.mjs';
import { readBoundJson, verifyBoundSource, projectIdentityHeap, validateIdentitySeries } from './heap-identity.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const evidencePolicy = Object.freeze({ maxTraces: 1, selection: 'first ranked growth group; baseline-absent node present with the same name/type in every back snapshot; lowest ID', sameIsolateRequired: true });

export function indexObjectIds(heap, keys) {
  censusObjects(heap); // Validate field layout and object values with the same decoder.
  const fields = heap.snapshot.meta.node_fields;
  const o = Object.fromEntries(fields.map((name, index) => [name, index]));
  const types = heap.snapshot.meta.node_types[o.type];
  const allIds = new Set(), byGroup = new Map([...keys].map(key => [key, new Set()]));
  for (let i = 0; i < heap.nodes.length; i += fields.length) {
    if (types[heap.nodes[i + o.type]] !== 'object') continue;
    const id = heap.nodes[i + o.id]; allIds.add(id);
    const key = JSON.stringify(['object', heap.strings[heap.nodes[i + o.name]]]);
    byGroup.get(key)?.add(id);
  }
  return { allIds, byGroup };
}

export function chooseAddedSurvivor(points, indexes, group) {
  const key = JSON.stringify([group.type, group.name]);
  const backIndexes = points.map((p, i) => p.phase === 'back' ? i : -1).filter(i => i >= 0);
  const candidates = [...(indexes[backIndexes[0]].byGroup.get(key) ?? [])]
    .filter(id => !indexes[0].allIds.has(id) && backIndexes.every(i => indexes[i].byGroup.get(key)?.has(id)))
    .sort((a, b) => a - b);
  if (!candidates.length) return { selected: false, group: { type: group.type, name: group.name }, reason: 'No baseline-absent ID with the same name/type survived every returned snapshot. No baseline exemplar substituted.' };
  const id = candidates[0], last = backIndexes.at(-1), followup = points.findIndex(p => p.phase === 'followup');
  return { selected: true, group: { type: group.type, name: group.name }, nodeId: id, qualifyingIdCount: candidates.length, baselinePresent: false, presentInBackCycles: backIndexes.map(i => points[i].cycle), presentAtFollowup: followup < 0 ? null : indexes[followup].allIds.has(id), snapshot: points[last].path, snapshotSha256: points[last].sha256, cycle: points[last].cycle, counts: group.counts, groupFollowupStatus: group.followupStatus };
}

export async function prepareRetentionEvidence(runDir, growthPath, identityPath = null) {
  const input = await loadRunPoints(runDir);
  const captureReportSha256 = digest(await readFile(resolve(input.runDir, 'report.json')));
  const identityFile = identityPath ? await readBoundJson(identityPath) : null, manifest = identityFile?.value ?? null;
  let sourceValid = false;
  if (manifest) { try { sourceValid = await verifyBoundSource(manifest.collector, input.runDir); } catch {} }
  const path = await realpath(resolve(growthPath));
  if (!path.startsWith(input.runDir + sep)) throw new Error('Growth result must belong to the same run directory');
  const growthBytes = await readFile(path), growth = JSON.parse(growthBytes);
  if (growth.status !== 'completed' || growth.inputRunId !== input.report.runId) throw new Error('Growth result is incomplete or belongs to another run');
  const implementationSha256 = digest(await readFile(new URL('./snapshot-growth.mjs', import.meta.url)));
  if (growth.tool?.implementationSha256 !== implementationSha256) throw new Error('Growth implementation differs; create a new growth analysis before composing evidence');
  if (growth.points.length !== input.points.length) throw new Error('Growth/capture point counts differ');
  const groups = growth.candidates.slice(0, evidencePolicy.maxTraces);
  const keys = new Set(groups.map(g => JSON.stringify([g.type, g.name])));
  const indexes = [], projections = [], rss = [process.memoryUsage().rss];
  for (let i = 0; i < input.points.length; i++) {
    const point = input.points[i], recorded = growth.points[i];
    if (point.path !== recorded.path || point.phase !== recorded.phase || point.cycle !== recorded.cycle) throw new Error('Growth/capture point identity differs');
    const raw = await readFile(point.path), hash = digest(raw);
    if (hash !== recorded.sha256) throw new Error('Snapshot hash differs from the growth input: ' + point.path);
    point.sha256 = hash;
    let heap = JSON.parse(raw.toString('utf8'));
    const index = indexObjectIds(heap, keys);
    if (manifest) projections.push(projectIdentityHeap(heap, manifest.ownerToken));
    for (const group of groups) if ((index.byGroup.get(JSON.stringify([group.type, group.name]))?.size ?? 0) !== group.counts[i]) throw new Error('Candidate counts differ from raw snapshot');
    indexes.push(index); rss.push(process.memoryUsage().rss); heap = null; global.gc?.();
  }
  const identity = validateIdentitySeries(manifest, input.report, captureReportSha256, input.points, projections, sourceValid);
  if (identity.status === 'invalid') throw new Error('Identity comparison refused: ' + identity.code);
  return {
    schemaVersion: '0.1.0', runId: input.report.runId, captureKind: growth.provenance.captureKind, captureScope: growth.provenance.captureScope,
    input: { runDir: input.runDir, captureReportSha256, growthPath: path, growthSha256: digest(growthBytes), growthImplementationSha256: implementationSha256, snapshots: input.points, identity: identityFile && { path: identityFile.path, sha256: identityFile.sha256 } },
    identity,
    policy: evidencePolicy, candidateCount: growth.candidateCount, unresolvedCandidateCount: growth.unresolvedCandidateCount,
    candidateGroups: growth.candidates.map(g => ({ type: g.type, name: g.name, counts: g.counts, followupStatus: g.followupStatus })),
    selections: identity.comparable ? groups.map(group => chooseAddedSurvivor(input.points, indexes, group)) : [], selectionSuppressedReason: identity.comparable ? null : identity.code, selectionObservedPeakRssBytes: Math.max(...rss),
    assumptions: ['Cross-snapshot selection is suppressed without contemporaneous collector/anchor consistency.', 'Identity checks remain conditional on the supplied collector; source hashes are not execution attestation.', 'Only one representative of the first ranked group is sampled, not every growing instance.'],
  };
}
