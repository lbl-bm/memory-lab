import { readFile } from 'node:fs/promises';
import { analyzeSourceCandidates } from './source-candidates.mjs';
import { readBoundJson, sha256, verifyBoundSource } from './heap-identity.mjs';

const sameTokens = (a, b) => Array.isArray(a) && Array.isArray(b) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const validTokens = a => Array.isArray(a) && a.length <= 128 && a.every(t => typeof t === 'string' && t.length > 0 && t.length <= 256) && new Set(a).size === a.length;
export function validateObservationLedger(ledger, source, manifest, adapterSourceValid = true) {
  const bad = code => ({ status: 'invalid', code });
  if (!ledger) return { status: 'unknown', code: 'missing-call-observations' };
  if (!adapterSourceValid) return bad('observation-adapter-source-mismatch');
  if (ledger.schemaVersion !== '0.1.0' || ledger.runId !== source.runId || ledger.captureReportSha256 !== source.inputs.captureReportSha256 || ledger.identitySha256 !== source.inputs.identity?.sha256 || ledger.scriptsSha256 !== source.inputs.scripts?.sha256) return bad('observation-run-binding-mismatch');
  if (ledger.epochId !== manifest.epochId || ledger.runtime?.pid !== manifest.runtime.pid || ledger.runtime?.threadId !== 0 || ledger.collector?.sha256 !== manifest.collector.sha256) return bad('observation-epoch-mismatch');
  if (!source.selected || ledger.view?.kind !== 'Array-own-data' || source.selected.measuredOwnerRoute[0]?.edgeToNext?.type !== 'property' || source.selected.measuredOwnerRoute[0].edgeToNext.name !== ledger.view.propertyKey) return bad('observation-view-binding-mismatch');
  if (!Array.isArray(ledger.windows) || ledger.windows.length < 4 || !Array.isArray(ledger.events) || !Array.isArray(ledger.checkpoints) || ledger.checkpoints.length < source.series.length) return { status: 'unknown', code: 'incomplete-observation-series' };
  if (ledger.windows.length > 4 || ledger.events.length > 128 || ledger.checkpoints.length !== source.series.length) return bad('observation-series-invalid');
  const resources = new Set(manifest.resources.map(r => r.token)), resourceEvents = new Map(manifest.resources.map(r => [r.token, r])), ids = new Set(), windowIds = new Set();
  for (let i = 0; i < ledger.windows.length; i++) {
    const w = ledger.windows[i];
    if (w.cycle !== i || !w.windowId || windowIds.has(w.windowId) || !Array.isArray(w.bindings) || !w.bindings.length || w.bindings.length > 8 || w.bindings.some(b => typeof b.propertyKey !== 'string' || typeof b.functionTextSha256 !== 'string') || new Set(w.bindings.map(b => b.propertyKey)).size !== w.bindings.length || !/^\d+$/.test(w.startedNs ?? '') || !/^\d+$/.test(w.finishedNs ?? '') || BigInt(w.startedNs) > BigInt(w.finishedNs) || BigInt(w.finishedNs) >= BigInt(manifest.points[i].startedNs)) return bad('observation-window-invalid');
    if (i && (w.bindings.length !== ledger.windows[0].bindings.length || w.bindings.some(b => !ledger.windows[0].bindings.some(first => first.propertyKey === b.propertyKey && first.functionTextSha256 === b.functionTextSha256)))) return bad('window-method-binding-changed');
    windowIds.add(w.windowId);
  }
  for (const e of ledger.events) {
    const window = ledger.windows.find(w => w.windowId === e.windowId);
    if (!window || e.cycle !== window.cycle || e.epochId !== manifest.epochId || e.pid !== manifest.runtime.pid || e.threadId !== 0 || !e.id || ids.has(e.id) || !/^\d+$/.test(e.startedNs ?? '') || !/^\d+$/.test(e.finishedNs ?? '') || BigInt(e.startedNs) > BigInt(e.finishedNs)) return bad('call-event-identity-invalid');
    if (BigInt(e.startedNs) < BigInt(window.startedNs) || BigInt(e.finishedNs) > BigInt(window.finishedNs) || !Number.isSafeInteger(e.nestedDepth) || e.nestedDepth < 0 || !Number.isSafeInteger(e.childCalls) || e.childCalls < 0) return bad('call-window-bounds-invalid');
    ids.add(e.id);
    const binding = window.bindings.find(b => b.propertyKey === e.binding?.propertyKey);
    if (!binding || binding.functionTextSha256 !== e.binding.functionTextSha256) return bad('call-binding-mismatch');
    if (e.before?.status === 'observed' && (!validTokens(e.before.tokens) || e.before.tokens.some(t => !resources.has(t)))) return bad('call-view-tokens-invalid');
    if (e.after?.status === 'observed' && (!validTokens(e.after.tokens) || e.after.tokens.some(t => !resources.has(t)))) return bad('call-view-tokens-invalid');
    for (const view of [e.before, e.after]) if (view?.status === 'observed' && view.tokens.some(t => BigInt(resourceEvents.get(t).createdNs) > BigInt(e.finishedNs))) return bad('call-token-time-mismatch');
    if (e.before?.status === 'observed' && e.after?.status === 'observed') {
      const added = e.after.tokens.filter(t => !e.before.tokens.includes(t)), removed = e.before.tokens.filter(t => !e.after.tokens.includes(t));
      if (!sameTokens(e.added, added) || !sameTokens(e.removed, removed)) return bad('call-delta-mismatch');
    }
  }
  for (const e of ledger.events) {
    const parent = e.parentId == null ? null : ledger.events.find(p => p.id === e.parentId);
    if ((e.parentId != null && (!parent || parent.windowId !== e.windowId || parent.nestedDepth + 1 !== e.nestedDepth || BigInt(parent.startedNs) > BigInt(e.startedNs) || BigInt(parent.finishedNs) < BigInt(e.finishedNs))) || (e.parentId == null && e.nestedDepth !== 0) || ledger.events.filter(c => c.parentId === e.id).length !== e.childCalls) return bad('call-nesting-invalid');
  }
  for (let i = 0; i < ledger.checkpoints.length; i++) {
    const p = ledger.checkpoints[i], input = source.inputs.points[i];
    if (p.point !== i || p.snapshotSha256 !== input.sha256 || p.phase !== input.phase || p.cycle !== input.cycle) return bad('checkpoint-binding-mismatch');
    const viewTokens = source.series[i].resources.filter(r => r.ownerRoute.status === 'observed' && r.ownerRoute.path?.[0]?.edgeToNext?.type === 'property' && r.ownerRoute.path[0].edgeToNext.name === ledger.view.propertyKey).map(r => r.token);
    if (p.view?.status !== 'observed') return { status: 'unknown', code: 'checkpoint-view-not-observed' };
    if (!validTokens(p.view.tokens) || !sameTokens(p.view.tokens, viewTokens)) return bad('checkpoint-view-heap-mismatch');
    if (!Array.isArray(p.methods) || ledger.windows[0].bindings.some(b => !p.methods.some(m => m.propertyKey === b.propertyKey && m.functionTextSha256 === b.functionTextSha256))) return bad('checkpoint-method-binding-mismatch');
  }
  for (const w of ledger.windows) {
    const calls = ledger.events.filter(e => e.windowId === w.windowId).sort((a, b) => BigInt(a.startedNs) < BigInt(b.startedNs) ? -1 : 1);
    const complete = w.bindings.every(b => Number.isSafeInteger(w.expectedCalls?.[b.propertyKey]) && calls.filter(e => e.binding.propertyKey === b.propertyKey).length === w.expectedCalls[b.propertyKey]);
    if (!complete || !calls.length || calls.some(e => e.status !== 'returned' || e.nestedDepth || e.childCalls || e.before?.status !== 'observed' || e.after?.status !== 'observed')) continue;
    if (!sameTokens(calls.at(-1).after.tokens, ledger.checkpoints[w.cycle].view.tokens) || calls.some((e, i) => i > 0 && !sameTokens(calls[i - 1].after.tokens, e.before.tokens)) || (w.cycle && !sameTokens(calls[0].before.tokens, ledger.checkpoints[w.cycle - 1].view.tokens))) return bad('call-checkpoint-transition-mismatch');
  }
  return { status: 'validated-consistency', trust: 'Conditional on synchronous exclusive workload, truthful collector, token/view coverage and restoration records. No execution attestation or statement-level write observation.' };
}

export function assessObservedCalls(source, manifest, ledger, validation) {
  const unknown = code => ({ status: 'unknown', code, candidates: [], intervention: { status: 'unknown' }, causalSourceLocalization: 'not-determined' });
  if (validation.status !== 'validated-consistency') return unknown(validation.code);
  const restorationOK = ledger.windows.every(w => w.restoration?.restored && !w.restoration.dropped && !w.restoration.emitFailures && !w.restoration.unsupported?.length) && ledger.checkpoints.every(p => p.methodsRestored === true);
  const ownerId = source.selected.measuredOwnerRoute[0].id;
  const candidates = source.candidates.map(candidate => {
    const edge = candidate.relation.route?.[0];
    const key = candidate.relation.kind === 'property-nearby-function-location' && candidate.relation.depth === 1 && edge?.from === ownerId ? edge.name : null;
    const out = { nodeId: candidate.nodeId, source: candidate.source, relation: candidate.relation, propertyKey: key, finding: 'unknown' };
    if (!key) return { ...out, code: 'candidate-not-covered-by-own-method-observer' };
    if (!restorationOK) return { ...out, code: 'incomplete-restoration-or-observer-coverage' };
    const events = ledger.events.filter(e => e.binding.propertyKey === key);
    const coverage = ledger.windows.every(w => {
      const expected = w.expectedCalls?.[key];
      return Number.isSafeInteger(expected) && expected >= 1 && w.bindings.some(b => b.propertyKey === key) && events.filter(e => e.windowId === w.windowId).length === expected;
    });
    if (!coverage) return { ...out, code: 'missing-or-incomplete-call-observations', observedCalls: events.length };
    if (events.some(e => e.status !== 'returned' || e.receiverMatches !== true || e.nestedDepth !== 0 || e.childCalls !== 0 || e.before.status !== 'observed' || e.after.status !== 'observed')) return { ...out, code: 'nonexclusive-or-unsupported-call', observedCalls: events.length };
    const changing = events.filter(e => e.added.length || e.removed.length);
    return { ...out, finding: changing.length ? 'membership-change-during-call-observed' : 'deprioritized-for-observed-view-and-workload', observedCalls: events.length, changingCalls: changing.length, addedTokens: [...new Set(events.flatMap(e => e.added))], removedTokens: [...new Set(events.flatMap(e => e.removed))], eventIds: events.map(e => e.id), limitation: 'Observed dynamic call window only; helpers/native operations may perform writes. No assertion that an unchanging method is globally irrelevant.' };
  });
  let intervention = { status: 'unknown', code: 'missing-intervention-observation' };
  const cut = ledger.intervention, beforeIndex = source.inputs.points.findLastIndex(p => p.phase === 'back'), followupIndex = source.inputs.points.findIndex(p => p.phase === 'followup');
  if (cut?.status === 'completed' && ['cut', 'sham'].includes(cut.kind) && followupIndex > beforeIndex && cut.before?.status === 'observed' && cut.after?.status === 'observed') {
    const before = ledger.checkpoints[beforeIndex].view.tokens, after = ledger.checkpoints[followupIndex].view.tokens;
    if (!sameTokens(cut.before.tokens, before) || !sameTokens(cut.after.tokens, after) || (cut.kind === 'cut' && cut.after.tokens.length !== 0) || (cut.kind === 'sham' && !sameTokens(before, after)) || !/^\d+$/.test(cut.startedNs ?? '') || !/^\d+$/.test(cut.finishedNs ?? '') || BigInt(cut.startedNs) > BigInt(cut.finishedNs) || BigInt(cut.startedNs) <= BigInt(manifest.points[beforeIndex].startedNs) || BigInt(cut.finishedNs) >= BigInt(manifest.points[followupIndex].startedNs)) intervention = { status: 'unknown', code: 'intervention-not-bound-to-heap-points' };
    else if ([beforeIndex, followupIndex].some(i => !Number.isSafeInteger(manifest.points[i].gcCount) || manifest.points[i].gcCount < 2)) intervention = { status: 'unknown', code: 'insufficient-gc-around-intervention' };
    else {
      const alive = new Set(source.series[followupIndex].resources.map(r => r.token)), released = before.filter(t => !alive.has(t)), survivors = before.filter(t => alive.has(t));
      intervention = { status: 'observed', kind: cut.kind, beforeTokens: before, afterViewTokens: after, releasedTokens: released, survivingTokens: survivors, result: cut.kind === 'sham' ? 'sham-observation-no-edge-cut' : survivors.length ? 'view-cleared-but-tagged-survivors-remain' : before.length ? 'tagged-release-observed-after-directed-view-cut' : 'empty-view-intervention-uninformative', lifecycleVerdict: source.lifecycleAssessment.verdict, limitation: 'A collection-edge cut is a synthetic intervention, not a correct business cleanup or leak/repair verdict. Cache entries can also be released by a cut.' };
    }
  }
  const policyContext = source.lifecycleAssessment.verdict === 'consistent-with-declared-cache' ? 'Observed holding is compatible with supplied cache context; no defect inferred.' : 'Use the separately supplied lifecycle assessment; call/view evidence alone does not establish a defect.';
  return { status: 'observed-with-limits', candidates, intervention, policyContext, causalSourceLocalization: 'not-determined', limitation: 'At most own synchronous methods and one tagged Array view; missing/nested/async observations remain unknown. No exact retaining statement or complete root-cause proof.' };
}

export async function analyzeIntervention(runDir, identityPath, scriptsPath, contractPath, ledgerPath = null) {
  const begin = performance.now(), source = await analyzeSourceCandidates(runDir, identityPath, scriptsPath, contractPath);
  const ledgerFile = ledgerPath ? await readBoundJson(ledgerPath) : null, manifest = source.inputs.identity ? (await readBoundJson(source.inputs.identity.path)).value : null;
  let adapterSourceValid = false;
  if (ledgerFile) { try { adapterSourceValid = await verifyBoundSource(ledgerFile.value.adapter, source.inputs.runDir) && ledgerFile.value.adapter.sha256 === sha256(await readFile(new URL('./call-observer.mjs', import.meta.url))); } catch {} }
  const validation = !source.identity.comparable || source.registry?.status !== 'validated-consistency' ? { status: 'unknown', code: 'missing-valid-source-or-identity-context' } : validateObservationLedger(ledgerFile?.value, source, manifest, adapterSourceValid);
  const assessment = assessObservedCalls(source, manifest, ledgerFile?.value, validation);
  return { schemaVersion: '0.1.0', status: source.status === 'refused' || validation.status === 'invalid' ? 'refused' : 'completed', runId: source.runId, inputs: { ...source.inputs, observations: ledgerFile && { path: ledgerFile.path, sha256: ledgerFile.sha256 } }, identity: source.identity, sourceRegistry: source.registry, lifecycleAssessment: source.lifecycleAssessment, selected: source.selected, heapPresence: source.series.map(p => ({ point: p.point, resources: p.resources.map(r => ({ token: r.token, nodeId: r.id, ownerRouteStatus: r.ownerRoute.status })) })), observationValidation: validation, assessment, conclusion: { causalSourceLocalization: 'not-determined', leakVerdict: 'not-determined', repairValidation: 'not-tested', browserValidation: 'not-completed', strictBlindTest: 'not-started' }, tool: { implementationSha256: sha256(await readFile(new URL(import.meta.url))), source: source.tool }, resources: { elapsedMs: performance.now() - begin, maxRssKiB: process.resourceUsage().maxRSS, maxOldSpaceMiB: 512 } };
}
