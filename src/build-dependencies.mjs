import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
export const supportedBuildVersions = Object.freeze({ typescript: '6.0.3', esbuild: '0.24.0', rxjs: '7.8.1' });

// Resolve from this package, never from a research checkout or the target project's cwd.
export function resolveBuildDependency(name) {
  const expected = supportedBuildVersions[name];
  if (!expected) throw Error('unsupported-build-dependency:' + name);
  let manifestPath;
  try { manifestPath = require.resolve(name + '/package.json'); }
  catch { throw Error('missing-build-dependency:' + name + '; install memory-lab dependencies from its lockfile'); }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== expected) throw Error('unsupported-build-dependency-version:' + name + ':' + manifest.version + '; expected ' + expected);
  return { manifestPath, root: dirname(manifestPath), manifest };
}

resolveBuildDependency('typescript');
resolveBuildDependency('esbuild');
export const ts = require('typescript');
export const esbuild = require('esbuild');
