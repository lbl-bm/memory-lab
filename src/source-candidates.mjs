import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeLifecycle } from './lifecycle.mjs';
import { censusObjects } from './snapshot-growth.mjs';
import { sha256, readBoundJson } from './heap-identity.mjs';
import { loadSourceEvidence } from './source-evidence-input.mjs';
import { loadNativeSourceEvidence, validateNativeSourceOptions } from './native-source-input.mjs';
import { mapOriginalSources } from './original-source.mjs';

export const sourcePolicy = Object.freeze({ maxCandidatePositions: 24, maxNeighborDepth: 2, maxTraversedEdges: 2000, neighborEdgeTypes: ['property'], positionOrder: 'all-direct-before-property-neighbors', maxSourceBytes: 1024 * 1024, sourceMaps: 'not-resolved', causalLocalization: 'not-implemented' });

export function sourcePositions(heap, seedIds, requiredPath = null) {
  censusObjects(heap);
  const m = heap.snapshot.meta, nf = m.node_fields, ef = m.edge_fields, lf = m.location_fields;
  if (!Array.isArray(lf) || !Array.isArray(heap.locations)) return { positions: [], unknown: [{ code: 'missing-location-metadata' }], truncated: false };
  if (!Array.isArray(ef) || !Array.isArray(heap.edges)) throw Error('Missing graph metadata');
  const n = Object.fromEntries(nf.map((k, i) => [k, i])), e = Object.fromEntries(ef.map((k, i) => [k, i])), l = Object.fromEntries(lf.map((k, i) => [k, i]));
  if (['object_index', 'script_id', 'line', 'column'].some(k => !Number.isInteger(l[k])) || !Number.isInteger(n.edge_count) || ['type', 'name_or_index', 'to_node'].some(k => !Number.isInteger(e[k]))) throw Error('Unsupported location/edge metadata');
  const nt = m.node_types[n.type], et = m.edge_types?.[e.type];
  if (!Array.isArray(et) || heap.locations.length % lf.length || heap.edges.length % ef.length) throw Error('Malformed graph/location arrays');
  const byOffset = new Map(), byId = new Map(); let ep = 0;
  for (let o = 0; o < heap.nodes.length; o += nf.length) {
    const count = heap.nodes[o + n.edge_count], id = heap.nodes[o + n.id];
    if (!Number.isSafeInteger(count) || count < 0 || byId.has(id)) throw Error('Invalid node/edge identity');
    const node = { id, offset: o, name: heap.strings[heap.nodes[o + n.name]], type: nt[heap.nodes[o + n.type]], edgeOffset: ep, count };
    byOffset.set(o, node); byId.set(id, node); ep += count * ef.length;
  }
  if (ep !== heap.edges.length) throw Error('Invalid edge counts');
  let rawPathValidation = null;
  if (requiredPath) {
    if (!Array.isArray(requiredPath) || !requiredPath.length || requiredPath.length > 100) throw Error('Invalid required retaining path');
    for (let i = 0; i < requiredPath.length; i++) {
      const quoted = requiredPath[i], node = byId.get(quoted.id);
      if (!node || node.name !== quoted.name || node.type !== quoted.type) throw Error('Retaining path node does not match raw snapshot');
      if (i === requiredPath.length - 1) break;
      const edge = quoted.edgeToNext, nextId = requiredPath[i + 1].id;
      if (!edge || edge.type === 'weak') throw Error('Missing/weak retaining path edge');
      let matched = false;
      for (let o = node.edgeOffset; o < node.edgeOffset + node.count * ef.length; o += ef.length) {
        const type = et[heap.edges[o + e.type]], to = byOffset.get(heap.edges[o + e.to_node]);
        const name = ['element', 'hidden'].includes(type) ? heap.edges[o + e.name_or_index] : heap.strings[heap.edges[o + e.name_or_index]];
        if (to?.id === nextId && type === edge.type && String(name) === String(edge.name)) matched = true;
      }
      if (!matched) throw Error('Retaining path edge is not present in raw snapshot');
    }
    rawPathValidation = { status: 'all-literal-raw-edges-matched', nodes: requiredPath.length, edges: requiredPath.length - 1, explicitWeakEdges: 0 };
  }
  const locations = new Map();
  for (let o = 0; o < heap.locations.length; o += lf.length) {
    const offset = heap.locations[o + l.object_index], scriptId = heap.locations[o + l.script_id], line = heap.locations[o + l.line], column = heap.locations[o + l.column];
    if (!byOffset.has(offset) || !Number.isSafeInteger(scriptId) || scriptId < 0 || !Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(column) || column < 0 || locations.has(offset)) throw Error('Invalid or duplicate node location');
    locations.set(offset, { scriptId: String(scriptId), line, column });
  }
  const seeds = [...new Set(seedIds)].map(id => { const node = byId.get(id); if (!node) throw Error('Measured path seed is absent from raw heap'); return { node, seedNodeId: id, depth: 0, route: [] }; });
  const queue = [...seeds], queued = new Set(seedIds), visited = new Set(), positions = [], unknown = [];
  const direct = { requestedNodes: seeds.length, inspectedNodes: 0, locatedNodes: 0, missingLocations: 0, emittedPositions: 0, omittedPositions: 0, outcomes: [], inspectionComplete: false, outputComplete: false };
  const neighbors = { inspectedNodes: 0, emittedPositions: 0, omittedPositionsAtLeast: 0, stopReason: 'frontier-exhausted-within-depth-policy', queuedNodesNotInspected: 0, coverage: 'exhausted-under-depth-and-edge-policy' };
  let edges = 0, unknownLocationCount = 0;
  function inspect(item) {
    visited.add(item.node.id);
    if (item.depth === 0) direct.inspectedNodes++; else neighbors.inspectedNodes++;
    const location = locations.get(item.node.offset), relevant = item.depth === 0 || item.node.type === 'closure';
    let status = 'not-a-neighbor-function';
    if (relevant && location) {
      if (item.depth === 0) direct.locatedNodes++;
      if (positions.length >= sourcePolicy.maxCandidatePositions) {
        status = 'omitted-position-limit';
        if (item.depth === 0) direct.omittedPositions++; else neighbors.omittedPositionsAtLeast++;
      } else {
        status = 'emitted';
        positions.push({ nodeId: item.node.id, nodeName: item.node.name, nodeType: item.node.type, location, relation: { kind: item.depth === 0 ? 'direct-path-node-location' : 'property-nearby-function-location', seedNodeId: item.seedNodeId, depth: item.depth, route: item.route }, interpretation: 'V8 node/constructor or function definition location; not an observed allocation stack or retaining write statement.' });
        if (item.depth === 0) direct.emittedPositions++; else neighbors.emittedPositions++;
      }
    } else if (relevant) {
      status = 'missing-location'; unknownLocationCount++; if (item.depth === 0) direct.missingLocations++;
      if (unknown.length < sourcePolicy.maxCandidatePositions) unknown.push({ nodeId: item.node.id, nodeType: item.node.type, code: 'no-node-location', depth: item.depth });
    }
    if (item.depth === 0) direct.outcomes.push({ nodeId: item.node.id, status });
    return status;
  }
  // Finish direct location inspection before any adjacency traversal. In
  // particular, a large Context/global object cannot starve later path nodes.
  for (const item of seeds) inspect(item);
  direct.inspectionComplete = true; direct.outputComplete = direct.omittedPositions === 0;
  traversal: for (let qi = 0; qi < queue.length; qi++) {
    const item = queue[qi];
    if (item.depth && inspect(item) === 'omitted-position-limit') { neighbors.stopReason = 'position-limit'; break; }
    if (item.depth >= sourcePolicy.maxNeighborDepth || item.node.type === 'closure') continue;
    for (let o = item.node.edgeOffset; o < item.node.edgeOffset + item.node.count * ef.length; o += ef.length) {
      if (edges === sourcePolicy.maxTraversedEdges) { neighbors.stopReason = 'edge-limit'; break traversal; }
      edges++;
      const type = et[heap.edges[o + e.type]], to = byOffset.get(heap.edges[o + e.to_node]);
      if (!type || !to) throw Error('Invalid graph edge');
      if (!sourcePolicy.neighborEdgeTypes.includes(type) || queued.has(to.id)) continue;
      const name = heap.strings[heap.edges[o + e.name_or_index]];
      queued.add(to.id); queue.push({ node: to, seedNodeId: item.seedNodeId, depth: item.depth + 1, route: [...item.route, { from: item.node.id, to: to.id, name, type }] });
    }
  }
  neighbors.queuedNodesNotInspected = queue.filter(item => item.depth > 0 && !visited.has(item.node.id)).length;
  if (neighbors.stopReason !== 'frontier-exhausted-within-depth-policy') neighbors.coverage = 'incomplete-bounded-prefix';
  const truncated = direct.omittedPositions > 0 || neighbors.coverage === 'incomplete-bounded-prefix';
  return { positions, unknown, unknownLocationCount, unknownSamplesTruncated: unknownLocationCount > unknown.length, truncated, coverage: { direct, neighbors }, visitedNodes: visited.size, traversedEdges: edges, locationCount: locations.size, rawPathValidation };
}

export function validateScriptRegistry(registry, life, manifest) {
  const bad = code => ({ status: 'invalid', code });
  if (!registry) return { status: 'unknown', code: 'missing-contemporaneous-script-registry' };
  if (registry.schemaVersion !== '0.1.0' || registry.runId !== life.runId || registry.captureReportSha256 !== life.inputs.captureReportSha256 || registry.identitySha256 !== life.inputs.identity?.sha256) return bad('script-registry-run-binding-mismatch');
  if (!registry.sessionId || registry.epochId !== manifest.epochId || registry.runtime?.pid !== manifest.runtime.pid || registry.runtime?.threadId !== manifest.runtime.threadId || registry.runtime?.kind !== manifest.runtime.kind || registry.collector?.sha256 !== manifest.collector.sha256) return bad('script-registry-epoch-mismatch');
  if (!Array.isArray(registry.points) || registry.points.length !== life.inputs.points.length || registry.points.some((p, i) => p.path !== life.inputs.points[i].path || p.sha256 !== life.inputs.points[i].sha256)) return bad('script-registry-snapshot-mismatch');
  if (!Array.isArray(registry.scripts) || registry.scripts.length > 128) return bad('script-registry-budget');
  const ids = new Set();
  for (const script of registry.scripts) {
    if (typeof script.scriptId !== 'string' || !/^\d+$/.test(script.scriptId) || ids.has(script.scriptId)) return bad('ambiguous-script-id');
    ids.add(script.scriptId);
  }
  return { status: 'validated-consistency', scripts: ids.size, trust: 'Contemporaneous collector registry, conditional on collector truthfulness; source hashes are not execution attestation.' };
}

export async function mapSourcePosition(position, scripts, runDir, maxSourceBytes = sourcePolicy.maxSourceBytes) {
  const unknown = (code, extra = {}) => ({ ...position, status: 'unknown', code, ...extra });
  const script = scripts.find(s => s.scriptId === position.location.scriptId);
  if (!script) return unknown('script-id-not-recorded');
  if (script.hasSourceURL || script.startLine !== 0 || script.startColumn !== 0) return unknown('unsupported-virtual-or-offset-script');
  let file;
  try {
    const url = new URL(script.url);
    if (url.protocol !== 'file:') return unknown('unsupported-script-url');
    file = await realpath(fileURLToPath(url));
    const recorded = await realpath(resolve(runDir, script.path));
    if (file !== recorded || !file.startsWith(runDir + sep)) return unknown('source-path-outside-recorded-run');
    if ((await stat(file)).size > maxSourceBytes) return unknown('source-size-budget');
  } catch { return unknown('source-file-unavailable'); }
  const raw = await readFile(file), hash = sha256(raw);
  if (hash !== script.sourceSha256 || hash !== script.inspectorSourceSha256) return unknown('stale-or-unmatched-source-bytes');
  const lines = raw.toString('utf8').split(/\r\n|[\n\r\u2028\u2029]/), { line, column } = position.location;
  if (line >= lines.length || column > lines[line].length) return unknown('location-out-of-range');
  return { ...position, status: 'mapped-generated-source', code: 'exact-loaded-and-local-source-bytes', reliability: 'Exact supplied V8 location -> contemporaneously registered generated script -> matching loaded/local bytes; causal role remains a hypothesis.', source: { path: file, url: script.url, sha256: hash, scriptId: script.scriptId, line: line + 1, column: column + 1, coordinates: '1-based display; V8 input is 0-based UTF-16', excerpt: lines[line].slice(0, 180) }, originalSourceMapping: script.sourceMapURL ? { status: 'unknown', code: 'source-map-not-resolved', sourceMapURL: script.sourceMapURL } : { status: 'generated-source-only', code: 'no-source-map-recorded' } };
}

export async function analyzeSourceCandidates(runDir, identityPath = null, scriptsPath = null, contractPath = null, options = {}) {
  const begin = performance.now();
  if (options.growthPath && options.evidencePath) throw Error('Choose --growth or --evidence, not both');
  if (options.growthPath) validateNativeSourceOptions(options.searchOptions);
  else if (options.searchOptions) throw Error('Native search options require --growth');
  const maxSourceBytes = options.maxSourceBytes ?? sourcePolicy.maxSourceBytes;
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1024 || maxSourceBytes > 16 * 1024 ** 2) throw Error('Source byte budget must be an integer from 1024 to 16777216');
  const life = await analyzeLifecycle(runDir, identityPath, contractPath);
  const report = { schemaVersion: '0.1.0', status: 'completed', method: 'Measured route -> V8 node positions/property-nearby closures -> same-epoch loaded/local source bytes', runId: life.runId, inputs: life.inputs, identity: life.identity, lifecycleAssessment: life.assessment, policy: sourcePolicy, registry: null, selected: null, candidates: [], unknown: [], conclusion: { sourceMapping: 'unknown', causalSourceLocalization: 'not-determined', leakVerdict: 'not-determined', repairValidation: 'not-tested', browserValidation: 'not-completed', strictBlindTest: 'not-started' } };
  report.tool = { implementationSha256: sha256(await readFile(new URL(import.meta.url))), lifecycle: life.tool };
  report.policy = { ...sourcePolicy, maxSourceBytes, sourceMaps: options.sourceMapContextPath ? 'opt-in-bound-local-flat-map' : sourcePolicy.sourceMaps };
  report.series = life.measurements.map(p => ({ point: p.point, resources: p.resources.map(r => ({ id: r.id, token: r.token, ownerRoute: r.ownerRoute })) }));
  const finish = () => { report.resources = { elapsedMs: performance.now() - begin, maxRssKiB: process.resourceUsage().maxRSS, maxOldSpaceMiB: 512 }; return report; };
  if (!life.identity.comparable) { report.status = life.identity.status === 'invalid' ? 'refused' : 'completed'; report.unknown.push({ code: life.identity.code }); return finish(); }
  const manifest = (await readBoundJson(life.inputs.identity.path)).value;
  const registryFile = scriptsPath ? await readBoundJson(scriptsPath) : null;
  report.inputs.scripts = registryFile && { path: registryFile.path, sha256: registryFile.sha256 };
  report.registry = validateScriptRegistry(registryFile?.value, life, manifest);
  if (report.registry.status !== 'validated-consistency') { if (report.registry.status === 'invalid') report.status = 'refused'; report.unknown.push({ code: report.registry.code }); return finish(); }
  let pointIndex, point, path, requiredPath = null;
  if (options.growthPath) {
    const input = await loadNativeSourceEvidence(options.growthPath, report, options.searchOptions); report.nativeEvidence = input;
    if (input.status !== 'selected') { if (input.status === 'invalid') report.status = 'refused'; report.unknown.push({ code: input.code }); return finish(); }
    pointIndex = input.pointIndex; point = life.inputs.points[pointIndex]; path = input.path; requiredPath = path;
    report.selected = { pointIndex, snapshot: point.path, snapshotSha256: point.sha256, nodeId: input.selection.nodeId, group: input.selection.group, literalPath: path, selection: input.provenance, businessOwnership: 'unknown-for-untagged-object', representativeLifecycle: input.representativeLifecycle, origin: 'native-generic-growth-path' };
  } else if (options.evidencePath) {
    const input = await loadSourceEvidence(options.evidencePath, report); report.inputs.growthEvidence = input.input;
    if (input.status !== 'selected') { if (input.status === 'invalid') report.status = 'refused'; report.unknown.push({ code: input.code }); return finish(); }
    pointIndex = input.pointIndex; point = life.inputs.points[pointIndex]; path = input.path; requiredPath = path;
    report.selected = { pointIndex, snapshot: point.path, snapshotSha256: point.sha256, nodeId: input.selection.nodeId, group: input.selection.group, retainingPath: path, selection: input.provenance, businessOwnership: 'unknown-for-untagged-object', origin: 'generic-growth-evidence' };
  } else {
    pointIndex = life.inputs.points.findLastIndex(p => p.phase === 'back'); point = life.inputs.points[pointIndex];
    const resource = life.measurements[pointIndex].resources.filter(r => r.ownerRoute.status === 'observed').sort((a, b) => a.id - b.id)[0];
    if (!resource) { report.unknown.push({ code: 'no-measured-owner-route' }); return finish(); }
    path = resource.ownerRoute.path;
    report.selected = { pointIndex, snapshot: point.path, snapshotSha256: point.sha256, nodeId: resource.id, token: resource.token, measuredOwnerRoute: path, selection: 'Lowest-ID tagged resource with a measured owner route in the final returned snapshot; no class/file/name filter.' };
  }
  global.gc?.();
  const raw = await readFile(point.path); if (sha256(raw) !== point.sha256) throw Error('Selected source snapshot changed');
  const positions = sourcePositions(JSON.parse(raw), path.map(p => p.id), requiredPath);
  report.search = { ...positions, positions: undefined }; report.unknown.push(...positions.unknown);
  if (requiredPath && !positions.rawPathValidation) { report.unknown.push({ code: 'retaining-path-not-validated-without-location-metadata' }); return finish(); }
  global.gc?.();
  for (const p of positions.positions) {
    const mapped = await mapSourcePosition(p, registryFile.value.scripts, life.inputs.runDir, maxSourceBytes);
    if (mapped.status === 'mapped-generated-source') report.candidates.push(mapped); else report.unknown.push(mapped);
  }
  report.conclusion.sourceMapping = report.candidates.length ? 'generated-source-candidates' : 'unknown';
  if (options.sourceMapContextPath) {
    global.gc?.();
    const original = await mapOriginalSources(report, options.sourceMapContextPath);
    report.originalSourceEvidence = original.evidence; report.candidates = original.candidates;
    report.tool.originalSourceImplementationSha256 = sha256(await readFile(new URL('./original-source.mjs', import.meta.url)));
    report.tool.originalSourceModules = Object.fromEntries(await Promise.all(['source-artifacts.mjs', 'dependency-source.mjs'].map(async name => [name, sha256(await readFile(new URL('./' + name, import.meta.url)))])));
    report.conclusion.originalSourceMapping = original.evidence.status === 'invalid' ? 'refused' : original.evidence.mappedRecords ? 'original-source-anchors' : 'unknown';
    if (original.evidence.status === 'invalid') report.status = 'refused';
  }
  return finish();
}
