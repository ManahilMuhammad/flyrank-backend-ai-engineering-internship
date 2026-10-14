import { z } from 'zod';
import { generateJson } from '../lib/gemini.js';
import { httpError } from '../lib/errors.js';

export const PROMPT_VERSION = 'querygen-v1';

export const INTENTS = [
    'recommendation', // best x for y
    'comparison',     // x vs y, which is better
    'alternatives',   // cheaper alternative to xyz
    'pricing',        // how much does x cost, is it worth it
    'use_case',       // x for shopify store with 500 products
    'evaluation',     // is x legit, does x actually work
    'how_to'          // how do i get my brand cited by chatgpt
];

// each group is a need asked several ways 
// first query is the seed, the rest paraphrase
const VARIANTS_PER_GROUP = 3;

// json schema sent to gemini so can only answer in this shape
const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        groups: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    intent: { type: 'string', enum: INTENTS },
                    queries: {
                        type: 'array',
                        items: { type: 'string' },
                        minItems: VARIANTS_PER_GROUP,
                        maxItems: VARIANTS_PER_GROUP
                    }
                },
                required: ['intent', 'queries']
            }
        }
    },
    required: ['groups']
};

// output validated again
const responseValidator = z.object({
    groups: z.array(z.object({
        intent: z.enum(INTENTS),
        queries: z.array(z.string()).min(1)
    }))
});

const SYSTEM_INSTRUCTION = `You simulate real people typing questions into an AI assistant such as ChatGPT, Gemini or Perplexity.
You write the questions they would actually ask, not SEO keywords.`;

function buildPrompt({ category, groupCount }) {
    return `Product category: "${category.name}"
${category.description ? `What the category covers: ${category.description}\n` : ''}
Write ${groupCount} groups of questions that potential buyers in this category would ask an AI assistant.

Each group is ONE underlying need, phrased ${VARIANTS_PER_GROUP} different ways:
- the first phrasing is the most common way to ask it
- the others differ in wording, specificity or persona (e.g. adding a budget, team size, platform or constraint),
  the way different people would really type the same need

Across all groups:
- cover every intent: ${INTENTS.join(', ')}; weight towards recommendation, comparison and alternatives, because those are the answers that cite third-party sources
- vary the asker: founders, in-house marketers, agency owners, e-commerce managers, SEO specialists
- vary the length: some short and blunt, some long with context
- write natural conversational English, the way people type into a chat box (lowercase and no question mark are fine)

Hard rules:
- do NOT name any specific company, product or brand in any question; ask about the category, not a vendor
- no two questions may be near-duplicates of each other`;
}

// lowercase, strip punctuation, collapse whitespace
export function normalize(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

// whole word match on normalised text
export function mentionsAny(text, terms) {
    const padded = ` ${normalize(text)} `;
    return terms.map(normalize).filter(Boolean).some(term => padded.includes(` ${term} `));
}

// turn raw llm groups into clean list
export function cleanGroups(groups, { count, brandTerms, existingTexts = [] }) {
    const seen = new Set(existingTexts.map(normalize));
    const queries = [];
    const dropped = [];

    for (const [groupIndex, group] of groups.entries()) {
        if (queries.length >= count) break;

        const kept = [];
        for (const raw of group.queries) {
            const text = raw.trim().replace(/\s+/g, ' ');
            const key = normalize(text);

            if (key.length < 8) {
                dropped.push({ text, reason: 'too_short' });
            } else if (mentionsAny(text, brandTerms)) {
                dropped.push({ text, reason: 'mentions_brand' });
            } else if (seen.has(key)) {
                dropped.push({ text, reason: 'duplicate' });
            } else {
                seen.add(key);
                kept.push(text);
            }
        }

        // first surviving phrasing becomes group's seed, rest point back to it
        kept.slice(0, count - queries.length).forEach((text, i) => {
            queries.push({ text, intent: group.intent, group: groupIndex, is_seed: i === 0 });
        });
    }

    return { queries, dropped };
}

// ask gemini for query set for category and clean it
export async function generateQueries({ category, brand, count, existingTexts }) {
    // ask for more than needed so filtering still leaves enough
    const groupCount = Math.ceil((count * 1.25) / VARIANTS_PER_GROUP);

    const { data, model } = await generateJson({
        prompt: buildPrompt({ category, groupCount }),
        systemInstruction: SYSTEM_INSTRUCTION,
        schema: RESPONSE_SCHEMA,
        temperature: 0.9 // higher temperature = more varied phrasings
    });

    const parsed = responseValidator.safeParse(data);
    if (!parsed.success) {
        console.error('Query generation output failed validation: ', parsed.error.issues.slice(0, 3));
        throw httpError(502, 'LLM output did not match the expected shape');
    }

    const brandTerms = [brand.name, ...brand.aliases];
    const { queries, dropped } = cleanGroups(parsed.data.groups, { count, brandTerms, existingTexts });

    return { model, prompt_version: PROMPT_VERSION, requested: count, queries, dropped };
}
