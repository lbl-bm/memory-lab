import test from 'node:test';
import assert from 'node:assert/strict';
import { marker, projectIdentityHeap, validateIdentitySeries } from '../src/heap-identity.mjs';
import { assessLifecycle } from '../src/lifecycle.mjs';

const points = [{ phase: 'baseline', cycle: 0 }, { phase: 'back', cycle: 1 }, { phase: 'back', cycle: 2 }, { phase: 'back', cycle: 3 }, { phase: 'followup', cycle: 3 }].map((p, i) => ({ ...p, path: 'p' + i, sha256: 'h' + i }));
const report = { runId: 'run' };
function fixture() {
  const manifest = { schemaVersion: '0.1.0', runId: 'run', captureReportSha256: 'rh', epochId: 'epoch', anchorToken: 'anchor', ownerToken: 'owner', runtime: { kind: 'node-main-isolate', pid: 123, threadId: 0 }, points: points.map((p, i) => ({ ...p, sequence: i, epochId: 'epoch', pid: 123, threadId: 0, startedNs: String((i + 1) * 1000000000), gcCount: 2 })), resources: [{ token: 'r1', ownerToken: 'owner', createdNs: '1', closedNs: '10' }] };
  const projections = points.map(() => ({ anchors: [{ id: 8, epoch: 'epoch', token: 'anchor' }], owners: [{ id: 10, token: 'owner' }], resources: [{ id: 20, token: 'r1', ownerToken: 'owner', ownerRoute: { status: 'observed', path: [{ id: 10 }, { id: 20 }] } }] }));
  const contract = { schemaVersion: '0.1.0', ownerToken: 'owner', authority: 'asserted', provenance: { statement: 'fixture contract' }, expectation: { kind: 'release-after-close', graceMs: 0 } };
  return { manifest, projections, contract };
}
const validate = (m, p) => validateIdentitySeries(m, report, 'rh', points, p, true);

test('identity refuses epoch/anchor/token drift, duplicates, reused IDs and reappearance', () => {
  let { manifest, projections } = fixture(); assert.equal(validate(manifest, projections).status, 'validated-consistency');
  assert.equal(validate(null, []).status, 'unknown');
  const cases = [
    ['runtime-epoch-changed', (m, p) => { m.points[2].epochId = 'reload'; }],
    ['anchor-id-changed', (m, p) => { p[2].anchors[0].id = 800; }],
    ['resource-id-changed', (m, p) => { p[2].resources[0].id = 200; }],
    ['resource-token-invalid', (m, p) => { p[2].resources.push({ ...p[2].resources[0] }); }],
    ['resource-reappeared', (m, p) => { p[1].resources = []; }],
    ['snapshot-binding-mismatch', (m, p) => { m.points[2].sha256 = 'different'; }],
    ['capture-clock-invalid', (m, p) => { m.points[2].startedNs = m.points[1].startedNs; }],
    ['resource-id-reused', (m, p) => { m.resources.push({ ...m.resources[0], token: 'r2' }); p[2].resources[0].token = 'r2'; }],
    ['resource-created-after-capture', (m, p) => { m.resources[0].createdNs = '2000000000'; m.resources[0].closedNs = '2000000001'; }],
  ];
  for (const [expected, mutate] of cases) { const f = fixture(); mutate(f.manifest, f.projections); const result = validate(f.manifest, f.projections); assert.equal(result.code, expected); assert.equal(result.comparable, false); }
});

test('lifecycle requires explicit bound context and measured owner route; curves alone do not decide', () => {
  const { manifest, projections, contract } = fixture(), identity = validate(manifest, projections);
  const assess = c => assessLifecycle(c, identity, points, projections, manifest, true);
  assert.equal(assess(null).code, 'missing-lifecycle-context');
  assert.equal(assess({ ...contract, authority: 'inferred' }).code, 'unconfirmed-lifecycle-hypothesis');
  assert.equal(assess(contract).verdict, 'residual-after-declared-deadline-supported');
  assert.equal(assess({ ...contract, expectation: { kind: 'bounded-cache', maxEntries: 1 } }).verdict, 'consistent-with-declared-cache');
  assert.equal(assess({ ...contract, expectation: { kind: 'bounded-cache', maxEntries: 0 } }).verdict, 'cache-bound-violation-supported');
  projections[2].resources[0].ownerRoute.status = 'not-observed-within-budget';
  assert.equal(assess(contract).code, 'insufficient-owner-evidence');
});

test('release timing, GC evidence and missing close boundaries are conservative', () => {
  const { manifest, projections, contract } = fixture(), identity = validate(manifest, projections);
  const assess = c => assessLifecycle(c, identity, points, projections, manifest, true);
  assert.equal(assess({ ...contract, expectation: { kind: 'release-after-close', graceMs: 10000 } }).verdict, 'release-window-not-observed');
  projections.at(-1).resources = [];
  assert.equal(assess({ ...contract, expectation: { kind: 'release-after-close', graceMs: 4000 } }).verdict, 'release-observed');
  manifest.resources[0].closedNs = null; assert.equal(assess(contract).code, 'missing-close-boundary');
  manifest.resources[0].closedNs = '10'; manifest.points[2].gcCount = 0;
  assert.equal(assess(contract).code, 'insufficient-gc-evidence');
  assert.equal(assessLifecycle(contract, { comparable: false, code: 'bad' }, points, projections, manifest, true).verdict, 'unknown');
});

function heap(rope = false) {
  const list = [
    { id: 8, name: 'Object', props: { [marker.epoch]: 'epoch', [marker.anchor]: 'anchor' } },
    { id: 10, name: 'Object', props: { [marker.owner]: 'owner' }, edges: [{ name: 'held', type: 'property', to: 11 }] },
    { id: 11, name: 'Array', edges: [{ name: 0, type: 'element', to: 20 }] },
    { id: 20, name: 'ArbitraryBinding', props: { [marker.resource]: 'r1', [marker.owner]: 'owner' } },
  ];
  const strings = [], s = v => { const i = strings.indexOf(v); if (i >= 0) return i; strings.push(v); return strings.length - 1; };
  let next = 100;
  for (const item of [...list]) for (const [name, value] of Object.entries(item.props ?? {})) {
    const id = next++; (item.edges ??= []).push({ name, type: 'property', to: id });
    if (rope && name === marker.resource) { const first = next++, second = next++; list.push({ id, name: '(concatenated string)', type: 'concatenated string', edges: [{ name: 'first', type: 'internal', to: first }, { name: 'second', type: 'internal', to: second }] }, { id: first, name: 'r', type: 'string' }, { id: second, name: '1', type: 'string' }); }
    else list.push({ id, name: value, type: 'string' });
  }
  const offsets = new Map(list.map((item, i) => [item.id, i * 5])), types = ['object', 'string', 'concatenated string'], edgeTypes = ['property', 'element', 'weak', 'internal'];
  return { snapshot: { meta: { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'], node_types: [types], edge_fields: ['type', 'name_or_index', 'to_node'], edge_types: [edgeTypes] } }, strings, nodes: list.flatMap(item => [types.indexOf(item.type ?? 'object'), s(item.name), item.id, 24, item.edges?.length ?? 0]), edges: list.flatMap(item => (item.edges ?? []).flatMap(edge => [edgeTypes.indexOf(edge.type), edge.type === 'element' ? edge.name : s(edge.name), offsets.get(edge.to)])) };
}

test('raw marker decoder follows a measured owner route and excludes weak edges', () => {
  const raw = heap(), p = projectIdentityHeap(raw, 'owner');
  assert.equal(p.resources[0].token, 'r1'); assert.equal(p.resources[0].ownerRoute.status, 'observed');
  assert.deepEqual(p.resources[0].ownerRoute.path.map(n => n.id), [10, 11, 20]);
  raw.edges[6] = 2; // The owner->held edge follows the two anchor property edges.
  assert.notEqual(projectIdentityHeap(raw, 'owner').resources[0].ownerRoute.status, 'observed');
  assert.equal(projectIdentityHeap(heap(true), 'owner').resources[0].token, 'r1');
});
