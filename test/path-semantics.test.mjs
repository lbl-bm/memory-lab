import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/incoming-oracle.mjs';
import { buildIncomingIndex } from '../src/incoming-index.mjs';
import { searchReversePaths } from '../src/reverse-paths.mjs';
const run = (nodes, edges, target, options = {}) => searchReversePaths(buildIncomingIndex(fixture(nodes, edges)), target, { rootIds: [nodes[0].id], ...options });
const nodes = [{ id: 71, name: '', type: 'synthetic' }, { id: 77, name: '(GC roots)', type: 'synthetic' }, { id: 79, name: 'target' }];
const edge = (from,to,type='property',name='p') => ({from,to,type,name});
const unproven = r => { assert.equal(r.semanticAssessment.gcRetentionStatus, 'not-established'); assert.equal(r.semanticAssessment.gcReachabilityStatus, 'not-established'); assert.equal(r.semanticAssessment.supportsLeakVerdictOnItsOwn, false); };

test('semantics: weak-only literal paths never become retention proofs', () => {
  const edges=[edge(71,79,'weak','weak-target')], all=run(nodes,edges,79,{edgePolicy:'all-literal'}), filtered=run(nodes,edges,79);
  assert.equal(all.outcome,'path-found'); assert.equal(all.semanticAssessment.facts.weakEdges.length,1); assert.equal(filtered.outcome,'no-path-under-policy');
  unproven(all); unproven(filtered); assert.equal(filtered.semanticAssessment.status,'no-returned-path');
});

test('semantics: shortcut position and synthetic labels do not certify a GC root', () => {
  const result=run(nodes,[edge(71,77,'shortcut','global-like'),edge(77,79,'shortcut','bound-like')],79);
  assert.equal(result.outcome,'path-found'); assert.deepEqual(result.semanticAssessment.facts.shortcuts.map(e=>e.originatesAtFirstArrayNode),[true,false]);
  assert.ok(result.semanticAssessment.facts.shortcuts.every(e=>e.rootRole==='not-certified-by-position-or-type')); unproven(result);
  const arbitrary=run(nodes,[edge(77,79)],79,{rootIds:[77]}); assert.equal(arbitrary.outcome,'path-found'); assert.equal(arbitrary.semanticAssessment.facts.syntheticDeclarations[0].nodeIndex,1); unproven(arbitrary);
  const spoof=run([{id:71,name:'(GC roots)'},{id:79,name:'target'}],[edge(71,79)],79); assert.equal(spoof.semanticAssessment.facts.syntheticDeclarations.length,0); unproven(spoof);
});

test('semantics: orphan and isolated-cycle nodes receive no invented root edge', () => {
  const edges=[edge(77,79),edge(79,77)], result=run(nodes,edges,79);
  assert.equal(result.outcome,'no-path-under-policy'); assert.equal(result.path,null); assert.equal(result.stats.discoveredNodes,2); unproven(result);
  const cut=run(nodes,[edge(71,79)],79,{maxDepth:0}); assert.equal(cut.outcome,'incomplete'); assert.ok(cut.semanticAssessment.cautions.some(c=>c.code==='bounded-search-has-no-conclusive-path-result')); unproven(cut);
});

test('semantics: WeakMap-shaped internal labels are explicit uncertain hints only', () => {
  const name='3 / part of key (Key @71) -> value (Value @79) pair in WeakMap (table @77)';
  const internal=run(nodes,[edge(71,79,'internal',name)],79), property=run(nodes,[edge(71,79,'property',name)],79);
  assert.equal(internal.semanticAssessment.facts.weakMapLabelHints.length,1); assert.equal(internal.semanticAssessment.facts.weakMapLabelHints[0].reliability,'label-shape-only-not-validated-ephemeron');
  assert.equal(property.semanticAssessment.facts.weakMapLabelHints.length,0); unproven(internal); unproven(property);
  const plain=run(nodes,[edge(71,79)],79); assert.equal(plain.semanticAssessment.facts.internalOrHiddenEdges.length,0); unproven(plain);
});
