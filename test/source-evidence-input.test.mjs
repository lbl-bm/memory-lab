import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {loadSourceEvidence} from '../src/source-evidence-input.mjs';
test('partial engine evidence stays unknown; unrelated evidence refuses mapping',async()=>{
  const root=await mkdtemp(join(tmpdir(),'source-evidence-test-'));
  try{
    const path=join(root,'evidence.json');await writeFile(path,JSON.stringify({status:'partial',traces:[{status:'failed'}]}));
    assert.equal((await loadSourceEvidence(path,{})).code,'no-complete-retaining-evidence-path');
    await writeFile(path,JSON.stringify({status:'completed',runId:'other',traces:[{status:'completed'}]}));
    assert.equal((await loadSourceEvidence(path,{runId:'expected',inputs:{}})).code,'source-evidence-run-binding-mismatch');
  }finally{const target=await realpath(root);assert.equal(dirname(target).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(target).startsWith('source-evidence-test-'));await rm(target,{recursive:true,force:true});}
});
