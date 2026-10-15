import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, domainOf, sourceTypeFor } from '../src/lib/urls.js';
import { supportShares, buildCitations } from '../src/services/harvester.js';

// pure functions only

describe('canonicalizeUrl', () => {
    it('drops tracking params, fragments and trailing slashes', () => {
        expect(canonicalizeUrl('https://WWW.G2.com/products/flyrank/reviews/?utm_source=x&srsltid=abc#:~:text=price'))
            .toBe('https://www.g2.com/products/flyrank/reviews');
    });

    it('keeps meaningful params, in a stable order', () => {
        expect(canonicalizeUrl('https://example.com/search?q=geo&page=2&utm_medium=y'))
            .toBe('https://example.com/search?page=2&q=geo');
    });

    it('keeps the root path', () => {
        expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/');
    });

    it('rejects anything that is not http(s)', () => {
        expect(canonicalizeUrl('not a url')).toBeNull();
        expect(canonicalizeUrl('mailto:hi@example.com')).toBeNull();
        expect(canonicalizeUrl(null)).toBeNull();
    });
});

describe('domainOf and sourceTypeFor', () => {
    it('strips www', () => {
        expect(domainOf('https://www.reddit.com/r/SEO')).toBe('reddit.com');
    });

    it('classifies known platforms, including subdomains, and nothing else', () => {
        expect(sourceTypeFor('reddit.com')).toBe('forum');
        expect(sourceTypeFor('old.reddit.com')).toBe('forum');
        expect(sourceTypeFor('g2.com')).toBe('review_platform');
        expect(sourceTypeFor('youtube.com')).toBe('video');
        expect(sourceTypeFor('notreddit.com')).toBeNull();
        expect(sourceTypeFor('searchengineland.com')).toBeNull();
    });
});

describe('supportShares', () => {
    it('weights chunks by the answer text they support and sums to 1', () => {
        const shares = supportShares(3, [
            { chunkIndices: [0], length: 60 },
            { chunkIndices: [0, 1], length: 40 } // split 20/20
        ]);
        expect(shares).toEqual([0.8, 0.2, 0]);
    });

    it('ignores out of range indices', () => {
        expect(supportShares(1, [{ chunkIndices: [0, 5], length: 10 }])).toEqual([1]);
    });

    it('falls back to equal shares when there are no supports', () => {
        expect(supportShares(4, [])).toEqual([0.25, 0.25, 0.25, 0.25]);
        expect(supportShares(0, [])).toEqual([]);
    });
});

describe('buildCitations', () => {
    const resolved = new Map([
        ['r1', 'https://www.g2.com/products/flyrank?utm_source=gemini'],
        ['r2', 'https://www.g2.com/products/flyrank/'],
        ['r3', 'https://www.reddit.com/r/SEO/comments/abc'],
        ['r4', null]
    ]);

    it('merges chunks that resolve to the same page and drops unresolved ones', () => {
        const chunks = [
            { uri: 'r1', title: 'g2.com' },
            { uri: 'r2', title: 'FlyRank Reviews 2026' },
            { uri: 'r3', title: 'reddit.com' },
            { uri: 'r4', title: 'lost.example' }
        ];
        const supports = [
            { chunkIndices: [0], length: 30 },
            { chunkIndices: [1], length: 20 },
            { chunkIndices: [2], length: 40 },
            { chunkIndices: [3], length: 10 }
        ];

        const { citations, unresolved } = buildCitations(chunks, supports, resolved);
        expect(unresolved).toBe(1);
        expect(citations).toHaveLength(2);
        expect(citations[0]).toMatchObject({
            url: 'https://www.g2.com/products/flyrank',
            domain: 'g2.com',
            sourceType: 'review_platform',
            title: null, // first chunk's title was just domain
            chunkIndex: 0
        });
        expect(citations[0].weight).toBeCloseTo(0.5);
        expect(citations[1]).toMatchObject({ domain: 'reddit.com', sourceType: 'forum' });
        expect(citations[1].weight).toBeCloseTo(0.4);
    });
});
