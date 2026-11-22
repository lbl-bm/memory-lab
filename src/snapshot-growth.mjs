import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';

export const growthRule = Object.freeze({ nodeTypes: ['object'], minimumBackSamples: 3, requiredIncrementEveryStep: 1, maxInputBytes: 64 * 1024 ** 2 });

export function censusObjects(heap) {
  const fields = heap?.snapshot?.meta?.node_fields;
  if (!Array.isArray(fields) || !Array.isArray(heap.nodes) || !Array.isArray(heap.strings)) throw new Error('Unsupported V8 snapshot structure');
  const offsets = Object.fromEntries(fields.map((name, index) => [name, index]));
  for (const field of ['type', 'name', 'id', 'self_size']) if (!Number.isInteger(offsets[field])) throw new Error('Missing V8 node field: ' + field);
  const types = heap.snapshot.meta.node_types?.[offsets.type];
  if (!Array.isArray(types) || heap.nodes.length % fields.length !== 0) throw new Error('Invalid V8 node metadata');
  const groups = new Map();
  for (let i = 0; i < heap.nodes.length; i += fields.length) {
    const type = types[heap.nodes[i + offsets.type]];
    if (typeof type !== 'string') throw new Error('Invalid V8 node type index');
    if (type !== 'object') continue;
    const name = heap.strings[heap.nodes[i + offsets.name]];
    const id = heap.nodes[i + offsets.id];
    const selfSize = heap.nodes[i + offsets.self_size];
    if (typeof name !== 'string' || !Number.isSafeInteger(id) || !Number.isSafeInteger(selfSize) || selfSize < 0) throw new Error('Invalid V8 object node');
    const key = JSON.stringify([type, name]);
    let group = groups.get(key);
    if (!group) { group = { type, name, count: 0, selfSizeBytes: 0, exampleNodeIds: [] }; groups.set(key, group); }
    group.count++; group.selfSizeBytes += selfSize;
    if (group.exampleNodeIds.length < 3) group.exampleNodeIds.push(id);
  }
  return groups;
}

export function validatePoints(points) {
  if (!Array.isArray(points) || points[0]?.phase !== 'baseline' || points[0]?.cycle !== 0) throw new Error('Series must start with baseline cycle 0');
  const backs = points.filter(p => p.phase === 'back');
  if (backs.length < growthRule.minimumBackSamples) throw new Error('Growth analysis needs at least 3 completed back snapshots; capture with roundSnapshots and cycles >= 3');
  if (points.length !== 1 + backs.length + points.filter(p => p.phase === 'followup').length || points.filter(p => p.phase === 'followup').length > 1) throw new Error('Invalid growth phases');
  for (let i = 0; i < backs.length; i++) if (points[i + 1] !== backs[i] || backs[i].cycle !== i + 1) throw new Error('Back snapshot cycles must be ordered, consecutive and unique');
  const followup = points.find(p => p.phase === 'followup');
  if (followup && (points.at(-1) !== followup || followup.cycle !== backs.length)) throw new Error('Followup must follow the final back cycle');
  return { backs, followup };
}

export function compareCensuses(points, censuses) {
  const { backs, followup } = validatePoints(points);
  if (censuses.length !== points.length) throw new Error('Census and point counts differ');
  const keys = new Set(censuses.flatMap(c => [...c.keys()]));
  const lastBackIndex = backs.length;
  const groups = [];
  for (const key of keys) {
    const present = censuses.find(c => c.has(key)).get(key);
    const counts = censuses.map(c => c.get(key)?.count ?? 0);
    const selfSizeBytes = censuses.map(c => c.get(key)?.selfSizeBytes ?? 0);
    const increments = counts.slice(1, lastBackIndex + 1).map((n, i) => n - counts[i]);
    const persistentGrowth = increments.every(n => n >= growthRule.requiredIncrementEveryStep);
    const netGrowth = counts[lastBackIndex] - counts[0];
    let followupStatus = 'not-measured';
    if (followup) followupStatus = counts.at(-1) <= counts[0] ? 'at-or-below-baseline' : counts.at(-1) < counts[lastBackIndex] ? 'partly-released' : 'still-above-baseline';
    groups.push({ type: present.type, name: present.name, ...(present.familyKey ? { familyKey: present.familyKey, family: present.family } : {}), counts, increments, netGrowth, selfSizeBytes, persistentGrowth, followupStatus, exampleLastBackNodeIds: censuses[lastBackIndex].get(key)?.exampleNodeIds ?? [] });
  }
  groups.sort((a, b) => Number(b.persistentGrowth) - Number(a.persistentGrowth) || b.netGrowth - a.netGrowth || a.name.localeCompare(b.name));
  const candidates = groups.filter(g => g.persistentGrowth);
  return { groups, candidates, candidateCount: candidates.length, unresolvedCandidateCount: candidates.filter(g => g.followupStatus !== 'at-or-below-baseline').length };
}

export async function loadRunPoints(runDir) {
  runDir = await realpath(resolve(runDir));
  const report = JSON.parse(await readFile(resolve(runDir, 'report.json'), 'utf8'));
  if (report.status !== 'completed') throw new Error('Only completed capture runs can be analyzed');
  if (!report.config?.roundSnapshots) throw new Error('Run must use roundSnapshots; the ordinary first-cycle triplet is insufficient');
  const relevant = report.artifacts.filter(a => a.kind === 'heap-snapshot' && ['baseline', 'final', 'back', 'followup'].includes(a.phase));
  const points = relevant.map(a => ({ phase: a.phase === 'final' ? 'back' : a.phase, cycle: a.cycle, path: a.path, capturedAt: a.capturedAt ?? null }));
  validatePoints(points);
  for (const point of points) {
    const path = await realpath(resolve(runDir, point.path));
    if (!path.startsWith(runDir + sep) || extname(path) !== '.heapsnapshot') throw new Error('Snapshot must be a .heapsnapshot file inside its run directory');
    const info = await stat(path);
    if (!info.isFile() || info.size > growthRule.maxInputBytes) throw new Error('Growth input exceeds the 64 MiB per-snapshot parser limit');
    point.path = path; point.bytes = info.size;
  }
  return { runDir, report, points };
}

export async function analyzeGrowthRun(runDir) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const input = await loadRunPoints(runDir);
  const censuses = [];
  const rssSamples = [process.memoryUsage().rss];
  for (const point of input.points) {
    const raw = await readFile(point.path);
    point.sha256 = createHash('sha256').update(raw).digest('hex');
    let heap;
    try { heap = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Invalid V8 snapshot JSON: ' + point.path); }
    censuses.push(censusObjects(heap));
    rssSamples.push(process.memoryUsage().rss);
    heap = null;
    global.gc?.();
  }
  const comparison = compareCensuses(input.points, censuses);
  const usage = process.resourceUsage();
  return {
    schemaVersion: '0.1.0', status: 'completed', method: 'V8 object node-name/type count growth across returned states', startedAt, finishedAt: new Date().toISOString(),
    inputRunId: input.report.runId, runDir: input.runDir, rule: growthRule, points: input.points,
    tool: { name: 'snapshot-growth', implementationSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') },
    provenance: { captureKind: input.report.captureKind ?? 'chromium-cdp', captureScope: input.report.scope, repo: input.report.repo, browser: input.report.browser, scenario: input.report.scenario, configHash: input.report.config.configHash ?? null, node: process.version },
    ...comparison,
    resources: { elapsedMs: performance.now() - started, snapshotBytesRead: input.points.reduce((n, p) => n + p.bytes, 0), observedPeakRssBytes: Math.max(...rssSamples), maxRssKiB: usage.maxRSS || null },
    conclusion: { status: 'requires-review', reasons: ['Count growth is a candidate signal, not a leak or repair verdict.', 'Legitimate cache prefill and delayed release can satisfy the same rule.'] },
    limits: ['Only V8 object nodes; closures, strings, native-only retention and workers are excluded.', 'Same-name constructors/realms can merge; minification changes names.', 'No cross-snapshot object identity, GC-root reachability, source localization or retained-size calculation.', 'selfSizeBytes is shallow node size and excludes separately owned/backing allocations.', 'Intermittent leaks, growth hidden by churn, or groups that plateau during this short series can be missed.', 'Snapshot capture/GC changes timing; scenario state equality does not prove all internal state is equivalent.'],
  };
}
