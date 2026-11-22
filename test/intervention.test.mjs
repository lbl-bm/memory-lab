import test from 'node:test';
import assert from 'node:assert/strict';
import { validateObservationLedger, assessObservedCalls } from '../src/intervention.mjs';
function fixture(kind = 'cut', shadow = false, cache = false) {
  const bindings = [{ propertyKey: 'a', functionTextSha256: 'ha' }, { propertyKey: 'b', functionTextSha256: 'hb' }];
  const points = [{ phase: 'baseline', cycle: 0 }, { phase: 'back', cycle: 1 }, { phase: 'back', cycle: 2 }, { phase: 'back', cycle: 3 }, { phase: 'followup', cycle: 3 }].map((p, i) => ({ ...p, path: 'p' + i, sha256: 'h' + i }));
  const route = [{ id: 10, edgeToNext: { type: 'property', name: 'c' } }, { id: 11, edgeToNext: { type: 'element', name: 0 } }, { id: 20 }];
  const source = { runId: 'r', inputs: { captureReportSha256: 'rh', identity: { sha256: 'ih' }, scripts: { sha256: 'sh' }, points }, selected: { measuredOwnerRoute: route }, series: [], lifecycleAssessment: { verdict: cache ? 'consistent-with-declared-cache' : 'residual-after-declared-deadline-supported' }, candidates: [
    { nodeId: 20, source: { path: 'x', line: 1 }, relation: { kind: 'direct-path-node-location', depth: 0 } },
    ...['a', 'b'].map((name, i) => ({ nodeId: 30 + i, source: { path: 'y', line: 2 + i }, relation: { kind: 'property-nearby-function-location', depth: 1, route: [{ from: 10, to: 30 + i, name, type: 'property' }] } })),
  ] };
  const manifest = { epochId: 'e', runtime: { pid: 1, threadId: 0 }, collector: { sha256: 'ch' }, resources: [0,1,2,3].map(i => ({ token: 'r' + i, createdNs: String(i * 100 + 1) })), points: points.map((p, i) => ({ startedNs: String(i * 100 + 30), gcCount: 2 })) };
  const ledger = { schemaVersion: '0.1.0', runId: 'r', captureReportSha256: 'rh', identitySha256: 'ih', scriptsSha256: 'sh', epochId: 'e', runtime: { pid: 1, threadId: 0 }, collector: { sha256: 'ch' }, view: { kind: 'Array-own-data', propertyKey: 'c' }, windows: [], events: [], checkpoints: [] };
  for (let i = 0; i < 4; i++) {
    const before = Array.from({length:i}, (_, n) => 'r' + n), after = [...before, 'r' + i], windowId = 'w' + i;
    ledger.windows.push({ windowId, cycle: i, startedNs: String(i * 100 + 1), finishedNs: String(i * 100 + 9), bindings, expectedCalls: { a: 1, b: 1 }, restoration: { restored: true, dropped: 0, emitFailures: 0, unsupported: [] } });
    for (let j = 0; j < 2; j++) ledger.events.push({ windowId, cycle: i, epochId: 'e', pid: 1, threadId: 0, id: windowId + '-' + j, parentId: null, nestedDepth: 0, childCalls: 0, binding: bindings[j], startedNs: String(i * 100 + 2 + j * 2), finishedNs: String(i * 100 + 3 + j * 2), status: 'returned', receiverMatches: true, before: { status: 'observed', tokens: j ? after : before }, after: { status: 'observed', tokens: after }, added: j ? [] : ['r' + i], removed: [] });
  }
  for (let i = 0; i < 5; i++) {
    const lastCut = i === 4 && kind === 'cut', viewTokens = lastCut ? [] : Array.from({length:Math.min(i + 1, 4)}, (_, n) => 'r' + n);
    ledger.checkpoints.push({ point: i, phase: points[i].phase, cycle: points[i].cycle, snapshotSha256: points[i].sha256, view: { status: 'observed', tokens: viewTokens }, methodsRestored: true, methods: bindings });
    const heapTokens = lastCut && shadow ? ['r0','r1','r2','r3'] : viewTokens;
    source.series.push({ point: i, resources: heapTokens.map(token => ({ token, id: 20 + Number(token.slice(1)), ownerRoute: lastCut ? { status: 'not-observed-within-budget' } : { status: 'observed', path: route } })) });
  }
  ledger.intervention = { status: 'completed', kind, startedNs: '340', finishedNs: '341', before: { status: 'observed', tokens: ['r0','r1','r2','r3'] }, after: { status: 'observed', tokens: ledger.checkpoints[4].view.tokens } };
  return { source, manifest, ledger };
}
test('call observations deprioritize the observed decoy but keep unobserved constructor unknown', () => {
  const f = fixture(), validation = validateObservationLedger(f.ledger, f.source, f.manifest); assert.equal(validation.status, 'validated-consistency');
  const r = assessObservedCalls(f.source, f.manifest, f.ledger, validation);
  assert.equal(r.candidates[0].finding, 'unknown'); assert.equal(r.candidates[1].finding, 'membership-change-during-call-observed'); assert.equal(r.candidates[2].finding, 'deprioritized-for-observed-view-and-workload');
  assert.equal(r.intervention.result, 'tagged-release-observed-after-directed-view-cut'); assert.equal(r.intervention.releasedTokens.length, 4); assert.equal(r.causalSourceLocalization, 'not-determined');
});
test('cache context, sham and separate retained roots prevent a complete causal bug claim', () => {
  for (const [kind, shadow, cache, expected] of [['sham',false,false,'sham-observation-no-edge-cut'], ['cut',true,false,'view-cleared-but-tagged-survivors-remain'], ['cut',false,true,'tagged-release-observed-after-directed-view-cut']]) {
    const f = fixture(kind, shadow, cache), v = validateObservationLedger(f.ledger, f.source, f.manifest); assert.equal(v.status, 'validated-consistency'); const r = assessObservedCalls(f.source, f.manifest, f.ledger, v); assert.equal(r.intervention.result, expected); if (cache) assert.match(r.policyContext, /no defect inferred/);
  }
});
test('missing calls, restoration, nested/async failure and intervention bounds stay unknown', () => {
  const f = fixture(); f.ledger.events = []; let v = validateObservationLedger(f.ledger, f.source, f.manifest); assert.equal(v.status, 'validated-consistency'); let r = assessObservedCalls(f.source, f.manifest, f.ledger, v); assert.equal(r.candidates[1].code, 'missing-or-incomplete-call-observations');
  const g = fixture(); g.ledger.windows[1].restoration.restored = false; r = assessObservedCalls(g.source, g.manifest, g.ledger, {status:'validated-consistency'}); assert.equal(r.candidates[1].finding, 'unknown');
  const h = fixture(); h.ledger.events[0].status = 'unsupported-nonprimitive-result'; r = assessObservedCalls(h.source, h.manifest, h.ledger, {status:'validated-consistency'}); assert.equal(r.candidates[1].code, 'nonexclusive-or-unsupported-call');
  h.ledger.intervention.startedNs = '1'; r = assessObservedCalls(h.source, h.manifest, h.ledger, {status:'validated-consistency'}); assert.equal(r.intervention.status, 'unknown');
  const gcs = fixture(); gcs.manifest.points[4].gcCount = 0; assert.equal(assessObservedCalls(gcs.source, gcs.manifest, gcs.ledger, {status:'validated-consistency'}).intervention.code, 'insufficient-gc-around-intervention');
  assert.equal(assessObservedCalls(f.source, f.manifest, null, {status:'unknown',code:'missing'}).status, 'unknown');
});
test('ledger validates epoch, binding, primitive deltas, point facts and nesting', () => {
  for (const [mutate, expected] of [
    [f => f.ledger.epochId = 'other', 'observation-epoch-mismatch'],
    [f => f.ledger.events[0].added = [], 'call-delta-mismatch'],
    [f => f.ledger.checkpoints[0].view.tokens = [], 'checkpoint-view-heap-mismatch'],
    [f => f.ledger.events[0].binding = { propertyKey: 'a', functionTextSha256: 'bad' }, 'call-binding-mismatch'],
    [f => f.ledger.events[0].childCalls = 1, 'call-nesting-invalid'],
    [f => f.ledger.checkpoints[0].methods = [], 'checkpoint-method-binding-mismatch'],
    [f => { f.ledger.events[0].before.tokens = ['r3']; f.ledger.events[0].removed = ['r3']; }, 'call-token-time-mismatch'],
  ]) { const f = fixture(); mutate(f); assert.equal(validateObservationLedger(f.ledger, f.source, f.manifest).code, expected); }
});
