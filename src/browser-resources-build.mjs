import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ts, esbuild } from './build-dependencies.mjs';
import { instrumentSourceSites } from './site-instrumentation.mjs';
import { resourceOperations } from './resource-observer.mjs';
import { sha256 } from './heap-identity.mjs';

// Uses this package's fixed compiler/bundler dependencies without source maps.
export async function buildBrowserResources(config, base, output) {
  if (!Array.isArray(config.modules) || config.modules.length < 1 || config.modules.length > 64 || typeof config.entry !== 'string') throw Error('entry-and-selected-modules-required');
  const entry = await realpath(resolve(base, config.entry)), selected = new Map(await Promise.all(config.modules.map(async filename => { const path = await realpath(resolve(base, filename)); return [path, relative(base, path).replaceAll('\\', '/')]; })));
  if (selected.size !== config.modules.length) throw Error('duplicate-selected-module');
  const sourceModules = [], sites = [], skipped = [], seen = new Set();
  const observer = fileURLToPath(new URL('./resource-observer.mjs', import.meta.url));
  const registry = { schemaVersion: '0.1.0', adapter: 'browser-resources', sites, skipped, modules: [] };
  const bundles = {};
  for (const mode of ['original', 'instrumented']) {
    const bootstrap = (mode === 'instrumented' ? `import {installResourceObserver} from ${JSON.stringify(observer)};` : '') + `globalThis.__memoryLabStart=async()=>{` + (mode === 'instrumented' ? `const c=globalThis.__memoryLabResourcesConfig;globalThis.__memoryLabEpochAnchor={__memoryLabEpoch:c.epochId,__memoryLabAnchor:c.anchorToken};globalThis.__memoryLabProbe=installResourceObserver({...c,realm:globalThis});` : '') + `globalThis.__memoryLabApp=await import(${JSON.stringify(entry)});globalThis.__memoryLabReady=true;};globalThis.__memoryLabBootstrapped=true;`;
    const result = await esbuild.build({ stdin: { contents: bootstrap, resolveDir: base, sourcefile: 'resource-bootstrap.mjs' }, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', minify: true, sourcemap: false, write: false, legalComments: 'none',
      plugins: mode === 'original' ? [] : [{ name: 'resource-sites', setup(build) { build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
        const path = await realpath(args.path); if (!selected.has(path)) return;
        seen.add(path); const filename = selected.get(path), source = await readFile(path, 'utf8'), compiled = instrumentSourceSites(ts, source, filename, resourceOperations);
        sourceModules.push({ filename, source, sourceSha256: compiled.registry.sourceSha256 }); registry.modules.push({ filename, sourceSha256: compiled.registry.sourceSha256 });
        sites.push(...compiled.registry.sites.map(site => ({ ...site, filename, sourceSha256: compiled.registry.sourceSha256 })));
        skipped.push(...compiled.registry.skipped.map(site => ({ ...site, filename })));
        const extension = extname(filename).slice(1); return { contents: compiled.code, loader: ['ts', 'tsx', 'jsx'].includes(extension) ? extension : 'js', resolveDir: dirname(path) };
      }); } }] });
    if (result.outputFiles.length !== 1) throw Error('single-bundle-required');
    const text = result.outputFiles[0].text;
    if (Buffer.byteLength(text) > 16 * 1024 ** 2 || text.includes('sourceMappingURL')) throw Error('bundle-budget-or-map');
    bundles[mode] = { text, sha256: sha256(text) }; await writeFile(resolve(output, mode + '.js'), text, { flag: 'wx' });
  }
  if (seen.size !== selected.size) throw Error('selected-module-not-in-build');
  for (const site of sites) if (!bundles.instrumented.text.includes(site.id)) throw Error('selected-site-eliminated');
  const source = JSON.stringify({ schemaVersion: '0.1.0', modules: sourceModules }, null, 2) + '\n';
  if (Buffer.byteLength(source) > 1024 ** 2 || sites.length > 512) throw Error('source-or-sites-budget');
  await writeFile(resolve(output, 'source.json'), source, { flag: 'wx' });
  const registryText = JSON.stringify(registry, null, 2) + '\n';
  await writeFile(resolve(output, 'registry.json'), registryText, { flag: 'wx' });
  const build = { parserVersion: ts.version, bundlerVersion: esbuild.version, entry, modules: registry.modules, sites: sites.length, sourceSha256: sha256(source), registrySha256: sha256(registryText), bundles: Object.fromEntries(Object.entries(bundles).map(([mode, value]) => [mode, { sha256: value.sha256, bytes: Buffer.byteLength(value.text) }])), sourceMapsUsed: false, scope: 'Explicit modules; direct method calls. Other native calls remain observed with unknown source. Fixed compiler/bundler dependencies resolve from memory-lab.' };
  await writeFile(resolve(output, 'build.json'), JSON.stringify(build, null, 2) + '\n', { flag: 'wx' }); return { bundles, registry, build };
}
