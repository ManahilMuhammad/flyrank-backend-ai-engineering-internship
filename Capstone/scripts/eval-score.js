// score classifier against human labels in eval/labels.csv
// writes eval/results.json and evaluation section of README.md (between eval markers)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCsv } from '../src/lib/csv.js';
import { scoreEvaluation, renderMarkdown } from '../src/services/evaluation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const cases = JSON.parse(read('eval/cases.json'));
const predictions = JSON.parse(read('eval/predictions.json'));
const labels = parseCsv(read('eval/labels.csv'));

const bool = v => {
    const s = String(v ?? '').trim().toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(s)) return true;
    if (['no', 'n', 'false', '0'].includes(s)) return false;
    return undefined;
};

const rows = labels.map(l => {
    const brandKey = l.id.split(':')[1];
    const prediction = predictions.cases[l.id];
    return {
        id: l.id,
        human_stance: l.human_stance.trim().toLowerCase(),
        human_is_stale: bool(l.human_is_stale),
        has_fact_sheet: Object.keys(cases.brands[brandKey]?.fact_sheet ?? {}).length > 0,
        prediction: prediction && !prediction.error ? prediction : undefined
    };
});

const results = scoreEvaluation(rows);
fs.writeFileSync(path.join(ROOT, 'eval/results.json'), JSON.stringify(results, null, 2) + '\n');

const markdown = renderMarkdown(results, { model: `${predictions.model}, prompt ${predictions.prompt_version}` });
const readmePath = path.join(ROOT, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const updated = readme.replace(/(<!-- eval:start -->)[\s\S]*?(<!-- eval:end -->)/, `$1\n${markdown}\n$2`);
if (updated === readme && !readme.includes(markdown)) console.warn('README.md has no <!-- eval:start --> / <!-- eval:end --> markers; not updated');
fs.writeFileSync(readmePath, updated);

console.log(markdown);
