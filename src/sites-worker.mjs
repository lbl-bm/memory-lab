import { readFile, writeFile } from 'node:fs/promises';
import { sha256 } from './heap-identity.mjs';
import { loadSiteCapture, analyzeSiteEvidence } from './site-evidence.mjs';

const [capturePath, nodeText, outputPath, markdownPath] = process.argv.slice(2), start = performance.now();
let result;
try {
  let targetId = null;
  if (nodeText) {
    if (!/^(0|[1-9][0-9]*)$/.test(nodeText) || !Number.isSafeInteger(Number(nodeText))) throw Error('invalid-node-id');
    targetId = Number(nodeText);
  }
  result = analyzeSiteEvidence(await loadSiteCapture(capturePath), targetId);
  if (result.status === 'incomplete') process.exitCode = 2;
} catch (error) {
  result = { schemaVersion: '0.1.0', status: 'failed', capability: 'source-site-subscription-evidence', error: { code: error.code ?? 'site-evidence-error', message: error.message } };
  process.exitCode = 1;
}
result.tool = { node: process.version, v8: process.versions.v8, dependencies: 'Node built-ins only; no application execution or source-map decoding', hashes: Object.fromEntries(await Promise.all(['site-evidence.mjs', 'sites-worker.mjs', 'subscription-sources.mjs', 'subject-storage.mjs', 'receiver-subjects.mjs', 'incoming-index.mjs', 'reverse-paths.mjs', 'heap-identity.mjs'].map(async name => [name, sha256(await readFile(new URL(name, import.meta.url)))]))) };
result.resources = { elapsedMs: performance.now() - start, maxRssKiB: process.resourceUsage().maxRSS, maxOldSpaceMiB: 512 };
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
const lines = ['# Source-site subscription evidence', '', `Status: ${result.status}`, '', result.interpretation ?? result.error.message, ''];
if (result.coverage) lines.push(`Coverage: ${JSON.stringify(result.coverage)}`, '');
if (result.sourceMemberships) lines.push(`Bound Subject membership analysis: ${result.sourceMemberships.status}; this scope is separate from registration/observer path coverage.`, '');
for (const record of result.records ?? []) {
  const position = record.registration;
  lines.push(`- ${position.file}:${position.line}:${position.column} — ${record.status}; matched paths: ${record.matches.length}; closed at checkpoint: ${record.closedAtCheckpoint ?? 'unknown'}.`);
  if (record.sourceMemberships) lines.push(`  Current bound Subject memberships: ${record.sourceMemberships.membershipCount}; status: ${record.sourceMemberships.status}. This is not all upstream sources or all retaining resources.`);
  if (record.subjectStorage) lines.push(`  Primary Subject stored object references: ${record.subjectStorage.objectCount}; status: ${record.subjectStorage.status}; kind: ${record.subjectStorage.subjectKind ?? 'unavailable'}. Member cleanup does not imply value/buffer cleanup.`);
  if (record.receiverHolders) lines.push(`  Receiver closure holder hints: ${record.receiverHolders.status}; Subjects with a positive literal path: ${record.receiverHolders.subjects.length}. Hints are not shared-operator or cleanup certification.`);
  for (const holder of record.receiverHolders?.subjects ?? []) lines.push(`  Receiver-held ${holder.kind} @${holder.subjectId}: ${holder.path.map(edge => String(edge.name)).join(' → ')}; stored object references: ${holder.storage?.objectCount ?? 'unknown'} (${holder.storage?.status ?? 'unavailable'}).`);
  for (const release of record.releaseCalls) lines.push(`  Release call ${release.position.file}:${release.position.line}:${release.position.column}: ${release.outcome}; closed after call: ${release.closedAfter}.`);
}
await writeFile(markdownPath, lines.join('\n') + '\n', { flag: 'wx' });
