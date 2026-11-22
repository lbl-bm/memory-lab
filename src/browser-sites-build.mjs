import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ts, esbuild, resolveBuildDependency } from './build-dependencies.mjs';
import { instrumentSourceSites } from './site-instrumentation.mjs';
import { sha256 } from './heap-identity.mjs';

// Fixed compiler/bundler/adapter dependencies resolve from the memory-lab package.
export async function buildBrowserSites(config, base, output) {
  if (!Array.isArray(config.modules) || !config.modules.length || config.modules.length > 64 || typeof config.entry !== 'string') throw Error('entry-and-explicit-modules-required');
  const entry = await realpath(resolve(base, config.entry));
  const selected = new Map(await Promise.all(config.modules.map(async filename => {
    const absolute = await realpath(resolve(base, filename)); return [absolute, relative(base, absolute).replaceAll('\\', '/')];
  })));
  if (selected.size !== config.modules.length) throw Error('duplicate-selected-module');
  const { root: rxjsRoot, manifest: dependency } = resolveBuildDependency('rxjs');
  const modules = [], sites = [], skipped = [], seen = new Set();
  const observer = fileURLToPath(new URL('./rxjs-observer-core.mjs', import.meta.url));
  const bootstrap = `import * as rxjs from 'rxjs'; import {createRxjsObserver} from ${JSON.stringify(observer)}; const c=globalThis.__memoryLabSitesConfig; globalThis.__memoryLabEpochAnchor={__memoryLabEpoch:c.epochId,__memoryLabAnchor:c.anchorToken};globalThis.__memoryLabProbe=createRxjsObserver({rxjs,version:'7.8.1',registry:c.registry,epochId:c.epochId});globalThis.__memoryLabApp=await import(${JSON.stringify(entry)});globalThis.__memoryLabReady=true;`;
  const result = await esbuild.build({ stdin: { contents: bootstrap, resolveDir: base, sourcefile: 'memory-lab-bootstrap.mjs' }, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', minify: true, sourcemap: false, write: false, metafile: true,
    alias: Object.fromEntries(Object.entries(config.alias ?? {}).map(([key, value]) => [key, resolve(base, value)])),
    nodePaths: (config.nodePaths ?? []).map(path => resolve(base, path)), define: { 'process.env.NODE_ENV': '"production"' },
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }, loader: { '.css': 'empty', '.svg': 'dataurl' }, legalComments: 'none',
    plugins: [{ name: 'memory-lab-source-sites', setup(build) {
      build.onResolve({ filter: /^rxjs(?:\/|$)/ }, args => {
        const key = args.path === 'rxjs' ? '.' : './' + args.path.slice(5);
        const exported = dependency.exports[key]?.es2015 ?? (key.startsWith('./internal/') ? dependency.exports['./internal/*'].es2015.replace('*', key.slice(11)) : null);
        if (!exported) throw Error('unsupported-rxjs-export:' + args.path);
        return { path: resolve(rxjsRoot, exported) };
      });
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
        const absolute = await realpath(args.path); if (!selected.has(absolute)) return;
        if (seen.has(absolute)) throw Error('selected-module-loaded-twice'); seen.add(absolute);
        const filename = selected.get(absolute), source = await readFile(absolute, 'utf8'), compiled = instrumentSourceSites(ts, source, filename);
        modules.push({ filename, source, sourceSha256: compiled.registry.sourceSha256 });
        sites.push(...compiled.registry.sites.map(site => ({ ...site, filename, sourceSha256: compiled.registry.sourceSha256 })));
        skipped.push(...compiled.registry.skipped.map(site => ({ ...site, filename })));
        const extension = extname(filename).slice(1);
        return { contents: compiled.code, loader: ['ts', 'tsx', 'jsx'].includes(extension) ? extension : 'js', resolveDir: dirname(absolute) };
      });
    } }] });
  if (seen.size !== selected.size) throw Error('selected-module-not-in-build');
  const source = JSON.stringify({ schemaVersion: '0.2.0', modules: modules.sort((a, b) => a.filename.localeCompare(b.filename)) }, null, 2) + '\n';
  if (Buffer.byteLength(source) > 1024 ** 2 || result.outputFiles.length !== 1) throw Error('source-pack-or-output-budget');
  const bundle = result.outputFiles[0].text;
  if (Buffer.byteLength(bundle) > 16 * 1024 ** 2 || bundle.includes('sourceMappingURL')) throw Error('bundle-budget-or-map');
  for (const site of sites) if (!bundle.includes(site.id)) throw Error('instrumented-site-eliminated');
  const registry = { schemaVersion: '0.2.0', modules: modules.map(({ filename, sourceSha256 }) => ({ filename, sourceSha256 })), sites, skipped,
    scope: 'Explicitly selected modules only. Browser adapter supports ordinary same-realm RxJS values; Proxy detection is unavailable in browser JavaScript.' };
  await writeFile(resolve(output, 'source.json'), source, { flag: 'wx' });
  await writeFile(resolve(output, 'registry.json'), JSON.stringify(registry, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(output, 'bundle.js'), bundle, { flag: 'wx' });
  const build = { bundleSha256: sha256(bundle), sourceSha256: sha256(source), modules: registry.modules, siteCount: sites.length, parserVersion: ts.version, esbuildVersion: esbuild.version,
    entry, entrySha256: sha256(await readFile(entry)), dependency: { name: 'rxjs', version: dependency.version, resolution: 'All rxjs imports resolved to the same installed ESM package', packageSha256: sha256(await readFile(resolve(rxjsRoot, 'package.json'))) },
    bootstrapSha256: sha256(bootstrap), disabledInputs: Object.keys(result.metafile.inputs).filter(path => path.startsWith('(disabled):')),
    inputs: Object.fromEntries(await Promise.all(Object.keys(result.metafile.inputs).filter(path => !path.startsWith('<') && !path.startsWith('(disabled):') && resolve(path) !== resolve(base, 'memory-lab-bootstrap.mjs')).map(async path => [path, sha256(await readFile(resolve(path)))]))) };
  await writeFile(resolve(output, 'build.json'), JSON.stringify(build, null, 2) + '\n', { flag: 'wx' }); return { registry, bundle, build };
}
