import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runBrowserSitesCommand } from './browser-sites-command.mjs';
import { runSitesCommand } from './sites-command.mjs';
import { prepareProjectRegression } from './regression-input.mjs';
import { runRegressionCommand } from './regression-command.mjs';

export async function loadProjectVerificationConfig(path) {
  path = resolve(path);
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.schemaVersion !== '0.1.0' || ['before', 'after', 'rules'].some(key => typeof config[key] !== 'string' || !config[key].trim())) throw Error('Project verification requires schemaVersion 0.1.0 and before, after, rules paths');
  return { path, ...Object.fromEntries(['before', 'after', 'rules'].map(key => [key, resolve(dirname(path), config[key])])) };
}

// A single reusable entry over the existing capture, source and regression commands.
// Business assertions remain in the scenario/rules; this adds no alternate verdict rules.
export async function runProjectVerification(configPath, outputParent) {
  const output = resolve(outputParent, 'project-' + Date.now() + '-' + randomUUID().slice(0, 8));
  await mkdir(output, { recursive: true });
  const resultPath = resolve(output, 'project-verification.json');
  const result = { schemaVersion: '0.1.0', status: 'running', output, resultPath, configPath: resolve(configPath), startedAt: new Date().toISOString(),
    gate: null, verdict: null, paths: { beforeCapture: null, afterCapture: null, source: [], regression: null }, steps: [],
    knownLimits: ['Checks declared RxJS primary Subject membership and selected registration sites only; not all resources or a general GC proof.', 'Project authors own the scenario and business limits. An unsupported or incomplete observation cannot pass this gate.'] };
  try {
    const config = await loadProjectVerificationConfig(configPath);
    for (const arm of ['before', 'after']) {
      const captureConfig = JSON.parse(await readFile(config[arm], 'utf8')), base = dirname(config[arm]);
      for (const key of ['entry', 'scenario']) if (typeof captureConfig[key] === 'string') captureConfig[key] = resolve(base, captureConfig[key]);
      for (const key of ['modules', 'nodePaths']) if (Array.isArray(captureConfig[key])) captureConfig[key] = captureConfig[key].map(path => resolve(base, path));
      if (captureConfig.alias) captureConfig.alias = Object.fromEntries(Object.entries(captureConfig.alias).map(([key, path]) => [key, resolve(base, path)]));
      captureConfig.outRoot = resolve(output, 'capture-' + arm);
      const path = resolve(output, arm + '.config.json');
      await writeFile(path, JSON.stringify(captureConfig, null, 2) + '\n', { flag: 'wx' });
      const captured = await runBrowserSitesCommand(path);
      result.steps.push({ stage: 'capture-' + arm, ...captured }); result.paths[arm + 'Capture'] = captured.reportPath;
      if (captured.status !== 'completed') { result.status = captured.status; break; }
      const report = JSON.parse(await readFile(captured.reportPath, 'utf8')), point = report.points.at(-1);
      const source = await runSitesCommand(resolve(dirname(captured.reportPath), point.capture.path), resolve(output, 'source-' + arm));
      result.steps.push({ stage: 'source-' + arm, ...source }); result.paths.source.push(source.resultPath);
      if (source.status === 'failed') { result.status = 'failed'; break; }
    }
    if (result.status === 'running') {
      const input = await prepareProjectRegression(result.paths.beforeCapture, result.paths.afterCapture, config.rules, output);
      const regression = await runRegressionCommand(input.before, input.after, input.contract, output);
      result.steps.push({ stage: 'regression', ...regression }); result.paths.regression = regression.resultPath;
      result.gate = regression.gate; result.verdict = regression.verdict;
      result.status = regression.status === 'failed' ? 'failed' : result.steps.some(step => step.status === 'incomplete') ? 'incomplete' : 'completed';
    }
  } catch (error) { result.status = 'failed'; result.error = { message: error.message }; }
  result.finishedAt = new Date().toISOString();
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
