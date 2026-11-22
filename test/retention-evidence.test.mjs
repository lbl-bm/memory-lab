import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { indexObjectIds, chooseAddedSurvivor, prepareRetentionEvidence } from '../src/retention-evidence.mjs';
import { analyzeGrowthRun } from '../src/snapshot-growth.mjs';
import { runEvidenceCommand } from '../src/evidence-command.mjs';
function heap(ids, changedId=null) {
  return {snapshot:{meta:{node_fields:['type','name','id','self_size','edge_count'],node_types:[['object'],null,null,null,null]}},strings:['Unspecified_7ab','Other'],nodes:ids.flatMap(id=>[0,id===changedId?1:0,id,24,0])};
}
const points=[{phase:'baseline',cycle:0},{phase:'back',cycle:1},{phase:'back',cycle:2},{phase:'back',cycle:3},{phase:'followup',cycle:3}];
const group={type:'object',name:'Unspecified_7ab',counts:[1,2,3,4,1],followupStatus:'at-or-below-baseline'};
const key=JSON.stringify(['object',group.name]);
test('representative excludes baseline objects and must survive each back',()=>{
  const indexes=[[10],[10,20],[10,20,30],[10,20,30,40],[10]].map(ids=>indexObjectIds(heap(ids),new Set([key])));
  const selected=chooseAddedSurvivor(points,indexes,group);
  assert.equal(selected.nodeId,20);assert.equal(selected.baselinePresent,false);assert.equal(selected.presentAtFollowup,false);assert.deepEqual(selected.presentInBackCycles,[1,2,3]);
  indexes[2]=indexObjectIds(heap([10,20,30],20),new Set([key]));
  const changed=chooseAddedSurvivor(points,indexes,group);
  assert.equal(changed.selected,false);assert.match(changed.reason,/No baseline-absent/);
});
test('evidence verifies run identity, source and immutable raw input hashes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'evidence-test-'));
  try {
    const ids=[[10],[10,20],[10,20,30],[10,20,30,40],[10]];
    const artifacts=[];
    for(let i=0;i<points.length;i++){const path=join(root,i+'.heapsnapshot');await writeFile(path,JSON.stringify(heap(ids[i])));artifacts.push({kind:'heap-snapshot',...points[i],path});}
    await writeFile(join(root,'report.json'),JSON.stringify({status:'completed',runId:'same-run',config:{roundSnapshots:true},captureKind:'node-v8-synthetic',repo:null,browser:null,scenario:{name:'test'},scope:{},artifacts}));
    const growth=await analyzeGrowthRun(root),growthPath=join(root,'growth.json');const raw=JSON.stringify(growth);await writeFile(growthPath,raw);
    const evidence=await prepareRetentionEvidence(root,growthPath);assert.equal(evidence.identity.status,'unknown');assert.deepEqual(evidence.selections,[]);assert.equal(evidence.selectionSuppressedReason,'missing-contemporaneous-identity');
    await writeFile(growthPath,JSON.stringify({...growth,inputRunId:'other-run'}));await assert.rejects(prepareRetentionEvidence(root,growthPath),/another run/);
    const originalCapture=await readFile(join(root,'report.json'),'utf8');
    const failed=await runEvidenceCommand(root,growthPath);assert.equal(failed.status,'failed');assert.equal(failed.exitCode,1);
    assert.match(JSON.parse(await readFile(join(failed.output,'error.json'),'utf8')).error.message,/another run/);
    assert.equal(await readFile(join(root,'report.json'),'utf8'),originalCapture);
    await writeFile(growthPath,raw);await writeFile(artifacts[1].path,(await readFile(artifacts[1].path,'utf8'))+' ');
    await assert.rejects(prepareRetentionEvidence(root,growthPath),/hash differs/);
  } finally {const target=await realpath(root);assert.equal(dirname(target).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(target).startsWith('evidence-test-'));await rm(target,{recursive:true,force:true});}
});
