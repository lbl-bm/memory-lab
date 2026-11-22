import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadRunPoints } from './snapshot-growth.mjs';
import { sha256, readBoundJson, verifyBoundSource, projectIdentityHeap, validateIdentitySeries, routePolicy } from './heap-identity.mjs';

export function assessLifecycle(contract, identity, points, projections, manifest, sourceValid) {
  const unknown = (code, detail) => ({ verdict: 'unknown', code, detail, leakVerdict: 'not-determined' });
  if (!identity.comparable) return unknown(identity.code, 'Identity gate failed or is unknown; no cross-snapshot object inference');
  if (!contract) return unknown('missing-lifecycle-context', 'No lifecycle assertion supplied. Ownership routes do not establish intended lifetime.');
  if (contract.authority !== 'asserted') return unknown('unconfirmed-lifecycle-hypothesis', 'Inferred or proposed expectations cannot support a contract verdict');
  if (contract.schemaVersion !== '0.1.0' || contract.ownerToken !== manifest.ownerToken || !contract.provenance?.statement || !sourceValid) return unknown('unbound-lifecycle-context', 'Explicit owner and hashed provenance are required');
  const expectation = contract.expectation;
  if (!expectation || !['release-after-close', 'bounded-cache'].includes(expectation.kind)) return unknown('unsupported-lifecycle-context', 'Unsupported lifecycle expectation');
  const missingRoute = projections.some(p => p.resources.some(r => r.ownerRoute.status !== 'observed'));
  if (missingRoute) return unknown('insufficient-owner-evidence', 'A declared owner-to-resource non-weak route was not measured within the fixed budget');
  const conditional = 'Conditional on the supplied lifecycle assertion, truthful events and marker coverage. Not a universal or autonomous leak judgment.';
  const counts = projections.map(p => p.resources.length);
  if (expectation.kind === 'bounded-cache') {
    if (!Number.isSafeInteger(expectation.maxEntries) || expectation.maxEntries < 0) return unknown('invalid-cache-bound', 'Cache bound must be an explicit nonnegative integer');
    const exceededAt = counts.flatMap((count, i) => count > expectation.maxEntries ? [{ point: i, phase: points[i].phase, cycle: points[i].cycle, count }] : []);
    return { verdict: exceededAt.length ? 'cache-bound-violation-supported' : 'consistent-with-declared-cache', counts, maxEntries: expectation.maxEntries, exceededAt, conditional, leakVerdict: 'not-determined', limitation: 'Finite observed points and tagged resources only; no proof that the cache will remain bounded.' };
  }
  if (!Number.isSafeInteger(expectation.graceMs) || expectation.graceMs < 0) return unknown('invalid-release-window', 'Release grace must be an explicit nonnegative integer');
  const events = manifest.resources;
  if (events.some(e => e.closedNs == null)) return unknown('missing-close-boundary', 'Every covered resource needs an observed close boundary');
  if (manifest.points.some(p => !Number.isSafeInteger(p.gcCount) || p.gcCount < 2)) return unknown('insufficient-gc-evidence', 'Collector must record at least two completed GC requests before every snapshot');
  const graceNs = BigInt(expectation.graceMs) * 1000000n, violations = [], releases = [], pending = [];
  for (const event of events) {
    const due = BigInt(event.closedNs) + graceNs;
    let observed = false;
    for (let i = 0; i < points.length; i++) {
      const r = projections[i].resources.find(r => r.token === event.token);
      if (r && BigInt(event.createdNs) > BigInt(manifest.points[i].startedNs)) return unknown('event-after-observation', 'Creation event occurs after observed resource');
      if (BigInt(manifest.points[i].startedNs) < due) continue;
      observed = true;
      if (r) violations.push({ token: event.token, nodeId: r.id, point: i, phase: points[i].phase, cycle: points[i].cycle, ownerRoute: r.ownerRoute, elapsedAfterCloseMs: Number(BigInt(manifest.points[i].startedNs) - BigInt(event.closedNs)) / 1e6 });
    }
    const seen = projections.some(p => p.resources.some(r => r.token === event.token));
    const atEnd = projections.at(-1).resources.some(r => r.token === event.token);
    if (seen && !atEnd) releases.push({ token: event.token, absentAt: points.length - 1 });
    if (!observed) pending.push(event.token);
  }
  return { verdict: violations.length ? 'residual-after-declared-deadline-supported' : pending.length ? 'release-window-not-observed' : releases.length ? 'release-observed' : 'unknown', counts, graceMs: expectation.graceMs, violations, releases, pending, conditional, leakVerdict: 'not-determined', limitation: 'Snapshot intervals bound observation time; exact release instant and untagged objects are not measured.' };
}

export async function analyzeLifecycle(runDir, identityPath = null, contractPath = null) {
  const start = performance.now(), input = await loadRunPoints(runDir);
  const captureReportSha256 = sha256(await readFile(resolve(input.runDir, 'report.json')));
  const identityFile = identityPath ? await readBoundJson(identityPath) : null;
  const manifest = identityFile?.value ?? null, projections = [];
  let collectorSourceValid = false;
  if (manifest) {
    try { collectorSourceValid = await verifyBoundSource(manifest.collector, input.runDir); } catch { /* Invalid provenance is reported as invalid, not promoted. */ }
    for (const point of input.points) {
      const raw = await readFile(point.path); point.sha256 = sha256(raw);
      projections.push(projectIdentityHeap(JSON.parse(raw), manifest.ownerToken)); global.gc?.();
    }
  }
  const identity = validateIdentitySeries(manifest, input.report, captureReportSha256, input.points, projections, collectorSourceValid);
  const contractFile = contractPath ? await readBoundJson(contractPath) : null;
  let contractSourceValid = false;
  if (contractFile) { try { contractSourceValid = await verifyBoundSource(contractFile.value.provenance, input.runDir); } catch {} }
  const assessment = assessLifecycle(contractFile?.value, identity, input.points, projections, manifest, contractSourceValid);
  const tool = { name: 'conditional-lifecycle', implementationSha256: sha256(await readFile(new URL(import.meta.url))), identityImplementationSha256: sha256(await readFile(new URL('./heap-identity.mjs', import.meta.url))) };
  return { schemaVersion: '0.1.0', status: identity.status === 'invalid' ? 'refused' : 'completed', method: 'Explicit lifecycle sidecar + collector-trusted token/epoch consistency + measured owner routes', tool, runId: input.report.runId, captureKind: input.report.captureKind, inputs: { runDir: input.runDir, captureReportSha256, identity: identityFile && { path: identityFile.path, sha256: identityFile.sha256 }, contract: contractFile && { path: contractFile.path, sha256: contractFile.sha256 }, points: input.points }, identity, context: { authority: contractFile?.value?.authority ?? 'missing', provenance: contractFile?.value?.provenance ?? null, sourceValid: contractSourceValid }, assessment, measurements: projections.map((p, i) => ({ point: i, nodeCount: p.nodeCount, anchors: p.anchors, owners: p.owners, resources: p.resources })), policy: { route: routePolicy, maxInputBytes: 64 * 1024 ** 2, nodeMarkerScope: 'Opt-in tagged objects only; labels and tokens influence the heap. No automatic ownership inference.' }, conclusion: { leakVerdict: 'not-determined', sourceLocalization: 'not-implemented', repairValidation: 'not-tested', browserValidation: 'not-completed', strictBlindTest: 'not-started' }, resources: { elapsedMs: performance.now() - start, maxRssKiB: process.resourceUsage().maxRSS, maxOldSpaceMiB: 512 } };
}
