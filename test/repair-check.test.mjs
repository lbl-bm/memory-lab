import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSelectedRepair } from '../src/repair-check.mjs';

const rule = {diagnosticKey:'draftCallbacks',maxRetained:0};
const sample = (selected, unrelated, port = 3000) => ({
  status:'completed', config:{url:'http://127.0.0.1:'+port,cycles:1,warmupCycles:1,settleMs:120},
  browser:{version:'test-browser'}, scenario:{moduleSha256:'a'.repeat(64)}, tool:{runnerSha256:'b'.repeat(64)},
  observations:[
    {phase:'baseline',state:{closed:true}},
    {phase:'action',cycle:1,state:{editable:true}},
    {phase:'back',cycle:1,state:{closed:true}},
    {phase:'assertBaseline',cycle:1,state:{closed:true}},
    {phase:'followup',state:{closed:true}},
  ],
  samples:[{phase:'followup',cycle:1,diagnostic:{draftCallbacks:selected,unrelated}}]
});

test('requires the selected release transition and may ignore the controlled local port', () => {
  const r = assessSelectedRepair(sample(4,2),sample(0,2,3001),rule);
  assert.equal(r.verdict,'verified-for-rule');
  assert.deepEqual([r.beforeCount,r.afterCount],[4,0]);
});
test('clean baseline and a different improving rule never prove the selected repair', () => {
  assert.equal(assessSelectedRepair(sample(0,0),sample(0,0),rule).verdict,'not-reproduced');
  assert.equal(assessSelectedRepair(sample(4,6),sample(4,0),rule).verdict,'not-verified');
  assert.equal(assessSelectedRepair(sample(0,6),sample(0,0),rule).verdict,'not-reproduced');
});
test('scenario changes, a missing final point or a changed functional assertion withhold judgment', () => {
  const before=sample(4,0);
  const changed=sample(0,0);
  changed.observations[1].state.editable=false;
  assert.equal(assessSelectedRepair(before,changed,rule).verdict,'insufficient-evidence');
  const other = sample(0,0); other.scenario.moduleSha256='f'.repeat(64);
  assert.equal(assessSelectedRepair(before,other,rule).verdict,'insufficient-evidence');
  assert.equal(assessSelectedRepair(before,{...sample(0,0),samples:[]},rule).verdict,'insufficient-evidence');
});
