// agreement between standing classifier and human labels
// pure functions: eval scripts read files, these do maths

export const STANCES = ['absent', 'neutral', 'favorable', 'unfavorable'];

const round = (n, places = 3) => (n === null || Number.isNaN(n) ? null : Number(n.toFixed(places)));
const divide = (a, b) => (b ? a / b : null);

// matrix[human][model] = count
export function confusionMatrix(pairs, labels = STANCES) {
    const matrix = Object.fromEntries(labels.map(h => [h, Object.fromEntries(labels.map(m => [m, 0]))]));
    for (const { human, model } of pairs) matrix[human][model]++;
    return matrix;
}

// agreement beyond what two raters with these label frequencies would reach by chance
// 1 = perfect
// 0 = chance level
// null when chance agreement already total (one label only)
export function cohenKappa(pairs, labels = STANCES) {
    const n = pairs.length;
    if (!n) return null;
    const observed = pairs.filter(p => p.human === p.model).length / n;
    let expected = 0;
    for (const label of labels) {
        const h = pairs.filter(p => p.human === label).length / n;
        const m = pairs.filter(p => p.model === label).length / n;
        expected += h * m;
    }
    return expected === 1 ? null : (observed - expected) / (1 - expected);
}

export function perClass(pairs, labels = STANCES) {
    return Object.fromEntries(labels.map(label => {
        const tp = pairs.filter(p => p.human === label && p.model === label).length;
        const predicted = pairs.filter(p => p.model === label).length;
        const actual = pairs.filter(p => p.human === label).length;
        const precision = divide(tp, predicted);
        const recall = divide(tp, actual);
        const f1 = precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
        return [label, { support: actual, predicted, precision: round(precision), recall: round(recall), f1: round(f1) }];
    }));
}

function stanceBlock(pairs) {
    return {
        n: pairs.length,
        accuracy: round(divide(pairs.filter(p => p.human === p.model).length, pairs.length)),
        kappa: round(cohenKappa(pairs)),
        per_class: perClass(pairs),
        confusion: confusionMatrix(pairs)
    };
}

function staleBlock(pairs) {
    const tp = pairs.filter(p => p.human && p.model).length;
    const fp = pairs.filter(p => !p.human && p.model).length;
    const fn = pairs.filter(p => p.human && !p.model).length;
    const tn = pairs.filter(p => !p.human && !p.model).length;
    return {
        n: pairs.length, tp, fp, fn, tn,
        accuracy: round(divide(tp + tn, pairs.length)),
        precision: round(divide(tp, tp + fp)),
        recall: round(divide(tp, tp + fn))
    };
}

// rows: { id, human_stance, human_is_stale, prediction: { stance, isStale, model } | { rejected } | undefined }
// unlabelled rows and rows without a prediction are counted not scored
export function scoreEvaluation(rows) {
    const labelled = rows.filter(r => STANCES.includes(r.human_stance));
    const predicted = labelled.filter(r => r.prediction && !r.prediction.rejected);
    const pairs = predicted.map(r => ({ human: r.human_stance, model: r.prediction.stance, rule: r.prediction.model === 'rule' }));
    const llmPairs = pairs.filter(p => !p.rule);

    // staleness only where brand had fact sheet to compare against
    const stalePairs = predicted
        .filter(r => r.has_fact_sheet && typeof r.human_is_stale === 'boolean')
        .map(r => ({ human: r.human_is_stale, model: r.prediction.isStale }));

    // rule says "absent" when brand never named
    // human can disagree (e.g. misspelling)
    const rulePairs = pairs.filter(p => p.rule);

    return {
        cases: rows.length,
        labelled: labelled.length,
        unlabelled: rows.length - labelled.length,
        no_prediction: labelled.filter(r => !r.prediction).length,
        evidence_rejected: labelled.filter(r => r.prediction?.rejected).length,
        stance: stanceBlock(pairs),
        // honest number: only cases llm actually decided (rule's free "absent" calls removed)
        stance_llm_only: stanceBlock(llmPairs),
        rule_absent: { n: rulePairs.length, human_agrees: rulePairs.filter(p => p.human === 'absent').length },
        stale: staleBlock(stalePairs)
    };
}

const pct = x => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const num = x => (x === null ? 'n/a' : x.toFixed(2));

function confusionTable(matrix) {
    const header = `| label \\ model | ${STANCES.join(' | ')} |\n|---|${STANCES.map(() => '---').join('|')}|`;
    const rows = STANCES.map(h => `| **${h}** | ${STANCES.map(m => (h === m ? `**${matrix[h][m]}**` : matrix[h][m])).join(' | ')} |`);
    return [header, ...rows].join('\n');
}

// evaluation section of README
export function renderMarkdown(r, { generatedAt = new Date().toISOString().slice(0, 10), model } = {}) {
    if (!r.stance.n) {
        return `_No labelled cases yet (${r.cases} cases built, ${r.unlabelled} waiting for labels). ` +
            'Fill in `eval/labels.csv` and run `npm run eval:score`._';
    }
    const s = r.stance;
    const l = r.stance_llm_only;
    const perClassRows = STANCES.map(c => {
        const x = l.per_class[c];
        return `| ${c} | ${x.support} | ${pct(x.precision)} | ${pct(x.recall)} | ${num(x.f1)} |`;
    });
    return [
        `Scored ${generatedAt}${model ? ` (classifier: ${model})` : ''}. ${r.labelled} of ${r.cases} cases labelled` +
            `${r.no_prediction ? `; **${r.no_prediction} labelled cases have no classifier prediction yet** (LLM quota) and are not scored` : ''}` +
            `${r.evidence_rejected ? `; ${r.evidence_rejected} had no verdict because the quote check rejected the LLM's evidence twice` : ''}.`,
        '',
        '| | cases | stance accuracy | Cohen\'s kappa |',
        '|---|---|---|---|',
        `| All cases | ${s.n} | ${pct(s.accuracy)} | ${num(s.kappa)} |`,
        `| **LLM-decided only** (rule's "absent" calls removed) | ${l.n} | **${pct(l.accuracy)}** | **${num(l.kappa)}** |`,
        '',
        `The "brand never named" rule decided ${r.rule_absent.n} cases; the reference label agreed with "absent" in ${r.rule_absent.human_agrees}.`,
        '',
        '**Per stance (LLM-decided cases):**',
        '',
        '| stance | label count | precision | recall | F1 |',
        '|---|---|---|---|---|',
        ...perClassRows,
        '',
        '**Confusion matrix (all cases):**',
        '',
        confusionTable(s.confusion),
        '',
        r.stale.n
            ? `**Staleness** (${r.stale.n} cases where the brand had a fact sheet): accuracy ${pct(r.stale.accuracy)}, ` +
              `precision ${pct(r.stale.precision)}, recall ${pct(r.stale.recall)} ` +
              `(${r.stale.tp} caught, ${r.stale.fp} false alarms, ${r.stale.fn} missed).`
            : '**Staleness:** no labelled cases had a fact sheet to compare against.'
    ].join('\n');
}
