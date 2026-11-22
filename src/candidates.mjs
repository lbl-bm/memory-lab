import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { censusObjects, compareCensuses, validatePoints } from './snapshot-growth.mjs';
import { censusCandidateFamilies } from './candidate-families.mjs';
import { buildIncomingIndex } from './incoming-index.mjs';
import { searchCandidatePathsWithFallback } from './candidate-paths.mjs';
import { buildDominatorTree, dominatorLimits } from './dominator.mjs';
import { loadProbeAccounting, subtractProbeOwned } from './candidate-accounting.mjs';
import { compareSurvivorFamilies } from './survivor-candidates.mjs';
import { SortedSnapshotIds } from './snapshot-id-set.mjs';
import { collectCandidateSourceHints, candidateSourceLimits } from './candidate-source-hints.mjs';

export const candidateLimits = Object.freeze({ maxPoints: 12, maxInputBytes: 256 * 1024 ** 2, maxGroups: 16, maxInstancesPerGroup: 8, maxInstances: 64, maxTotalPathEdges: 200000, maxOldSpaceMiB: 512, timeoutMs: 60000 });
const keyOf = group => group.familyKey ?? JSON.stringify([group.type, group.name]);

// This runs in the bounded analysis worker. Keep the full input text out of the
// caller's async locals while JSON.parse allocates the graph.
function readCandidateText(path) {
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > candidateLimits.maxInputBytes) throw Error('Candidate snapshot exceeds 256 MiB');
  global.gc?.();
  return text;
}

export function validateCandidateSeries(series) {
  if (series?.schemaVersion !== '0.1.0') throw Error('Expected candidate series schemaVersion 0.1.0');
  if (series.identity?.kind !== 'same-isolate' || series.identity?.asserted !== true || typeof series.identity.statement !== 'string' || !series.identity.statement.trim()) throw Error('Cross-snapshot IDs require an explicit same-isolate collection statement');
  validatePoints(series.points);
  if (series.points.length > candidateLimits.maxPoints || series.points.some(point => typeof point.path !== 'string' || !point.path)) throw Error('Expected at most 12 snapshot paths');
  if (series.points.some(point => point.probeAccountingPath !== undefined) && series.points.some(point => typeof point.probeAccountingPath !== 'string' || !point.probeAccountingPath)) throw Error('Probe accounting must cover every point or none');
  if (!Array.isArray(series.rootIds) || !series.rootIds.length || series.rootIds.length > 128 || series.rootIds.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(series.rootIds).size !== series.rootIds.length) throw Error('Expected 1..128 unique declared root IDs');
  if (series.scripts !== undefined && (!Array.isArray(series.scripts) || series.scripts.length > candidateSourceLimits.maxScripts || series.scripts.some(script => !script || typeof script.scriptId !== 'string' || typeof script.url !== 'string') || new Set(series.scripts.map(script => script.scriptId)).size !== series.scripts.length)) throw Error('Expected unique collector scriptId/url labels');
  const options = { maxGroups: 16, maxInstancesPerGroup: 8, maxInstances: 64, ...(series.selection ?? {}) };
  for (const [name, value] of Object.entries(options)) if (!['maxGroups', 'maxInstancesPerGroup', 'maxInstances'].includes(name) || !Number.isSafeInteger(value) || value < 1 || value > candidateLimits[name]) throw Error('Invalid candidate selection limit: ' + name);
  return options;
}

// Consider late cohorts, not just exemplars surviving the first back.
// Identical names remain separate instances; the group itself is only a heuristic.
export function selectCandidateInstances(points, comparison, indexes, options) {
  const last = points.findLastIndex(point => point.phase === 'back'), followup = points.findIndex(point => point.phase === 'followup');
  const selectedGroups = comparison.candidates.slice(0, options.maxGroups), groups = [];
  const selections = selectedGroups.map(group => {
    const key = keyOf(group);
    const qualified = group.classification && group.classification !== 'continuous-growth' ? new Set(group.survivingNewIds) : null;
    const eligible = [...(indexes[last].byGroup.get(key) ?? [])].filter(id => !indexes[0].allIds.has(id) && (!qualified || qualified.has(id))).sort((a, b) => a - b);
    const cohortMap = new Map();
    for (const id of eligible) {
      const first = indexes.findIndex((index, position) => position <= last && index.byGroup.get(key)?.has(id));
      if (!cohortMap.has(first)) cohortMap.set(first, []);
      cohortMap.get(first).push(id);
    }
    const cohorts = [...cohortMap].sort(([a], [b]) => a - b).map(([first, ids]) => ({ firstObservedCycle: points[first].cycle, ids }));
    const sampleOrder = [];
    // Heap IDs are identities, not reliable allocation timestamps. Share the small
    // per-group budget across observed back cohorts, including minified same-name objects.
    for (let round = 0; sampleOrder.length < Math.min(eligible.length, options.maxInstancesPerGroup); round++) {
      for (const cohort of cohorts) if (round < cohort.ids.length && sampleOrder.length < options.maxInstancesPerGroup) sampleOrder.push(cohort.ids[round]);
    }
    return { group, key, eligible, cohorts, sampleOrder, ids: [], excludedBaselineInstanceCount: [...(indexes[last].byGroup.get(key) ?? [])].filter(id => indexes[0].allIds.has(id)).length };
  });
  let total = 0;
  // Distribute the global budget across groups before taking a second instance.
  for (let round = 0; round < options.maxInstancesPerGroup && total < options.maxInstances; round++) {
    for (const selection of selections) if (round < selection.sampleOrder.length && total < options.maxInstances) { selection.ids.push(selection.sampleOrder[round]); total++; }
  }
  for (const { group, key, eligible, cohorts, ids, excludedBaselineInstanceCount } of selections) {
    const instances = ids.map(id => {
      const present = points.map((point, i) => indexes[i].byGroup.get(key)?.has(id) ?? false);
      const first = present.findIndex(Boolean);
      return { nodeId: id, firstObservedCycle: points[first].cycle, present, observedBackCount: present.slice(1, last + 1).filter(Boolean).length, survivesEveryBack: present.slice(1, last + 1).every(Boolean),
        followup: followup < 0 ? 'not-measured' : present[followup] ? 'present' : indexes[followup].allIds.has(id) ? 'identity-shape-changed' : 'absent',
        interpretation: 'Baseline-absent instance in the final-back family. Presence and first-observed cycle refer to membership of that family, not allocation time. Source, business lifetime and defect are not inferred.' };
    });
    const { survivingNewIds, survivingNewInstances, ...summary } = group;
    groups.push({ ...summary, eligibleInstanceCount: eligible.length, excludedBaselineInstanceCount, selectedInstanceCount: instances.length, omittedInstanceCount: eligible.length - instances.length,
      cohorts: cohorts.map(cohort => ({ firstObservedCycle: cohort.firstObservedCycle, eligibleInstanceCount: cohort.ids.length, selectedInstanceCount: instances.filter(instance => instance.firstObservedCycle === cohort.firstObservedCycle).length })), instances });
  }
  return { groups, selectedInstanceCount: total, omittedGroupCount: comparison.candidates.length - selectedGroups.length,
    omittedInstanceCount: groups.reduce((sum, group) => sum + group.omittedInstanceCount, 0), unselectedGroupInstanceCounts: 'not-enumerated' };
}

export async function analyzeCandidateSeries(seriesPath) {
  const started = performance.now(), absolute = resolve(seriesPath);
  if ((await stat(absolute)).size > 1024 ** 2) throw Error('Candidate series exceeds 1 MiB');
  const series = JSON.parse(await readFile(absolute, 'utf8')), options = validateCandidateSeries(series);
  const points = series.points.map(point => ({ phase: point.phase, cycle: point.cycle, path: resolve(dirname(absolute), point.path), ...(point.probeAccountingPath ? { probeAccountingPath: resolve(dirname(absolute), point.probeAccountingPath) } : {}) }));
  const accounting = new Map(), accountingSummaries = [], rawCensuses = [], nameCensuses = [], familyMetadata = [];
  const readHeap = async (point, bindAccounting = false) => {
    const info = await stat(point.path);
    if (info.size > candidateLimits.maxInputBytes) throw Error('Candidate snapshot exceeds 256 MiB');
    if (bindAccounting && point.probeAccountingPath) {
      const bytes = await readFile(point.path);
      if (bytes.length > candidateLimits.maxInputBytes) throw Error('Candidate snapshot exceeds 256 MiB');
      accounting.set(point, await loadProbeAccounting(point.probeAccountingPath, bytes));
      return JSON.parse(bytes.toString('utf8'));
    }
    return JSON.parse(readCandidateText(point.path));
  };
  const censuses = [], indexes = [];
  for (const point of points) {
    let heap = await readHeap(point, true); global.gc?.(); // Release the input Buffer/JSON text before building graph indexes.
    const raw = censusObjects(heap), owned = accounting.get(point);
    if (owned) { const filtered = subtractProbeOwned(heap, raw, owned); nameCensuses.push(filtered.groups); accountingSummaries.push(filtered.summary); }
    else nameCensuses.push(raw);
    let families = censusCandidateFamilies(heap, { excludedIds: owned?.ids ?? new Set(), collectIds: true });
    censuses.push(families.groups); rawCensuses.push(families.rawGroups); familyMetadata.push(families.metadata);
    indexes.push({ allIds: new SortedSnapshotIds(families.allIds), byGroup: new Map([...families.byGroup].map(([key, ids]) => [key, new SortedSnapshotIds(ids)])) });
    heap = null; families = null;
    // Finish the previous reader's promise turn before allocating the next graph.
    await new Promise(done => setImmediate(done));
    global.gc?.();
  }
  if (new Set(accountingSummaries.map(row => row.epochId)).size > 1) throw Error('probe-accounting-epoch-mismatch');
  if (accountingSummaries.length && series.identity.epochId !== undefined && accountingSummaries.some(row => row.epochId !== series.identity.epochId)) throw Error('probe-accounting-series-epoch-mismatch');
  const comparison = compareSurvivorFamilies(points, indexes, censuses);
  const rawComparison = compareCensuses(points, rawCensuses);
  const nameComparison = compareCensuses(points, nameCensuses);
  const selection = selectCandidateInstances(points, comparison, indexes, options);
  indexes.length = 0; censuses.length = 0; rawCensuses.length = 0; nameCensuses.length = 0; accounting.clear(); global.gc?.();
  const last = points.findLastIndex(point => point.phase === 'back');
  let heap = await readHeap(points[last]); global.gc?.();
  let index = buildIncomingIndex(heap);
  const validatedGraphSize = { nodeCount: index.stats.nodeCount, edgeCount: index.stats.edgeCount };
  const paths = searchCandidatePathsWithFallback(heap, index, selection.groups.flatMap(group => group.instances.map(instance => instance.nodeId)), series.rootIds, { maxEdges: candidateLimits.maxTotalPathEdges });
  for (const group of selection.groups) for (const instance of group.instances) instance.path = paths.results.get(instance.nodeId);
  const sourceHints = collectCandidateSourceHints(heap, selection.groups.flatMap(group => group.instances), { scripts: series.scripts ?? [] }, index);
  const hintsById = new Map(sourceHints.records.map(record => [record.nodeId, record]));
  for (const group of selection.groups) for (const instance of group.instances) instance.sourceHints = hintsById.get(instance.nodeId);
  index = null; global.gc?.();
  let graphSummary;
  try {
    if (validatedGraphSize.nodeCount > dominatorLimits.maxNodes || validatedGraphSize.edgeCount > dominatorLimits.maxEdges) { const error = Error('Graph exceeds the declared node/edge budget'); error.code = 'dominator-graph-budget'; throw error; }
    let tree = buildDominatorTree(heap, { rootIds: series.rootIds, edgePolicy: 'exclude-weak' });
    for (const group of selection.groups) for (const instance of group.instances) instance.declaredGraph = tree.node(instance.nodeId);
    graphSummary = tree.summary; tree = null;
  } catch (error) {
    if (error.code !== 'dominator-graph-budget') throw error;
    graphSummary = { status: 'incomplete', reason: error.code, message: error.message, ...validatedGraphSize, limits: { maxNodes: dominatorLimits.maxNodes, maxEdges: dominatorLimits.maxEdges } };
    for (const group of selection.groups) for (const instance of group.instances) instance.declaredGraph = { status: 'unavailable', reason: error.code };
  }
  heap = null; global.gc?.();
  const pathIncompleteCount = selection.groups.flatMap(group => group.instances).filter(instance => instance.path.outcome === 'incomplete').length;
  const witnessPathCount = selection.groups.flatMap(group => group.instances).filter(instance => instance.path.witnessPath).length;
  const provenShortestPathCount = selection.groups.flatMap(group => group.instances).filter(instance => instance.path.outcome === 'path-found').length;
  const truncated = selection.omittedGroupCount > 0 || selection.omittedInstanceCount > 0 || pathIncompleteCount > 0 || sourceHints.status === 'incomplete' || graphSummary.status === 'incomplete' || accountingSummaries.some(row => !row.complete);
  return { schemaVersion: '0.1.0', status: truncated ? 'incomplete' : 'completed', capability: 'multiple-growth-candidates',
    input: { seriesPath: absolute, identity: { ...series.identity, authority: 'caller-declared; not authenticated' }, points, rootIds: series.rootIds, scriptLabelCount: series.scripts?.length ?? 0 },
    candidateGroupCount: comparison.candidateCount, noncandidateGroupCount: comparison.groups.length - comparison.candidateCount,
    screening: { method: 'continuous-growth-or-repeated-new-identity', unresolvedCandidateCount: comparison.unresolvedCandidateCount, unresolvedDefinition: comparison.unresolvedDefinition, rule: comparison.rule, interpretation: 'Strict growth is retained. Additionally, baseline-absent final-back objects observed in at least two back snapshots form survivor candidates. Stable caches can qualify; none of these classes certifies a defect. Followup count changes and object identity survival are separate facts.' },
    sourceMapping: { ...sourceHints, records: undefined },
    grouping: { method: 'literal-property-prototype-family-v1', nameOnlyCandidateGroupCount: nameComparison.candidateCount, nameOnlyCountScreening: 'legacy-continuous-growth-only; not comparable to the expanded survivor candidate count', points: familyMetadata,
      interpretation: 'Group identity uses one direct property __proto__ edge to an object or closure. Names are display hints. Missing, multiple or non-object targets fall back to name/type; shared prototypes merge. This is not a constructor, realm, source or GC certification. Legacy growth/source commands retain their name grouping.' },
    probeAccounting: { applied: accountingSummaries.length > 0, completeWithinDeclaredSlots: accountingSummaries.length ? accountingSummaries.every(row => row.complete) : null, rawCandidateGroupCount: rawComparison.candidateCount, rawCountScreening: 'legacy-continuous-growth-only; not comparable to the expanded survivor candidate count', points: accountingSummaries,
      authority: 'Collector-reported explicit private slots, bound to the snapshot bytes; not authenticated whole-heap ownership.', effect: 'Only explicitly listed IDs are excluded from candidate counts and instance selection. Raw graph, paths and retained bytes remain unchanged. Same-named business objects remain eligible.' },
    ...selection, completeness: { selectionTruncated: selection.omittedGroupCount > 0 || selection.omittedInstanceCount > 0, sourcePositionsTruncated: sourceHints.status === 'incomplete', pathIncompleteCount, provenShortestPathCount, witnessPathCount, pathUnavailableCount: selection.selectedInstanceCount - provenShortestPathCount - witnessPathCount, paths: 'one bounded literal path per selected instance when available; unproven shortest-distance witnesses remain incomplete', traversal: paths.traversal, examinedEdges: paths.stats.examinedEdges, pathEdgeBudget: candidateLimits.maxTotalPathEdges, sharedSearch: { forward: paths.forward, fallback: paths.fallback, limits: paths.limits, forwardStopReason: paths.stopReason } }, graphSummary,
    resources: { elapsedMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS },
    conclusion: { leakVerdict: 'not-determined', sourceLocation: sourceHints.records.some(record => record.hints?.length) ? 'generated-definition-hints-on-literal-path' : 'unknown', retainedSize: graphSummary.status === 'incomplete' ? 'unavailable: dominator graph budget; candidates/paths/source hints are retained' : 'exact for declared literal graph; not V8 GC retained bytes' },
    limits: ['Snapshot prototype-edge families are not JS constructor identity. Shared targets and name fallbacks can merge unrelated instances.', 'Baseline-existing objects that grow internally, one-back-only identities, native-only leaks and budget-excluded groups may be missed.', 'Stable legitimate caches also produce new survivor candidates; business lifetime and expected cleanup remain external evidence.', 'Snapshot IDs are comparable only under the supplied same-isolate declaration. Keep inputs immutable while analysis runs.', 'Explicit weak edges are excluded; ephemeron, native and shortcut semantics are not inferred by this command.', 'Generated definition hints on a retaining path are not allocation stacks, original-source positions, retaining writes or certified repair lines.', 'Per-object retained bytes overlap and must not be summed.'] };
}
