import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
export const integrityVersion = 'sha256-v1';

const safeInside = (base, file) => {
  const rel = relative(base, file);
  return Boolean(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
};
export const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
export const ownFile = async (base, path) => {
  if (typeof path !== 'string' || !safeInside(base, resolve(base, path))) return null;
  try {
    const real = await realpath(resolve(base, path));
    return safeInside(base, real) && (await stat(real)).isFile() ? real : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
};

// Treat the recorded producer path only as a namespace for relative names.
// Never open it directly when looking for files in a recipient's copy.
export function relativeArtifactPath(producerDir, artifactPath) {
  if (typeof producerDir !== 'string' || typeof artifactPath !== 'string') return null;
  const syntax = producerDir.startsWith('/') && !producerDir.startsWith('//') ? posix : win32;
  if (!syntax.isAbsolute(producerDir) || !syntax.isAbsolute(artifactPath)) return null;
  const rel = syntax.relative(producerDir, artifactPath);
  if (!rel || syntax.isAbsolute(rel)) return null;
  const names = rel.split(syntax.sep);
  if (names.some(name => !name || name === '.' || name === '..' || /[\\:\u0000-\u001f]/.test(name))) return null;
  return names.join('/');
}

export function producerRunDir(report) {
  if (report.snapshotIntegrity !== integrityVersion || typeof report.runDir !== 'string') return null;
  const syntax = report.runDir.startsWith('/') && !report.runDir.startsWith('//') ? posix : win32;
  return syntax.isAbsolute(report.runDir) && syntax.basename(report.runDir) === report.runId ? report.runDir : null;
}

export async function resolveCaptureInputs(root, report, finalPhase, auditLegacy = false) {
  if (!['final', 'followup'].includes(finalPhase)) throw Error('final-phase must be final or followup');
  const hashed = report.snapshotIntegrity === integrityVersion;
  if (report.snapshotIntegrity !== undefined && !hashed) throw Error('Unknown snapshot integrity format');
  const phases = ['baseline', 'target', finalPhase];
  const snapshots = {}, entries = {}, issues = {};
  for (const phase of ['baseline','target','final','followup']) {
    const artifacts = report.artifacts.filter(x => x?.kind === 'heap-snapshot' && x.phase === phase);
    if (artifacts.length !== 1) { issues[phase] = artifacts.length ? 'duplicate' : 'missing'; continue; }
    const a = artifacts[0];
    const mapped = relativeArtifactPath(producerRunDir(report), a.path);
    const path = await ownFile(root, mapped ?? a.path);
    if (!path || !(a.bytes > 0) || (await stat(path)).size !== a.bytes) { issues[phase] = 'unavailable'; continue; }
    let sha256 = null;
    if (phases.includes(phase) && (hashed || auditLegacy)) {
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
      sha256 = hash.digest('hex');
      if (bytes !== a.bytes || (hashed && sha256 !== a.sha256)) { issues[phase] = 'digest-mismatch'; continue; }
    }
    snapshots[phase] = path;
    entries[phase] = {phase, bytes: a.bytes, sha256};
  }
  const missing = phases.filter(p => !entries[p]);
  return {snapshots, missing, issues, hashes: missing.length ? null : phases.map(p => entries[p]), provenance: hashed ? 'verified' : 'legacy-unverified'};
}
export function sameInputHashes(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && a.every((x, i) =>
    x?.phase === b[i]?.phase && x?.bytes === b[i]?.bytes && /^[a-f0-9]{64}$/.test(x?.sha256 ?? '') && x.sha256 === b[i]?.sha256);
}
