import {realpath} from 'node:fs/promises';
import {dirname, basename, extname, resolve, relative, sep, isAbsolute} from 'node:path';
import {sha256} from './heap-identity.mjs';
import {inside, pathKey, scopedRead, reject, errorResult, parseLocalMap, sourceLines, lookupOriginalAnchor} from './source-artifacts.mjs';

export const dependencySourcePolicy = Object.freeze({
  mode: 'post-capture-js-map-source', maxJsBytes: 1024 ** 2, maxMapBytes: 2 * 1024 ** 2,
  maxAttemptsPerOriginal: 32, maxUniqueJs: 64, maxObservedBytes: 16 * 1024 ** 2,
  maxQueriesPerJs: 100000, maxQueriesTotal: 250000, maxWitnessesPerAnchor: 8,
  discovery: 'same node_modules package recorded build inputs; matching file stem first, then deterministic path order',
  tier: 'preserved-map-content-plus-post-capture-dependency-link',
  historicalDependencyMap: 'not-recorded', exactIntermediateTransform: 'not-established',
});

function packageRoot(path) {
  const parts = path.split(sep), index = parts.lastIndexOf('node_modules');
  if (index < 0 || !parts[index + 1]) return null;
  const end = index + (parts[index + 1].startsWith('@') ? 3 : 2);
  return parts.length > end ? parts.slice(0, end).join(sep) : null;
}
const stem = p => basename(p, extname(p));
const anchorKey = (index, line, column) => index + ':' + line + ':' + column;
function declaredMap(text) {
  const mentions = [...text.matchAll(/sourceMappingURL\s*=/g)].length;
  if (mentions !== 1) reject(mentions ? 'multiple-source-map-declarations' : 'missing-source-map-declaration', 'unknown');
  const trailing = text.match(/(?:^|[\r\n\u2028\u2029])\/\/[#@]\s*sourceMappingURL=([^\r\n\u2028\u2029]*)[\r\n\u2028\u2029\s]*$/);
  const ref = trailing?.[1].trim();
  if (!ref || isAbsolute(ref) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) || /[?#%\\\s]/.test(ref)) reject('unsupported-source-map-declaration', 'unknown');
  return ref;
}

// All links below are CURRENT observations. Their hashes must never be presented
// as build-time dependency-map hashes. No network fetch or source-name heuristic.
export function createDependencyResolver(root, inputs) {
  const cache = new Map();
  const stats = {uniqueJs: 0, observedBytes: 0, positionQueries: 0, cacheHits: 0};
  async function observe(path, maxBytes) {
    if (stats.observedBytes >= dependencySourcePolicy.maxObservedBytes) reject('dependency-observation-byte-budget', 'unknown');
    const remaining = dependencySourcePolicy.maxObservedBytes - stats.observedBytes;
    const f = await scopedRead(root, relative(root, path), Math.min(maxBytes, remaining));
    stats.observedBytes += f.bytes.length;
    return f;
  }
  async function probe(input, pkg) {
    const key = pathKey(input.path);
    if (cache.has(key)) { stats.cacheHits++; return cache.get(key); }
    if (stats.uniqueJs >= dependencySourcePolicy.maxUniqueJs) reject('dependency-file-budget', 'unknown');
    stats.uniqueJs++;
    try {
      const canonicalPackage = await realpath(pkg);
      if (!inside(root, canonicalPackage)) reject('dependency-package-outside-workspace', 'unknown');
      const js = await observe(input.path, dependencySourcePolicy.maxJsBytes);
      if (!inside(canonicalPackage, js.path)) reject('dependency-js-outside-package', 'unknown');
      if (js.sha256 !== input.sha256) reject('dependency-js-build-hash-mismatch');
      const declaration = declaredMap(js.bytes.toString('utf8')), mapPath = resolve(dirname(js.path), declaration);
      if (!inside(canonicalPackage, mapPath)) reject('dependency-map-outside-package', 'unknown');
      const file = await observe(mapPath, dependencySourcePolicy.maxMapBytes);
      if (!inside(canonicalPackage, file.path)) reject('dependency-map-outside-package', 'unknown');
      const payload = JSON.parse(file.bytes), parsed = parseLocalMap(payload, file.path);
      const lines = sourceLines(js.bytes.toString('utf8')), anchors = new Map();
      let queries = 0, exhausted = false, lastAnchor = '';
      scan: for (let line = 0; line < lines.length; line++) for (let column = 0; column <= lines[line].length; column++) {
        if (queries >= dependencySourcePolicy.maxQueriesPerJs || stats.positionQueries >= dependencySourcePolicy.maxQueriesTotal) { exhausted = true; break scan; }
        queries++; stats.positionQueries++;
        const a = lookupOriginalAnchor(parsed.map, line, column);
        if (a.status !== 'mapped-anchor') continue;
        const generatedKey = line + ':' + a.generatedAnchor.column;
        if (generatedKey === lastAnchor) continue;
        lastAnchor = generatedKey;
        const index = parsed.indexes.get(a.entry.originalSource);
        if (index === undefined) continue;
        const k = anchorKey(index, a.entry.originalLine, a.entry.originalColumn);
        let group = anchors.get(k);
        if (!group) { group = {count: 0, witnesses: []}; anchors.set(k, group); }
        group.count++;
        if (group.witnesses.length < dependencySourcePolicy.maxWitnessesPerAnchor) group.witnesses.push({generatedAnchor: a.generatedAnchor, originalAnchor: {sourceIndex: index, sourceReference: a.entry.originalSource, line: a.entry.originalLine, column: a.entry.originalColumn}});
      }
      const result = {status: 'observed', package: canonicalPackage,
        js: {path: js.path, sha256: js.sha256, bytes: js.bytes.length, observedAt: js.observedAt, expectedBuildSha256: input.sha256},
        map: {path: file.path, sha256: file.sha256, bytes: file.bytes.length, observedAt: file.observedAt, historicalSha256: null},
        declaration, paths: parsed.paths, contentHashes: payload.sources.map((_, i) => payload.sourcesContent?.[i] == null ? null : sha256(payload.sourcesContent[i])), anchors,
        coverage: {positionQueries: queries, completeWithinJsText: !exhausted, stopReason: exhausted ? 'position-query-budget' : 'all-js-text-positions', mappedAnchors: anchors.size}};
      cache.set(key, result); return result;
    } catch (error) { const failure = errorResult(error); cache.set(key, failure); return failure; }
  }
  return {stats, async resolve(sourcePath, coordinate, embeddedHash) {
    if (!embeddedHash) return {status: 'unknown', code: 'dependency-source-missing-preserved-content'};
    const pkg = packageRoot(sourcePath);
    if (!pkg || !inside(root, pkg)) return {status: 'unknown', code: 'unsupported-dependency-package-layout'};
    const candidates = [...inputs.values()].filter(f => inside(pkg, f.path) && /\.(?:c|m)?js$/i.test(f.path));
    candidates.sort((a, b) => Number(stem(b.path) === stem(sourcePath)) - Number(stem(a.path) === stem(sourcePath)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const search = {eligibleInputs: candidates.length, attempts: [], attemptLimit: dependencySourcePolicy.maxAttemptsPerOriginal, completeness: 'not-exhaustive', selection: dependencySourcePolicy.discovery};
    let found = null;
    for (const input of candidates.slice(0, dependencySourcePolicy.maxAttemptsPerOriginal)) {
      let p; try { p = await probe(input, pkg); } catch (error) { p = errorResult(error); }
      const attempt = {path: input.path, status: p.status, code: p.code}; search.attempts.push(attempt);
      if (p.status === 'invalid') return {...p, search};
      if (p.status !== 'observed') continue;
      const index = p.paths.findIndex(s => pathKey(s) === pathKey(sourcePath));
      if (index < 0) { attempt.code = 'dependency-map-other-source'; continue; }
      const group = p.anchors.get(anchorKey(index, coordinate.line, coordinate.column));
      attempt.coverage = p.coverage;
      if (!group) { attempt.code = p.coverage.completeWithinJsText ? 'dependency-coordinate-not-witnessed' : 'dependency-coordinate-query-budget'; continue; }
      if (p.contentHashes[index] !== null && p.contentHashes[index] !== embeddedHash) return {status: 'invalid', code: 'dependency-embedded-source-content-mismatch', search};
      found = {p, index, group}; break;
    }
    search.completeness = found ? 'first-supported-witness' : candidates.length > search.attempts.length ? 'attempt-limit' : 'all-eligible-inputs-attempted';
    if (!found) return {status: 'unknown', code: !candidates.length ? 'no-recorded-dependency-js' : search.completeness === 'attempt-limit' ? 'dependency-attempt-budget' : 'no-supported-dependency-link', search};
    const {p, index, group} = found;
    return {status: 'validated-consistency', tier: dependencySourcePolicy.tier, checkedAt: new Date().toISOString(), sourceExpectedSha256: embeddedHash,
      packageRoot: p.package, publishedJs: p.js, declaration: {kind: 'unique-trailing-local-sourceMappingURL', value: p.declaration}, dependencyMap: p.map,
      sourceIndex: index, dependencyEmbeddedContentChecked: p.contentHashes[index] !== null,
      coordinateWitnesses: group.witnesses, coordinateWitnessCount: group.count, witnessesTruncated: group.count > group.witnesses.length,
      coverage: p.coverage, search, historicalDependencyMap: 'not-recorded', exactIntermediateTransform: 'not-established', causalRole: 'not-established'};
  }};
}
