import { GoogleGenAI } from '@google/genai';
import { env } from '../config.js';
import { httpError } from './errors.js';

let client = null;

// created on first use so server can start without gemini key
function getClient() {
    if (!env.geminiApiKey) {
        throw httpError(503, 'LLM is not configured (missing GEMINI_API_KEY)');
    }
    if (!client) client = new GoogleGenAI({ apiKey: env.geminiApiKey });
    return client;
}

// rate limits (429) and overloads (500/503) on free tier
const RETRYABLE = new Set([429, 500, 503]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry(fn, { attempts = 4, baseDelayMs = 2000 } = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!RETRYABLE.has(err.status) || attempt >= attempts) throw toHttpError(err);
            const delay = baseDelayMs * 2 ** (attempt - 1); // 2s, 4s, 8s
            console.warn(`Gemini ${err.status}, retrying in ${delay / 1000}s (attempt ${attempt}/${attempts})`);
            await sleep(delay);
        }
    }
}

// turn SDK errors into responses client can act on without leaking raw API error
function toHttpError(err) {
    if (err.expose) return err;
    if (err.status === 429) return httpError(429, 'LLM rate limit reached, try again in a minute');
    // 404 = unknown or retired model name
    if (err.status === 400 || err.status === 401 || err.status === 403 || err.status === 404) {
        console.error('Gemini rejected the request: ', err.message);
        return httpError(502, 'LLM request was rejected (check GEMINI_API_KEY and GEMINI_MODEL)');
    }
    console.error('Gemini request failed: ', err.message);
    return httpError(502, 'LLM request failed');
}

// lets callers refuse up front 
// instead of failing later in background job
export function assertConfigured() {
    getClient();
}

// ask question like a user would with google search grounding on
// returns { text, chunks: [{ uri, title }], supports: [{ chunkIndices, length }], searchQueries, model }
// chunk uris are vertexaisearch redirect links not real page urls
export async function generateGrounded(prompt) {
    const response = await withRetry(() => getClient().models.generateContent({
        model: env.geminiModel,
        contents: prompt,
        config: { tools: [{ googleSearch: {} }] }
    }));

    const metadata = response.candidates?.[0]?.groundingMetadata ?? {};
    return {
        text: response.text ?? '',
        chunks: (metadata.groundingChunks ?? [])
            .map(chunk => ({ uri: chunk.web?.uri, title: chunk.web?.title ?? null })),
        supports: (metadata.groundingSupports ?? []).map(support => ({
            chunkIndices: support.groundingChunkIndices ?? [],
            // indices are utf-8 byte offsets so prefer segment text when present
            length: support.segment?.text?.length
                ?? Math.max(0, (support.segment?.endIndex ?? 0) - (support.segment?.startIndex ?? 0))
        })),
        searchQueries: metadata.webSearchQueries ?? [],
        model: env.geminiModel
    };
}

// ask for json matching json schema
// returns { data, model }
export async function generateJson({ prompt, systemInstruction, schema, temperature = 0.7 }) {
    const response = await withRetry(() => getClient().models.generateContent({
        model: env.geminiModel,
        contents: prompt,
        config: {
            systemInstruction,
            temperature,
            responseMimeType: 'application/json',
            responseJsonSchema: schema
        }
    }));

    try {
        return { data: JSON.parse(response.text), model: env.geminiModel };
    } catch {
        console.error('Gemini returned invalid JSON: ', response.text?.slice(0, 500));
        throw httpError(502, 'LLM returned malformed output');
    }
}
