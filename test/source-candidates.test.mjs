import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourcePositions, validateScriptRegistry, mapSourcePosition } from '../src/source-candidates.mjs';
import { sha256 } from '../src/heap-identity.mjs';

function graph() {
  return { snapshot: { meta: { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'], node_types: [['object', 'closure', 'string']], edge_fields: ['type', 'name_or_index', 'to_node'], edge_types: [['property', 'weak']], location_fields: ['column', 'object_index', 'line', 'script_id'] } }, strings: ['Object', 'r', 'q', 'name'], nodes: [0, 0, 10, 24, 1, 1, 2, 20, 24, 0], edges: [0, 1, 5], locations: [4, 5, 2, 37] };
}
test('source candidates decode metadata offsets and measured property proximity, not names', () => {
  const h = graph(), r = sourcePositions(h, [10]);
  assert.equal(r.positions.length, 1); assert.equal(r.positions[0].nodeId, 20); assert.equal(r.positions[0].location.scriptId, '37');
  assert.equal(r.positions[0].location.line, 2); assert.equal(r.positions[0].relation.depth, 1);
  assert.deepEqual(r.positions[0].relation.route, [{ from: 10, to: 20, name: 'r', type: 'property' }]);
  h.edges[0] = 1; assert.equal(sourcePositions(h, [10]).positions.length, 0);
  const missing = graph(); delete missing.locations; assert.equal(sourcePositions(missing, [10]).unknown[0].code, 'missing-location-metadata');
  const invalid = graph(); invalid.locations[1] = 6; assert.throws(() => sourcePositions(invalid, [10]), /Invalid or duplicate node location/);
});

test('external retaining evidence must match literal raw nodes and edges', () => {
  const path = [{ id: 10, name: 'Object', type: 'object', edgeToNext: { name: 'r', type: 'property' } }, { id: 20, name: 'q', type: 'closure', edgeToNext: null }];
  assert.equal(sourcePositions(graph(), [10,20], path).rawPathValidation.edges, 1);
  const wrong = structuredClone(path); wrong[0].edgeToNext.name = 'other'; assert.throws(() => sourcePositions(graph(), [10,20], wrong), /not present in raw/);
  const weak = structuredClone(path); weak[0].edgeToNext.type = 'weak'; assert.throws(() => sourcePositions(graph(), [10,20], weak), /weak retaining/);
  const node = structuredClone(path); node[1].name = 'wrong'; assert.throws(() => sourcePositions(graph(), [10,20], node), /node does not match/);
});

test('candidate budget truncation is explicit and unknown samples do not imply complete coverage', () => {
  const h = graph(); h.nodes = [0, 0, 10, 24, 30]; h.edges = []; h.locations = [];
  for (let i = 0; i < 30; i++) { const offset = h.nodes.length; h.nodes.push(1, 2, 20 + i, 24, 0); h.edges.push(0, 1, offset); h.locations.push(0, offset, 0, 37); }
  const bounded = sourcePositions(h, [10]); assert.equal(bounded.positions.length, 24); assert.equal(bounded.truncated, true);
  h.locations = []; const unknown = sourcePositions(h, [10]); assert.equal(unknown.positions.length, 0); assert.equal(unknown.unknownLocationCount, 31); assert.equal(unknown.unknown.length, 24); assert.equal(unknown.unknownSamplesTruncated, true);
});

test('script registry refuses wrong epoch, stale bindings and ambiguous script IDs', () => {
  const life = { runId: 'r', inputs: { captureReportSha256: 'rh', identity: { sha256: 'ih' }, points: [{ path: 'p', sha256: 'ph' }] } }, manifest = { epochId: 'ep', runtime: { pid: 1, threadId: 0 }, collector: { sha256: 'ch' } };
  const registry = { schemaVersion: '0.1.0', runId: 'r', captureReportSha256: 'rh', identitySha256: 'ih', sessionId: 's', epochId: 'ep', runtime: { pid: 1, threadId: 0 }, collector: { sha256: 'ch' }, points: [{ path: 'p', sha256: 'ph' }], scripts: [{ scriptId: '37' }] };
  assert.equal(validateScriptRegistry(registry, life, manifest).status, 'validated-consistency');
  assert.equal(validateScriptRegistry(null, life, manifest).status, 'unknown');
  for (const [mutate, code] of [
    [r => { r.epochId = 'other'; }, 'script-registry-epoch-mismatch'],
    [r => { r.identitySha256 = 'other'; }, 'script-registry-run-binding-mismatch'],
    [r => { r.points[0].sha256 = 'other'; }, 'script-registry-snapshot-mismatch'],
    [r => { r.scripts.push({ scriptId: '37' }); }, 'ambiguous-script-id'],
  ]) { const r = structuredClone(registry); mutate(r); assert.equal(validateScriptRegistry(r, life, manifest).code, code); }
});

test('file positions require matching loaded/local bytes; absent and source-map information stays unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-map-test-')), runDir = await realpath(root);
  try {
    const file = join(runDir, 'random.mjs'), text = '\n// 😀 UTF16\nexport function q() {}\n'; await writeFile(file, text);
    const script = { scriptId: '37', url: pathToFileURL(file).href, path: 'random.mjs', startLine: 0, startColumn: 0, hasSourceURL: false, sourceSha256: sha256(text), inspectorSourceSha256: sha256(text) };
    const p = { location: { scriptId: '37', line: 2, column: 17 }, nodeId: 20, relation: { kind: 'property-nearby-function-location' } };
    const mapped = await mapSourcePosition(p, [script], runDir); assert.equal(mapped.source.line, 3); assert.equal(mapped.source.column, 18); assert.equal(mapped.status, 'mapped-generated-source');
    assert.equal((await mapSourcePosition(p, [], runDir)).code, 'script-id-not-recorded');
    assert.equal((await mapSourcePosition(p, [{ ...script, hasSourceURL: true }], runDir)).code, 'unsupported-virtual-or-offset-script');
    assert.equal((await mapSourcePosition(p, [{ ...script, inspectorSourceSha256: 'bad' }], runDir)).code, 'stale-or-unmatched-source-bytes');
    assert.equal((await mapSourcePosition(p, [script], runDir, 1)).code, 'source-size-budget');
    assert.equal((await mapSourcePosition({ ...p, location: { ...p.location, line: 20 } }, [script], runDir)).code, 'location-out-of-range');
    const sm = await mapSourcePosition(p, [{ ...script, sourceMapURL: 'not-fetched.map' }], runDir); assert.equal(sm.status, 'mapped-generated-source'); assert.equal(sm.originalSourceMapping.status, 'unknown');
    const unicodeFile = join(runDir, 'line-terms.mjs'), unicodeText = '//😀\u2028export function q() {}\r// tail\r\n'; await writeFile(unicodeFile, unicodeText);
    const unicodeScript = { ...script, path: 'line-terms.mjs', url: pathToFileURL(unicodeFile).href, sourceSha256: sha256(unicodeText), inspectorSourceSha256: sha256(unicodeText) };
    const unicodeMapped = await mapSourcePosition({ ...p, location: { ...p.location, line: 1 } }, [unicodeScript], runDir); assert.equal(unicodeMapped.source.line, 2); assert.equal(unicodeMapped.source.column, 18);
    assert.equal((await mapSourcePosition({ ...p, location: { ...p.location, line: 0, column: 4 } }, [unicodeScript], runDir)).source.column, 5);
    await writeFile(file, text + '// changed'); assert.equal((await mapSourcePosition(p, [script], runDir)).code, 'stale-or-unmatched-source-bytes');
  } finally { const target = await realpath(root); assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(target).startsWith('source-map-test-')); await rm(target, { recursive: true, force: true }); }
});
