import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath, unlink, cp} from 'node:fs/promises';
import {join, dirname, basename} from 'node:path';
import {tmpdir} from 'node:os';
import * as esbuild from 'esbuild';
import {captureSourceBuild, verifySourceBuild} from '../src/build-source-capture.mjs';
import {sha256} from '../src/heap-identity.mjs';

async function fixture(callback) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'build-source-test-'))); let passed = false;
  try {
    const app = join(root, 'app'), pkg = join(root, 'vendor'), out = join(root, 'out');
    await mkdir(app); await mkdir(pkg); await mkdir(out); await mkdir(join(pkg, 'dist')); await mkdir(join(pkg, 'src'));
    const source = join(pkg, 'src/value.ts'), js = join(pkg, 'dist/value.js'), map = js + '.map', entry = join(app, 'entry.mjs');
    const sourceText = 'export function value(input: number) {\n  return input + 1;\n}\n';
    const jsText = 'export function value(input) { return input + 1; }\n//# sourceMappingURL=value.js.map\n';
    const payload = {version: 3, sources: ['../src/value.ts'], names: [], mappings: 'AAAA', sourcesContent: [sourceText]};
    const packageText = JSON.stringify({name: 'test-vendor', version: '1.0.0', type: 'module'});
    await writeFile(source, sourceText); await writeFile(js, jsText); await writeFile(map, JSON.stringify(payload)); await writeFile(join(pkg, 'package.json'), packageText);
    await writeFile(entry, 'export {value} from "../vendor/dist/value.js";\n');
    const expectation = {name: 'test-vendor', version: '1.0.0', sha256: sha256(packageText)};
    let number = 0;
    const run = () => captureSourceBuild({esbuild, workspaceRoot: root, entry, outputDir: join(out, 'build-' + number++), scopes: [{root: app}, {root: pkg, package: expectation}]});
    await callback({root, app, pkg, source, js, map, entry, sourceText, jsText, payload, expectation, run}); passed = true;
  } finally {
    if (passed) {
      const target = await realpath(root); assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(target).startsWith('build-source-test-'));
      await rm(target, {recursive: true, force: true});
    } else console.error('Failed fixture retained:', root);
  }
}
async function manifest(r) {assert.equal(r.status, 'captured', JSON.stringify(r)); return JSON.parse(await readFile(r.manifestPath));}

test('build capture preserves exact supplied bytes and verifies without original working files', async () => fixture(async f => {
  const r = await f.run(), m = await manifest(r); assert.equal(m.inputs.length, 2); assert.equal(m.inputs.filter(i => i.map).length, 1);
  const i = m.inputs.find(i => i.map); assert.equal(i.original.sha256, sha256(f.jsText)); assert.notEqual(i.supplied.sha256, i.original.sha256); assert.equal(i.originals[0].sha256, sha256(f.sourceText));
  assert.ok(i.persistedBeforeReturnAt <= m.finishedAt); assert.equal(m.claims.historicalCaptureBinding, 'none');
  const supplied = await readFile(join(dirname(r.manifestPath), i.supplied.artifact), 'utf8'); assert.match(supplied, /sourceMappingURL=data:application\/json;base64,/);
  const first = await verifySourceBuild(r.manifestPath, {manifestSha256: r.manifestSha256, buildId: r.buildId, packages: [f.expectation]}); assert.equal(first.status, 'verified-consistency', JSON.stringify(first));
  await unlink(f.source); await unlink(f.map); await writeFile(f.js, 'throw Error("changed")');
  const later = await verifySourceBuild(r.manifestPath, {manifestSha256: r.manifestSha256}); assert.equal(later.status, 'verified-consistency'); assert.deepEqual(later.artifacts, first.artifacts);
}));

test('missing maps/originals, content conflicts and unsupported declarations fail the build with preserved failures', async () => {
  for (const [change, code] of [
    [f => unlink(f.map), 'ENOENT'], [f => unlink(f.source), 'ENOENT'],
    [f => writeFile(f.source, 'different'), 'embedded-source-content-mismatch'],
    [f => writeFile(f.js, '//# sourceMappingURL=https://invalid.example/a.map\n'), 'unsupported-source-map-declaration'],
    [f => writeFile(f.js, '//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map\n'), 'multiple-source-map-declarations'],
    [async f => {f.payload.sections = []; await writeFile(f.map, JSON.stringify(f.payload));}, 'unsupported-source-map-form'],
  ]) await fixture(async f => {await change(f); const r = await f.run(); assert.equal(r.status, 'failed'); assert.equal(r.code, code, JSON.stringify(r)); const failure = JSON.parse(await readFile(r.resultPath)); assert.equal(failure.status, 'failed'); assert.ok(failure.startedAt);});
});

test('package version and hash expectations reject wrong inputs instead of trusting directory names', async () => {
  await fixture(async f => {await writeFile(join(f.pkg, 'package.json'), JSON.stringify({name: 'test-vendor', version: '2.0.0'})); const r = await f.run(); assert.equal(r.status, 'failed'); assert.equal(r.code, 'package-version-mismatch');});
  await fixture(async f => {await writeFile(join(f.pkg, 'package.json'), JSON.stringify({name: 'test-vendor', version: '1.0.0', extra: true})); const r = await f.run(); assert.equal(r.status, 'failed'); assert.equal(r.code, 'package-hash-mismatch');});
  await fixture(async f => {const r = await f.run(); await manifest(r); const v = await verifySourceBuild(r.manifestPath, {manifestSha256: r.manifestSha256, packages: [{...f.expectation, version: '2.0.0'}]}); assert.equal(v.status, 'refused'); assert.equal(v.code, 'expected-package-mismatch');});
});

test('saved JS, input map, original, supplied bytes and output corruption are refused independently', async () => fixture(async f => {
  const r = await f.run(), m = await manifest(r), mapped = m.inputs.find(i => i.map);
  const descriptors = [mapped.original, mapped.map, mapped.originals[0], mapped.suppliedMap, mapped.supplied, ...m.outputs];
  for (let index = 0; index < descriptors.length; index++) {
    const target = join(f.root, 'tampered-' + index); await cp(dirname(r.manifestPath), target, {recursive: true, errorOnExist: true, force: false});
    const d = descriptors[index], path = join(target, d.artifact), bytes = await readFile(path); bytes[0] ^= 1; await writeFile(path, bytes);
    const v = await verifySourceBuild(join(target, 'build-evidence.json'), {manifestSha256: r.manifestSha256}); assert.equal(v.status, 'refused'); assert.equal(v.code, 'artifact-hash-mismatch', d.artifact);
  }
  const missing = join(f.root, 'missing'); await cp(dirname(r.manifestPath), missing, {recursive: true, errorOnExist: true, force: false}); await unlink(join(missing, mapped.map.artifact));
  const v = await verifySourceBuild(join(missing, 'build-evidence.json'), {manifestSha256: r.manifestSha256}); assert.equal(v.status, 'refused'); assert.equal(v.code, 'ENOENT');
}));

test('manifest identity/hash and mixed-build output expectations remain separate guards', async () => fixture(async f => {
  const a = await f.run(), ma = await manifest(a);
  await writeFile(f.entry, 'export {value} from "../vendor/dist/value.js";\nexport const variant = 2;\n');
  const b = await f.run(), mb = await manifest(b); assert.notEqual(ma.outputs.find(o => o.role === 'emitted-javascript').sha256, mb.outputs.find(o => o.role === 'emitted-javascript').sha256);
  for (const [expect, code] of [
    [{}, 'expected-manifest-hash-required'],
    [{manifestSha256: a.manifestSha256}, 'manifest-hash-mismatch'],
    [{manifestSha256: b.manifestSha256, buildId: a.buildId}, 'build-id-mismatch'],
    [{manifestSha256: b.manifestSha256, outputSha256: ma.outputs.find(o => o.role === 'emitted-javascript').sha256}, 'expected-output-mismatch'],
  ]) {const v = await verifySourceBuild(b.manifestPath, expect); assert.equal(v.status, 'refused'); assert.equal(v.code, code);}
}));

test('scope escape and unsupported loader cannot silently fall back to unobserved native loads', async () => {
  await fixture(async f => {await writeFile(join(f.root, 'outside.mjs'), 'export const x=1;'); await writeFile(f.entry, 'export {x} from "../outside.mjs";'); const r = await f.run(); assert.equal(r.status, 'failed'); assert.equal(r.code, 'input-outside-scopes');});
  await fixture(async f => {await writeFile(join(f.app, 'data.json'), '{}'); await writeFile(f.entry, 'export {default} from "./data.json";'); const r = await f.run(); assert.equal(r.status, 'failed'); assert.equal(r.code, 'unsupported-input-loader');});
});
