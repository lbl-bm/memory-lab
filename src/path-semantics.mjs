// Risk annotation of literal graph output, not a GC-edge-strength classifier.
// Labels/types/positions are observations; none certify retention or a defect.
export function assessPathSemantics(search) {
  const path = search.path, edges = path?.edges ?? [], nodes = path?.nodes ?? [];
  const edgeFact = e => ({ edgeOffset: e.edgeOffset, sourceId: e.source.id, targetId: e.target.id, type: e.type });
  const weakEdges = edges.filter(e => e.type === 'weak').map(edgeFact);
  const shortcuts = edges.filter(e => e.type === 'shortcut').map(e => ({ ...edgeFact(e), sourceNodeIndex: e.source.nodeIndex, sourceType: e.source.type, originatesAtFirstArrayNode: e.source.nodeIndex === 0, rootRole: 'not-certified-by-position-or-type' }));
  const syntheticDeclarations = search.declaration.roots.filter(n => n.type === 'synthetic').map(n => ({ id: n.id, name: n.name, nodeIndex: n.nodeIndex }));
  const internalOrHiddenEdges = edges.filter(e => e.type === 'internal' || e.type === 'hidden').map(edgeFact);
  const codeOrNativeNodes = nodes.filter(n => n.type === 'code' || n.type === 'native').map(n => ({ id: n.id, type: n.type, nodeIndex: n.nodeIndex }));
  const weakMapLabelHints = edges.filter(e => e.type === 'internal' && typeof e.nameOrIndex === 'string' && /^\d+ \/ part of key \(.* @\d+\) -> value \(.* @\d+\) pair in WeakMap \(table @\d+\)$/.test(e.nameOrIndex)).map(e => ({ ...edgeFact(e), name: e.nameOrIndex, reliability: 'label-shape-only-not-validated-ephemeron' }));
  const cautions = [{ code: 'declared-stopping-nodes-not-certified-gc-roots', origin: 'caller-declaration' }];
  if (weakEdges.length) cautions.push({ code: 'explicit-weak-edge-cannot-alone-establish-retention', origin: 'raw-edge-type' });
  if (shortcuts.length) cautions.push({ code: 'shortcut-role-depends-on-generator-and-analysis-purpose', origin: 'raw-edge-type-and-source-position' });
  if (syntheticDeclarations.length) cautions.push({ code: 'synthetic-node-type-does-not-certify-root', origin: 'raw-node-type' });
  if (internalOrHiddenEdges.length || codeOrNativeNodes.length) cautions.push({ code: 'internal-native-runtime-semantics-not-evaluated', origin: 'raw-edge-or-node-type' });
  if (weakMapLabelHints.length) cautions.push({ code: 'possible-conditional-weakmap-relation-needs-key-and-table-context', origin: 'name-pattern-only' });
  if (!path) cautions.push({ code: search.outcome === 'incomplete' ? 'bounded-search-has-no-conclusive-path-result' : 'no-path-is-relative-to-declarations-and-policy', origin: 'search-coverage' });
  return { version: '0.1.0', evidenceKind: 'literal-path-search', status: path ? 'requires-semantic-review' : 'no-returned-path', gcRetentionStatus: 'not-established', gcReachabilityStatus: 'not-established', supportsLeakVerdictOnItsOwn: false, algorithmicOutcome: search.outcome, reachabilityScope: search.completeness, facts: { weakEdges, shortcuts, syntheticDeclarations, internalOrHiddenEdges, codeOrNativeNodes, weakMapLabelHints }, cautions, limitation: 'Facts annotate raw types, positions and label shapes. No full GC marking, ephemeron validation, dominator synthesis, lifecycle inference or repair judgment. Absence of these patterns does not certify a retaining path.' };
}
