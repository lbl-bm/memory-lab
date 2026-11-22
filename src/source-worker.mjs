import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeSourceCandidates } from './source-candidates.mjs';
import { withDeadline } from './deadline.mjs';
const [runDir, identity, scripts, contract, output, evidence, maxSourceBytes, nativeOptions] = process.argv.slice(2);
try {
  const report = await withDeadline(analyzeSourceCandidates(runDir, identity || null, scripts || null, contract || null, { ...JSON.parse(nativeOptions || '{}'), evidencePath: evidence || null, maxSourceBytes: maxSourceBytes ? Number(maxSourceBytes) : undefined }), 55000, 'Source candidate analysis');
  await writeFile(resolve(output, 'source.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const lines = ['# Source candidates, causal role unknown', '', 'Identity: ' + report.identity.status, '', 'Source mapping: ' + report.conclusion.sourceMapping, '', 'Lifecycle assessment: ' + report.lifecycleAssessment.verdict, '', 'V8 positions and nearby functions are source clues, not an observed retaining write or repair location.', ''];
  if (report.nativeEvidence) {
    const e = report.nativeEvidence;
    lines.push('Native evidence: ' + e.status + (e.code ? ' (' + e.code + ')' : ''), 'Growth groups: ' + (e.growth?.candidateCount ?? 'unknown'), 'Selected generic object lifecycle: ' + e.representativeLifecycle.verdict, 'GC retention: ' + e.conclusion.gcRetention, '');
    if (e.selection?.selected) lines.push('Representative: ' + e.selection.group.name + ' @' + e.selection.nodeId + '; counts: ' + e.selection.counts.join(' / ') + '; present at followup: ' + e.selection.presentAtFollowup, '');
    if (e.search) lines.push('Literal path search: ' + e.search.outcome + '; ' + e.search.stopReason + '; edges: ' + (e.search.path?.edgeCount ?? 'none'), 'Semantic cautions: ' + JSON.stringify(e.search.semanticAssessment.cautions), '');
  }
  if (report.search?.truncated) lines.push('Source-position search was truncated by the recorded policy; candidate coverage is incomplete.', '');
  if (report.search?.coverage) {
    const { direct, neighbors } = report.search.coverage;
    lines.push('Direct path nodes inspected: ' + direct.inspectedNodes + '/' + direct.requestedNodes + '; located: ' + direct.locatedNodes + '; missing: ' + direct.missingLocations + '; omitted by output cap: ' + direct.omittedPositions + '.', 'Neighbor search: ' + neighbors.coverage + '; stop: ' + neighbors.stopReason + '.', '');
  }
  if (report.originalSourceEvidence) {
    const e = report.originalSourceEvidence;
    lines.push('Original-source mapping: ' + e.status + '; mapped records: ' + e.mappedRecords + '; unknown records: ' + e.unknownRecords + '; invalid records: ' + e.invalidRecords + '.', 'Coordinate decoding: ' + e.coordinates.decodedRecords + ' decoded; ' + e.coordinates.unknownRecords + ' unknown; ' + e.coordinates.notEvaluatedRecords + ' not evaluated.', 'Source provenance: ' + e.provenance.directBuildInputRecords + ' direct build inputs; ' + e.provenance.postCaptureDependencyRecords + ' preserved-content + post-capture dependency links. Historical dependency-map bytes and exact intermediate transforms remain unverified.', '');
  }
  for (const c of report.candidates) {
    const o = c.originalSourceMapping;
    lines.push('- [' + c.nodeType + ' @' + c.nodeId + '] ' + c.source.path + ':' + c.source.line + ':' + c.source.column + ' (' + c.relation.kind + '); original mapping: ' + o.status + (o.source ? '; ' + o.source.path + ':' + o.source.line + ':' + o.source.column + ' (' + o.precision + '; ' + o.provenance.tier + ')' : o.code ? ' (' + o.code + ')' : ''));
  }
  if (!report.candidates.length) lines.push('No mapped source candidate. See structured unknown reasons in source.json.');
  lines.push('', 'Collector provenance remains a trust input; exact source bytes do not establish causation.');
  await writeFile(resolve(output, 'source.md'), lines.join('\n') + '\n', { flag: 'wx' }); if (report.status !== 'completed') process.exitCode = 1;
} catch (error) { await writeFile(resolve(output, 'error.json'), JSON.stringify({ status: 'failed', error: { name: error.name, message: error.message } }, null, 2) + '\n', { flag: 'wx' }); process.exitCode = 1; }
