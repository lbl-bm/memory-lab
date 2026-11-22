import { readFile, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256, readBoundJson } from './heap-identity.mjs';
import { censusObjects, compareCensuses, growthRule } from './snapshot-growth.mjs';
import { chooseAddedSurvivor, indexObjectIds, evidencePolicy } from './retention-evidence.mjs';
import { buildIncomingIndex } from './incoming-index.mjs';
import { searchReversePaths, reverseLimits } from './reverse-paths.mjs';

export function validateNativeSourceOptions(options) {
  if (!options || !Array.isArray(options.rootIds) || !options.rootIds.length || options.rootIds.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(options.rootIds).size !== options.rootIds.length) throw Error('Native source mode requires explicit unique nonnegative safe root IDs');
  if (Object.keys(options).some(k => !['rootIds', ...Object.keys(reverseLimits)].includes(k))) throw Error('Unsupported native source search option; explicit weak edges are always excluded');
  for (const [key, cap] of Object.entries(reverseLimits)) if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key] < (key === 'maxNodes' ? 1 : 0) || options[key] > cap)) throw Error('Invalid native source search limit: ' + key);
}

export function verifyGrowthComparison(growth, comparison) {
  return ['candidateCount', 'unresolvedCandidateCount', 'groups', 'candidates'].every(k => isDeepStrictEqual(growth[k], comparison[k]));
}

// The caller is analyzeSourceCandidates, which has already verified identity against
// every raw snapshot. This is not an API for treating a supplied identity verdict as proof.
export async function loadNativeSourceEvidence(growthPath, source, options) {
  validateNativeSourceOptions(options);
  const started = performance.now();
  const result = { status: 'unknown', code: null, input: null, policy: evidencePolicy, growth: null, selection: null, search: null,
    representativeLifecycle: { verdict: 'unknown', code: 'generic-object-not-covered-by-tagged-contract' },
    conclusion: { gcRetention: 'not-established', leakVerdict: 'not-determined', causalSourceLocalization: 'not-determined' } };
  const finish = (status, code = null) => ({ ...result, status, code, resources: { elapsedMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS } });
  if (!source.identity?.comparable || source.identity.status !== 'validated-consistency') return finish(source.identity?.status === 'invalid' ? 'invalid' : 'unknown', 'identity-not-comparable');
  const file = await readBoundJson(growthPath, 4 * 1024 ** 2), growth = file.value, points = source.inputs.points;
  result.input = { growth: { path: file.path, sha256: file.sha256 }, captureReportSha256: source.inputs.captureReportSha256, identity: source.inputs.identity };
  const names = ['native-source-input.mjs', 'snapshot-growth.mjs', 'retention-evidence.mjs', 'incoming-index.mjs', 'reverse-paths.mjs', 'path-semantics.mjs'];
  result.tool = { dependencies: 'Node built-ins only; no MemLab', sourceHashes: Object.fromEntries(await Promise.all(names.map(async name => [name, sha256(await readFile(new URL(name, import.meta.url)))]))) };
  if (!file.path.startsWith(source.inputs.runDir + sep) || growth.status !== 'completed' || growth.inputRunId !== source.runId || growth.runDir !== source.inputs.runDir) return finish('invalid', 'growth-run-binding-mismatch');
  if (growth.tool?.implementationSha256 !== result.tool.sourceHashes['snapshot-growth.mjs'] || !isDeepStrictEqual(growth.rule, growthRule)) return finish('invalid', 'growth-implementation-or-rule-mismatch');
  if (!Array.isArray(growth.points) || growth.points.length !== points.length || growth.points.some((p, i) => ['path', 'phase', 'cycle', 'sha256'].some(k => p[k] !== points[i][k]))) return finish('invalid', 'growth-snapshot-binding-mismatch');
  if (!Array.isArray(growth.candidates) || !Array.isArray(growth.groups)) return finish('invalid', 'malformed-growth-comparison');
  const first = growth.candidates[0], keys = new Set(first ? [JSON.stringify([first.type, first.name])] : []), censuses = [], indexes = [];
  async function readPoint(point) {
    if ((await stat(point.path)).size > growthRule.maxInputBytes) throw Error('Native source snapshot exceeds 64 MiB');
    const bytes = await readFile(point.path);
    if (bytes.length > growthRule.maxInputBytes || sha256(bytes) !== point.sha256) throw Error('Native source snapshot bytes changed');
    return JSON.parse(bytes);
  }
  for (const point of points) {
    let heap = await readPoint(point);
    censuses.push(censusObjects(heap)); indexes.push(indexObjectIds(heap, keys));
    heap = null; global.gc?.();
  }
  const comparison = compareCensuses(points, censuses);
  if (!verifyGrowthComparison(growth, comparison)) return finish('invalid', 'growth-counts-or-ranking-mismatch');
  result.growth = { recomputedFromEveryRawPoint: true, candidateCount: comparison.candidateCount, unresolvedCandidateCount: comparison.unresolvedCandidateCount, candidateGroups: comparison.candidates.map(g => ({ type: g.type, name: g.name, counts: g.counts, followupStatus: g.followupStatus })) };
  if (!first) return finish('unknown', 'no-growing-object-group');
  result.selection = chooseAddedSurvivor(points, indexes, comparison.candidates[0]);
  indexes.length = 0; censuses.length = 0; global.gc?.();
  if (!result.selection.selected) return finish('unknown', 'no-identity-safe-growth-representative');
  const pointIndex = points.findIndex(p => p.path === result.selection.snapshot && p.sha256 === result.selection.snapshotSha256);
  let heap = await readPoint(points[pointIndex]), index = buildIncomingIndex(heap);
  result.search = searchReversePaths(index, result.selection.nodeId, { ...options, edgePolicy: 'exclude-weak' });
  heap = null; index = null; global.gc?.();
  if (result.search.outcome !== 'path-found') return finish('unknown', result.search.outcome === 'incomplete' ? 'native-path-search-incomplete' : 'no-native-path-under-policy');
  const path = result.search.path.nodes.map((node, i) => ({ id: node.id, name: node.name, type: node.type, edgeToNext: i < result.search.path.edges.length ? { name: result.search.path.edges[i].nameOrIndex, type: result.search.path.edges[i].type } : null }));
  return { ...finish('selected'), pointIndex, path, provenance: 'Full generic growth ranking recomputed from raw snapshots; lowest baseline-absent ID in the first group surviving every back snapshot. One bounded literal path to caller-declared stopping nodes, not a proven GC retaining path. No target-name filter.' };
}
