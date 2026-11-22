import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { censusObjects, compareCensuses, validatePoints, loadRunPoints } from '../src/snapshot-growth.mjs';
import { runGrowthCommand } from '../src/growth-command.mjs';
import { withDeadline, withBrowserStage } from '../src/deadline.mjs';
import { EventEmitter } from 'node:events';

function heap(counts) {
  // Deliberately reorder fields: do not assume V8's usual numeric offsets.
  const strings=Object.keys(counts); const nodes=[]; let id=1;
  for(let name=0;name<strings.length;name++)for(let n=0;n<counts[strings[name]];n++)nodes.push(name,id++,24,1,0);
  nodes.push(0,id,8,0,0); // String node excluded by the explicit object scope.
  return {snapshot:{meta:{node_fields:['name','id','self_size','type','edge_count'],node_types:[null,null,null,['string','object'],null]}},nodes,strings};
}
const points=[{phase:'baseline',cycle:0},{phase:'back',cycle:1},{phase:'back',cycle:2},{phase:'back',cycle:3}];
async function cleanup(root) {
  const target=await realpath(root);
  assert.equal(dirname(target).toLowerCase(),(await realpath(tmpdir())).toLowerCase());
  assert.ok(basename(target).startsWith('growth-test-'));
  await rm(target,{recursive:true,force:true});
}

test('census decodes metadata and accepts previously unspecified object names',()=>{
  const census=censusObjects(heap({'NoPreselectedClass_938f':2,'Another':1}));
  assert.equal(census.get(JSON.stringify(['object','NoPreselectedClass_938f'])).count,2);
  assert.equal(census.get(JSON.stringify(['object','Another'])).selfSizeBytes,24);
  assert.equal(census.size,2);
  assert.throws(()=>censusObjects({snapshot:{meta:{node_fields:[]}},nodes:[],strings:[]}),/Missing/);
});
test('persistent counts, bounded cache and delayed release retain different evidence',()=>{
  const censuses=[0,1,2,3].map((n,i)=>censusObjects(heap({Arbitrary:n,Bounded:[1,2,2,2][i],Delay:n})));
  censuses.push(censusObjects(heap({Arbitrary:3,Bounded:2,Delay:0})));
  const result=compareCensuses([...points,{phase:'followup',cycle:3}],censuses);
  assert.equal(result.candidateCount,2);
  assert.equal(result.unresolvedCandidateCount,1);
  assert.equal(result.groups.find(g=>g.name==='Bounded').persistentGrowth,false);
  assert.equal(result.groups.find(g=>g.name==='Delay').followupStatus,'at-or-below-baseline');
  assert.deepEqual(result.groups.find(g=>g.name==='Arbitrary').increments,[1,1,1]);
  assert.throws(()=>validatePoints(points.slice(0,3)),/at least 3/);
  assert.throws(()=>validatePoints([points[0],points[1],points[1],points[3]]),/consecutive/);
});
test('run adapter rejects a first-cycle triplet and paths outside the run',async()=>{
  const root=await mkdtemp(join(tmpdir(),'growth-test-'));
  try {
    const run=join(root,'run');await mkdir(run);
    await writeFile(join(run,'report.json'),JSON.stringify({status:'completed',config:{roundSnapshots:false}}));
    await assert.rejects(loadRunPoints(run),/roundSnapshots/);
    const outside=join(root,'outside.heapsnapshot');await writeFile(outside,JSON.stringify(heap({X:1})));
    await writeFile(join(run,'report.json'),JSON.stringify({status:'completed',config:{roundSnapshots:true},artifacts:points.map(p=>({kind:'heap-snapshot',...p,path:outside}))}));
    await assert.rejects(loadRunPoints(run),/inside its run/);
  } finally {await cleanup(root);}
});
test('worker failures are recorded without changing the input report',async()=>{
  const root=await mkdtemp(join(tmpdir(),'growth-test-'));
  try {
    const path=join(root,'report.json');const original=JSON.stringify({status:'completed',config:{roundSnapshots:false}});await writeFile(path,original);
    const result=await runGrowthCommand(root);
    assert.equal(result.status,'failed');assert.equal(result.candidateCount,null);
    assert.match(JSON.parse(await readFile(join(result.output,'error.json'),'utf8')).error.message,/roundSnapshots/);
    assert.equal(await readFile(path,'utf8'),original);
  } finally {await cleanup(root);}
});
test('a pending startup stage has a finite deadline and cleans up a late resolution',async()=>{
  let resolveLate;let cleaned=false;
  const pending=new Promise(resolve=>{resolveLate=resolve;});
  await assert.rejects(withDeadline(pending,5,'Startup',()=>{cleaned=true;}),/deadline/);
  resolveLate('late value');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cleaned,true);
  assert.equal(await withDeadline(Promise.resolve(7),100,'Startup'),7);
});
test('browser disconnection rejects a pending stage and removes its listener',async()=>{
  const browser=new EventEmitter();browser.isConnected=()=>true;
  let resolveLate;let closed=false;
  const result=withBrowserStage(browser,()=>new Promise(resolve=>{resolveLate=resolve;}),1000,'page creation');
  setImmediate(()=>browser.emit('disconnected'));
  await assert.rejects(result,/Browser disconnected during page creation/);
  assert.equal(browser.listenerCount('disconnected'),0);
  resolveLate({close:async()=>{closed=true;}});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,true);
  browser.isConnected=()=>false;
  await assert.rejects(withBrowserStage(browser,()=>Promise.resolve(),100,'context creation'),/disconnected before/);
});
