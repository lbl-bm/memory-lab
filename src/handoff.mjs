import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const safeInside = (base, file) => {
  const rel = relative(base, file);
  return Boolean(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
};
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const ownFile = async (base, path) => {
  if (typeof path !== 'string' || !safeInside(base, resolve(base, path))) return null;
  try {
    const real = await realpath(resolve(base, path));
    return safeInside(base, real) && (await stat(real)).isFile() ? real : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
};

export async function buildHandoff(path, analysisPath) {
  const root = await realpath(resolve(path));
  const reportPath = await ownFile(root, 'report.json');
  if (!reportPath) throw Error('No report.json inside the run directory');
  const r = await readJSON(reportPath);
  if (r.schemaVersion !== '0.1.0' || typeof r.runId !== 'string' || r.runId !== basename(root)
    || !['running', 'completed', 'failed'].includes(r.status) || !Array.isArray(r.artifacts)) {
    throw Error('Not a supported Memory Lab capture report for this run directory');
  }
  const evidence = { report: reportPath, snapshots: {}, analysis: null };
  for (const phase of ['baseline', 'target', 'final', 'followup']) {
    const matches = r.artifacts.filter(x => x?.kind === 'heap-snapshot' && x.phase === phase);
    if (matches.length === 1) {
      const artifact = await ownFile(root, matches[0].path);
      if (artifact && (await stat(artifact)).size === matches[0].bytes && matches[0].bytes > 0) {
        evidence.snapshots[phase] = artifact;
      }
    }
  }
  const finalPhase = r.samples?.some(x => x.phase === 'followup') ? 'followup' : 'final';
  const missing = ['baseline', 'target', finalPhase].filter(phase => !evidence.snapshots[phase]);
  const nextActions = [];
  let status, reason;
  if (r.status !== 'completed') {
    status = 'capture-incomplete';
    reason = r.status === 'failed' ? 'Capture failed. Inspect the recorded stage and error before retrying.' : 'Capture has not finished. Reopen this handoff after it finishes.';
  } else if (missing.length) {
    status = 'snapshots-incomplete';
    reason = 'Required snapshots are missing or invalid: ' + missing.join(', ') + '.';
  } else {
    status = 'ready-for-analysis';
    reason = 'The required snapshots are available. Meta MemLab can analyze them without recapture.';
    nextActions.push({ id: 'analyze', argv: [process.execPath, fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'analyze', '--run', root, '--final-phase', finalPhase] });
  }

  if (analysisPath !== undefined) {
    const file = await ownFile(root, resolve(analysisPath));
    if (!file || basename(file) !== 'analysis.json' || dirname(file) === root) throw Error('Analysis must be an analysis.json file within the capture run');
    const a = await readJSON(file);
    if (a.schemaVersion !== '0.1.0' || a.inputRunId !== r.runId || a.inputFinalPhase !== finalPhase
      || a.engine?.name !== 'memlab' || typeof a.workDir !== 'string' || resolve(a.workDir) !== dirname(file)
      || !['completed', 'failed'].includes(a.status)) {
      throw Error('Analysis does not match this capture run and selected final phase');
    }
    if (status !== 'ready-for-analysis') throw Error('Cannot use an analysis report without a complete capture and the original snapshot set');
    evidence.analysis = { report: file, engineVersion: a.engine.version ?? null, candidateCount: null, candidates: null };
    if (a.status === 'completed') {
      const candidates = await ownFile(dirname(file), a.candidateFile);
      if (!candidates || !Number.isSafeInteger(a.candidateCount) || a.candidateCount < 0) throw Error('Analysis candidates are missing or invalid');
      const rows = await readJSON(candidates);
      if (!Array.isArray(rows) || rows.length !== a.candidateCount) throw Error('Analysis candidate count does not match the artifact');
      evidence.analysis.candidates = candidates;
      evidence.analysis.candidateCount = rows.length;
      nextActions.length = 0;
      status = 'review-required';
      reason = 'Review the candidate paths and expected resource lifetime before deciding whether to make a repair. Zero candidates does not prove no leak.';
    } else {
      status = 'analysis-incomplete';
      reason = 'Analysis failed. Review the analysis report before retrying with the same capture.';
    }
  }

  return {
    schemaVersion: '0.1.0', kind: 'memory-lab-handoff', runId: r.runId, status, reason,
    capture: { status: r.status, stage: r.progress?.stage ?? null, scenario: r.scenario?.name ?? null,
      scenarioFile: r.config?.scenario ?? null, configFile: r.config?.configPath ?? null,
      scenarioSha256: r.scenario?.moduleSha256 ?? null, browserVersion: r.browser?.version ?? null,
      cycles: r.config?.cycles ?? null, warmupCycles: r.config?.warmupCycles ?? null,
      settleMs: r.config?.settleMs ?? null, finalPhase, firstError: r.errors?.[0]?.message ?? null },
    evidence, nextActions,
    conclusion: { leak: 'not-determined', repair: 'not-validated' },
  };
}
const forDisplay = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
function displayAction(argv) {
  if (argv.some(arg => /[\u0000-\u001f\u007f-\u009f\u2018-\u201f]/.test(arg))) return 'Next command arguments: ' + JSON.stringify(argv);
  return process.platform === 'win32'
    ? 'Next command (PowerShell): & ' + argv.map(arg => "'" + arg.replaceAll("'", "''") + "'").join(' ')
    : 'Next command (shell): ' + argv.map(arg => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(' ');
}

export function renderHandoff(h) {
  const { capture, evidence } = h;
  return [
    'Memory Lab run: ' + h.runId, 'Status: ' + h.status, h.reason,
    'Scenario: ' + (capture.scenario ?? 'unknown'),
    ...(capture.scenarioFile ? ['Scenario module: ' + capture.scenarioFile] : []),
    ...(capture.configFile ? ['Capture config: ' + capture.configFile] : []),
    ...(capture.cycles === null ? [] : ['Capture settings: ' + capture.cycles + ' measured cycles, ' + capture.warmupCycles + ' warm-up, ' + capture.settleMs + ' ms settle interval']),
    'Capture: ' + capture.status + ' at ' + (capture.stage ?? 'unknown') + '; comparison phase: ' + capture.finalPhase,
    ...(capture.firstError ? ['Capture error: ' + capture.firstError] : []),
    'Capture report: ' + evidence.report,
    ...Object.entries(evidence.snapshots).map(([phase, path]) => phase + ' snapshot: ' + path),
    ...(evidence.analysis ? ['Analysis report: ' + evidence.analysis.report] : []),
    ...(evidence.analysis?.candidates ? ['Candidates (' + evidence.analysis.candidateCount + '): ' + evidence.analysis.candidates] : []),
    ...h.nextActions.map(a => displayAction(a.argv)),
    'No leak or repair verdict is asserted by this handoff.',
  ].map(forDisplay).join('\n') + '\n';
}
