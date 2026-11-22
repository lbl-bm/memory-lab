import { compareCensuses, validatePoints } from './snapshot-growth.mjs';
import { SortedSnapshotIds } from './snapshot-id-set.mjs';

const keyOf = group => group.familyKey ?? JSON.stringify([group.type, group.name]);
const rank = { 'continuous-growth': 0, 'accumulating-survivors': 1, 'stable-new-survivors': 2, none: 3 };
const isIdSet = value => value instanceof Set || value instanceof SortedSnapshotIds;

export function compareSurvivorFamilies(points, indexes, censuses) {
  const { backs, followup } = validatePoints(points);
  if (!Array.isArray(indexes) || indexes.length !== points.length || !Array.isArray(censuses) || censuses.length !== points.length) throw Error('Survivor census and identity index counts differ');
  // All families must be indexed before selection; a selected-key index would
  // silently hide exactly the plateau/replacement families this rule adds.
  for (let i = 0; i < points.length; i++) {
    const index = indexes[i], census = censuses[i];
    if (!isIdSet(index?.allIds) || !(index?.byGroup instanceof Map) || !(census instanceof Map)) throw Error('Invalid survivor identity index');
    for (const [key, group] of census) if (group.count !== (index.byGroup.get(key)?.size ?? 0)) throw Error('Incomplete survivor family index');
    for (const [key, ids] of index.byGroup) {
      if (!isIdSet(ids) || ids.size !== (census.get(key)?.count ?? 0)) throw Error('Inconsistent survivor family index');
      for (const id of ids) if (!Number.isSafeInteger(id) || id < 0 || !index.allIds.has(id)) throw Error('Invalid survivor indexed identity');
    }
  }
  const old = compareCensuses(points, censuses), last = backs.length, final = followup ? indexes.length - 1 : -1, baseline = indexes[0].allIds;
  const oldOrder = new Map(old.groups.map((group, i) => [keyOf(group), i]));
  const groups = old.groups.map(group => {
    const key = keyOf(group), baselineAbsentByPoint = indexes.map(index => {
      let count = 0; for (const id of index.byGroup.get(key) ?? []) if (!baseline.has(id)) count++; return count;
    });
    const eligible = [...(indexes[last].byGroup.get(key) ?? [])].filter(id => !baseline.has(id)).sort((a, b) => a - b);
    const survivingNewInstances = [];
    for (const nodeId of eligible) {
      let backObservations = 0, firstObservedCycle = null;
      for (let point = 1; point <= last; point++) if (indexes[point].byGroup.get(key)?.has(nodeId)) {
        backObservations++; firstObservedCycle ??= points[point].cycle;
      }
      if (backObservations < 2) continue;
      survivingNewInstances.push({ nodeId, firstObservedCycle, backObservations,
        followup: final < 0 ? 'not-measured' : indexes[final].byGroup.get(key)?.has(nodeId) ? 'present' : indexes[final].allIds.has(nodeId) ? 'identity-shape-changed' : 'absent' });
    }
    const survivingNewIds = survivingNewInstances.map(row => row.nodeId), cohorts = new Set(survivingNewInstances.map(row => row.firstObservedCycle));
    const classification = group.persistentGrowth ? 'continuous-growth' : cohorts.size > 1 ? 'accumulating-survivors' : cohorts.size ? 'stable-new-survivors' : 'none';
    const candidateIds = group.persistentGrowth ? eligible : survivingNewIds;
    const presentCount = final < 0 ? null : candidateIds.filter(id => indexes[final].allIds.has(id)).length;
    const changedFamilyCount = final < 0 ? null : candidateIds.filter(id => indexes[final].allIds.has(id) && !indexes[final].byGroup.get(key)?.has(id)).length;
    const candidateIdentityFollowup = { eligibleCount: candidateIds.length, presentCount, changedFamilyCount,
      status: !candidateIds.length ? 'no-eligible-identities' : final < 0 ? 'not-measured' : presentCount === 0 ? 'all-absent' : presentCount === candidateIds.length ? 'all-present' : 'partly-present' };
    return { ...group, classification, baselineAbsentByPoint, baselineAbsentFinalCount: eligible.length, survivingNewCount: survivingNewIds.length, survivingNewIds, survivingNewInstances, candidateIdentityFollowup,
      candidateReasons: [...(group.persistentGrowth ? ['continuous-family-count-growth'] : []), ...(survivingNewIds.length ? ['new-identities-observed-in-multiple-backs'] : [])] };
  });
  groups.sort((a, b) => rank[a.classification] - rank[b.classification] || (a.classification === 'continuous-growth' || a.classification === 'none'
    ? oldOrder.get(keyOf(a)) - oldOrder.get(keyOf(b))
    : b.survivingNewCount - a.survivingNewCount || a.name.localeCompare(b.name) || keyOf(a).localeCompare(keyOf(b))));
  const candidates = groups.filter(group => group.classification !== 'none');
  return { groups, candidates, candidateCount: candidates.length,
    unresolvedCandidateCount: candidates.filter(group => !['all-absent', 'no-eligible-identities'].includes(group.candidateIdentityFollowup.status)).length,
    unresolvedDefinition: 'A candidate has eligible baseline-absent identities still present anywhere in the followup object index, or no followup measurement. Family count at/below baseline is not identity release; a changed family remains present. This is not a leak verdict.',
    rule: { minimumBackObservations: 2, baselineIdentityScope: 'all indexed baseline object IDs, across families', classification: 'Continuous count growth keeps its prior priority/order. Otherwise final-back new identities observed in at least two backs form a candidate: multiple first-observed cohorts are accumulating, one cohort is stable. Stable includes legitimate bounded caches and does not certify normality or leakage.' } };
}
