import { chromium } from 'playwright-core';
import { mkdir, readFile, writeFile, stat, unlink, statfs } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { schemaVersion, hash, repoInfo, findBrowser } from './config.mjs';
import { withDeadline, withBrowserStage } from './deadline.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const saveJSON = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');

export function assertSameState(expected, actual) {
  if (!isDeepStrictEqual(expected, actual)) throw new Error('Returned state does not match the scenario baseline');
}

export async function collectSample(cdp, phase, cycle, settleMs) {
  await wait(settleMs);
  await cdp.send('HeapProfiler.collectGarbage');
  await wait(settleMs);
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  return { phase, cycle, timestamp: new Date().toISOString(), heap, dom, forcedGC: true };
}

async function snapshot(cdp, path, maxBytes) {
  const fd = openSync(path, 'wx');
  let bytes = 0;
  let failure = null;
  const listener = ({ chunk }) => {
    if (failure) return;
    try {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) throw new Error('Snapshot exceeded the 256 MiB per-file limit');
      writeSync(fd, chunk, null, 'utf8');
    } catch (error) { failure = error; }
  };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', listener);
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    if (failure) throw failure;
  } catch (error) {
    failure = error;
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', listener);
    closeSync(fd);
  }
  if (failure) { await unlink(path); throw failure; }
  return { path, bytes: (await stat(path)).size };
}

export async function run(config) {
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  await mkdir(config.outRoot, { recursive: true });
  const runDir = join(config.outRoot, runId);
  await mkdir(runDir); // Never overwrite another run.
  const report = {
    schemaVersion, runId, status: 'running', startedAt: new Date().toISOString(), runDir,
    config, environment: { node: process.version, platform: process.platform, arch: process.arch, totalMemoryBytes: os.totalmem(), freeMemoryBytesAtStart: os.freemem() },
    repo: null, scenario: null, browser: null, samples: [], observations: [], artifacts: [], errors: [], pageErrors: [], consoleErrors: [],
    network: { policy: 'loopback-only, fresh browser context, no service workers', blockedRequests: [] },
    scope: {
      heap: 'Main page Chromium CDP target; worker heaps and separate renderer targets are excluded',
      dom: 'CDP DOM counters; nodes are not a detached-DOM count',
      processMemory: 'Not measured; JS heap bytes are not browser RSS or total system memory',
      privacy: 'Local synthetic fixtures only; no upload; snapshots and screenshots can contain application data',
    },
    conclusion: { status: 'insufficient-evidence', reasons: ['A successful scenario and heap deltas alone do not establish a memory leak or a repair. This capture does not perform a controlled before/after judgment; consult a separate comparison report.'] },
  };
  let browser;
  let context;
  let page;
  const progress = async stage => {
    report.progress = { stage, timestamp: new Date().toISOString() };
    await saveJSON(join(runDir, 'report.json'), report);
  };
  try {
    await progress('initializing');
    if (config.roundSnapshots && !config.snapshots) throw new Error('roundSnapshots requires snapshots; pass --snapshots or enable snapshots in the config');
    report.tool = { name: 'frontend-memory-lab', version: '0.1.0', runnerSha256: hash(await readFile(new URL(import.meta.url))) };
    report.repo = repoInfo(config.repo);
    await progress('scenario-loading');
    const scenarioSource = await readFile(config.scenario);
    const scenario = await import(pathToFileURL(config.scenario).href);
    for (const hook of ['setup', 'action', 'back', 'assertBaseline']) {
      if (typeof scenario[hook] !== 'function') throw new Error(`Scenario must export ${hook}`);
    }
    report.scenario = { name: scenario.name ?? config.scenario, description: scenario.description ?? '', moduleSha256: hash(scenarioSource) };
    await progress('runtime-checks');
    const disk = await statfs(runDir);
    if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error('At least 2 GiB free disk space is required');
    if (os.freemem() < 1.5 * 1024 ** 3) throw new Error('At least 1.5 GiB available system memory is required');
    const executablePath = await findBrowser(config.browserExecutable);
    await progress('browser-launch');
    browser = await withDeadline(chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 30000 }), 31000, 'Browser launch', lateBrowser => lateBrowser.close());
    report.browser = { executablePath, version: browser.version(), headless: true, viewport: config.viewport, locale: 'en-US', timezone: 'UTC', freshContext: true };
    await progress('browser-context');
    context = await withBrowserStage(browser, () => browser.newContext({ viewport: config.viewport, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' }), 30000, 'context creation');
    await withBrowserStage(browser, () => context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        if (report.network.blockedRequests.length < 50) report.network.blockedRequests.push(url.origin + url.pathname);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    }), 30000, 'request routing');
    await progress('browser-page');
    page = await withBrowserStage(browser, () => context.newPage(), 30000, 'page creation');
    page.setDefaultTimeout(config.timeoutMs);
    page.setDefaultNavigationTimeout(config.timeoutMs);
    page.on('pageerror', error => { if (report.pageErrors.length < 30) report.pageErrors.push(error.message); });
    page.on('console', message => { if (message.type() === 'error' && report.consoleErrors.length < 30) report.consoleErrors.push(message.text()); });
    const cdp = await withBrowserStage(browser, () => context.newCDPSession(page), 30000, 'CDP initialization');
    await withBrowserStage(browser, () => cdp.send('HeapProfiler.enable'), 30000, 'heap-profiler initialization');
    await progress('navigating');
    await page.goto(config.url, { waitUntil: 'domcontentloaded' });
    await progress('scenario-setup');
    await scenario.setup(page);
    const initialState = await scenario.assertBaseline(page);
    for (let i = 0; i < config.warmupCycles; i++) {
      await progress('warmup-' + (i + 1));
      await scenario.action(page);
      await scenario.back(page);
      assertSameState(initialState, await scenario.assertBaseline(page));
    }
    const baselineState = await scenario.assertBaseline(page);
    assertSameState(initialState, baselineState);
    report.observations.push({ phase: 'baseline', state: baselineState });
    const takeSample = async (phase, cycle) => {
      const diagnostic = scenario.observe ? await scenario.observe(page, cdp, phase, cycle) : null;
      const sample = await collectSample(cdp, phase, cycle, config.settleMs);
      if (diagnostic) sample.diagnostic = diagnostic;
      report.samples.push(sample);
    };
    await takeSample('baseline', 0);
    await progress('baseline-collected');
    const takeArtifact = async (name, heap = false, cycle = 0, stem = name) => {
      if (heap) {
        const started = performance.now();
        const artifact = await snapshot(cdp, join(runDir, stem + '.heapsnapshot'), config.maxSnapshotBytes);
        report.artifacts.push({ kind: 'heap-snapshot', phase: name, cycle, capturedAt: new Date().toISOString(), captureDurationMs: performance.now() - started, ...artifact });
      } else {
        const path = join(runDir, name + '.png');
        await page.screenshot({ path });
        report.artifacts.push({ kind: 'screenshot', phase: name, cycle, path });
      }
    };
    await takeArtifact('baseline');
    if (config.snapshots) await takeArtifact('baseline', true);
    for (let cycle = 1; cycle <= config.cycles; cycle++) {
      await progress('action-' + cycle);
      report.observations.push({ phase: 'action', cycle, state: await scenario.action(page) });
      await takeSample('action', cycle);
      if (cycle === 1) {
        await takeArtifact('target', false, cycle);
        if (config.snapshots) await takeArtifact('target', true, cycle);
      }
      report.observations.push({ phase: 'back', cycle, state: await scenario.back(page) });
      const state = await scenario.assertBaseline(page);
      assertSameState(baselineState, state);
      report.observations.push({ phase: 'assertBaseline', cycle, state });
      await takeSample('back', cycle);
      await progress('back-collected-' + cycle);
      if (cycle === 1) {
        await takeArtifact('final', false, cycle);
        if (config.snapshots) await takeArtifact('final', true, cycle);
      } else if (config.snapshots && config.roundSnapshots) {
        await takeArtifact('back', true, cycle, 'back-' + cycle);
      }
    }
    if (scenario.followup) {
      await progress('followup');
      report.observations.push({ phase: 'followup', state: await scenario.followup(page) });
      assertSameState(baselineState, await scenario.assertBaseline(page));
      await takeSample('followup', config.cycles);
      await takeArtifact('followup', false, config.cycles);
      if (config.snapshots) await takeArtifact('followup', true, config.cycles);
    }
    report.observedWorkersAtEnd = page.workers().map(worker => worker.url());
    const baseline = report.samples[0].heap.usedSize;
    report.summary = {
      baselineUsedHeapBytes: baseline,
      backSamples: report.samples.filter(s => s.phase === 'back').map(s => ({ cycle: s.cycle, usedHeapBytes: s.heap.usedSize, deltaFromBaselineBytes: s.heap.usedSize - baseline })),
      historicalLeakReproduced: 'not-assessed-by-capture', repairValidated: 'not-assessed-by-capture',
    };
    if (report.pageErrors.length) throw new Error('Uncaught page errors occurred; inspect report.pageErrors');
    report.status = 'completed';
  } catch (error) {
    report.status = 'failed';
    report.errors.push({ name: error.name, message: error.message });
    report.conclusion.reasons.push('The run did not complete successfully.');
    if (page && !page.isClosed()) {
      try {
        const path = join(runDir, 'failure.png');
        await page.screenshot({ path, timeout: 10000 });
        report.artifacts.push({ kind: 'failure-screenshot', path });
        report.failureUrl = page.url();
      } catch { /* failure evidence must not prevent browser cleanup */ }
    }
  } finally {
    try { await context?.close(); await browser?.close(); } catch (error) { report.errors.push({ name: 'CleanupError', message: error.message }); report.status = 'failed'; }
    report.finishedAt = new Date().toISOString();
    await saveJSON(join(runDir, 'report.json'), report);
  }
  return report;
}
