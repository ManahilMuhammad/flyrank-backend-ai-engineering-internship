// the audit's quote must come from the page, word for word
// llms re-type quotes, so spacing, curly vs straight quotes and dash styles may differ; nothing else may

const MIN_QUOTE_CHARS = 12; // shorter than this proves nothing

const EQUIVALENT = {
    '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
    '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '−': '-'
};

// normalised copy of text plus index each character came from
function normalizeWithMap(text) {
    let out = '';
    const map = [];
    let lastWasSpace = true; // drops leading whitespace
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            if (lastWasSpace) continue;
            out += ' ';
            lastWasSpace = true;
        } else {
            out += EQUIVALENT[ch] ?? ch;
            lastWasSpace = false;
        }
        map.push(i);
    }
    return { out, map };
}

// exact span of page reproduced by quote 
// null if page doesnt contain it
export function findVerbatim(page, quote) {
    if (typeof quote !== 'string') return null;
    const needle = normalizeWithMap(quote).out.trim();
    if (needle.length < MIN_QUOTE_CHARS) return null;

    const { out, map } = normalizeWithMap(page);
    const start = out.indexOf(needle);
    if (start === -1) return null;
    return page.slice(map[start], map[start + needle.length - 1] + 1);
}
