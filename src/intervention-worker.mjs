import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeIntervention } from './intervention.mjs';
import { withDeadline } from './deadline.mjs';
const [runDir, identity, scripts, contract, observations, output] = process.argv.slice(2);
try {
  const r = await withDeadline(analyzeIntervention(runDir, identity || null, scripts || null, contract || null, observations || null), 55000, 'Intervention analysis');
  await writeFile(resolve(output, 'intervention.json'), JSON.stringify(r, null, 2) + '\n', { flag: 'wx' });
  const lines = ['# Call/view intervention evidence', '', 'Observation consistency: ' + r.observationValidation.status, '', 'Intervention: ' + (r.assessment.intervention.result ?? 'unknown'), '', 'Causal source localization and leak verdict remain undetermined.', ''];
  for (const c of r.assessment.candidates) lines.push('- ' + c.source.path + ':' + c.source.line + ':' + c.source.column + ': ' + c.finding + (c.code ? ' (' + c.code + ')' : ''));
  lines.push('', r.assessment.policyContext ?? r.assessment.code ?? '', '', 'Wrappers and edge cuts alter the experiment. Findings apply only to the observed view/workload; this is not production repair validation.');
  await writeFile(resolve(output, 'intervention.md'), lines.join('\n') + '\n', { flag: 'wx' }); if (r.status !== 'completed') process.exitCode = 1;
} catch (error) { await writeFile(resolve(output, 'error.json'), JSON.stringify({ status: 'failed', error: { name: error.name, message: error.message } }, null, 2) + '\n', { flag: 'wx' }); process.exitCode = 1; }
