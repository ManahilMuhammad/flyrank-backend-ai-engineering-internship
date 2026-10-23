import { describe, it, expect, afterEach, vi } from 'vitest';

process.env.GROQ_API_KEY ||= 'gsk_test_key'; // generateBrowsed refuses without a key - fetch stubbed below
const { parseBrowseResponse, generateBrowsed } = await import('../src/lib/groq.js');

// shaped like real groq/openai gpt-oss browser_search response (trimmed)
// page of n numbered lines
// 'at' puts real text on given line numbers, rest is filler
const lines = (url, title, n, at = {}) => [`L0: `, `L1: URL: ${url}`, `L2: ${title}`,
    ...Array.from({ length: n - 3 }, (_, i) => `L${i + 3}: ${at[i + 3] ?? 'filler navigation footer'}`)].join('\n');
const LETTERTRACE = { 5: 'Lettertrace is free, open source and self-hosted.', 21: 'Self-hosted Lettertrace keeps data private and free.' };
const ENCITED = { 6: 'Encited tracks five engines including ChatGPT and Gemini.' };
const SIMULAR = { 8: 'Simular runs the real interfaces of each assistant weekly.' };
const ORCHLY = { 40: 'Orchly builds a prompt library from your topics automatically.' };
const message = {
    content: 'Intro line without a citation.\n' +
        'Lettertrace is free and self-hosted【1†L4-L12】【1†L20-L22】. Encited tracks five engines【2†L5-L9】\n' +
        'Simular runs real interfaces weekly【3†L6-L13】 and this claim cites a line that does not exist【2†L400-L410】.',
    executed_tools: [
        { index: 0, type: 'browser_search', arguments: '{"query": "monitor brand mentions in chatgpt", "topn": 10}', output: 'L0: \nL1: URL: https://exa.ai/search?q=x\nL2: # Search Results' },
        { index: 1, type: 'browser.open', arguments: '{"cursor": 0, "id": 5}', output: lines('https://lettertrace.com/', 'Lettertrace: Monitor how AI talks about your brand', 194, LETTERTRACE) },
        { index: 2, type: 'browser.open', arguments: '{"cursor": 0, "id": 8}', output: lines('https://encited.com/ai-visibility-tracker', 'AI Search analytics \\| Encited', 229, ENCITED) },
        { index: 3, type: 'browser_search', arguments: '{"query": "gemini brand monitoring"}', output: 'L0: \nL1: URL: https://exa.ai/search?q=y' },
        { index: 4, type: 'function', arguments: '{}', output: 'python output' }, // steps that arent pages are ignored
        { index: 5, type: 'browser.open', arguments: '{"cursor": 3, "id": 5}', output: lines('https://www.simular.ai/solutions/ai-brand-monitoring', 'Simular', 124, SIMULAR) },
        { index: 6, type: 'browser.open', arguments: '{"cursor": 0, "id": 1}', output: lines('https://orchly.ai/tracker/', 'Orchly', 293, ORCHLY) } // opened, never cited
    ]
};

describe('parseBrowseResponse', () => {
    const parsed = parseBrowseResponse(message);

    it('assigns each citation to the opened page whose cited lines back the claim', () => {
        expect(parsed.chunks).toEqual([
            { uri: 'https://lettertrace.com/', title: 'Lettertrace: Monitor how AI talks about your brand' },
            { uri: 'https://encited.com/ai-visibility-tracker', title: 'AI Search analytics | Encited' },
            { uri: 'https://www.simular.ai/solutions/ai-brand-monitoring', title: 'Simular' }
        ]); // orchly opened but never cited, so not source of answer
    });

    it('weights each citation by the text it backs', () => {
        expect(parsed.supports).toEqual([
            { chunkIndices: [0], length: 'Lettertrace is free and self-hosted'.length },
            { chunkIndices: [1], length: '. Encited tracks five engines'.length },
            { chunkIndices: [2], length: 'Simular runs real interfaces weekly'.length }
            // last run only cited line range encited doesnt have: dropped
        ]);
        expect(parsed.invalidCitations).toBe(1);
    });

    it('follows the cited text when the marker number points at the wrong page', () => {
        // real answers drift: here 【1】 means orchly (only orchly has these words at line 40)
        const p = parseBrowseResponse({ ...message, content: 'Orchly builds a prompt library from topics【1†L40-L40】.' });
        expect(p.chunks).toEqual([{ uri: 'https://orchly.ai/tracker/', title: 'Orchly' }]);
        expect(p.invalidCitations).toBe(0);
    });

    it('drops a citation whose lines exist but say something else', () => {
        const p = parseBrowseResponse({ ...message, content: 'Pricing starts at ninety dollars monthly【2†L30-L32】.' });
        expect(p.invalidCitations).toBe(1);
        expect(p.chunks).toHaveLength(4); // no valid citation left: every opened page counts equally
    });

    it('strips the markers from the stored answer and keeps the searches', () => {
        expect(parsed.text).not.toMatch(/【/);
        expect(parsed.text).toContain('Lettertrace is free and self-hosted. Encited tracks five engines');
        expect(parsed.searchQueries).toEqual(['monitor brand mentions in chatgpt', 'gemini brand monitoring']);
    });

    it('treats every opened page as a source when the answer has no citations', () => {
        const p = parseBrowseResponse({ ...message, content: 'No markers at all.' });
        expect(p.chunks).toHaveLength(4);
        expect(p.supports).toEqual([]); // harvester gives each an equal share
    });

    it('handles an answer that never browsed', () => {
        expect(parseBrowseResponse({ content: 'From memory.' })).toMatchObject({ chunks: [], supports: [], searchQueries: [] });
    });
});

describe('generateBrowsed errors', () => {
    afterEach(() => vi.unstubAllGlobals());
    const respond = (status, body, headers = {}) =>
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers })));

    it('marks a used-up daily quota with when it frees up', async () => {
        respond(429, { error: { message: 'Rate limit reached ... on tokens per day (TPD): Limit 200000, Used 199983. Please try again in 38m24.288s.' } });
        const err = await generateBrowsed('q').catch(e => e);
        expect(err).toMatchObject({ status: 429, daily: true, retryAfterSeconds: 38 * 60 + 25 });
    });

    it('prefers the retry-after header', async () => {
        respond(429, { error: { message: 'tokens per minute' } }, { 'retry-after': '12' });
        expect(await generateBrowsed('q').catch(e => e)).toMatchObject({ status: 429, daily: false, retryAfterSeconds: 12 });
    });

    it('turns a rejected key or model into a clean 502', async () => {
        respond(404, { error: { message: 'model not found' } });
        expect(await generateBrowsed('q').catch(e => e)).toMatchObject({
            status: 502, message: 'LLM request was rejected (check GROQ_API_KEY and GROQ_MODEL)'
        });
    });

    it('returns the parsed answer with the model and token count', async () => {
        respond(200, { choices: [{ message }], usage: { total_tokens: 38696 } });
        const answer = await generateBrowsed('q');
        expect(answer).toMatchObject({ model: 'openai/gpt-oss-120b', tokens: 38696 });
        expect(answer.chunks).toHaveLength(3);
    });
});
