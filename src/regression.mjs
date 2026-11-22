import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadSiteCapture, analyzeSiteEvidence } from './site-evidence.mjs';
import { sha256 } from './heap-identity.mjs';

export const regressionLimits = Object.freeze({ maxPoints: 12, maxRules: 16, minBackCycles: 3, maxMetadataBytes: 1024 ** 2 });
const fail = code => { const error = Error(code); error.code = code; throw error; };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
async function boundFile(path, hash, maxBytes = regressionLimits.maxMetadataBytes) {
  path = await realpath(resolve(path)); const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) fail('regression-input-budget');
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) fail('regression-input-budget');
  const digest = sha256(bytes); if (hash && hash !== digest) fail('regression-input-hash-mismatch');
  return { path, sha256: digest, bytes };
}
export function validateRegressionContract(contract) {
  if (contract?.schemaVersion !== '0.1.0' || contract.authority !== 'asserted' || typeof contract.scenarioId !== 'string' || !contract.scenarioId || typeof contract.statement !== 'string' || !contract.statement.trim()) fail('unasserted-regression-contract');
  if (!Array.isArray(contract.rules) || !contract.rules.length || contract.rules.length > regressionLimits.maxRules) fail('invalid-regression-rules');
  const change = contract.workloadChange;
  if (!change || !['same-entry', 'controlled-entry-switch'].includes(change.kind) || typeof change.statement !== 'string' || !change.statement.trim() || !digest(change.beforeEntrySha256) || !digest(change.afterEntrySha256)) fail('invalid-regression-workload-change');
  const seen = new Set();
  for (const rule of contract.rules) {
    if (typeof rule.id !== 'string' || !rule.id || seen.has(rule.id) || !['subject-observer-count', 'subscription-subject-membership-count', 'subject-stored-object-count'].includes(rule.metric) || !['bounded-after-back', 'release-at-settle'].includes(rule.expectation) || !integer(rule.maxEntries) || (rule.expectation === 'release-at-settle' && rule.maxEntries !== 0)) fail('invalid-regression-rule');
    seen.add(rule.id);
  }
  return contract;
}

// Counts a declared Subject's actual observer array, not absence of a retaining path.
// The already-validated sites identity supplies receiver IDs; no arbitrary class/name scan.
export function measureSubjectObservers(loaded, analysis, bindings) {
  const heap = loaded.heap, meta = heap.snapshot.meta, nf = Object.fromEntries(meta.node_fields.map((v, i) => [v, i])), ef = Object.fromEntries(meta.edge_fields.map((v, i) => [v, i]));
  const width = meta.node_fields.length, edgeWidth = meta.edge_fields.length, nodes = new Map(); let edgeStart = 0;
  for (let offset = 0; offset < heap.nodes.length; offset += width) {
    nodes.set(heap.nodes[offset + nf.id], { offset, edgeStart }); edgeStart += heap.nodes[offset + nf.edge_count] * edgeWidth;
  }
  function node(offset) { return { id: heap.nodes[offset + nf.id], type: meta.node_types[nf.type][heap.nodes[offset + nf.type]], name: heap.strings[heap.nodes[offset + nf.name]] }; }
  function edges(id) {
    const entry = nodes.get(id); if (!entry) fail('regression-missing-heap-node'); const output = [];
    for (let i = 0; i < heap.nodes[entry.offset + nf.edge_count]; i++) {
      const offset = entry.edgeStart + i * edgeWidth, type = meta.edge_types[ef.type][heap.edges[offset + ef.type]], raw = heap.edges[offset + ef.name_or_index];
      output.push({ type, name: type === 'element' || type === 'hidden' ? raw : heap.strings[raw], target: node(heap.edges[offset + ef.to_node]), edgeOffset: offset });
    }
    return output;
  }
  const ids = new Map(loaded.identities.objects.map(value => [value.id, value]));
  const results = {};
  for (const [ruleId, siteIds] of Object.entries(bindings)) {
    const selected = analysis.records.filter(record => siteIds.includes(record.registration.siteId));
    const sources = new Set(), cleared = new Set(), unknown = [], witnesses = [], associations = [];
    if (analysis.status !== 'completed' || !analysis.coverage.completeWithinDeclaredScope) unknown.push('site-evidence-incomplete');
    if (!selected.length) unknown.push('no-covered-registration');
    for (const record of selected) {
      const lineage = record.sourceLineage;
      if (lineage && lineage.status !== 'observed') { unknown.push('source-lineage-' + lineage.status + ':' + (lineage.reason ?? 'unconfirmed')); continue; }
      const sourceId = lineage?.subjectId ?? record.receiverId, identity = ids.get(sourceId);
      associations.push({ registrationSequence: record.sequence, sourceId, evidence: lineage ?? 'legacy-declared-receiver', resolution: identity?.resolution ?? 'legacy' });
      if (identity?.heapId) sources.add(identity.heapId);
      else if (lineage && analysis.input?.weakIdentityProtocol === 'registered-weakref-v1' && identity?.resolution === 'weak-ref-cleared') cleared.add(sourceId);
      else unknown.push(lineage ? 'subject-identity-unavailable' : 'receiver-identity-unavailable');
    }
    let count = 0;
    for (const source of sources) {
      const properties = edges(source), observerEdges = properties.filter(edge => edge.type === 'property' && edge.name === 'observers');
      const shape = ['closed', 'isStopped', 'currentObservers'].every(name => properties.filter(edge => edge.type === 'property' && edge.name === name).length === 1);
      if (!shape || observerEdges.length !== 1 || observerEdges[0].target.type !== 'object' || observerEdges[0].target.name !== 'Array') { unknown.push('unsupported-subject-observer-structure'); continue; }
      const array = observerEdges[0].target, elements = edges(array.id).filter(edge => edge.type === 'element').sort((a, b) => a.name - b.name);
      if (elements.some((edge, i) => edge.name !== i || edge.target.type !== 'object')) { unknown.push('unsupported-observer-array'); continue; }
      count += elements.length;
      witnesses.push({ receiverHeapId: source, observerArrayHeapId: array.id, arrayEdgeOffset: observerEdges[0].edgeOffset, entries: elements.map(edge => ({ index: edge.name, heapId: edge.target.id, edgeOffset: edge.edgeOffset })), count: elements.length });
    }
    for (const id of cleared) witnesses.push({ subjectId: id, resolution: 'weak-ref-cleared', count: 0, meaning: 'One registered WeakRef deref returned undefined at the collector bridge; this Subject contributes no live observer-array entries. Other resources are not assessed.' });
    results[ruleId] = { status: unknown.length ? 'unknown' : 'measured', value: unknown.length ? null : count, unknownReasons: [...new Set(unknown)], witnesses, associations,
      sourcePositions: selected.map(record => record.registration), retainedPathRegistrations: selected.filter(record => record.matches.length).length,
      releaseCalls: selected.flatMap(record => record.releaseCalls ?? []),
      closedWithPaths: selected.filter(record => record.status === 'closed-with-observed-reference-path').length,
      meaning: 'Number of element entries in declared primary-source Subject.observers arrays. Explicit cleared WeakRefs contribute zero; unavailable legacy identities remain unknown. Not all operator sources, resource liveness, retained bytes, or complete callback release.' };
  }
  return results;
}

export function measureSubscriptionSubjects(analysis, bindings) {
  const results = {};
  for (const [ruleId, siteIds] of Object.entries(bindings)) {
    const selected = analysis.records.filter(record => siteIds.includes(record.registration.siteId));
    const unknown = [], memberships = new Map(), associations = [];
    if (analysis.status !== 'completed' || !analysis.coverage.completeWithinDeclaredScope) unknown.push('site-evidence-incomplete');
    if (!selected.length) unknown.push('no-covered-registration');
    if (analysis.sourceMemberships?.status !== 'completed') unknown.push('source-membership-analysis-unavailable-or-incomplete');
    for (const record of selected) {
      const source = record.sourceMemberships;
      associations.push({ registrationSequence: record.sequence, subscriptionId: record.subscriptionId, heapSubscriptionId: record.heapSubscriptionId, subscriptionResolution: record.subscriptionResolution, sourceMemberships: source ?? null });
      if (record.status === 'unsupported-call' || source?.status !== 'completed') { unknown.push('selected-source-membership-incomplete'); continue; }
      if (!record.heapSubscriptionId) {
        if (analysis.input?.weakIdentityProtocol !== 'registered-weakref-v1' || record.subscriptionResolution !== 'weak-ref-cleared') unknown.push('subscription-identity-unavailable');
        continue;
      }
      if (record.closedAtCheckpoint === null || record.closedAtCheckpoint === undefined) unknown.push('subscription-state-unavailable');
      // An open subscription with no supported Subject association may be waiting
      // for scheduling, or may use another producer/bridge. Do not certify it as zero.
      if (record.closedAtCheckpoint !== true && source.membershipCount === 0) unknown.push('open-subscription-without-supported-membership');
      for (const membership of source.memberships) memberships.set(JSON.stringify([membership.subjectId, membership.memberId]), membership);
    }
    results[ruleId] = { status: unknown.length ? 'unknown' : 'measured', value: unknown.length ? null : memberships.size, unknownReasons: [...new Set(unknown)],
      witnesses: [...memberships.values()], associations, sourcePositions: selected.map(record => record.registration), releaseCalls: selected.flatMap(record => record.releaseCalls ?? []),
      meaning: 'Unique (bound Subject kind, observer member) pairs whose bounded Subscriber.destination chain reaches a selected returned subscription at this checkpoint. Explicitly cleared returned subscriptions contribute zero to this relation only. Shared-subject bridges, stored values, arbitrary producers and other holders are not certified released.' };
  }
  return results;
}

export function measureSubjectStorage(analysis, bindings) {
  const results = {};
  for (const [ruleId, siteIds] of Object.entries(bindings)) {
    const selected = analysis.records.filter(record => siteIds.includes(record.registration.siteId)), unknown = [], pairs = new Map();
    if (analysis.status !== 'completed' || !analysis.coverage.completeWithinDeclaredScope) unknown.push('site-evidence-incomplete');
    if (!selected.length) unknown.push('no-covered-registration');
    for (const record of selected) {
      const storage = record.subjectStorage;
      if (record.status === 'unsupported-call' || storage?.status !== 'completed') { unknown.push('subject-storage-incomplete'); continue; }
      if (!storage.heapSubjectId) {
        if (analysis.input?.weakIdentityProtocol !== 'registered-weakref-v1' || storage.sourceResolution !== 'weak-ref-cleared') unknown.push('storage-source-identity-unavailable');
        continue;
      }
      for (const stored of storage.storedObjects) pairs.set(JSON.stringify([stored.subjectId, stored.valueId]), stored);
    }
    results[ruleId] = { status: unknown.length ? 'unknown' : 'measured', value: unknown.length ? null : pairs.size, unknownReasons: [...new Set(unknown)], witnesses: [...pairs.values()],
      associations: selected.map(record => ({ registrationSequence: record.sequence, subjectStorage: record.subjectStorage ?? null })), sourcePositions: selected.map(record => record.registration), releaseCalls: selected.flatMap(record => record.releaseCalls ?? []),
      meaning: 'Distinct (primary Subject, object/function) references in the bound BehaviorSubject/AsyncSubject._value or ReplaySubject._buffer. Explicitly cleared source identities contribute zero; subscription closure or disappearance alone never does. Primitives, error slots, other sources/owners and GC retained bytes are outside this contract.' };
  }
  return results;
}

export function assessRegressionSeries(contract, points) {
  const back = points.filter(point => point.phase === 'back'), final = points.at(-1), finalSettled = final?.phase === 'settled' && final.settled === true;
  const assessments = contract.rules.map(rule => {
    const observations = points.map(point => {
      const measurement = point.measurements[rule.id];
      const applicable = rule.expectation === 'bounded-after-back' ? ['back', 'settled'].includes(point.phase) : point.phase === 'settled';
      const verdict = measurement.status !== 'measured' ? 'unknown' : !applicable || (point.phase === 'settled' && !point.settled) ? 'pending' : measurement.value <= rule.maxEntries ? 'satisfied' : 'violated';
      return { phase: point.phase, cycle: point.cycle, settled: point.settled, value: measurement.value, verdict, capturePath: point.capturePath, captureSha256: point.captureSha256, unknownReasons: measurement.unknownReasons };
    });
    const relevant = observations.filter(point => ['back', 'settled'].includes(point.phase));
    const verdict = relevant.some(point => point.verdict === 'violated') ? 'violated' : relevant.some(point => point.verdict === 'unknown') ? 'unknown' : !finalSettled ? 'pending' : 'satisfied';
    const values = back.map(point => point.measurements[rule.id].value), measured = values.every(integer);
    const growth = measured && values.length >= 3 && values.slice(1).every((value, i) => value > values[i]);
    return { ruleId: rule.id, metric: rule.metric, expectation: rule.expectation, maxEntries: rule.maxEntries, verdict,
      pattern: verdict === 'unknown' ? 'insufficient-evidence' : !finalSettled ? 'awaiting-settle' : rule.expectation === 'release-at-settle' && verdict === 'satisfied' ? (rule.metric === 'subject-stored-object-count' ? 'storage-cleared-by-declared-settle' : 'membership-cleared-by-declared-settle') : growth ? (rule.metric === 'subject-stored-object-count' ? 'growing-stored-object-references' : 'growing-observer-membership') : verdict === 'satisfied' ? 'bounded-in-observed-window' : 'bound-exceeded', observations };
  });
  return { assessments, backCycles: back.length, finalSettled, completeForComparison: back.length >= regressionLimits.minBackCycles && finalSettled && assessments.every(rule => !['pending', 'unknown'].includes(rule.verdict)) && points.every(point => contract.rules.every(rule => point.measurements[rule.id].status === 'measured')) };
}

export function compareRegressionAssessments(before, after) {
  if (!before.completeForComparison || !after.completeForComparison) return { verdict: 'inconclusive', reason: 'Require at least three comparable back cycles, declared final settle and complete measured membership evidence in both arms.', repairVerdict: 'not-established' };
  const baselineViolation = before.assessments.some(rule => rule.verdict === 'violated'), afterViolation = after.assessments.some(rule => rule.verdict === 'violated');
  return { verdict: afterViolation ? baselineViolation ? 'contract-still-violated' : 'regression-observed' : baselineViolation ? 'contract-improvement-supported' : 'no-baseline-violation',
    reason: 'Comparison applies only to explicitly declared membership/storage reference contracts in the finite observed workload.', repairVerdict: 'not-established', resourceGarbageCollection: 'not-assessed' };
}

async function reference(base, artifact) {
  if (typeof artifact?.path !== 'string' || !digest(artifact.sha256)) fail('invalid-regression-artifact-reference');
  return boundFile(resolve(base, artifact.path), artifact.sha256);
}
// Read the collector's report/config first, before allocating any snapshot graph.
export async function loadRegressionSeriesMetadata(path, contract, contractSha256) {
  const file = await boundFile(path), series = JSON.parse(file.bytes), base = dirname(file.path);
  if (series.schemaVersion !== '0.1.0' || series.contractSha256 !== contractSha256 || series.scenario?.id !== contract.scenarioId || typeof series.bindingStatement !== 'string' || !series.bindingStatement.trim()) fail('regression-series-context-mismatch');
  const scenario = await reference(base, series.scenario), runFile = await reference(base, series.captureRun), run = JSON.parse(runFile.bytes);
  const configFile = await reference(base, series.captureConfig), config = JSON.parse(configFile.bytes);
  if (run.schemaVersion !== '0.1.0' || run.status !== 'completed' || run.configSha256 !== configFile.sha256 || run.scenario?.id !== contract.scenarioId || run.scenario.moduleSha256 !== scenario.sha256 || !Array.isArray(run.points)) fail('regression-collector-context-mismatch');
  if (await realpath(resolve(dirname(configFile.path), config.scenario)) !== scenario.path || await realpath(run.scenario.path) !== scenario.path) fail('regression-scenario-path-mismatch');
  const entry = await boundFile(run.build.entry, run.build.entrySha256);
  if (!digest(run.build.entrySha256) || await realpath(resolve(dirname(configFile.path), config.entry)) !== entry.path || sha256(Buffer.concat([scenario.bytes, entry.bytes])) !== run.scenario.workloadSha256) fail('regression-workload-hash-mismatch');
  if (!series.build?.bundleSha256 || !Array.isArray(series.points) || !series.points.length || series.points.length > regressionLimits.maxPoints) fail('invalid-regression-series');
  if (series.build.bundleSha256 !== run.build.bundleSha256 || series.points.length !== run.points.length || (config.cycles ?? 3) !== run.points.filter(p => p.phase === 'back').length) fail('regression-collector-schedule-mismatch');
  const bindings = series.bindings;
  if (!bindings || Object.keys(bindings).length !== contract.rules.length) fail('invalid-regression-bindings');
  for (const rule of contract.rules) if (!Array.isArray(bindings[rule.id]) || !bindings[rule.id].length || new Set(bindings[rule.id]).size !== bindings[rule.id].length || bindings[rule.id].some(id => typeof id !== 'string')) fail('invalid-regression-bindings');
  let previousCycle = 0, settled = false; const points = [];
  for (let i = 0; i < series.points.length; i++) {
    const point = series.points[i], recorded = run.points[i];
    if (!['action', 'back', 'settled'].includes(point.phase) || !integer(point.cycle) || !point.cycle || typeof point.settled !== 'boolean' || settled) fail('invalid-regression-phase-order');
    if (point.phase === 'back') { if (point.cycle !== previousCycle + 1) fail('invalid-regression-phase-order'); previousCycle = point.cycle; }
    else if (point.phase === 'settled') { if (point.cycle !== previousCycle) fail('invalid-regression-phase-order'); settled = true; }
    else if (point.cycle !== previousCycle + 1 || points.at(-1)?.phase === 'action') fail('invalid-regression-phase-order');
    const captured = await reference(base, point.capture), capture = JSON.parse(captured.bytes);
    const recordedPhase = recorded.phase === 'followup' ? 'settled' : recorded.phase;
    if (point.phase !== recordedPhase || point.cycle !== recorded.cycle || captured.sha256 !== recorded.capture?.sha256 || captured.path !== await realpath(resolve(dirname(runFile.path), recorded.capture.path)) || capture.epochId !== run.epochId || capture.loadedScriptSha256 !== run.build.bundleSha256 || capture.artifacts?.source?.sha256 !== run.build.sourceSha256 || capture.artifacts?.snapshot?.sha256 !== recorded.snapshot?.sha256) fail('regression-capture-provenance-mismatch');
    if (point.settled && (point.phase !== 'settled' || recorded.quiescence?.scenarioAsserted !== true || recorded.quiescence?.stableInstrumentedEvents !== true)) fail('regression-unasserted-settle');
    points.push({ ...point, capturePath: captured.path, captureSha256: captured.sha256 });
  }
  return { path: file.path, sha256: file.sha256, scenario: { id: series.scenario.id, sha256: scenario.sha256, workloadSha256: run.scenario.workloadSha256 }, build: run.build, bindingStatement: series.bindingStatement, bindings,
    captureRun: { path: runFile.path, sha256: runFile.sha256 }, captureConfig: { path: configFile.path, sha256: configFile.sha256 }, captureTiming: { cycles: config.cycles ?? 3, followupMs: config.followupMs ?? 500 }, expectedEpochId: run.epochId, points };
}
export function validateRegressionWorkload(contract, before, after) {
  if (before.scenario.sha256 !== after.scenario.sha256 || !isDeepStrictEqual(before.captureTiming, after.captureTiming)) fail('regression-comparison-context-mismatch');
  const change = contract.workloadChange;
  if (change.beforeEntrySha256 !== before.build.entrySha256 || change.afterEntrySha256 !== after.build.entrySha256) fail('regression-undeclared-entry-change');
  if (change.kind === 'same-entry') {
    if (before.build.entrySha256 !== after.build.entrySha256 || before.scenario.workloadSha256 !== after.scenario.workloadSha256) fail('regression-workload-mismatch');
  } else {
    if (before.build.entrySha256 === after.build.entrySha256 || before.build.sourceSha256 !== after.build.sourceSha256) fail('regression-uncontrolled-entry-switch');
    const otherInputs = build => Object.fromEntries(Object.entries(build.inputs).filter(([name]) => resolve(name) !== resolve(build.entry)));
    if (!isDeepStrictEqual(otherInputs(before.build), otherInputs(after.build))) fail('regression-uncontrolled-entry-switch');
  }
  if (!isDeepStrictEqual(before.build.dependency, after.build.dependency) || before.build.esbuildVersion !== after.build.esbuildVersion || before.build.parserVersion !== after.build.parserVersion) fail('regression-build-environment-mismatch');
  if (before.build.bundleSha256 === after.build.bundleSha256) fail('regression-no-build-change');
}
async function measureSeries(series, contract) {
  const { bindings } = series, points = [], epochs = new Set(), environments = new Set(), snapshots = new Set();
  for (const point of series.points) {
    const measured = await analyzePoint(point.capturePath, bindings, series.build.bundleSha256, point.captureSha256, contract.rules);
    const numbered = /^(back|followup|settled)-(\d+)$/.exec(measured.captureCheckpoint);
    if (numbered && (Number(numbered[2]) !== point.cycle || (numbered[1] === 'back' ? 'back' : 'settled') !== point.phase)) fail('regression-capture-phase-mismatch');
    if (snapshots.has(measured.snapshotSha256)) fail('regression-repeated-snapshot');
    snapshots.add(measured.snapshotSha256);
    epochs.add(measured.epochId); environments.add(measured.environment);
    points.push({ ...point, ...measured }); global.gc?.();
  }
  if (epochs.size !== 1 || !epochs.has(series.expectedEpochId) || environments.size !== 1) fail('regression-arm-runtime-mismatch');
  return { ...series, environment: [...environments][0], epochId: [...epochs][0], points, ...assessRegressionSeries(contract, points) };
}
async function analyzePoint(path, bindings, bundleHash, captureHash, rules) {
  const loaded = await loadSiteCapture(path), analysis = analyzeSiteEvidence(loaded);
  if (loaded.captureSha256 !== captureHash) fail('regression-capture-changed');
  if (loaded.capture.loadedScriptSha256 !== bundleHash) fail('regression-build-mismatch');
  const covered = new Set(analysis.records.map(record => record.registration.siteId));
  for (const ids of Object.values(bindings)) if (ids.some(id => !covered.has(id))) fail('regression-site-binding-not-observed');
  const runtime = loaded.capture.runtime, dependency = loaded.capture.dependency;
  const subset = metric => Object.fromEntries(rules.filter(rule => rule.metric === metric).map(rule => [rule.id, bindings[rule.id]]));
  return { epochId: loaded.capture.epochId, captureCheckpoint: loaded.capture.checkpoint, snapshotSha256: loaded.capture.artifacts.snapshot.sha256, environment: JSON.stringify({ adapter: loaded.capture.adapter, dependency: { name: dependency.name, version: dependency.version }, kind: runtime.kind ?? 'node-main-isolate', node: runtime.node, v8: runtime.v8, browserVersion: runtime.browserVersion }),
    measurements: { ...measureSubjectObservers(loaded, analysis, subset('subject-observer-count')), ...measureSubscriptionSubjects(analysis, subset('subscription-subject-membership-count')), ...measureSubjectStorage(analysis, subset('subject-stored-object-count')) }, siteAnalysis: { status: analysis.status, summary: analysis.summary, coverage: analysis.coverage, sourceMemberships: analysis.sourceMemberships, subjectStorage: analysis.subjectStorage } };
}
export async function analyzeRegression(beforePath, afterPath, contractPath) {
  const started = performance.now(), contractFile = await boundFile(contractPath), contract = validateRegressionContract(JSON.parse(contractFile.bytes));
  const beforeInput = await loadRegressionSeriesMetadata(beforePath, contract, contractFile.sha256), afterInput = await loadRegressionSeriesMetadata(afterPath, contract, contractFile.sha256);
  validateRegressionWorkload(contract, beforeInput, afterInput);
  const before = await measureSeries(beforeInput, contract), after = await measureSeries(afterInput, contract);
  if (before.scenario.sha256 !== after.scenario.sha256 || before.environment !== after.environment || JSON.stringify(before.points.map(p => [p.phase, p.cycle, p.settled])) !== JSON.stringify(after.points.map(p => [p.phase, p.cycle, p.settled]))) fail('regression-comparison-context-mismatch');
  const conclusion = compareRegressionAssessments(before, after), complete = before.completeForComparison && after.completeForComparison;
  return { schemaVersion: '0.1.0', status: complete ? 'completed' : 'incomplete', capability: 'declared-lifecycle-membership-regression', contract: { path: contractFile.path, sha256: contractFile.sha256, ...contract }, before, after, conclusion,
    gate: { pass: complete && after.assessments.every(rule => rule.verdict === 'satisfied'), meaning: 'Pass requires complete evidence and all after-arm declared membership/storage reference contracts satisfied; this gate does not assess global memory release or a production repair.' },
    limits: regressionLimits, resources: { elapsedMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS },
    limitations: ['Scenario and logical population bindings are explicit trusted assertions.', 'Subject.observers is a version-scoped membership metric, not all holders or all resources.', 'No statistics or population-wide generalization from three cycles.', 'sites unknown paths remain unknown; they are not used as release or GC evidence.'] };
}
