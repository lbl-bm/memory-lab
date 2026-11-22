import {readFile, realpath, stat} from 'node:fs/promises';
import {resolve, relative, isAbsolute, dirname, sep} from 'node:path';
import {SourceMap} from 'node:module';
import {sha256} from './heap-identity.mjs';

class MappingInputError extends Error {
  constructor(code, status = 'invalid') { super(code); this.code = code; this.mappingStatus = status; }
}
export const reject = (code, status) => { throw new MappingInputError(code, status); };
export const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export const pathKey = p => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
export const inside = (root, path) => {
  const r = relative(root, path);
  return r !== '' && r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r);
};
export function scopedPath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) reject('unsupported-local-artifact-path', 'unknown');
  const p = resolve(root, path);
  if (!inside(root, p)) reject('artifact-outside-workspace', 'unknown');
  return p;
}
export async function scopedRead(root, path, maxBytes) {
  const lexical = scopedPath(root, path), canonical = await realpath(lexical);
  if (!inside(root, canonical)) reject('artifact-outside-workspace', 'unknown');
  const info = await stat(canonical);
  if (!info.isFile() || info.size > maxBytes) reject('artifact-size-budget', 'unknown');
  const bytes = await readFile(canonical);
  if (bytes.length > maxBytes) reject('artifact-size-budget', 'unknown');
  return {path: canonical, lexical, bytes, sha256: sha256(bytes), observedAt: new Date().toISOString()};
}
export function errorResult(error) {
  return {status: error.mappingStatus ?? 'unknown', code: error.code ?? 'source-map-processing-failed', detail: error.mappingStatus ? undefined : error.message};
}
export const sourceLines = text => text.split(/\r\n|[\n\r\u2028\u2029]/);

// Supported local flat subset only. Normalize aliases before byte caching.
// Realpath scope is checked again at read time; embedded contents are checked per reference.
export function parseLocalMap(payload, mapPath, maxSources = 10000) {
  if (payload.version !== 3 || payload.sections !== undefined || (payload.sourceRoot !== undefined && payload.sourceRoot !== '')) reject('unsupported-source-map-form', 'unknown');
  if (!Array.isArray(payload.sources) || !payload.sources.length || payload.sources.length > maxSources || payload.sources.some(s => typeof s !== 'string' || !s || isAbsolute(s) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) || /[?#%\\]/.test(s))) reject('unsupported-or-ambiguous-source-path', 'unknown');
  const paths = payload.sources.map(s => resolve(dirname(mapPath), s));
  if (new Set(paths.map(pathKey)).size !== paths.length) reject('unsupported-or-ambiguous-source-path', 'unknown');
  if (!Array.isArray(payload.names) || payload.names.some(s => typeof s !== 'string') || typeof payload.mappings !== 'string' || !/^[A-Za-z0-9+/;,]*$/.test(payload.mappings) || (payload.sourcesContent !== undefined && (!Array.isArray(payload.sourcesContent) || payload.sourcesContent.length !== payload.sources.length || payload.sourcesContent.some(s => s !== null && typeof s !== 'string')))) reject('malformed-source-map', 'unknown');
  return {map: new SourceMap(payload), paths, indexes: new Map(payload.sources.map((s, i) => [s, i]))};
}

export function lookupOriginalAnchor(map, line, column) {
  if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(column) || column < 0) return {status: 'unknown', code: 'invalid-generated-query'};
  const entry = map.findEntry(line, column);
  if (entry.generatedLine !== line) return {status: 'unknown', code: 'no-mapping-on-query-line'};
  if (typeof entry.originalSource !== 'string') return {status: 'unknown', code: 'unmapped-generated-segment'};
  if (!Number.isSafeInteger(entry.generatedColumn) || entry.generatedColumn < 0 || entry.generatedColumn > column || !Number.isSafeInteger(entry.originalLine) || entry.originalLine < 0 || !Number.isSafeInteger(entry.originalColumn) || entry.originalColumn < 0) return {status: 'unknown', code: 'invalid-mapping-coordinate'};
  return {status: 'mapped-anchor', entry, precision: entry.generatedColumn === column ? 'exact-segment-start' : 'preceding-segment-on-same-line', generatedQuery: {line, column}, generatedAnchor: {line: entry.generatedLine, column: entry.generatedColumn}, columnDistance: column - entry.generatedColumn};
}
