import { basename, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { ownFile, readJSON, resolveCaptureInputs } from './capture-evidence.mjs';

const definedText = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 500;
function declareRule(rule) {
  if (rule?.schemaVersion !== '0.1.0' || !definedText(rule.id) || !definedText(rule.owner)
    || !definedText(rule.releasePoint) || !definedText(rule.expectationSource)
    || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(rule.diagnosticKey ?? '')
    || !Number.isSafeInteger(rule.maxRetained) || rule.maxRetained < 0) {
    throw Error('Repair contract requires id, owner, releasePoint, expectationSource, diagnosticKey and maxRetained');
  }
  return { id: rule.id, owner: rule.owner, releasePoint: rule.releasePoint, expectationSource: rule.expectationSource,
    diagnosticKey: rule.diagnosticKey, maxRetained: rule.maxRetained, phase: 'followup' };
}
const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const definedState = value => value !== null && typeof value === 'object' && Object.keys(value).length > 0;

function workload(r) {
  const c = r?.config, b = r?.browser;
  if (!c || !b || !definedText(b.version) || !sha(r.scenario?.moduleSha256) || !sha(r.tool?.runnerSha256)
    || !Number.isInteger(c.cycles) || c.cycles < 1 || c.cycles > 5
    || !Number.isInteger(c.warmupCycles) || !Number.isInteger(c.settleMs)) return null;
  let url;
  try { url = new URL(c.url); } catch { return null; }
  return {
    scenario: r.scenario.moduleSha256, runner: r.tool.runnerSha256,
    url: [url.protocol, url.hostname, url.pathname, url.search, url.hash],
    cycles: c.cycles, warmupCycles: c.warmupCycles, settleMs: c.settleMs,
    viewport: b.viewport ?? null, locale: b.locale ?? null, timezone: b.timezone ?? null,
    version: b.version, headless: b.headless ?? null, freshContext: b.freshContext ?? null,
  };
}

function observationPath(r) {
  const trail = r.observations;
  if (!Array.isArray(trail) || trail.length !== 2 + 3 * r.config.cycles) return null;
  if (trail[0]?.phase !== 'baseline' || trail.at(-1)?.phase !== 'followup') return null;
  if (!trail.every(x => definedState(x?.state))) return null;
  for (let i=1; i<=r.config.cycles; i++) {
    const triplet = trail.slice(1+3*(i-1), 1+3*i);
    if (!triplet.every((x, j) => x.cycle === i && x.phase === ['action','back','assertBaseline'][j])) return null;
  }
  return trail;
}

export function assessSelectedRepair(before, after, rule) {
  const a = workload(before), b = workload(after);
  if (before.status !== 'completed' || after.status !== 'completed' || !a || !b || !isDeepStrictEqual(a, b))
    return { verdict:'insufficient-evidence', reason:'Capture workload, browser, or scenario does not match.' };
  const x = observationPath(before), y = observationPath(after);
  if (!x || !y || !isDeepStrictEqual(x, y))
    return { verdict:'insufficient-evidence', reason:'Functional observations are incomplete or differ across runs.' };
  const read = r => {
    const points = r.samples?.filter(s => s.phase === 'followup') ?? [];
    if (points.length !== 1 || points[0].cycle !== r.config.cycles) return null;
    const diagnostic = points[0].diagnostic;
    const value = diagnostic && Object.hasOwn(diagnostic,rule.diagnosticKey) ? diagnostic[rule.diagnosticKey] : null;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const beforeCount = read(before), afterCount = read(after);
  const observed = {beforeCount, afterCount};
  if (beforeCount === null || afterCount === null)
    return {...observed, verdict:'insufficient-evidence', reason:'No usable paired follow-up counts for this rule.'};
  if (beforeCount <= rule.maxRetained)
    return {...observed, verdict:'not-reproduced', reason:'The selected release rule already passed before the change.'};
  if (afterCount > rule.maxRetained)
    return {...observed, verdict:'not-verified', reason:'The selected release rule is still violated after the change.'};
  return {...observed, verdict:'verified-for-rule', reason:'The selected release rule changed from violated to satisfied with matched functional observations.'};
}

export async function checkRepair(before, after, contract) {
  const rule = declareRule(await readJSON(resolve(contract)));
  const load = async input => {
    const root = await realpath(resolve(input));
    const file = await ownFile(root, 'report.json');
    if (!file) throw Error('Missing capture report');
    const r = await readJSON(file);
    if (r.schemaVersion !== '0.1.0' || r.runId !== basename(root) || !Array.isArray(r.artifacts)) throw Error('Invalid capture report');
    const inputs = await resolveCaptureInputs(root, r, 'followup');
    return {r, evidence:{runId:r.runId, report:file, provenance:inputs.provenance, inputs:inputs.hashes, missing:inputs.missing}};
  };
  const a = await load(before), b = await load(after);
  const evidence = {before:a.evidence, after:b.evidence};
  let result;
  if (a.r.runId === b.r.runId || [a,b].some(v=>v.evidence.provenance !== 'verified' || v.evidence.missing.length))
    result = {verdict:'insufficient-evidence', reason:'Verification needs two distinct captures with verified input snapshots.'};
  else result = assessSelectedRepair(a.r,b.r,rule);
  return {schemaVersion:'0.1.0', kind:'memory-lab-repair-check', rule, evidence, ...result,
    scope:'Only the supplied scenario and follow-up count. This is not proof of heap collection or a general leak verdict.'};
}
const line = x => String(x).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');
export function renderRepairCheck(r) {
  return [
    'Repair check: ' + r.verdict, r.reason, 'Rule: ' + r.rule.id + '; declared owner: ' + r.rule.owner,
    'Expected release: ' + r.rule.releasePoint + ' (' + r.rule.expectationSource + ')',
    'Follow-up count: ' + (r.beforeCount ?? 'unknown') + ' -> ' + (r.afterCount ?? 'unknown') + '; limit: ' + r.rule.maxRetained,
    'Before run: ' + r.evidence.before.runId, 'After run: ' + r.evidence.after.runId, r.scope,
  ].map(line).join('\n') + '\n';
}
