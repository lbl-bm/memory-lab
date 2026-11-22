import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { openSync, closeSync, writeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { freemem } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findBrowser } from './config.mjs';
import { sha256 } from './heap-identity.mjs';
import { buildBrowserSites } from './browser-sites-build.mjs';

const configPath = resolve(process.argv[2]), output = resolve(process.argv[3]), base = dirname(configPath);
const configBytes = await readFile(configPath), config = JSON.parse(configBytes), epochId = randomUUID(), anchorToken = randomUUID();
let browser, context, server, stopRequested = false, report = { schemaVersion: '0.1.0', status: 'running', output, epochId, configPath, configSha256: sha256(configBytes), points: [], errors: [], startedAt: new Date().toISOString() };
process.on('message', message => {
  if (message?.type !== 'abort-capture') return;
  stopRequested = true; report.stopReason = message.reason;
  void browser?.close().catch(() => {});
});
const save = async (name, value) => { const bytes = JSON.stringify(value, null, 2) + '\n'; await writeFile(resolve(output, name), bytes, { flag: 'wx' }); return { path: name, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) }; };
const artifact = async name => { const bytes = await readFile(resolve(output, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes) }; };
try {
  const cycles = config.cycles ?? 3;
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 5 || freemem() < 1.5 * 1024 ** 3) throw Error('cycle-or-memory-budget');
  const built = await buildBrowserSites(config, base, output); report.build = built.build;
  if (stopRequested) throw Error('capture-stopped');
  const scenarioPath = resolve(base, config.scenario), scenarioBytes = await readFile(scenarioPath), scenario = await import(pathToFileURL(scenarioPath).href);
  for (const hook of ['setup', 'action', 'back', 'assertBaseline']) if (typeof scenario[hook] !== 'function') throw Error('missing-scenario-hook-' + hook);
  report.scenario = { id: scenario.name ?? config.scenario, path: scenarioPath, moduleSha256: sha256(scenarioBytes), workloadSha256: sha256(Buffer.concat([scenarioBytes, await readFile(built.build.entry)])) };
  server = createServer((req, res) => {
    if (req.url === '/bundle.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(built.bundle); }
    else if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><meta charset="utf-8"><title>Memory Lab browser capture</title><h1>Memory Lab browser capture</h1><div id="app"></div><script type="module" src="/bundle.js"></script>'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: await findBrowser(config.browserExecutable), headless: true, chromiumSandbox: true });
  if (stopRequested) throw Error('capture-stopped');
  const browserCDP = await browser.newBrowserCDPSession(); report.browserRssSamples = [];
  async function sampleBrowserRss(stage) {
    if (process.platform !== 'win32') return;
    try {
      const info = await browserCDP.send('SystemInfo.getProcessInfo'), ids = info.processInfo.map(p => Number(p.id));
      if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw Error('invalid-browser-process-ids');
      report.browserProcessIds = ids;
      const command = `@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64) | ConvertTo-Json -Compress`;
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000 });
      const rows = JSON.parse(stdout || '[]'), processes = Array.isArray(rows) ? rows : [rows];
      report.browserRssSamples.push({ stage, at: new Date().toISOString(), requestedPids: ids, processes, observedBytes: processes.reduce((sum, p) => sum + p.WorkingSet64, 0) });
    } catch (error) { report.browserRssSamples.push({ stage, error: error.message }); }
  }
  context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
  await context.addInitScript(value => { globalThis.__memoryLabSitesConfig = value; }, { epochId, anchorToken, registry: built.registry });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page), runtime = { kind: 'chromium-main-frame', epochId, browserVersion: browser.version(), scriptId: null, targetId: null, frameId: null, url: url + '/bundle.js' };
  cdp.on('Debugger.scriptParsed', value => { if (value.url === runtime.url) runtime.scriptId = value.scriptId; });
  await cdp.send('Debugger.enable'); await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.startTrackingHeapObjects', { trackAllocations: false });
  await page.goto(url, { waitUntil: 'load' }); await page.waitForFunction(() => globalThis.__memoryLabReady === true);
  runtime.targetId = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; runtime.frameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  const loaded = await cdp.send('Debugger.getScriptSource', { scriptId: runtime.scriptId });
  if (sha256(loaded.scriptSource) !== built.build.bundleSha256) throw Error('actual-browser-script-mismatch');
  report.runtime = runtime;
  await sampleBrowserRss('loaded');
  await save('browser-processes.json', { epochId, processes: report.browserProcessIds ?? [], runtime });
  await scenario.setup(page); const baseline = await scenario.assertBaseline(page); report.baseline = baseline;
  const pause = async () => { await page.waitForTimeout(20); await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(20); await cdp.send('HeapProfiler.collectGarbage'); };
  async function snapshot(name) {
    const fd = openSync(resolve(output, name), 'wx'); let bytes = 0, failure;
    const listener = ({ chunk }) => { bytes += Buffer.byteLength(chunk); if (bytes > 64 * 1024 ** 2) { failure = Error('snapshot-budget'); return; } try { writeSync(fd, chunk); } catch (error) { failure = error; } };
    cdp.on('HeapProfiler.addHeapSnapshotChunk', listener);
    try { await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); } finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', listener); closeSync(fd); }
    if (failure) throw failure; return artifact(name);
  }
  async function point(phase, cycle) {
    const state = await scenario.assertBaseline(page); if (!isDeepStrictEqual(state, baseline)) throw Error('baseline-state-mismatch');
    await pause(); const before = await page.evaluate(() => globalThis.__memoryLabProbe.report());
    const prefix = phase + '-' + cycle; await snapshot(prefix + '-seed.heapsnapshot');
    const objects = [], objectGroup = 'memory-lab-bridge';
    try {
      for (const object of before.objects) {
        const response = await cdp.send('Runtime.evaluate', { expression: `globalThis.__memoryLabProbe.resolve(${JSON.stringify(object.id)})`, objectGroup, silent: true });
        if (response.exceptionDetails) throw Error('bridge-evaluation-failed');
        const row = { id: object.id, heapId: null, closed: null };
        if (before.weakIdentityProtocol === 'registered-weakref-v1') {
          if (response.result.type === 'undefined') row.resolution = 'weak-ref-cleared';
          else if (response.result.objectId) row.resolution = 'resolved';
          else throw Error('unexpected-weak-reference-result');
        }
        if (response.result.objectId) {
          row.heapId = Number((await cdp.send('HeapProfiler.getHeapObjectId', { objectId: response.result.objectId })).heapSnapshotObjectId);
          if (!Number.isSafeInteger(row.heapId) || row.heapId < 1) throw Error('invalid-heap-id');
          if (object.roles.includes('subscription')) {
            const result = await cdp.send('Runtime.callFunctionOn', { objectId: response.result.objectId, functionDeclaration: "function(){const d=Object.getOwnPropertyDescriptor(this,'closed');return d&&typeof d.value==='boolean'?d.value:null}", returnByValue: true, silent: true });
            if (result.exceptionDetails) throw Error('closed-read-failed'); row.closed = result.result.value;
          }
        }
        objects.push(row);
      }
    } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup }); }
    await pause(); const heap = await snapshot(prefix + '.heapsnapshot'), after = await page.evaluate(() => globalThis.__memoryLabProbe.report());
    if (before.events.length !== after.events.length || before.dropped !== after.dropped) throw Error('events-during-capture');
    const observation = await save(prefix + '-observation.json', after), identities = await save(prefix + '-identities.json', { epochId, snapshotSha256: heap.sha256, ...(before.weakIdentityProtocol ? { weakIdentityProtocol: before.weakIdentityProtocol } : {}), objects });
    const capture = await save(prefix + '-capture.json', { schemaVersion: '0.2.0', status: 'completed', adapter: 'rxjs-7.8.1', checkpoint: prefix, epochId, anchorToken, runtime, dependency: built.build.dependency,
      loadedScriptSha256: sha256(loaded.scriptSource), artifacts: { source: await artifact('source.json'), registry: await artifact('registry.json'), bundle: await artifact('bundle.js'), observation, identities, snapshot: heap },
      bridge: { handlesReleased: true, eventsBefore: before.events.length, eventsAfter: after.events.length, scenarioQuiescence: 'Scenario baseline assertion plus stable instrumented event count; not a proof of all asynchronous work settling' }, observerAliveDuringGC: true, browserProxyDetection: 'unavailable; ordinary same-realm RxJS values required', sourceMapsUsed: false });
    report.points.push({ phase, cycle, state, capturePath: resolve(output, capture.path), capture, snapshot: heap, quiescence: { scenarioAsserted: true, stableInstrumentedEvents: true }, events: after.events.length, dropped: after.dropped });
    await sampleBrowserRss(prefix);
    await writeFile(resolve(output, 'progress.json'), JSON.stringify(report, null, 2));
  }
  for (let cycle = 1; cycle <= cycles; cycle++) { await scenario.action(page); await scenario.back(page); await point('back', cycle); }
  if (scenario.followup) await scenario.followup(page); else await page.waitForTimeout(config.followupMs ?? 500);
  await point('followup', cycles); await page.screenshot({ path: resolve(output, 'final.png') });
  if (errors.length) throw Error('browser-errors: ' + errors.join('; '));
  report.browserHeapUsage = await cdp.send('Runtime.getHeapUsage');
  report.status = 'completed';
} catch (error) { report.status = 'failed'; report.errors.push({ message: error.message, stack: error.stack }); process.exitCode = 1; }
finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  if (server) await new Promise(done => server.close(done));
  report.finishedAt = new Date().toISOString(); report.resources = { nodeMaxRssKiB: process.resourceUsage().maxRSS, browserObservedMaxBytes: Math.max(0, ...(report.browserRssSamples ?? []).map(s => s.observedBytes ?? 0)), browserRssInterpretation: 'Sum of Windows WorkingSet64 for CDP-reported browser instance processes at sampled checkpoints, not continuous peak or private memory. Runtime heap usage is separate.' };
  if (report.resources.nodeMaxRssKiB > 768 * 1024) { report.status = 'failed'; report.errors.push({ message: 'node-rss-budget' }); process.exitCode = 1; }
  await writeFile(resolve(output, 'browser-sites.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (process.connected) process.disconnect();
}
