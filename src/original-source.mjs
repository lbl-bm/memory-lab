import {readFile, realpath} from 'node:fs/promises';
import {resolve, relative, isAbsolute} from 'node:path';
import {sha256, readBoundJson} from './heap-identity.mjs';
import {reject, hex, inside, pathKey, scopedPath, scopedRead, errorResult, sourceLines, parseLocalMap, lookupOriginalAnchor} from './source-artifacts.mjs';
import {createDependencyResolver, dependencySourcePolicy} from './dependency-source.mjs';

export {lookupOriginalAnchor};
export const originalSourcePolicy = Object.freeze({
  maxContextBytes: 256 * 1024, maxBuildBytes: 4 * 1024 ** 2, maxMapBytes: 32 * 1024 ** 2,
  maxSources: 10000, maxOriginalSourceBytes: 1024 ** 2,
  parser: 'node:module.SourceMap.findEntry', supported: 'flat v3; normalized unique relative local sources; empty sourceRoot',
  bias: 'preceding mapped segment on same generated line; no column interpolation',
  causalLocalization: 'not-implemented', dependencySources: dependencySourcePolicy,
});
const notEvaluated = () => ({status: 'not-evaluated', code: 'mapping-input-not-verified'});

export async function mapOriginalSources(report, contextPath) {
  const begin = performance.now(), evidence = {
    status: 'unknown', input: null, build: null, map: null, policy: originalSourcePolicy,
    parser: {name: 'node:module.SourceMap', node: process.version},
    trust: 'Local hash consistency under collector/build trust; post-capture links do not attest historical dependency map bytes.',
    coordinates: {decodedRecords: 0, unknownRecords: 0, notEvaluatedRecords: 0},
    provenance: {directBuildInputRecords: 0, postCaptureDependencyRecords: 0, unknownRecords: 0, invalidRecords: 0},
    mappedRecords: 0, unknownRecords: 0, invalidRecords: 0,
  };
  let candidates = report.candidates;
  const finish = () => ({evidence: {...evidence, resources: {elapsedMs: performance.now() - begin, maxRssKiB: process.resourceUsage().maxRSS}}, candidates});
  try {
    if (!report.identity?.comparable || report.registry?.status !== 'validated-consistency') reject('original-mapping-requires-verified-runtime-context');
    const file = await readBoundJson(contextPath, originalSourcePolicy.maxContextBytes), context = file.value;
    evidence.input = {path: file.path, sha256: file.sha256};
    if (context.schemaVersion !== '0.1.0' || context.capture?.runId !== report.runId || context.capture.reportSha256 !== report.inputs.captureReportSha256 || context.capture.identitySha256 !== report.inputs.identity?.sha256 || context.capture.scriptsSha256 !== report.inputs.scripts?.sha256) reject('source-map-run-binding-mismatch');
    if (context.dependencySources !== undefined && context.dependencySources?.mode !== dependencySourcePolicy.mode) reject('unsupported-dependency-source-mode', 'unknown');
    if (typeof context.workspaceRoot !== 'string' || !isAbsolute(context.workspaceRoot)) reject('invalid-mapping-workspace');
    const root = await realpath(context.workspaceRoot);
    if (report.inputs.runDir !== root && !inside(root, report.inputs.runDir)) reject('run-outside-mapping-workspace');
    const buildFile = await scopedRead(root, context.build?.path, originalSourcePolicy.maxBuildBytes);
    if (!hex(context.build?.sha256) || buildFile.sha256 !== context.build.sha256) reject('build-hash-mismatch');
    const build = JSON.parse(buildFile.bytes), script = context.script;
    evidence.build = {path: buildFile.path, sha256: buildFile.sha256, repoSha: build.sha};
    const captureBytes = await readFile(resolve(report.inputs.runDir, 'report.json'));
    if (sha256(captureBytes) !== report.inputs.captureReportSha256) reject('capture-report-changed');
    const capture = JSON.parse(captureBytes);
    if (capture.repo?.sha && build.sha !== capture.repo.sha) reject('build-revision-mismatch');
    if (!script || typeof script.id !== 'string' || !/^\d+$/.test(script.id) || !hex(script.sourceSha256) || script.sourceSha256 !== build.bundleSha256 || !hex(script.mapSha256) || script.mapSha256 !== build.sourceMapSha256) reject('build-bundle-map-binding-mismatch');
    if (!build.inputs || Array.isArray(build.inputs) || typeof build.inputs !== 'object' || Object.keys(build.inputs).length > originalSourcePolicy.maxSources || build.inputCount !== Object.keys(build.inputs).length) reject('unsupported-build-input-list');
    const inputs = new Map();
    for (const [path, hash] of Object.entries(build.inputs)) {
      if (!hex(hash)) reject('invalid-build-source-hash');
      const p = scopedPath(root, path), key = pathKey(p);
      if (inputs.has(key)) reject('ambiguous-build-source-path');
      inputs.set(key, {path: p, sha256: hash});
    }
    const registryBytes = await readFile(report.inputs.scripts.path);
    if (sha256(registryBytes) !== report.inputs.scripts.sha256) reject('script-registry-changed');
    const registry = JSON.parse(registryBytes), registered = registry.scripts.filter(s => s.scriptId === script.id);
    if (registered.length !== 1 || registered[0].sourceSha256 !== script.sourceSha256 || registered[0].inspectorSourceSha256 !== script.sourceSha256) reject('registered-bundle-mismatch');
    const mapFile = await scopedRead(root, script.mapPath, originalSourcePolicy.maxMapBytes);
    if (mapFile.sha256 !== script.mapSha256) reject('map-hash-mismatch');
    evidence.map = {path: mapFile.path, sha256: mapFile.sha256, bytes: mapFile.bytes.length};
    const payload = JSON.parse(mapFile.bytes), parsed = parseLocalMap(payload, mapFile.path, originalSourcePolicy.maxSources);
    const sourceCache = new Map(), resolver = context.dependencySources ? createDependencyResolver(root, inputs) : null;
    evidence.map.sourceCount = payload.sources.length;
    evidence.dependencyResolution = {enabled: !!resolver, observation: 'post-capture', stats: resolver?.stats ?? null};
    async function original(candidate) {
      let coordinateEvidence = notEvaluated(), provenance = {status: 'unknown', code: 'not-evaluated'};
      try {
        if (candidate.status !== 'mapped-generated-source') reject('generated-position-not-verified', 'unknown');
        if (candidate.location.scriptId !== script.id) reject('script-not-covered-by-mapping-context', 'unknown');
        if (candidate.source.sha256 !== script.sourceSha256 || candidate.source.scriptId !== script.id) reject('candidate-bundle-mismatch');
        const anchor = lookupOriginalAnchor(parsed.map, candidate.location.line, candidate.location.column);
        if (anchor.status !== 'mapped-anchor') { coordinateEvidence = anchor; return {...anchor, coordinateEvidence, provenance}; }
        const index = parsed.indexes.get(anchor.entry.originalSource);
        if (index === undefined) reject('source-not-in-map', 'unknown');
        const {originalLine: line, originalColumn: column} = anchor.entry;
        coordinateEvidence = {status: 'decoded-anchor', sourceReference: anchor.entry.originalSource, sourceIndex: index,
          originalAnchor: {line, column}, generatedQuery: anchor.generatedQuery, generatedAnchor: anchor.generatedAnchor,
          precision: anchor.precision, columnDistance: anchor.columnDistance, coordinates: 'zero-based UTF-16', mapSha256: mapFile.sha256};
        const lexical = parsed.paths[index], key = pathKey(lexical);
        if (!inside(root, lexical)) reject('source-outside-workspace', 'unknown');
        const embeddedHash = payload.sourcesContent?.[index] == null ? null : sha256(payload.sourcesContent[index]);
        const direct = inputs.get(key);
        if (direct) provenance = {status: 'validated-consistency', tier: 'direct-build-input', expectedSha256: direct.sha256};
        else if (!resolver) reject('source-not-in-build-inputs', 'unknown');
        else {
          provenance = await resolver.resolve(lexical, {line, column}, embeddedHash);
          if (provenance.status !== 'validated-consistency') return {status: provenance.status, code: provenance.code, coordinateEvidence, provenance};
        }
        let source = sourceCache.get(key);
        if (!source) {
          const f = await scopedRead(root, relative(root, lexical), originalSourcePolicy.maxOriginalSourceBytes);
          source = {path: f.path, sha256: f.sha256, observedAt: f.observedAt, lines: sourceLines(f.bytes.toString('utf8'))};
          sourceCache.set(key, source);
        }
        // Hash/content checks are per source reference even on a byte-cache hit.
        if (direct && source.sha256 !== direct.sha256) reject('original-source-hash-mismatch');
        if (embeddedHash !== null && source.sha256 !== embeddedHash) reject('embedded-source-content-mismatch');
        if (!direct && !inside(provenance.packageRoot, source.path)) reject('dependency-original-outside-package', 'unknown');
        if (line >= source.lines.length || column > source.lines[line].length) reject('original-position-out-of-range', 'unknown');
        provenance = {...provenance, sourceObservedAt: source.observedAt, sourceSha256: source.sha256,
          preservedContent: {present: embeddedHash !== null, sha256: embeddedHash, bundleMapSha256: mapFile.sha256, sourceIndex: index}};
        return {status: 'mapped-original-source', code: direct ? 'bound-build-map-and-original-bytes' : 'bound-map-content-and-post-capture-dependency-link',
          coordinateEvidence, provenance, precision: anchor.precision, generatedQuery: anchor.generatedQuery, generatedAnchor: anchor.generatedAnchor, columnDistance: anchor.columnDistance,
          source: {path: source.path, sha256: source.sha256, line: line + 1, column: column + 1, coordinates: '1-based display; zero-based UTF-16 mapping anchor', excerpt: source.lines[line].slice(0, 180)},
          mapping: {contextSha256: file.sha256, buildSha256: buildFile.sha256, mapSha256: mapFile.sha256, sourceIndex: index, embeddedContentChecked: embeddedHash !== null}, causalRole: 'not-established'};
      } catch (error) {
        const failure = errorResult(error);
        return {...failure, coordinateEvidence, provenance: {...provenance, status: failure.status, code: failure.code}};
      }
    }
    candidates = [];
    for (const candidate of report.candidates) {
      const mapping = await original(candidate); candidates.push({...candidate, originalSourceMapping: mapping});
      evidence.coordinates[mapping.coordinateEvidence.status === 'decoded-anchor' ? 'decodedRecords' : mapping.coordinateEvidence.status === 'not-evaluated' ? 'notEvaluatedRecords' : 'unknownRecords']++;
      if (mapping.status === 'mapped-original-source') { evidence.mappedRecords++; evidence.provenance[mapping.provenance.tier === 'direct-build-input' ? 'directBuildInputRecords' : 'postCaptureDependencyRecords']++; }
      else if (mapping.status === 'invalid') { evidence.invalidRecords++; evidence.provenance.invalidRecords++; }
      else { evidence.unknownRecords++; evidence.provenance.unknownRecords++; }
    }
    evidence.status = evidence.invalidRecords ? 'invalid' : evidence.mappedRecords ? 'completed-with-coverage-limits' : 'unknown';
    evidence.code = evidence.invalidRecords ? 'original-source-binding-contradiction' : evidence.mappedRecords ? null : 'no-supported-original-position';
  } catch (error) {
    const failure = errorResult(error); Object.assign(evidence, failure);
    candidates = report.candidates.map(c => ({...c, originalSourceMapping: {...failure, coordinateEvidence: notEvaluated(), provenance: failure}}));
    evidence.coordinates.notEvaluatedRecords = candidates.length;
    evidence.invalidRecords = failure.status === 'invalid' ? candidates.length : 0;
    evidence.unknownRecords = failure.status === 'invalid' ? 0 : candidates.length;
    evidence.provenance.invalidRecords = evidence.invalidRecords; evidence.provenance.unknownRecords = evidence.unknownRecords;
  }
  return finish();
}
