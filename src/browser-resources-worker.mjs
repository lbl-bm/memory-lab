import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { freemem } from 'node:os';
import { isDeepStrictEqual, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { findBrowser } from './config.mjs';
import { sha256 } from './heap-identity.mjs';
import { buildBrowserResources } from './browser-resources-build.mjs';
import { captureResourceHeap } from './resource-heap-capture.mjs';
import { runResourceHeapCommand } from './resource-heap-command.mjs';

const configPath = resolve(process.argv[2]), output = resolve(process.argv[3]), config = JSON.parse(await readFile(configPath)), base = dirname(configPath), runId = randomUUID();
const report = { schemaVersion: '0.1.0', capability: 'browser-resource-lifecycle-source-evidence', status: 'running', configPath, runId, startedAt: new Date().toISOString(), points: [], comparisons: [], errors: [], browserRssSamples: [] };
let browser, context, server, stopping = false;
process.on('message', message => { if (message?.type === 'abort-capture') { stopping = true; report.stopReason = message.reason; void browser?.close().catch(() => {}); } });
const save = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
try {
  if (freemem() < 1.5 * 1024 ** 3) throw Error('memory-budget');
  const built = await buildBrowserResources(config, base, output); report.build = built.build;
  const locations = new Map(built.registry.sites.map(site => [site.id, { file: site.filename, line: site.line, column: site.column, operation: site.operation }]));
  if (stopping) throw Error('capture-stopped');
  const scenarioPath = resolve(base, config.scenario), scenario = await import(pathToFileURL(scenarioPath).href);
  if (!Array.isArray(scenario.cases) || scenario.cases.length < 1 || scenario.cases.length > 16 || new Set(scenario.cases.map(value => value.name)).size !== scenario.cases.length || scenario.cases.some(value => typeof value.name !== 'string' || typeof value.run !== 'function')) throw Error('invalid-resource-scenarios');
  report.scenario = { name: scenario.name, path: scenarioPath, cases: scenario.cases.map(value => value.name) };
  server = createServer((req, res) => {
    const request = new URL(req.url, 'http://localhost');
    if (['/original.js', '/instrumented.js'].includes(request.pathname)) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(built.bundles[request.pathname.slice(1, -3)].text); }
    else if (request.pathname === '/' && ['original', 'instrumented'].includes(request.searchParams.get('mode'))) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><meta charset="utf-8"><title>Browser resource diagnostic control</title><main id="app"></main><script type="module" src="/' + request.searchParams.get('mode') + '.js"></script>'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: await findBrowser(config.browserExecutable), headless: true, chromiumSandbox: true });
  if (stopping) throw Error('capture-stopped');
  const browserCDP = await browser.newBrowserCDPSession();
  await save('browser-processes.json', { runId, ids: (await browserCDP.send('SystemInfo.getProcessInfo')).processInfo.map(value => Number(value.id)) });
  async function rss(stage) {
    if (process.platform !== 'win32') return;
    try {
      const ids = (await browserCDP.send('SystemInfo.getProcessInfo')).processInfo.map(value => Number(value.id));
      if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw Error('invalid-instance-pids');
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64) | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 10000 });
      const parsed = JSON.parse(stdout || '[]'), processes = Array.isArray(parsed) ? parsed : [parsed]; report.browserRssSamples.push({ stage, ids, processes, bytes: processes.reduce((sum, value) => sum + value.WorkingSet64, 0) });
    } catch (error) { report.browserRssSamples.push({ stage, error: error.message }); }
  }
  for (const item of scenario.cases) {
    const modes = {};
    for (const mode of ['original', 'instrumented']) {
      const epochId = runId + ':' + item.name + ':' + mode, anchorToken = randomUUID();
      context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(value => { globalThis.__memoryLabResourcesConfig = value; }, { registry: built.registry, epochId, anchorToken });
      const page = await context.newPage(), errors = [], cdp = await context.newCDPSession(page), runtime = { epochId, browserVersion: browser.version(), url: origin + '/' + mode + '.js', scriptId: null, targetId: null, frameId: null };
      page.on('pageerror', error => errors.push(error.message));
      cdp.on('Debugger.scriptParsed', event => { if (event.url === runtime.url) runtime.scriptId = event.scriptId; });
      await cdp.send('Debugger.enable'); await cdp.send('HeapProfiler.enable');
      if (config.heap === true && mode === 'instrumented') await cdp.send('HeapProfiler.startTrackingHeapObjects', { trackAllocations: false });
      await page.goto(origin + '/?mode=' + mode); await page.waitForFunction(() => globalThis.__memoryLabBootstrapped === true);
      // Initialize the automation realm before installing the adapter and importing app code.
      // This avoids mistaking Playwright's own initial event listeners for app registrations.
      await page.evaluate(() => globalThis.__memoryLabStart());
      const script = await cdp.send('Debugger.getScriptSource', { scriptId: runtime.scriptId });
      if (sha256(script.scriptSource) !== built.bundles[mode].sha256) throw Error('actual-script-mismatch');
      runtime.targetId = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; runtime.frameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
      const points = [];
      const checkpoint = async (phase, behavior, options = {}) => {
        if (points.length >= 64 || typeof phase !== 'string') throw Error('checkpoint-budget-or-name');
        let observation = mode === 'instrumented' ? await page.evaluate(() => globalThis.__memoryLabProbe.report()) : null, heap = null;
        if (options.heap && mode === 'instrumented') {
          if (config.heap !== true) throw Error('resource-heap-capture-not-enabled');
          const capture = await captureResourceHeap({ page, cdp, output, prefix: 'heap-' + scenario.cases.indexOf(item) + '-' + points.length, request: options.heap, runtime, anchorToken, build: built.build });
          observation = capture.observation;
          const analysis = await runResourceHeapCommand(capture.capturePath, output);
          heap = { capturePath: capture.capturePath, snapshot: capture.snapshot, probeAccountingPath: capture.probeAccountingPath, status: analysis.status, resultPath: analysis.resultPath, summary: analysis.summary };
          if (analysis.status === 'failed') throw Error('resource-heap-analysis-failed: ' + (analysis.error?.code ?? analysis.logPath));
        }
        if (observation && observation.epochId !== epochId) throw Error('resource-epoch-mismatch');
        if (observation) {
          for (const resource of observation.resources) { resource.registration = locations.get(resource.registrationSiteId) ?? null; resource.release = locations.get(resource.releaseSiteId) ?? null; }
          for (const event of observation.events) event.position = locations.get(event.siteId) ?? null;
        }
        const point = { case: item.name, mode, phase, behavior, runtime, observation, ...(heap ? { heap } : {}) };
        points.push(point); report.points.push(point);
      };
      const result = await item.run(page, checkpoint);
      if (!points.length) await checkpoint('final', result.behavior);
      await cdp.send('HeapProfiler.collectGarbage');
      modes[mode] = { result, points, errors, heapUsageAfterGC: await cdp.send('Runtime.getHeapUsage') };
      await rss(item.name + ':' + mode);
      await context.close(); context = null;
    }
    const sameBehavior = isDeepStrictEqual(modes.original.result.behavior, modes.instrumented.result.behavior) && isDeepStrictEqual(modes.original.points.map(({ phase, behavior }) => ({ phase, behavior })), modes.instrumented.points.map(({ phase, behavior }) => ({ phase, behavior }))) && isDeepStrictEqual(modes.original.errors, modes.instrumented.errors);
    const expectedErrors = isDeepStrictEqual(modes.original.errors, item.expectedErrors ?? []);
    report.comparisons.push({ case: item.name, sameBehavior, expectedErrors, original: { result: modes.original.result, errors: modes.original.errors, heapUsageAfterGC: modes.original.heapUsageAfterGC }, instrumented: { result: modes.instrumented.result, errors: modes.instrumented.errors, heapUsageAfterGC: modes.instrumented.heapUsageAfterGC } });
    await writeFile(resolve(output, 'progress.json'), JSON.stringify(report, null, 2) + '\n');
    if (!sameBehavior || !expectedErrors) throw Error('original-instrumented-behavior-mismatch:' + item.name);
  }
  report.status = report.points.some(point => (point.observation && !point.observation.coverage.completeWithinScope) || point.heap?.status === 'incomplete') ? 'incomplete' : 'completed';
  if (report.status === 'incomplete') process.exitCode = 2;
} catch (error) { report.status = 'failed'; report.errors.push({ message: error.message, stack: error.stack }); process.exitCode = 1; }
finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {}); if (server) await new Promise(done => server.close(done));
  report.finishedAt = new Date().toISOString(); report.resources = { nodeMaxRssKiB: process.resourceUsage().maxRSS, browserSampledMaxBytes: Math.max(0, ...report.browserRssSamples.map(value => value.bytes ?? 0)), interpretation: 'Windows per-instance process WorkingSet64 sum sampled after each case. Not continuous peak, private memory, or business-only memory.' };
  if (report.resources.nodeMaxRssKiB > 768 * 1024) { report.status = 'failed'; report.errors.push({ message: 'node-rss-budget' }); process.exitCode = 1; }
  report.interpretation = 'Source sites plus native registration/automatic-completion observations. Optional heap evidence adds final-heap identity and bounded literal paths, never all retaining paths or an automatic GC/leak verdict. Paired behavior checks cover only the declared scenarios and same-realm adapter assumptions.';
  await save('browser-resources.json', report); if (process.connected) process.disconnect();
}
