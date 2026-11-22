import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './helpers/incoming-oracle.mjs';
import { censusObjects, compareCensuses, growthRule } from '../src/snapshot-growth.mjs';
import { sha256 } from '../src/heap-identity.mjs';
import { loadNativeSourceEvidence, validateNativeSourceOptions } from '../src/native-source-input.mjs';
import { analyzeSourceCandidates, sourcePositions } from '../src/source-candidates.mjs';

// Tiny encoded graphs test composition logic only. The simulated identity below
// is not a collector validation or a new browser/Node heap measurement.
async function withSeries(counts, callback, edgeType = 'property') {
  const root = await mkdtemp(join(tmpdir(), 'native-source-test-')), runDir = await realpath(root), points = [], censuses = [];
  try {
    for (let i = 0; i < counts.length; i++) {
      const nodes = [{ id: 1, name: '', type: 'synthetic' }, { id: 9, name: 'unreachable-stop', type: 'synthetic' }], edges = [];
      for (let j = 0; j < counts[i]; j++) { nodes.push({ id: 20 + 2 * j, name: 'Resource' }); edges.push({ from: 1, to: 20 + 2 * j, type: edgeType, name: 'r' + j }); }
      const heap = fixture(nodes, edges), raw = JSON.stringify(heap), path = join(runDir, i + '.heapsnapshot');
      await writeFile(path, raw); censuses.push(censusObjects(heap));
      points.push({ path, phase: i === 0 ? 'baseline' : i === 4 ? 'followup' : 'back', cycle: Math.min(i, 3), sha256: sha256(raw) });
    }
    const growth = { status: 'completed', inputRunId: 'unit', runDir, rule: growthRule, points, tool: { implementationSha256: sha256(await readFile(new URL('../src/snapshot-growth.mjs', import.meta.url))) }, ...compareCensuses(points, censuses) }, growthPath = join(runDir, 'growth.json');
    await writeFile(growthPath, JSON.stringify(growth));
    const source = { runId: 'unit', identity: { status: 'validated-consistency', comparable: true }, inputs: { runDir, points, captureReportSha256: 'simulated-unit-report', identity: { sha256: 'simulated-unit-identity' } } };
    await callback({ growth, growthPath, source, writeGrowth: g => writeFile(growthPath, JSON.stringify(g)) });
  } finally {
    const path = await realpath(root); assert.equal(dirname(path).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(path).startsWith('native-source-test-')); await rm(path, { recursive: true, force: true });
  }
}

test('native composition distinguishes plateau and release, but equal leak/cache ramps stay undecided', async () => {
  for (const [name, counts, status, followup] of [['leak', [1,2,3,4,4], 'selected', true], ['cache-ramp', [1,2,3,4,4], 'selected', true], ['cache-plateau', [1,2,2,2,2], 'unknown', null], ['delayed', [1,2,3,4,0], 'selected', false]]) {
    await withSeries(counts, async ({ growthPath, source }) => {
      const r = await loadNativeSourceEvidence(growthPath, source, { rootIds: [1] }); assert.equal(r.status, status, name);
      assert.equal(r.representativeLifecycle.verdict, 'unknown'); assert.equal(r.conclusion.leakVerdict, 'not-determined');
      if (status === 'selected') { assert.equal(r.selection.nodeId, 22); assert.equal(r.selection.presentAtFollowup, followup); assert.equal(r.search.path.edgeCount, 1); assert.equal(r.search.semanticAssessment.supportsLeakVerdictOnItsOwn, false); assert.equal(r.growth.recomputedFromEveryRawPoint, true); }
      else assert.equal(r.code, 'no-growing-object-group');
    });
  }
});

test('native composition keeps weak-only, unreachable and truncated paths explicitly unknown', async () => {
  await withSeries([1,2,3,4,4], async ({growthPath,source}) => {
    for (const [options, code, stop] of [[{rootIds:[9]}, 'no-native-path-under-policy','frontier-exhausted'], [{rootIds:[1],maxDepth:0},'native-path-search-incomplete','depth-limit'], [{rootIds:[1],maxNodes:1},'native-path-search-incomplete','node-limit'], [{rootIds:[1],maxEdges:0},'native-path-search-incomplete','edge-limit']]) {
      const r=await loadNativeSourceEvidence(growthPath,source,options);assert.equal(r.status,'unknown');assert.equal(r.code,code);assert.equal(r.search.stopReason,stop);assert.equal(r.search.path,null);
    }
  });
  await withSeries([1,2,3,4,4],async ({growthPath,source})=>{const r=await loadNativeSourceEvidence(growthPath,source,{rootIds:[1]});assert.equal(r.code,'no-native-path-under-policy');assert.equal(r.search.stats.explicitWeakSkipped,1);},'weak');
});

test('native composition refuses mismatched run, implementation, point, counts and fabricated ranking',async()=>{
  await withSeries([1,2,3,4,4],async({growth,growthPath,source,writeGrowth})=>{
    for(const [mutate,code] of [
      [g=>g.inputRunId='other','growth-run-binding-mismatch'],[g=>g.tool.implementationSha256='stale','growth-implementation-or-rule-mismatch'],
      [g=>g.points[1].sha256='wrong','growth-snapshot-binding-mismatch'],[g=>g.candidates[0].counts[1]++,'growth-counts-or-ranking-mismatch'],
      [g=>g.candidates.unshift({...g.candidates[0],name:'fabricated-top'}),'growth-counts-or-ranking-mismatch'],[g=>g.groups=[],'growth-counts-or-ranking-mismatch'],
    ]) {const g=structuredClone(growth);mutate(g);await writeGrowth(g);assert.equal((await loadNativeSourceEvidence(growthPath,source,{rootIds:[1]})).code,code);}
    await writeGrowth(growth); await writeFile(source.inputs.points[2].path,'{}'); await assert.rejects(loadNativeSourceEvidence(growthPath,source,{rootIds:[1]}),/bytes changed/);
  });
});

test('identity gates selection even if a growth file is missing; invalid options are rejected before I/O',async()=>{
  for(const status of ['unknown','invalid']) {const r=await loadNativeSourceEvidence('absent',{identity:{status,comparable:false}},{rootIds:[1]});assert.equal(r.status,status);assert.equal(r.selection,null);}
  for(const options of [null,{}, {rootIds:[]},{rootIds:[1,1]},{rootIds:[-1]},{rootIds:[1],edgePolicy:'all-literal'},{rootIds:[1],maxNodes:50001},{rootIds:[1],maxDepth:-1}]) assert.throws(()=>validateNativeSourceOptions(options));
  await assert.rejects(analyzeSourceCandidates('absent',null,null,null,{growthPath:'g',evidencePath:'e'}),/Choose/);
  await assert.rejects(analyzeSourceCandidates('absent',null,null,null,{searchOptions:{rootIds:[1]}}),/require/);
});

test('native literal path converts to existing source decoder without upgrading missing locations', async()=>{
  await withSeries([1,2,3,4,4],async({growthPath,source})=>{
    const r=await loadNativeSourceEvidence(growthPath,source,{rootIds:[1]}),heap=JSON.parse(await readFile(r.selection.snapshot));
    const positions=sourcePositions(heap,r.path.map(p=>p.id),r.path);assert.equal(positions.rawPathValidation.edges,1);assert.equal(positions.positions.length,0);
    delete heap.locations;assert.equal(sourcePositions(heap,r.path.map(p=>p.id),r.path).unknown[0].code,'missing-location-metadata');
  });
});
