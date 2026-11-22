import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { supportedBuildVersions, resolveBuildDependency, ts, esbuild } from '../src/build-dependencies.mjs';
import { buildBrowserSites } from '../src/browser-sites-build.mjs';
import { buildBrowserResources } from '../src/browser-resources-build.mjs';

async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'memory-lab-dependencies-')));
  try { await run(root); }
  finally { assert.equal(dirname(root).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(root).startsWith('memory-lab-dependencies-')); await rm(root, { recursive: true, force: true }); }
}

test('builder dependencies match the package-owned exact versions', () => {
  assert.equal(ts.version, '6.0.3'); assert.equal(esbuild.version, '0.24.0');
  for (const [name, version] of Object.entries(supportedBuildVersions)) assert.equal(resolveBuildDependency(name).manifest.version, version);
  assert.throws(() => resolveBuildDependency('unrelated-package'), /unsupported-build-dependency/);
});

test('a package copy with missing or incompatible TypeScript refuses to use another checkout', async () => {
  for (const version of [null, '6.0.2']) await fixture(async root => {
    await mkdir(join(root, 'src')); await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await copyFile(new URL('../src/build-dependencies.mjs', import.meta.url), join(root, 'src/build-dependencies.mjs'));
    if (version) { const pkg = join(root, 'node_modules/typescript'); await mkdir(pkg, { recursive: true }); await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', version })); }
    await assert.rejects(import(pathToFileURL(join(root, 'src/build-dependencies.mjs'))), version ? /unsupported-build-dependency-version:typescript:6.0.2/ : /missing-build-dependency:typescript/);
  });
});

test('both builders compile an external TypeScript project with their own toolchain and no source maps', async () => fixture(async root => {
  await writeFile(join(root, 'panel.ts'), "import { Subject } from 'rxjs';\nexport const bus = new Subject<number>();\nexport function mount() { return bus.subscribe(() => 1); }\n");
  await writeFile(join(root, 'app.ts'), "import { mount } from './panel';\nexport function run() { const sub = mount(); sub.unsubscribe(); }\n");
  await writeFile(join(root, 'resources.ts'), "const callback = (_event: Event) => 1;\nexport function mount() { window.addEventListener('resize', callback); }\nexport function unmount() { window.removeEventListener('resize', callback); }\n");
  for (const name of ['sites', 'resources']) await mkdir(join(root, name));
  const sites = await buildBrowserSites({ entry: 'app.ts', modules: ['panel.ts', 'app.ts'] }, root, join(root, 'sites'));
  const resources = await buildBrowserResources({ entry: 'resources.ts', modules: ['resources.ts'] }, root, join(root, 'resources'));
  assert.equal(sites.registry.modules.length, 2); assert.equal(sites.build.siteCount, 2); assert.equal(sites.build.parserVersion, '6.0.3');
  assert.equal(resources.registry.sites.length, 2); assert.equal(resources.build.bundlerVersion, '0.24.0');
  assert.ok(!sites.bundle.includes('sourceMappingURL')); assert.equal(resources.build.sourceMapsUsed, false);
}));
