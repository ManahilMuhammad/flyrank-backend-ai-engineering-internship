import { describe, it, expect } from 'vitest';
import { cohenKappa, confusionMatrix, perClass, scoreEvaluation, renderMarkdown } from '../src/services/evaluation.js';
import { toCsv, parseCsv } from '../src/lib/csv.js';

// pure functions only

const repeat = (human, model, n) => Array.from({ length: n }, () => ({ human, model }));
// 10 cases, 9 agree: human a4 n2 f3 u1, model a4 n3 f2 u1
const PAIRS = [
    ...repeat('absent', 'absent', 4), ...repeat('neutral', 'neutral', 2),
    ...repeat('favorable', 'favorable', 2), ...repeat('favorable', 'neutral', 1), ...repeat('unfavorable', 'unfavorable', 1)
];

describe('agreement metrics', () => {
    it('computes Cohen\'s kappa from observed and chance agreement', () => {
        // observed 0.9
        // chance = .4*.4 + .2*.3 + .3*.2 + .1*.1 = 0.29
        // kappa = (0.9 - 0.29) / 0.71
        expect(cohenKappa(PAIRS)).toBeCloseTo(0.61 / 0.71);
    });

    it('is 0 at chance level and null when there is only one label', () => {
        expect(cohenKappa([...repeat('absent', 'neutral', 1), ...repeat('neutral', 'absent', 1)])).toBeCloseTo(-1);
        expect(cohenKappa(repeat('absent', 'absent', 5))).toBeNull();
        expect(cohenKappa([])).toBeNull();
    });

    it('builds the confusion matrix as human x model', () => {
        const m = confusionMatrix(PAIRS);
        expect(m.favorable).toEqual({ absent: 0, neutral: 1, favorable: 2, unfavorable: 0 });
        expect(m.absent.absent).toBe(4);
    });

    it('computes precision and recall per stance', () => {
        const c = perClass(PAIRS);
        expect(c.favorable).toMatchObject({ support: 3, predicted: 2, precision: 1, recall: 0.667 });
        expect(c.neutral).toMatchObject({ support: 2, predicted: 3, precision: 0.667, recall: 1 });
    });
});

describe('scoreEvaluation', () => {
    const row = (id, human, prediction, extra = {}) => ({ id, human_stance: human, human_is_stale: false, has_fact_sheet: true, prediction, ...extra });
    const rows = [
        row('1', 'absent', { stance: 'absent', isStale: false, model: 'rule' }),
        row('2', 'absent', { stance: 'absent', isStale: false, model: 'rule' }),
        row('3', 'favorable', { stance: 'favorable', isStale: true, model: 'm' }, { human_is_stale: true }),
        row('4', 'neutral', { stance: 'favorable', isStale: true, model: 'm' }),
        row('5', 'unfavorable', { rejected: 'quote not on page' }),
        row('6', '', { stance: 'neutral', isStale: false, model: 'm' }),          // not labelled yet
        row('7', 'neutral', { stance: 'neutral', isStale: false, model: 'm' }, { has_fact_sheet: false })
    ];
    const r = scoreEvaluation(rows);

    it('separates the rule\'s free "absent" calls from the llm\'s decisions', () => {
        expect(r).toMatchObject({ cases: 7, labelled: 6, unlabelled: 1, evidence_rejected: 1, no_prediction: 0 });
        expect(r.stance).toMatchObject({ n: 5, accuracy: 0.8 });
        expect(r.stance_llm_only).toMatchObject({ n: 3, accuracy: 0.667 });
        expect(r.rule_absent).toEqual({ n: 2, human_agrees: 2 });
    });

    it('scores staleness only where there was a fact sheet', () => {
        expect(r.stale).toMatchObject({ n: 4, tp: 1, fp: 1, fn: 0, tn: 2, precision: 0.5, recall: 1 });
    });

    it('renders the README section, or says labels are missing', () => {
        const md = renderMarkdown(r, { generatedAt: '2026-10-22', model: 'm' });
        expect(md).toContain('| **LLM-decided only** (rule\'s "absent" calls removed) | 3 | **67%** |');
        expect(md).toContain('1 had no verdict because the quote check rejected');
        expect(md).toContain('precision 50%, recall 100% (1 caught, 1 false alarms, 0 missed)');
        expect(renderMarkdown(scoreEvaluation([row('1', '', undefined)]))).toMatch(/^_No labelled cases yet/);
    });
});

describe('csv', () => {
    it('round-trips quotes, commas and newlines', () => {
        const rows = [{ id: 'p01:peec', notes: 'says "best", cheap\nsecond line' }, { id: 'p02:x', notes: '' }];
        expect(parseCsv(toCsv(['id', 'notes'], rows))).toEqual(rows);
    });

    it('reads spreadsheet exports (BOM, CRLF, blank trailing lines)', () => {
        expect(parseCsv('﻿id,human_stance\r\np01:peec,favorable\r\n\r\n')).toEqual([{ id: 'p01:peec', human_stance: 'favorable' }]);
    });
});
