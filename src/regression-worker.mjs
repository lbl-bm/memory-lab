import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeRegression } from './regression.mjs';
import { sha256 } from './heap-identity.mjs';
const [before, after, contract, output] = process.argv.slice(2), started = performance.now(); let result;
try { result = await analyzeRegression(before, after, contract); if (result.status === 'incomplete') process.exitCode = 2; }
catch (error) { result = { schemaVersion: '0.1.0', status: 'failed', error: { code: error.code ?? 'regression-worker-error', message: error.message } }; process.exitCode = 1; }
result.tool = { node: process.version, v8: process.versions.v8, dependencies: 'Node built-ins only; replays existing sites captures', hashes: Object.fromEntries(await Promise.all(['regression.mjs', 'regression-worker.mjs', 'site-evidence.mjs', 'subscription-sources.mjs', 'subject-storage.mjs', 'receiver-subjects.mjs', 'incoming-index.mjs', 'reverse-paths.mjs', 'heap-identity.mjs'].map(async name => [name, sha256(await readFile(new URL(name, import.meta.url)))]))) };
result.resources = { elapsedMs: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS, maxOldSpaceMiB: 512 };
if (result.resources.maxRssKiB > 768 * 1024) { result.status = 'failed'; result.gate = { pass: false, meaning: 'Worker exceeded 768 MiB measured max RSS' }; result.error = { code: 'regression-rss-budget', message: 'Worker exceeded 768 MiB measured max RSS' }; process.exitCode = 1; }
await writeFile(resolve(output, 'regression.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
const lines = ['# Declared lifecycle reference regression', '', 'Analysis: ' + result.status, '', result.error?.message ?? ('Conclusion: ' + result.conclusion.verdict), '', 'Gate pass: ' + (result.gate?.pass ?? false), '', result.gate?.meaning ?? ''];
for (const arm of ['before', 'after']) for (const rule of result[arm]?.assessments ?? []) lines.push('', `${arm} / ${rule.ruleId}: ${rule.verdict} (${rule.pattern})`, '', 'Counts: ' + rule.observations.map(point => `${point.phase}[${point.cycle}]=${point.value ?? 'unknown'}`).join(' / '));
await writeFile(resolve(output, 'regression.md'), lines.join('\n') + '\n', { flag: 'wx' });
