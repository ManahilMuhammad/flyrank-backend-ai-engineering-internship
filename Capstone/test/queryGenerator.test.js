import { describe, it, expect } from 'vitest';
import { cleanGroups } from '../src/services/queryGenerator.js';
import { normalize, mentionsAny } from '../src/lib/text.js';

// pure functions only: no database, no LLM

describe('normalize', () => {
    it('ignores case, punctuation and extra whitespace', () => {
        expect(normalize('  Best GEO tools?!  ')).toBe('best geo tools');
        expect(normalize('best   geo\ttools')).toBe('best geo tools');
    });
});

describe('mentionsAny', () => {
    const terms = ['FlyRank', 'FlyRank AI', 'flyrank.ai'];

    it('matches the brand name and aliases regardless of case/punctuation', () => {
        expect(mentionsAny('is flyrank worth it', terms)).toBe(true);
        expect(mentionsAny('FlyRank AI vs the rest?', terms)).toBe(true);
        expect(mentionsAny('reviews of flyrank.ai', terms)).toBe(true);
    });

    it('matches whole words only', () => {
        expect(mentionsAny('rank tracking tools', ['rank'])).toBe(true);
        expect(mentionsAny('best ranking tools', ['rank'])).toBe(false);
    });

    it('ignores empty terms', () => {
        expect(mentionsAny('anything', ['', '  '])).toBe(false);
    });
});

describe('cleanGroups', () => {
    const groups = [
        { intent: 'recommendation', queries: ['best GEO tool for agencies', 'what geo tool should my agency use', 'Best GEO tool for agencies?'] },
        { intent: 'alternatives', queries: ['cheaper alternative to FlyRank', 'tools like flyrank but cheaper', 'affordable ai visibility platforms'] },
        { intent: 'pricing', queries: ['hi', 'how much do ai search tools cost', 'ai visibility software pricing for small teams'] }
    ];
    const brandTerms = ['FlyRank'];

    it('drops near-duplicates, brand mentions and fragments, with reasons', () => {
        const { queries, dropped } = cleanGroups(groups, { count: 100, brandTerms });
        expect(queries.map(q => q.text)).toEqual([
            'best GEO tool for agencies',
            'what geo tool should my agency use',
            'affordable ai visibility platforms',
            'how much do ai search tools cost',
            'ai visibility software pricing for small teams'
        ]);
        expect(dropped).toEqual([
            { text: 'Best GEO tool for agencies?', reason: 'duplicate' },
            { text: 'cheaper alternative to FlyRank', reason: 'mentions_brand' },
            { text: 'tools like flyrank but cheaper', reason: 'mentions_brand' },
            { text: 'hi', reason: 'too_short' }
        ]);
    });

    it('promotes the first surviving query in a group to seed', () => {
        const { queries } = cleanGroups(groups, { count: 100, brandTerms });
        const alternatives = queries.filter(q => q.intent === 'alternatives');
        expect(alternatives).toEqual([
            { text: 'affordable ai visibility platforms', intent: 'alternatives', group: 1, is_seed: true }
        ]);
        expect(queries.filter(q => q.is_seed)).toHaveLength(3); // one per group
    });

    it('stops at the requested count', () => {
        const { queries } = cleanGroups(groups, { count: 3, brandTerms });
        expect(queries).toHaveLength(3);
    });

    it('skips queries that already exist in the category', () => {
        const { queries, dropped } = cleanGroups(groups, {
            count: 100,
            brandTerms,
            existingTexts: ['How much do AI search tools cost?']
        });
        expect(queries.map(q => q.text)).not.toContain('how much do ai search tools cost');
        expect(dropped).toContainEqual({ text: 'how much do ai search tools cost', reason: 'duplicate' });
    });
});
