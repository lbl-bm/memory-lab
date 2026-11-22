import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { sha256 } from './heap-identity.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const operations = { listener: 'addEventListener', timeout: 'setTimeout', interval: 'setInterval' };
export const resourceRegressionLimits = { maxReportBytes: 16 * 1024 ** 2, maxEvidenceBytes: 4 * 1024 ** 2, maxRules: 16, maxPoints: 64, maxResources: 512, maxLabels: 8 };

async function json(path, maximum = resourceRegressionLimits.maxEvidenceBytes) {
  if ((await stat(path)).size > maximum) throw Error('resource-regression-input-budget');
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw Error('resource-regression-input-budget');
  return { value: JSON.parse(bytes), bytes };
}

export function validateResourceRules(rules) {
  if (rules?.schemaVersion !== '0.1.0' || !nonempty(rules.statement) || !nonempty(rules.beforeCase) || !nonempty(rules.afterCase)) throw Error('Resource rules require statement, beforeCase and afterCase');
  if (!['same-case', 'controlled-case-switch'].includes(rules.workload?.kind) || !nonempty(rules.workload.statement)) throw Error('Declare resource workload comparison');
  if (rules.workload.kind === 'same-case' && rules.beforeCase !== rules.afterCase) throw Error('Different cases require controlled-case-switch');
  if (typeof rules.settle?.confirmed !== 'boolean' || !nonempty(rules.settle.statement)) throw Error('Declare settle confirmation and its business condition');
  if (!Array.isArray(rules.rules) || !rules.rules.length || rules.rules.length > resourceRegressionLimits.maxRules || new Set(rules.rules.map(rule => rule.id)).size !== rules.rules.length) throw Error('Invalid resource rule count or duplicate IDs');
  for (const rule of rules.rules) {
    if (!nonempty(rule.id) || !['resource-active-count', 'declared-target-alive-count'].includes(rule.metric) || !['bounded-after-back', 'release-at-settle'].includes(rule.expectation) || !integer(rule.maxCount) || rule.maxCount > 512 || (rule.expectation === 'release-at-settle' && rule.maxCount !== 0)) throw Error('Invalid resource metric or bound');
    for (const selector of [rule.before, rule.after]) {
      if (rule.metric === 'resource-active-count') {
        if (!nonempty(selector?.file) || !integer(selector.line) || selector.line < 1 || (selector.column !== undefined && (!integer(selector.column) || selector.column < 1)) || !Object.hasOwn(operations, selector.kind) || (selector.kind === 'listener' && !nonempty(selector.eventType)) || (selector.kind !== 'listener' && selector.eventType !== undefined)) throw Error('Resource selector requires original source position, kind and listener eventType');
      } else if (!Array.isArray(selector?.labels) || !selector.labels.length || selector.labels.length > resourceRegressionLimits.maxLabels || selector.labels.some(label => !nonempty(label)) || new Set(selector.labels).size !== selector.labels.length) throw Error('Target selector requires distinct declared labels');
    }
    if (rule.metric === 'resource-active-count' && (rule.before.kind !== rule.after.kind || rule.before.eventType !== rule.after.eventType)) throw Error('Compared resource selectors must use the same kind and eventType');
  }
  return rules;
}

function selectSite(registry, selector) {
  const file = selector.file.replaceAll('\\', '/');
  const matches = registry.sites.filter(site => {
    const name = site.filename?.replaceAll('\\', '/') ?? '';
    return (name === file || name.endsWith('/' + file)) && site.line === selector.line && (selector.column === undefined || site.column === selector.column) && site.operation === operations[selector.kind];
  });
  return matches.length === 1 ? matches[0] : null;
}
const unknown = (...reasons) => ({ status: 'unknown', value: null, lifecycle: { established: null, released: null, retained: null, unknown: true }, reasons: [...new Set(reasons)], witnesses: [] });

export function measureResourcePoint(point, rule, selector, registry, heapResult) {
  const observation = point.observation;
  if (observation?.adapter !== 'browser-resources' || observation.epochId !== point.runtime?.epochId || !Array.isArray(observation.resources) || observation.resources.length > 512 || !Array.isArray(observation.declarations) || !Array.isArray(observation.objects)) return unknown('observation-missing-or-invalid');
  // Unsupported or dropped observations may include a matching resource. A missing
  // record must not become a zero count. Unrelated collected listener targets and
  // truncated path displays do not change this narrowly selected state metric.
  if (observation.coverage?.unsupported !== 0 || observation.coverage?.dropped !== 0) return unknown('resource-observation-incomplete');
  if (rule.metric === 'resource-active-count') {
    const site = selectSite(registry, selector);
    if (!site) return unknown('registration-site-missing-or-ambiguous');
    const records = observation.resources.filter(record => record.registrationSiteId === site.id && record.kind === selector.kind && (selector.kind !== 'listener' || record.type === selector.eventType));
    if (new Set(records.map(record => record.id)).size !== records.length || records.some(record => !/^r[1-9][0-9]*$/.test(record.id) || record.stateCertain !== true || !['active', 'running', 'released', 'completed'].includes(record.state))) return unknown('selected-resource-state-uncertain');
    const retained = records.filter(record => ['active', 'running'].includes(record.state)).length;
    return { status: 'measured', value: retained, lifecycle: { established: records.length, released: records.length - retained, retained, unknown: false }, reasons: [], witnesses: records.map(record => ({ resourceId: record.id, state: record.state, registration: record.registration, release: record.release, endedBy: record.endedBy ?? null })), site: { file: site.filename, line: site.line, column: site.column, operation: site.operation } };
  }
  if (!heapResult || !['completed', 'incomplete'].includes(heapResult.status) || heapResult.capability !== 'resource-heap-source-evidence' || heapResult.input?.epochId !== point.runtime?.epochId || resolve(heapResult.input?.capturePath ?? '.') !== resolve(point.heap?.capturePath ?? '.')) return unknown('heap-evidence-missing-or-mismatched');
  const snapshot = heapResult.input.snapshot, expectedSnapshot = point.heap.snapshot;
  if (!snapshot || !expectedSnapshot || !/^[a-f0-9]{64}$/.test(snapshot.sha256) || snapshot.sha256 !== expectedSnapshot.sha256 || snapshot.bytes !== expectedSnapshot.bytes || resolve(dirname(point.heap.capturePath), snapshot.path) !== resolve(expectedSnapshot.path)) return unknown('heap-snapshot-binding-mismatch');
  const witnesses = [];
  for (const label of selector.labels) {
    const declarations = observation.declarations.filter(value => value.role === 'target' && value.label === label);
    const targets = heapResult.targets?.filter(value => value.label === label) ?? [];
    if (declarations.length !== 1 || targets.length !== 1 || targets[0].objectId !== declarations[0].objectId || !['weak-cleared', 'present-in-final-heap'].includes(targets[0].resolution)) return unknown('selected-target-identity-missing-or-unresolved');
    if (observation.objects.filter(value => value.id === declarations[0].objectId && value.roles?.includes('declared-target')).length !== 1) return unknown('selected-target-identity-missing-or-unresolved');
    const target = targets[0];
    if (target.resolution === 'present-in-final-heap' ? (!integer(target.heapId) || target.heapId === 0 || target.node?.id !== target.heapId || target.bridgeResolution !== 'resolved') : (target.heapId !== null || target.node !== null || target.bridgeResolution !== 'cleared')) return unknown('selected-target-identity-missing-or-unresolved');
    witnesses.push({ label, objectId: targets[0].objectId, heapId: targets[0].heapId, resolution: targets[0].resolution });
  }
  const identities = new Map(witnesses.map(value => [value.objectId, value]));
  const retained = [...identities.values()].filter(value => value.resolution === 'present-in-final-heap').length;
  return { status: 'measured', value: retained, lifecycle: { established: identities.size, released: identities.size - retained, retained, unknown: false }, reasons: [], witnesses };
}

function comparisonVerdict(before, after) {
  if (before === 'unknown' || after === 'unknown') return 'inconclusive';
  if (before === 'violated' && after === 'satisfied') return 'contract-improvement-supported';
  if (before === 'satisfied' && after === 'violated') return 'contract-regression-supported';
  return after === 'violated' ? 'contract-still-violated' : 'no-baseline-violation';
}

export function assessResourceSeries(points, rule, settled, structuralReasons = [], selector = rule.before) {
  const backs = points.filter(point => /^back-[1-9][0-9]*$/.test(point.phase));
  const followups = points.filter(point => /^followup-[1-9][0-9]*$/.test(point.phase));
  const reasons = [...structuralReasons];
  if (backs.length < 3 || backs.some((point, index) => point.phase !== 'back-' + (index + 1))) reasons.push('three-ordered-back-cycles-required');
  if (!settled || followups.length !== 1 || followups[0].phase !== 'followup-' + backs.length || points.indexOf(followups[0]) < points.indexOf(backs.at(-1))) reasons.push('confirmed-settled-followup-required');
  const selected = [...backs, ...followups];
  if (selected.some(point => point.measurement.status !== 'measured')) reasons.push('selected-measurement-unknown');
  const recordedResources = new Set(), declaredTargets = new Map();
  for (const point of points) {
    if (point.measurement.status !== 'measured') continue;
    if (rule.metric === 'resource-active-count') {
      const ids = new Set(point.measurement.witnesses.map(witness => witness.resourceId));
      // The collector keeps released records. Disappearance is missing history,
      // not observed release, even if the point claims zero dropped records.
      if ([...recordedResources].some(id => !ids.has(id))) reasons.push('resource-history-missing');
      for (const id of ids) recordedResources.add(id);
    } else for (const witness of point.measurement.witnesses) {
      if (declaredTargets.has(witness.label) && declaredTargets.get(witness.label) !== witness.objectId) reasons.push('declared-target-identity-changed');
      declaredTargets.set(witness.label, witness.objectId);
    }
  }
  // Establishment is a precondition, not evidence that later cleanup can supply.
  // The first back may carry a released record proving an earlier registration.
  const initial = points.slice(0, points.indexOf(backs[0]) + 1).filter(point => point.measurement.status === 'measured');
  const established = rule.metric === 'resource-active-count'
    ? initial.some(point => point.measurement.lifecycle.established > 0)
    : selector.labels.every(label => initial.some(point => point.measurement.witnesses.some(witness => witness.label === label && witness.resolution === 'present-in-final-heap')));
  if (!established) reasons.push('selected-resource-or-target-never-observed-established');
  const checked = rule.expectation === 'release-at-settle' ? followups : selected;
  const verdict = reasons.length ? 'unknown' : checked.some(point => point.measurement.value > rule.maxCount) ? 'violated' : 'satisfied';
  return { verdict, reasons: [...new Set(reasons)], points, backCounts: backs.map(point => point.measurement.value), followupCount: followups[0]?.measurement.value ?? null, checkedPhases: checked.map(point => point.phase) };
}

async function loadRun(path, caseName) {
  path = resolve(path);
  const run = (await json(path, resourceRegressionLimits.maxReportBytes)).value;
  if (!['completed', 'incomplete'].includes(run.status) || run.capability !== 'browser-resource-lifecycle-source-evidence' || !Array.isArray(run.points) || !Array.isArray(run.comparisons)) throw Error('Expected finished browser-resources capture');
  const registryFile = await json(resolve(dirname(path), 'registry.json'));
  if (sha256(registryFile.bytes) !== run.build?.registrySha256 || registryFile.value.adapter !== 'browser-resources' || !Array.isArray(registryFile.value.sites) || registryFile.value.sites.length > 512) throw Error('Resource registry does not match captured build');
  const points = run.points.filter(point => point.case === caseName && point.mode === 'instrumented');
  if (points.length > resourceRegressionLimits.maxPoints) throw Error('resource-regression-point-budget');
  const reasons = [], comparison = run.comparisons.filter(item => item.case === caseName);
  if (comparison.length !== 1 || comparison[0].sameBehavior !== true || comparison[0].expectedErrors !== true) reasons.push('paired-behavior-not-confirmed');
  if (!points.length || new Set(points.map(point => point.phase)).size !== points.length) reasons.push('missing-or-duplicate-checkpoints');
  for (const key of ['epochId', 'targetId', 'frameId', 'scriptId', 'browserVersion']) if (!nonempty(points[0]?.runtime?.[key]) || points.some(point => point.runtime?.[key] !== points[0].runtime[key])) reasons.push('capture-runtime-mismatch');
  return { path, run, registry: registryFile.value, points, reasons };
}

export async function analyzeResourceRegression(beforePath, afterPath, rulesPath) {
  const started = performance.now(), rules = validateResourceRules((await json(resolve(rulesPath))).value);
  const before = await loadRun(beforePath, rules.beforeCase), after = await loadRun(afterPath, rules.afterCase);
  const globalReasons = [];
  if (!nonempty(before.run.scenario?.name) || before.run.scenario.name !== after.run.scenario?.name) globalReasons.push('scenario-name-mismatch');
  if (before.points[0]?.runtime?.browserVersion !== after.points[0]?.runtime?.browserVersion) globalReasons.push('browser-version-mismatch');
  const arms = [];
  for (const [index, arm] of [before, after].entries()) {
    const series = new Map(rules.rules.map(rule => [rule.id, []]));
    for (const point of arm.points) {
      let heapResult = null;
      if (rules.rules.some(rule => rule.metric === 'declared-target-alive-count') && point.heap?.resultPath) {
        try { heapResult = (await json(resolve(dirname(arm.path), point.heap.resultPath))).value; } catch { /* Absence remains an unknown measurement. */ }
      }
      for (const rule of rules.rules) series.get(rule.id).push({ phase: point.phase, measurement: measureResourcePoint(point, rule, rule[index === 0 ? 'before' : 'after'], arm.registry, heapResult) });
    }
    arms.push(rules.rules.map(rule => assessResourceSeries(series.get(rule.id), rule, rules.settle.confirmed, [...globalReasons, ...arm.reasons], rule[index === 0 ? 'before' : 'after'])));
  }
  const results = rules.rules.map((rule, index) => ({ id: rule.id, metric: rule.metric, expectation: rule.expectation, maxCount: rule.maxCount, before: arms[0][index], after: arms[1][index], verdict: comparisonVerdict(arms[0][index].verdict, arms[1][index].verdict) }));
  const scopedGate = results.some(result => result.verdict === 'inconclusive') ? 'inconclusive' : results.some(result => result.after.verdict === 'violated') ? 'fail' : 'pass';
  const inputEvidenceIncomplete = [before, after].some(arm => arm.run.status === 'incomplete' || arm.points.some(point => point.heap?.status === 'incomplete' || point.observation?.coverage?.completeWithinScope !== true));
  const status = inputEvidenceIncomplete || scopedGate === 'inconclusive' ? 'incomplete' : 'completed';
  return { schemaVersion: '0.1.0', capability: 'resource-lifecycle-regression', status, gate: status === 'incomplete' ? 'inconclusive' : scopedGate, scopedGate, authority: 'caller-asserted-business-contract', input: { beforeRun: before.path, afterRun: after.path, rulesPath: resolve(rulesPath), beforeCase: rules.beforeCase, afterCase: rules.afterCase }, workload: rules.workload, settle: rules.settle, rules: results, coverage: { inputEvidenceIncomplete, globalReasons, limits: resourceRegressionLimits }, resources: { elapsedMs: performance.now() - started, nodeMaxRssKiB: process.resourceUsage().maxRSS }, interpretation: 'Measures selected registration states and explicitly declared target identities from saved collector reports. Registration release and target collection are independent. It does not certify all holders, all resource kinds, application equivalence or global leak freedom. Workload and settle are caller assertions; controlled case switches are consumer controls, not an upstream fix. Raw heap analyses are reused, not recomputed. Incomplete input evidence remains incomplete even when selected rules pass.' };
}
