import test from 'node:test';
import assert from 'node:assert/strict';
import {sourcePositions,sourcePolicy} from '../src/source-candidates.mjs';
import {fixture} from './helpers/incoming-oracle.mjs';

test('high-degree early path node cannot starve a later direct function position',()=>{
  const nodes=[{id:1,name:'hub'},{id:2,name:'noise'},{id:3,name:'tail',type:'closure'}],edges=Array.from({length:sourcePolicy.maxTraversedEdges+10},()=>({from:1,to:2,type:'property',name:'noise'}));edges.push({from:1,to:3,type:'property',name:'tail'});
  const heap=fixture(nodes,edges);heap.locations=[2*heap.snapshot.meta.node_fields.length,37,2,3];
  const path=[{id:1,name:'hub',type:'object',edgeToNext:{type:'property',name:'tail'}},{id:3,name:'tail',type:'closure',edgeToNext:null}];
  const result=sourcePositions(heap,[1,3],path);assert.deepEqual(result.positions.map(p=>p.nodeId),[3]);assert.equal(result.positions[0].relation.kind,'direct-path-node-location');
  assert.equal(result.coverage.direct.inspectedNodes,2);assert.equal(result.coverage.direct.inspectionComplete,true);assert.equal(result.coverage.neighbors.stopReason,'edge-limit');assert.equal(result.traversedEdges,2000);assert.equal(result.truncated,true);
});

test('all direct positions are inspected even beyond the unchanged output cap',()=>{
  const nodes=Array.from({length:30},(_,i)=>({id:i+1,name:'f'+i,type:'closure'})),heap=fixture(nodes,[]);
  heap.locations=nodes.flatMap((_,i)=>[i*heap.snapshot.meta.node_fields.length,37,i,0]);
  const result=sourcePositions(heap,nodes.map(n=>n.id));assert.equal(result.positions.length,24);assert.equal(result.coverage.direct.inspectedNodes,30);assert.equal(result.coverage.direct.locatedNodes,30);assert.equal(result.coverage.direct.omittedPositions,6);assert.equal(result.coverage.direct.outcomes.filter(o=>o.status==='omitted-position-limit').length,6);assert.equal(result.coverage.direct.inspectionComplete,true);assert.equal(result.coverage.direct.outputComplete,false);assert.equal(result.traversedEdges,0);assert.equal(result.truncated,true);
});

test('cycles and parallel property edges do not duplicate clues; weak edges and decoys keep their scope',()=>{
  const heap=fixture([{id:1,name:'owner'},{id:2,name:'nearby'},{id:3,name:'decoy',type:'closure'},{id:4,name:'weak-decoy',type:'closure'}],[{from:1,to:2,type:'property',name:'nearby'},{from:1,to:4,type:'weak',name:'weak'},{from:2,to:1,type:'property',name:'cycle'},{from:2,to:3,type:'property',name:'fn'},{from:2,to:3,type:'property',name:'fn2'}]);
  const width=heap.snapshot.meta.node_fields.length;heap.locations=[2*width,37,2,0,3*width,37,3,0];
  const r=sourcePositions(heap,[1]);assert.equal(r.positions.length,1);assert.equal(r.positions[0].nodeId,3);assert.equal(r.positions[0].relation.kind,'property-nearby-function-location');assert.equal(r.positions[0].relation.depth,2);assert.equal(r.coverage.neighbors.inspectedNodes,2);
  const direct=sourcePositions(heap,[1,3]);assert.equal(direct.positions.length,1);assert.equal(direct.positions[0].relation.kind,'direct-path-node-location');assert.equal(direct.coverage.direct.inspectedNodes,2);
});

test('missing locations are accounted independently from emitted positions',()=>{
  const heap=fixture([{id:1,name:'a'},{id:2,name:'b'}],[]);const r=sourcePositions(heap,[1,2,1]);assert.equal(r.coverage.direct.inspectedNodes,2);assert.equal(r.coverage.direct.missingLocations,2);assert.equal(r.positions.length,0);assert.equal(r.truncated,false);
  delete heap.locations;const missing=sourcePositions(heap,[1,2]);assert.equal(missing.positions.length,0);assert.equal(missing.unknown[0].code,'missing-location-metadata');assert.equal(missing.coverage,undefined);
});
