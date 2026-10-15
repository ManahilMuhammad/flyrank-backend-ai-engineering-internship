// lowercase, strip punctuation, collapse whitespace
export function normalize(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

// whole word match on normalised text
export function mentionsAny(text, terms) {
    const padded = ` ${normalize(text)} `;
    return terms.map(normalize).filter(Boolean).some(term => padded.includes(` ${term} `));
}
