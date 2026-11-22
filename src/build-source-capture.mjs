import {readFile, writeFile, mkdir, realpath} from 'node:fs/promises';
import {resolve, relative, dirname, sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256, readBoundJson} from './heap-identity.mjs';
import {inside, pathKey, scopedRead, parseLocalMap} from './source-artifacts.mjs';

export const buildSourcePolicy = Object.freeze({maxInputs: 512, maxJsBytes: 1024 ** 2, maxSourceBytes: 1024 ** 2, maxMapBytes: 2 * 1024 ** 2, maxPackageBytes: 256 * 1024, maxReadBytes: 32 * 1024 ** 2, maxStoredBytes: 32 * 1024 ** 2, maxOutputBytes: 10 * 1024 ** 2, maxManifestBytes: 4 * 1024 ** 2, supported: 'local UTF-8 JS; unique trailing external local flat map; same explicit scope; no indexed maps/sourceRoot/remote/recursive maps', trust: 'collector and esbuild consistency; not authenticity or runtime execution attestation'});
class BuildEvidenceError extends Error {constructor(code) {super(code); this.code = code;}}
const fail = code => {throw new BuildEvidenceError(code);};
const ensure = (value, code) => {if (!value) fail(code);};
const digest = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const local = p => p.split(sep).join('/');
function utf8(bytes) {const text = bytes.toString('utf8'); ensure(Buffer.from(text, 'utf8').equals(bytes), 'non-utf8-source'); return text;}
function declaration(text) {
  const count = [...text.matchAll(/sourceMappingURL\s*=/g)].length;
  if (count === 0) return null;
  ensure(count === 1, 'multiple-source-map-declarations');
  const matches = [...text.matchAll(/^\/\/[#@][ \t]*sourceMappingURL=([^\r\n\u2028\u2029]*)$/gm)];
  ensure(matches.length === 1, 'unsupported-source-map-declaration');
  const m = matches[0], ref = m[1].trim();
  ensure(!text.slice(m.index + m[0].length).trim() && ref && !/^[\/\\]|^[A-Za-z][A-Za-z0-9+.-]*:|[?#%\\\s]/.test(ref), 'unsupported-source-map-declaration');
  return {reference: ref, start: m.index, end: m.index + m[0].length};
}
function normalizedMap(payload, originals, jsPath, contents) {
  return {...payload, sources: originals.map(s => local(relative(dirname(jsPath), s.path))), sourcesContent: contents};
}
function suppliedJs(text, directive, mapBytes) {
  return Buffer.from(text.slice(0, directive.start) + '//# sourceMappingURL=data:application/json;base64,' + mapBytes.toString('base64') + text.slice(directive.end));
}
function mappedSources(inputs) {
  const sources = new Map();
  for (const i of inputs) for (const f of [i.original, i.supplied, ...(i.originals ?? [])]) {
    const key = pathKey(f.path); if (!sources.has(key)) sources.set(key, new Set()); sources.get(key).add(f.sha256);
  }
  return sources;
}
function checkOutputSources(mapBytes, mapPath, inputs) {
  const payload = JSON.parse(utf8(mapBytes)), parsed = parseLocalMap(payload, mapPath), allowed = mappedSources(inputs);
  ensure(payload.sourcesContent?.length === payload.sources.length, 'output-source-content-missing');
  return parsed.paths.map((path, index) => {
    ensure(typeof payload.sourcesContent[index] === 'string', 'output-source-content-missing');
    const hash = sha256(payload.sourcesContent[index]); ensure(allowed.get(pathKey(path))?.has(hash), 'output-source-not-accounted-for');
    return {sourceIndex: index, path, sha256: hash};
  });
}
function checkMetafile(meta, inputs, workspace) {
  const expected = new Map(inputs.map(i => [pathKey(i.path), i]));
  ensure(meta && Object.keys(meta.inputs).length === inputs.length, 'metafile-capture-coverage-mismatch');
  for (const [path, input] of Object.entries(meta.inputs)) {
    const observed = expected.get(pathKey(resolve(workspace, path)));
    ensure(observed && input.bytes === observed.supplied.bytes, 'metafile-input-not-captured');
  }
  return {metafileInputs: inputs.length, capturedInputs: inputs.length, allMetafileInputsCaptured: true, resolutionFileReads: 'not-intercepted'};
}

// Caller supplies the installed public esbuild API. No engine imports, package
// installation, process inventory or implicit workspace discovery occurs here.
export async function captureSourceBuild({esbuild, workspaceRoot, entry, outputDir, scopes}) {
  const begin = performance.now(), root = await realpath(workspaceRoot), dir = resolve(outputDir);
  ensure(inside(root, dir), 'output-outside-workspace');
  await mkdir(dir); // Exclusive new directory; never overwrite previous evidence.
  await mkdir(resolve(dir, 'blobs'));
  const state = {schemaVersion: '0.1.0', kind: 'controlled-build-source-evidence', status: 'capturing', buildId: randomUUID(), startedAt: new Date().toISOString(), workspaceRoot: root, policy: buildSourcePolicy, scopes: [], packages: [], inputs: [], outputs: [], stats: {readBytes: 0, storedBytes: 0, storedBlobs: 0}};
  const blobs = new Map(), readCache = new Map(); let queue = Promise.resolve();
  const store = async bytes => {
    const hash = sha256(bytes);
    if (!blobs.has(hash)) {
      ensure(state.stats.storedBytes + bytes.length <= buildSourcePolicy.maxStoredBytes, 'stored-byte-budget');
      await writeFile(resolve(dir, 'blobs', hash), bytes, {flag: 'wx'});
      state.stats.storedBytes += bytes.length; state.stats.storedBlobs++;
      blobs.set(hash, {sha256: hash, bytes: bytes.length, artifact: 'blobs/' + hash});
    }
    return {...blobs.get(hash)};
  };
  async function read(path, scope, maxBytes) {
    const key = pathKey(path);
    if (readCache.has(key)) return readCache.get(key);
    const f = await scopedRead(scope, relative(scope, path), Math.min(maxBytes, buildSourcePolicy.maxReadBytes - state.stats.readBytes));
    state.stats.readBytes += f.bytes.length; ensure(state.stats.readBytes <= buildSourcePolicy.maxReadBytes, 'input-read-byte-budget');
    const result = {descriptor: {...await store(f.bytes), path: f.path, requestedPath: f.lexical, observedAt: f.observedAt}, bytes: f.bytes};
    readCache.set(key, result); return result;
  }
  try {
    ensure(esbuild?.version === '0.24.0' && typeof esbuild.build === 'function', 'unsupported-builder-version');
    ensure(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= 16, 'invalid-build-scopes');
    for (const s of scopes) {
      const path = await realpath(s.root); ensure(inside(root, path), 'scope-outside-workspace');
      ensure(!state.scopes.some(x => pathKey(x.path) === pathKey(path) || inside(x.path, path) || inside(path, x.path)), 'overlapping-build-scopes');
      const item = {path, packageIndex: null};
      if (s.package) {
        const file = await read(resolve(path, 'package.json'), path, buildSourcePolicy.maxPackageBytes), value = JSON.parse(utf8(file.bytes));
        ensure(value.name === s.package.name && value.version === s.package.version, 'package-version-mismatch');
        ensure(digest(s.package.sha256) && file.descriptor.sha256 === s.package.sha256, 'package-hash-mismatch');
        item.packageIndex = state.packages.length; state.packages.push({name: value.name, version: value.version, root: path, file: file.descriptor, role: 'package-metadata-side-observation; resolver-reads-not-intercepted'});
      }
      state.scopes.push(item);
    }
    const entryPath = await realpath(entry); ensure(state.scopes.some(s => inside(s.path, entryPath)), 'entry-outside-scopes');
    const outfile = resolve(dir, 'bundle.cjs');
    const options = {absWorkingDir: root, entryPoints: [entryPath], outfile, bundle: true, format: 'cjs', platform: 'node', target: 'node24', minify: false, keepNames: true, sourcemap: 'external', sourcesContent: true, metafile: true, write: false, logLevel: 'silent'};
    state.options = options; state.builder = {name: 'esbuild', version: esbuild.version, node: process.version};
    state.tool = {captureSha256: sha256(await readFile(new URL(import.meta.url))), artifactsSha256: sha256(await readFile(new URL('./source-artifacts.mjs', import.meta.url)))};
    const plugin = {name: 'preserve-build-source-bytes', setup(build) {
      build.onLoad({filter: /.*/, namespace: 'file'}, args => {
        const job = queue.then(async () => {
          ensure(state.inputs.length < buildSourcePolicy.maxInputs, 'input-count-budget');
          ensure(/\.(?:c|m)?js$/i.test(args.path), 'unsupported-input-loader');
          const path = await realpath(args.path), scope = state.scopes.find(s => inside(s.path, path)); ensure(scope, 'input-outside-scopes');
          const input = await read(path, scope.path, buildSourcePolicy.maxJsBytes), text = utf8(input.bytes), directive = declaration(text);
          const record = {path, scope: scope.path, packageIndex: scope.packageIndex, original: input.descriptor, declaration: directive, map: null, originals: [], suppliedMap: null, supplied: null, evidenceRole: directive ? 'captured-map-supplied-inline-to-builder' : 'captured-js-without-input-map'};
          let supplied = input.bytes;
          if (directive) {
            const mapPath = resolve(dirname(path), directive.reference), mapFile = await read(mapPath, scope.path, buildSourcePolicy.maxMapBytes);
            const payload = JSON.parse(utf8(mapFile.bytes)), parsed = parseLocalMap(payload, mapFile.descriptor.path); record.map = mapFile.descriptor;
            const contents = [];
            for (let index = 0; index < parsed.paths.length; index++) {
              const source = await read(parsed.paths[index], scope.path, buildSourcePolicy.maxSourceBytes), content = utf8(source.bytes);
              if (payload.sourcesContent?.[index] != null) ensure(sha256(payload.sourcesContent[index]) === source.descriptor.sha256, 'embedded-source-content-mismatch');
              record.originals.push({...source.descriptor, sourceIndex: index, embeddedContentChecked: payload.sourcesContent?.[index] != null}); contents.push(content);
            }
            const mapBytes = Buffer.from(JSON.stringify(normalizedMap(payload, record.originals, path, contents)));
            record.suppliedMap = {...await store(mapBytes), path, role: 'normalized-inline-map; captured sourcesContent supplied'};
            supplied = suppliedJs(text, directive, mapBytes);
          }
          record.supplied = {...await store(supplied), path}; record.persistedBeforeReturnAt = new Date().toISOString(); state.inputs.push(record);
          return {contents: supplied, loader: 'js', resolveDir: dirname(path)};
        });
        queue = job.catch(() => {}); return job;
      });
    }};
    const result = await esbuild.build({...options, plugins: [plugin]}); await queue;
    ensure(result.warnings.length === 0, 'builder-warnings'); state.coverage = checkMetafile(result.metafile, state.inputs, root);
    state.metafile = {...await store(Buffer.from(JSON.stringify(result.metafile))), role: 'builder-metafile'};
    ensure(result.outputFiles?.length === 2, 'unexpected-build-output-count');
    for (const file of result.outputFiles) {
      ensure(file.contents.length <= buildSourcePolicy.maxOutputBytes, 'output-byte-budget');
      ensure(file.path === outfile || file.path === outfile + '.map', 'unexpected-build-output');
      state.outputs.push({...await store(file.contents), path: file.path, role: file.path.endsWith('.map') ? 'emitted-source-map' : 'emitted-javascript'});
    }
    const mapFile = result.outputFiles.find(f => f.path.endsWith('.map'));
    state.outputSources = checkOutputSources(Buffer.from(mapFile.contents), mapFile.path, state.inputs);
    state.status = 'captured'; state.finishedAt = new Date().toISOString(); state.resources = {elapsedMs: performance.now() - begin, nodeMaxRssKiB: process.resourceUsage().maxRSS, nativeBuilderRss: 'not-measured'};
    state.claims = {inputSupply: 'captured-bytes-returned-by-public-onLoad', outputSourceCoverage: 'accounted-for', mapConsumption: 'requires-separate-controlled-canary', resolutionReads: 'not-intercepted', runtimeBinding: 'not-performed', historicalCaptureBinding: 'none', causalLocalization: 'not-established'};
    const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n'), path = resolve(dir, 'build-evidence.json'); ensure(bytes.length <= buildSourcePolicy.maxManifestBytes, 'manifest-size-budget'); await writeFile(path, bytes, {flag: 'wx'});
    return {status: 'captured', manifestPath: path, manifestSha256: sha256(bytes), buildId: state.buildId, resources: state.resources};
  } catch (error) {
    await queue; state.status = 'failed'; state.finishedAt = new Date().toISOString(); state.failure = {code: error.code ?? error.errors?.[0]?.detail?.code ?? 'build-source-capture-failed', message: error.message};
    state.resources = {elapsedMs: performance.now() - begin, nodeMaxRssKiB: process.resourceUsage().maxRSS}; const path = resolve(dir, 'failure.json'); await writeFile(path, JSON.stringify(state, null, 2) + '\n', {flag: 'wx'});
    return {status: 'failed', resultPath: path, ...state.failure, resources: state.resources};
  }
}

export async function verifySourceBuild(manifestPath, expected) {
  const begin = performance.now(), result = {status: 'refused', method: 'preserved-build-artifact-consistency', unknown: [], claims: {runtimeBinding: 'not-performed', historicalCaptureBinding: 'none', authentication: 'not-established', resolutionReads: 'not-intercepted'}};
  try {
    ensure(digest(expected?.manifestSha256), 'expected-manifest-hash-required');
    const file = await readBoundJson(manifestPath, buildSourcePolicy.maxManifestBytes), m = file.value, root = dirname(file.path);
    ensure(file.sha256 === expected.manifestSha256, 'manifest-hash-mismatch');
    ensure(m.schemaVersion === '0.1.0' && m.kind === 'controlled-build-source-evidence' && m.status === 'captured', 'unsupported-build-evidence');
    if (expected.buildId) ensure(m.buildId === expected.buildId, 'build-id-mismatch');
    ensure(Array.isArray(m.inputs) && m.inputs.length > 0 && m.inputs.length <= buildSourcePolicy.maxInputs, 'invalid-input-list');
    const cache = new Map(); let readBytes = 0;
    async function blob(d) {
      ensure(d && digest(d.sha256) && d.artifact === 'blobs/' + d.sha256 && Number.isSafeInteger(d.bytes) && d.bytes >= 0 && d.bytes <= buildSourcePolicy.maxStoredBytes, 'invalid-artifact-descriptor');
      if (cache.has(d.sha256)) {ensure(cache.get(d.sha256).length === d.bytes, 'artifact-size-mismatch'); return cache.get(d.sha256);}
      const f = await scopedRead(root, d.artifact, d.bytes);
      ensure(f.bytes.length === d.bytes && f.sha256 === d.sha256, 'artifact-hash-mismatch'); readBytes += f.bytes.length; ensure(readBytes <= buildSourcePolicy.maxStoredBytes, 'verification-byte-budget'); cache.set(d.sha256, f.bytes); return f.bytes;
    }
    for (const p of m.packages) {
      const data = JSON.parse(utf8(await blob(p.file))); ensure(data.name === p.name && data.version === p.version, 'recorded-package-version-mismatch');
      const expectation = expected.packages?.find(x => x.name === p.name); if (expectation) ensure(expectation.version === p.version && expectation.sha256 === p.file.sha256, 'expected-package-mismatch');
    }
    for (const p of expected.packages ?? []) ensure(m.packages.some(x => x.name === p.name), 'expected-package-missing');
    for (const i of m.inputs) {
      const original = await blob(i.original), supplied = await blob(i.supplied), directive = declaration(utf8(original));
      ensure(JSON.stringify(directive) === JSON.stringify(i.declaration), 'declaration-record-mismatch');
      ensure(pathKey(i.path) === pathKey(i.original.path) && pathKey(i.path) === pathKey(i.supplied.path), 'input-path-mismatch');
      ensure(m.scopes.some(s => s.path === i.scope && inside(s.path, i.path) && s.packageIndex === i.packageIndex), 'input-scope-mismatch');
      if (!directive) {ensure(original.equals(supplied) && i.map === null && i.suppliedMap === null && i.originals.length === 0, 'unmapped-input-changed'); continue;}
      ensure(resolve(dirname(i.path), directive.reference) === i.map.requestedPath && inside(i.scope, i.map.path), 'declared-map-path-mismatch');
      const rawMap = JSON.parse(utf8(await blob(i.map))), parsed = parseLocalMap(rawMap, i.map.path);
      ensure(parsed.paths.length === i.originals.length, 'original-source-list-mismatch'); const contents = [];
      for (let index = 0; index < i.originals.length; index++) {
        const source = i.originals[index], bytes = await blob(source);
        ensure(source.sourceIndex === index && source.requestedPath === parsed.paths[index] && inside(i.scope, source.path), 'original-source-path-mismatch');
        if (rawMap.sourcesContent?.[index] != null) ensure(sha256(rawMap.sourcesContent[index]) === source.sha256, 'embedded-source-content-mismatch'); contents.push(utf8(bytes));
      }
      const normalized = Buffer.from(JSON.stringify(normalizedMap(rawMap, i.originals, i.path, contents))), stored = await blob(i.suppliedMap);
      ensure(normalized.equals(stored), 'supplied-map-not-derived-from-capture'); ensure(suppliedJs(utf8(original), directive, stored).equals(supplied), 'supplied-js-not-derived-from-capture');
    }
    const metafile = JSON.parse(utf8(await blob(m.metafile))); result.coverage = checkMetafile(metafile, m.inputs, m.workspaceRoot);
    ensure(m.outputs.length === 2, 'unexpected-build-output-count'); let map = null;
    for (const o of m.outputs) {
      const bytes = await blob(o); if (o.role === 'emitted-source-map') map = {bytes, path: o.path};
      if (expected.outputSha256 && o.role === 'emitted-javascript') ensure(o.sha256 === expected.outputSha256, 'expected-output-mismatch');
    }
    ensure(map, 'emitted-map-missing'); result.sources = checkOutputSources(map.bytes, map.path, m.inputs);
    result.status = 'verified-consistency'; result.manifest = {path: file.path, sha256: file.sha256, buildId: m.buildId};
    result.artifacts = {verifiedBlobs: cache.size, verifiedBytes: readBytes, inputMaps: m.inputs.filter(i => i.map).length, originalRecords: m.inputs.reduce((n, i) => n + i.originals.length, 0)};
  } catch (error) {result.code = error.code ?? 'build-evidence-verification-failed'; result.detail = error.message;}
  result.resources = {elapsedMs: performance.now() - begin, nodeMaxRssKiB: process.resourceUsage().maxRSS}; return result;
}
