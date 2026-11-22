import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './heap-identity.mjs';
import { validateRegressionContract } from './regression.mjs';

async function jsonFile(path) {
  path = resolve(path);
  if ((await stat(path)).size > 1024 ** 2) throw Error('project-regression-metadata-budget');
  const bytes = await readFile(path);
  if (bytes.length > 1024 ** 2) throw Error('project-regression-metadata-budget');
  return { path, sha256: sha256(bytes), value: JSON.parse(bytes) };
}
const reference = file => ({ path: file.path, sha256: file.sha256 });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function selectRegistration(registry, selector) {
  if (!nonempty(selector?.file) || !Number.isSafeInteger(selector.line) || selector.line < 1) throw Error('Registration selector requires file and positive original line');
  const file = selector.file.replaceAll('\\', '/');
  const matches = registry.sites.filter(site => {
    const name = (site.filename ?? registry.filename).replaceAll('\\', '/');
    return site.operation === 'subscribe' && site.line === selector.line && (name === file || name.endsWith('/' + file));
  });
  if (matches.length !== 1) throw Error(`Expected exactly one subscribe at ${file}:${selector.line}; found ${matches.length}`);
  return matches[0].id;
}

async function runInput(path) {
  const file = await jsonFile(path), run = file.value, base = dirname(file.path);
  if (run.status !== 'completed' || !run.build || !run.scenario || !Array.isArray(run.points) || !run.points.length) throw Error('Expected a completed browser-sites report');
  // Older reports can find their config in the command's existing invocation record.
  const configPath = run.configPath ?? (await jsonFile(join(base, 'analysis.json'))).value.invocation?.args?.[2];
  if (!configPath) throw Error('Capture report does not identify its config');
  const config = await jsonFile(resolve(base, configPath));
  const scenarioPath = resolve(dirname(config.path), config.value.scenario), scenarioBytes = await readFile(scenarioPath);
  const capture = await jsonFile(resolve(base, run.points[0].capture.path));
  const registry = await jsonFile(resolve(dirname(capture.path), capture.value.artifacts.registry.path));
  return { file, run, config, scenario: { path: scenarioPath, sha256: sha256(scenarioBytes) }, registry: registry.value };
}

// Project authors specify source locations and business expectations, never artifact hashes.
// Existing regression validation still checks the generated inputs against the actual captures.
export async function prepareProjectRegression(beforePath, afterPath, rulesPath, outputParent) {
  const rules = (await jsonFile(rulesPath)).value;
  if (rules.schemaVersion !== '0.1.0' || !nonempty(rules.statement) || !Array.isArray(rules.rules) || !rules.rules.length) throw Error('Expected project rules with a statement and registrations');
  if (rules.settle !== undefined && (typeof rules.settle?.confirmed !== 'boolean' || !nonempty(rules.settle.statement))) throw Error('Settle needs confirmed and a business statement');
  const before = await runInput(beforePath), after = await runInput(afterPath);
  if (before.run.scenario.id !== after.run.scenario.id) throw Error('Project runs use different scenarios');
  const change = rules.workloadChange ?? { kind: 'same-entry', statement: 'Same scenario and entry; compare the changed application build.' };
  const contract = validateRegressionContract({ schemaVersion: '0.1.0', authority: 'asserted', scenarioId: before.run.scenario.id, statement: rules.statement,
    workloadChange: { ...change, beforeEntrySha256: before.run.build.entrySha256, afterEntrySha256: after.run.build.entrySha256 },
    rules: rules.rules.map(rule => ({ id: rule.id, metric: rule.metric ?? 'subject-observer-count', expectation: rule.expectation, maxEntries: rule.maxEntries })) });
  if (change.kind === 'same-entry' && before.run.build.entrySha256 !== after.run.build.entrySha256) throw Error('Entry changed; declare the controlled entry switch in project rules');
  const bindings = [before, after].map((arm, i) => Object.fromEntries(rules.rules.map(rule => [rule.id, [selectRegistration(arm.registry, rule[i === 0 ? 'before' : 'after'])]])));
  const directory = resolve(outputParent, 'regression-input-' + Date.now() + '-' + randomUUID().slice(0, 8));
  await mkdir(directory, { recursive: true });
  const contractPath = join(directory, 'contract.json'), contractBytes = JSON.stringify(contract, null, 2) + '\n';
  await writeFile(contractPath, contractBytes, { flag: 'wx' });
  const seriesPaths = [];
  for (const [i, arm] of [before, after].entries()) {
    const base = dirname(arm.file.path), series = { schemaVersion: '0.1.0', contractSha256: sha256(contractBytes),
      captureRun: reference(arm.file), captureConfig: reference(arm.config), scenario: { id: arm.run.scenario.id, ...arm.scenario }, build: { bundleSha256: arm.run.build.bundleSha256 },
      bindingStatement: rules.statement + (rules.settle?.confirmed ? ' Settle: ' + rules.settle.statement : ' Final settle is not confirmed.'), bindings: bindings[i],
      points: arm.run.points.map(point => ({ phase: point.phase === 'followup' ? 'settled' : point.phase, cycle: point.cycle,
        settled: point.phase === 'followup' && rules.settle?.confirmed === true,
        capture: { path: resolve(base, point.capture.path), sha256: point.capture.sha256 } })) };
    const path = join(directory, i === 0 ? 'before-series.json' : 'after-series.json');
    await writeFile(path, JSON.stringify(series, null, 2) + '\n', { flag: 'wx' }); seriesPaths.push(path);
  }
  return { directory, before: seriesPaths[0], after: seriesPaths[1], contract: contractPath, rulesPath: resolve(rulesPath), bindings };
}
