import { env } from '../config.js';
import { httpError } from './errors.js';

// second answer engine: open-weight model on groq with built in browser search
// used because gemini's search grounding has no free quota on this project

const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 180_000; // browsing answer opens many pages before replying

// browsing only triggered reliably when asked for (a "search mode" assistant, like chatgpt search)
const SYSTEM_PROMPT = 'Search the web before answering and cite the pages you used.';

export function assertGroqConfigured() {
    if (!env.groqApiKey) throw httpError(503, 'Groq engine is not configured (missing GROQ_API_KEY)');
}

// 【3†L6-L13】 = lines 6-13 of 3rd page model opened (search result lists not counted)
const MARKER = /【(\d+)†L(\d+)(?:-L(\d+))?】/g;
const MARKER_RUN = /(?:【\d+†[^】]*】)+/g;

// turn groq browser_search response into shape harvester expects from any engine:
// { text, chunks: [{ uri, title }], supports: [{ chunkIndices, length }], searchQueries }
// chunks = pages model opened
// supports = text before each run of citation markers
export function parseBrowseResponse(message) {
    const tools = message.executed_tools ?? [];
    const searchQueries = [];
    const pages = [];
    for (const t of tools) {
        if (t.type === 'browser_search') {
            try {
                searchQueries.push(JSON.parse(t.arguments).query);
            } catch { /* arguments are model's own json - ignore if malformed */ }
            continue;
        }
        if (t.type !== 'browser.open') continue;
        const uri = /^L1: URL: (.*)$/m.exec(t.output ?? '')?.[1]?.trim() ?? t.search_results?.results?.[0]?.url;
        if (!uri) continue;
        const title = /^L2: (.*)$/m.exec(t.output)?.[1]?.replace(/\\\|/g, '|').trim() || null;
        pages.push({ uri, title, lineCount: (t.output ?? '').split('\n').length });
    }

    const content = message.content ?? '';
    const supports = [];
    let invalid = 0;
    let segmentStart = 0;
    for (const run of content.matchAll(MARKER_RUN)) {
        // claim a run of markers backs: from previous run (or line start) up to markers
        const lineStart = content.lastIndexOf('\n', run.index) + 1;
        const from = Math.max(segmentStart, lineStart);
        const length = content.slice(from, run.index).trim().length;
        segmentStart = run.index + run[0].length;

        const chunkIndices = [];
        for (const [, cursor, , to] of run[0].matchAll(MARKER)) {
            const page = pages[Number(cursor) - 1];
            const lastLine = Number(to ?? 0);
            // model's cursor ids not always right: only trust citation whose lines exist on page
            if (!page || lastLine >= page.lineCount) {
                invalid++;
                continue;
            }
            if (!chunkIndices.includes(Number(cursor) - 1)) chunkIndices.push(Number(cursor) - 1);
        }
        if (chunkIndices.length && length > 0) supports.push({ chunkIndices, length });
    }

    // keep only cited pages when there are citations 
    // otherwise every opened page counts equally
    const cited = new Set(supports.flatMap(s => s.chunkIndices));
    const keep = cited.size ? pages.map((_, i) => cited.has(i)) : pages.map(() => true);
    const newIndex = [];
    const chunks = [];
    pages.forEach((p, i) => {
        if (!keep[i]) return;
        newIndex[i] = chunks.length;
        chunks.push({ uri: p.uri, title: p.title });
    });

    return {
        text: content.replace(MARKER_RUN, '').replace(/[ \t]+\n/g, '\n').trim(),
        chunks,
        supports: supports.map(s => ({ chunkIndices: s.chunkIndices.map(i => newIndex[i]), length: s.length })),
        searchQueries,
        invalidCitations: invalid
    };
}

// seconds until daily quota frees up from message or header
function retryAfterSeconds(res, message) {
    const header = Number(res.headers.get('retry-after'));
    if (header > 0) return header;
    const m = /try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/.exec(message ?? '');
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Math.ceil(Number(m[3])) : null;
}

// ask like a user would with browsing on 
// same return shape as gemini's generateGrounded
export async function generateBrowsed(prompt) {
    assertGroqConfigured();
    let res;
    try {
        res = await fetch(API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.groqApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: env.groqModel,
                messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
                tools: [{ type: 'browser_search' }],
                reasoning_effort: 'medium',
                max_completion_tokens: 8192
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (err) {
        console.error('Groq request failed: ', err.name === 'TimeoutError' ? 'timeout' : err.message);
        throw httpError(502, 'LLM request failed');
    }

    const body = await res.json().catch(() => ({}));
    if (res.status === 429) {
        const message = body.error?.message ?? '';
        const err = httpError(429, 'LLM rate limit reached, try again later');
        err.retryAfterSeconds = retryAfterSeconds(res, message);
        err.daily = /per day/i.test(message); // daily quota: worth pausing run rather than retrying soon
        throw err;
    }
    if (!res.ok) {
        console.error(`Groq returned ${res.status}: `, body.error?.message);
        throw httpError(502, res.status === 401 || res.status === 404
            ? 'LLM request was rejected (check GROQ_API_KEY and GROQ_MODEL)'
            : 'LLM request failed');
    }

    const message = body.choices?.[0]?.message;
    if (!message) throw httpError(502, 'LLM returned malformed output');
    return {
        ...parseBrowseResponse(message),
        model: env.groqModel,
        tokens: body.usage?.total_tokens ?? null,
        raw: { content: message.content, executed_tools: message.executed_tools ?? [] }
    };
}
