#!/usr/bin/env node
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { schemaVersion, loadConfig, findBrowser, repoInfo } from './config.mjs';
import { run } from './runner.mjs';
import { runGrowthCommand } from './growth-command.mjs';
import { withDeadline } from './deadline.mjs';
import { runEvidenceCommand } from './evidence-command.mjs';
import { runLifecycleCommand } from './lifecycle-command.mjs';
import { runSourceCommand } from './source-command.mjs';
import { runInterventionCommand } from './intervention-command.mjs';
import { runIncomingCommand } from './incoming-command.mjs';
import { runReverseCommand } from './reverse-command.mjs';
import { runSitesCommand } from './sites-command.mjs';
import { ownFile, resolveCaptureInputs, sameInputHashes } from './capture-evidence.mjs';

const require = createRequire(import.meta.url);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const help = { schemaVersion, commands: ['doctor --config <file>', 'run --config <file> [--snapshots]', 'analyze --run <run-directory> [--final-phase final|followup]', 'growth --run <run-directory>', 'evidence --run <run-directory> --growth <growth.json> [--identity <identity.json>]', 'lifecycle --run <run-directory> [--identity <identity.json>] [--contract <contract.json>]', 'source --run <run-directory> [--identity <identity.json>] [--scripts <scripts.json>] [--contract <contract.json>]', 'intervention --run <run-directory> [--identity <identity.json>] [--scripts <scripts.json>] [--contract <contract.json>] [--observations <observations.json>]'], note: 'JSON on stdout. Identity/source/call context gates inference. Intervention analyzes existing local evidence; it does not instrument a target. No automatic causal leak/repair verdict. Scenario and opt-in adapter code is trusted executable code. Artifacts stay local.' };

help.commands = help.commands.map(command => command.startsWith('source --run') ? command + ' [--evidence <evidence.json> | --growth <growth.json> --root-ids <ids>] [--max-depth 0..64] [--max-nodes 1..50000] [--max-edges 0..200000] [--max-source-bytes <bytes>] [--source-map-context <context.json>]' : command);
help.commands.push('incoming --snapshot <file> --node-id <safe-integer> --output <parent-directory>');
help.commands.push('sites --capture <capture.json> --output <parent-directory> [--node-id <safe-integer>]');
help.commands.push('dominators --snapshot <file> --root-ids <ids> --output <parent-directory> [--edge-policy exclude-weak|all-literal] [--node-ids <ids>] [--cut-ids <ids>] [--top 1..100]');
help.commands.push('capture-sites --config <file>');
help.commands.push('regression --before <series.json> --after <series.json> --contract <contract.json> --output <parent-directory>');
help.commands.push('regression --before-run <browser-sites.json> --after-run <browser-sites.json> --rules <project-rules.json> --output <parent-directory>');
help.commands.push('capture-resources --config <file>');
help.commands.push('candidates --series <same-isolate-series.json> --output <parent-directory>');
help.commands.push('candidates --resource-run <browser-resources.json> --case <name> --root-ids <ids> --output <parent-directory>');
help.commands.push('resource-heap --capture <resource-heap-capture.json> --output <parent-directory>');
help.commands.push('verify-project --config <project.json> --output <parent-directory>');
help.commands.push('resource-regression --before-run <browser-resources.json> --after-run <browser-resources.json> --rules <resource-rules.json> --output <parent-directory>');
help.commands.push('semantics --snapshot <file> --v8-version <version> --root-ids <ids> --output <parent-directory> [--node-ids <ids>] [--cut-ids <ids>]');
help.note += ' sites analyzes hash-bound source-site/heap evidence without running the application. Registration/release positions and closed state do not establish a leak or successful resource release.';
help.commands.push('repair-check --before <run-directory> --after <run-directory> --contract <rule.json> [--json]');
help.commands.push('handoff --run <run-directory> [--analysis <analysis.json>] [--json]');
help.commands.push('paths --snapshot <file> --node-id <safe-integer> --root-ids <comma-separated-ids> --output <parent-directory> [--edge-policy exclude-weak|all-literal] [--max-depth 0..64] [--max-nodes 1..50000] [--max-edges 0..200000]');

async function analyze(runDir, finalPhase = 'final') {
  if (!['final', 'followup'].includes(finalPhase)) throw new Error('final-phase must be final or followup');
  runDir = await realpath(resolve(runDir));
  const reportPath = await ownFile(runDir, 'report.json');
  if (!reportPath) throw Error('Missing run report');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (report.status !== 'completed') throw new Error('Only completed capture runs can be analyzed');
  const selected = await resolveCaptureInputs(runDir, report, finalPhase, true);
  if (selected.missing.length) throw Error('Missing or invalid snapshot: ' + selected.missing.map(p => p + ' (' + selected.issues[p] + ')').join(', '));
  const snapshots = selected.hashes.map(x => selected.snapshots[x.phase]);
  const memlabRoot = resolve(require.resolve('memlab/package.json'), '..');
  const manifest = JSON.parse(await readFile(join(memlabRoot, 'package.json'), 'utf8'));
  const workDir = join(runDir, 'memlab-' + Date.now());
  await mkdir(workDir);
  const args = ['--expose-gc', '--max-old-space-size=2048', fileURLToPath(new URL('./memlab-worker.mjs', import.meta.url)), ...snapshots, workDir];
  const logPath = join(workDir, 'engine.log');
  const { createWriteStream } = await import('node:fs');
  const log = createWriteStream(logPath, { flags: 'wx' });
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 180000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } finally {
    clearTimeout(timeout);
    await new Promise(resolve => log.end(resolve));
  }
  const current = code === 0 && !timedOut ? await resolveCaptureInputs(runDir, report, finalPhase, true) : null;
  const consistent = current ? sameInputHashes(current.hashes, selected.hashes) : null;
  let candidates = null;
  if (consistent) candidates = JSON.parse(await readFile(join(workDir, 'candidates.json'), 'utf8'));
  const result = { schemaVersion, status: consistent ? 'completed' : 'failed', engine: { name: 'memlab', version: manifest.version, api: 'findLeaksBySnapshotFilePaths', exitCode: code, timedOut, maxOldSpaceMiB: 2048, consoleMode: 'SILENT' }, inputRunId: report.runId, inputFinalPhase: finalPhase, inputSnapshots: selected.hashes, snapshotProvenance: selected.provenance, inputsMatchAfterAnalysis: consistent, workDir, logPath, candidateCount: candidates?.length ?? null, candidateFile: candidates ? join(workDir, 'candidates.json') : null, invocation: { executable: process.execPath, args }, conclusion: { status: 'requires-review', reason: consistent === false ? 'Snapshot inputs changed during analysis; candidates were not accepted.' : 'MemLab heuristic candidates require scenario, retention-path, and before/after review; this is not a confirmed leak or a repair validation.' } };
  await writeFile(join(workDir, 'analysis.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

try {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help') { emit(help); }
  else {
    const allowed = command === 'repair-check' ? ['--before', '--after', '--contract', '--json'] : command === 'handoff' ? ['--run', '--analysis', '--json'] : command === 'resource-regression' ? ['--before-run', '--after-run', '--rules', '--output'] : command === 'verify-project' ? ['--config', '--output'] : command === 'resource-heap' ? ['--capture', '--output'] : command === 'candidates' ? ['--series', '--resource-run', '--case', '--root-ids', '--output'] : command === 'semantics' ? ['--snapshot', '--v8-version', '--root-ids', '--output', '--node-ids', '--cut-ids'] : command === 'regression' ? ['--before', '--after', '--contract', '--before-run', '--after-run', '--rules', '--output'] : ['capture-sites', 'capture-resources'].includes(command) ? ['--config'] : command === 'dominators' ? ['--snapshot', '--root-ids', '--output', '--edge-policy', '--node-ids', '--cut-ids', '--top'] : command === 'sites' ? ['--capture', '--output', '--node-id'] : command === 'run' ? ['--config', '--snapshots'] : command === 'doctor' ? ['--config'] : command === 'analyze' ? ['--run', '--final-phase'] : command === 'growth' ? ['--run'] : command === 'paths' ? ['--snapshot', '--node-id', '--root-ids', '--output', '--edge-policy', '--max-depth', '--max-nodes', '--max-edges'] : command === 'incoming' ? ['--snapshot', '--node-id', '--output'] : command === 'evidence' ? ['--run', '--growth', '--identity'] : command === 'lifecycle' ? ['--run', '--identity', '--contract'] : command === 'source' ? ['--run', '--identity', '--scripts', '--contract', '--evidence', '--max-source-bytes', '--growth', '--root-ids', '--max-depth', '--max-nodes', '--max-edges', '--source-map-context'] : command === 'intervention' ? ['--run', '--identity', '--scripts', '--contract', '--observations'] : [];
    if (!allowed.length) throw new Error('Unknown command: ' + command);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (!allowed.includes(args[i]) || options[args[i]] !== undefined) throw new Error('Unknown or duplicate option: ' + args[i]);
      const key = args[i];
      const isFlag = key === '--snapshots' || key === '--json';
      options[key] = isFlag ? true : args[++i];
      if (!options[key] || (!isFlag && options[key].startsWith('--'))) throw new Error('Missing value for ' + key);
    }
    if (command === 'repair-check') {
      if (['--before','--after','--contract'].some(key => !options[key])) throw Error('--before, --after and --contract are required');
      const { checkRepair, renderRepairCheck } = await import('./repair-check.mjs');
      const result = await checkRepair(options['--before'], options['--after'], options['--contract']);
      if (options['--json']) emit(result);
      else process.stdout.write(renderRepairCheck(result));
      process.exitCode = result.verdict === 'verified-for-rule' ? 0 : result.verdict === 'insufficient-evidence' ? 2 : 3;
    } else if (command === 'handoff') {
      if (!options['--run']) throw Error('--run is required');
      const { buildHandoff, renderHandoff } = await import('./handoff.mjs');
      const result = await buildHandoff(options['--run'], options['--analysis']);
      if (options['--json']) emit(result);
      else process.stdout.write(renderHandoff(result));
      if (result.status.endsWith('-incomplete')) process.exitCode = 2;
    } else if (command === 'resource-regression') {
      if (['--before-run', '--after-run', '--rules', '--output'].some(flag => !options[flag])) throw Error('--before-run, --after-run, --rules and --output are required');
      const { runResourceRegressionCommand } = await import('./resource-regression-command.mjs');
      const result = await runResourceRegressionCommand(options['--before-run'], options['--after-run'], options['--rules'], options['--output']);
      emit(result); process.exitCode = result.status === 'completed' ? result.gate === 'pass' ? 0 : 3 : result.status === 'incomplete' ? 2 : 1;
    } else if (command === 'verify-project') {
      if (!options['--config'] || !options['--output']) throw Error('--config and --output are required');
      const { runProjectVerification } = await import('./project-verification.mjs');
      const result = await runProjectVerification(options['--config'], options['--output']);
      emit(result); process.exitCode = result.status === 'completed' ? result.gate?.pass === true ? 0 : 3 : result.status === 'incomplete' ? 2 : 1;
    } else if (command === 'candidates') {
      if (!options['--output']) throw Error('--output is required');
      let seriesPath = options['--series'], prepared;
      if (options['--resource-run']) {
        if (seriesPath || !options['--case'] || !options['--root-ids']) throw Error('Resource mode requires --case and --root-ids, without --series');
        const ids = options['--root-ids'].split(',');
        if (ids.some(id => !/^(0|[1-9][0-9]*)$/.test(id) || !Number.isSafeInteger(Number(id)))) throw Error('Expected decimal nonnegative safe root IDs');
        const { prepareResourceCandidateSeries } = await import('./candidate-input.mjs');
        prepared = await prepareResourceCandidateSeries(options['--resource-run'], options['--case'], ids.map(Number), options['--output']); seriesPath = prepared.seriesPath;
      } else if (!seriesPath || options['--case'] || options['--root-ids']) throw Error('Use --series, or --resource-run with --case and --root-ids');
      const { runCandidatesCommand } = await import('./candidates-command.mjs');
      const result = await runCandidatesCommand(seriesPath, options['--output']);
      if (prepared) result.projectInputs = prepared;
      emit(result); process.exitCode = result.status === 'completed' ? 0 : result.status === 'incomplete' ? 2 : 1;
    } else if (command === 'regression') {
      const projectMode = ['--before-run', '--after-run', '--rules'].some(flag => options[flag]);
      let inputs;
      if (projectMode) {
        if (['--before', '--after', '--contract'].some(flag => options[flag])) throw Error('Choose project runs or prepared series, not both');
        if (['--before-run', '--after-run', '--rules', '--output'].some(flag => !options[flag])) throw Error('--before-run, --after-run, --rules and --output are required');
        const { prepareProjectRegression } = await import('./regression-input.mjs');
        inputs = await prepareProjectRegression(options['--before-run'], options['--after-run'], options['--rules'], options['--output']);
      } else {
        if (['--before', '--after', '--contract', '--output'].some(flag => !options[flag])) throw Error('--before, --after, --contract and --output are required');
        inputs = { before: options['--before'], after: options['--after'], contract: options['--contract'] };
      }
      const { runRegressionCommand } = await import('./regression-command.mjs');
      const result = await runRegressionCommand(inputs.before, inputs.after, inputs.contract, options['--output']);
      if (projectMode) result.projectInputs = inputs;
      emit(result);
      process.exitCode = result.status === 'completed' ? result.gate?.pass === true ? 0 : 3 : result.status === 'incomplete' ? 2 : 1;
    } else if (command === 'capture-resources') {
      if (!options['--config']) throw Error('--config is required');
      const { runBrowserResourcesCommand } = await import('./browser-resources-command.mjs');
      const result = await runBrowserResourcesCommand(options['--config']);
      emit(result); if (result.status !== 'completed') process.exitCode = result.status === 'incomplete' ? 2 : 1;
    } else if (command === 'capture-sites') {
      if (!options['--config']) throw Error('--config is required');
      const { runBrowserSitesCommand } = await import('./browser-sites-command.mjs');
      const result = await runBrowserSitesCommand(options['--config']);
      emit(result); if (result.status !== 'completed') process.exitCode = 1;
    } else if (command === 'dominators' || command === 'semantics') {
      if (!options['--snapshot'] || !options['--root-ids'] || !options['--output']) throw Error('--snapshot, --root-ids and --output are required');
      if (command === 'semantics' && !options['--v8-version']) throw Error('--v8-version is required for the version-scoped semantics profile');
      const ids = text => {
        const values = text.split(',');
        if (values.some(value => !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))) throw Error('Expected decimal nonnegative safe node IDs');
        return values.map(Number);
      };
      const settings = { rootIds: ids(options['--root-ids']) };
      if (options['--edge-policy']) settings.edgePolicy = options['--edge-policy'];
      if (options['--node-ids']) settings.nodeIds = ids(options['--node-ids']);
      if (options['--cut-ids']) settings.cutIds = ids(options['--cut-ids']);
      if (options['--top']) settings.top = Number(options['--top']);
      let result;
      if (command === 'semantics') {
        const { runHeapSemanticsCommand } = await import('./heap-semantics-command.mjs');
        result = await runHeapSemanticsCommand(options['--snapshot'], options['--output'], { ...settings, v8Version: options['--v8-version'] });
      } else {
        const { runDominatorCommand } = await import('./dominator-command.mjs');
        result = await runDominatorCommand(options['--snapshot'], options['--output'], settings);
      }
      emit(result); if (result.status !== 'completed') process.exitCode = 1;
    } else if (command === 'resource-heap') {
      if (!options['--capture'] || !options['--output']) throw Error('--capture and --output are required');
      const { runResourceHeapCommand } = await import('./resource-heap-command.mjs');
      const result = await runResourceHeapCommand(options['--capture'], options['--output']);
      emit(result); process.exitCode = result.status === 'completed' ? 0 : result.status === 'incomplete' ? 2 : 1;
    } else if (command === 'sites') {
      if (!options['--capture'] || !options['--output']) throw Error('--capture and --output are required');
      const result = await runSitesCommand(options['--capture'], options['--output'], options['--node-id'] ?? null);
      emit(result); if (result.status !== 'completed') process.exitCode = result.status === 'incomplete' ? 2 : 1;
    } else if (command === 'paths') {
      if (!options['--snapshot'] || !options['--node-id'] || !options['--root-ids'] || !options['--output']) throw new Error('--snapshot, --node-id, --root-ids and --output are required');
      const searchOptions = { rootIds: options['--root-ids'].split(',') };
      if (options['--edge-policy']) searchOptions.edgePolicy = options['--edge-policy'];
      for (const [flag, name] of [['--max-depth', 'maxDepth'], ['--max-nodes', 'maxNodes'], ['--max-edges', 'maxEdges']]) if (options[flag] !== undefined) searchOptions[name] = Number(options[flag]);
      const result = await runReverseCommand(options['--snapshot'], options['--node-id'], options['--output'], searchOptions);
      emit(result); if (result.status !== 'completed') process.exitCode = result.status === 'incomplete' ? 2 : 1;
    } else if (command === 'incoming') {
      if (!options['--snapshot'] || !options['--node-id'] || !options['--output']) throw new Error('--snapshot, --node-id and --output are required');
      const result = await runIncomingCommand(options['--snapshot'], options['--node-id'], options['--output']);
      emit(result); if (result.status !== 'completed') process.exitCode = 1;
    } else if (command === 'intervention') {
      if (!options['--run']) throw new Error('--run is required');
      const result = await runInterventionCommand(options['--run'], options['--identity'], options['--scripts'], options['--contract'], options['--observations']);
      emit(result); if (result.status !== 'completed') process.exitCode = 1;
    } else if (command === 'source') {
      if (!options['--run']) throw new Error('--run is required');
      const searchFlags = ['--root-ids', '--max-depth', '--max-nodes', '--max-edges'];
      if (options['--growth'] && options['--evidence']) throw Error('Choose --growth or --evidence, not both');
      if (options['--growth'] && !options['--root-ids']) throw Error('--growth requires explicit --root-ids');
      if (!options['--growth'] && searchFlags.some(k => options[k] !== undefined)) throw Error('Native search options require --growth');
      let searchOptions;
      if (options['--growth']) {
        const ids = options['--root-ids'].split(',');
        if (ids.some(id => !/^(0|[1-9][0-9]*)$/.test(id) || !Number.isSafeInteger(Number(id)))) throw Error('Expected decimal nonnegative safe root IDs');
        searchOptions = { rootIds: ids.map(Number) };
        for (const [flag, name] of [['--max-depth', 'maxDepth'], ['--max-nodes', 'maxNodes'], ['--max-edges', 'maxEdges']]) if (options[flag] !== undefined) searchOptions[name] = Number(options[flag]);
      }
      const result = await runSourceCommand(options['--run'], options['--identity'], options['--scripts'], options['--contract'], { growthPath: options['--growth'], searchOptions, sourceMapContextPath: options['--source-map-context'], evidencePath: options['--evidence'], maxSourceBytes: options['--max-source-bytes'] == null ? undefined : Number(options['--max-source-bytes']) });
      emit(result); if (result.status !== 'completed') process.exitCode = 1;
    } else if (command === 'lifecycle') {
      if (!options['--run']) throw new Error('--run is required');
      const result = await runLifecycleCommand(options['--run'], options['--identity'], options['--contract']);
      emit(result); if (result.status !== 'completed') process.exitCode = 1;
    } else if (command === 'evidence') {
      if (!options['--run'] || !options['--growth']) throw new Error('--run and --growth are required');
      const result = await runEvidenceCommand(options['--run'], options['--growth'], options['--identity']);
      emit(result); if (result.status !== 'completed') process.exitCode = 1;
    } else if (command === 'growth') {
      if (!options['--run']) throw new Error('--run is required');
      const result = await runGrowthCommand(options['--run']);
      emit(result); if (result.status !== 'completed') process.exitCode = 1;
    } else if (command === 'analyze') {
      if (!options['--run']) throw new Error('--run is required');
      const result = await analyze(options['--run'], options['--final-phase']);
      emit(result); if (result.status !== 'completed') process.exitCode = 1;
    } else {
      if (!options['--config']) throw new Error('--config is required');
      const config = await loadConfig(options['--config']);
      if (options['--snapshots']) config.snapshots = true;
      if (command === 'doctor') emit({ schemaVersion, status: 'ready', node: process.version, browserExecutable: await findBrowser(config.browserExecutable), repo: repoInfo(config.repo), config });
      else {
        const report = await withDeadline(run(config), 180000, 'Capture');
        emit({ schemaVersion, status: report.status, runId: report.runId, reportPath: join(report.runDir, 'report.json'), summary: report.summary ?? null, errors: report.errors, conclusion: report.conclusion });
        if (report.status !== 'completed') process.exitCode = 1;
      }
    }
  }
} catch (error) {
  emit({ schemaVersion, status: 'failed', error: { name: error.name, message: error.message } });
  process.exitCode = 1;
}
