import crypto from 'crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

const MAX_TEXT_CHARS = 200_000;
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd, figcaption';

// one line per paragraph-like block 
// whitespace collapsed inside each
function blockText(root) {
    const blocks = [...root.querySelectorAll(BLOCKS)]
        .filter(el => !el.querySelector(BLOCKS)) // innermost blocks only so nothing repeated
        .map(el => el.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    return blocks.length ? blocks.join('\n') : root.textContent.replace(/\s+/g, ' ').trim();
}

// main content of page as plain text without navigation, ads, footers
// returns { title, text } (text empty if nothing readable)
export function extractText(body, { url, contentType = 'text/html' } = {}) {
    if (contentType === 'text/plain') {
        return { title: null, text: normalizeText(body) };
    }

    // silent console: pages full of css jsdom cant parse
    const dom = new JSDOM(body, { url, virtualConsole: new VirtualConsole() });
    const doc = dom.window.document;
    const pageTitle = doc.title?.trim() || null;

    const article = new Readability(doc.cloneNode(true)).parse();
    let text = '';
    if (article?.content) {
        const fragment = new JSDOM(`<body>${article.content}</body>`, { virtualConsole: new VirtualConsole() });
        text = blockText(fragment.window.document.body);
    }
    // fall back to whole body
    if (text.length < 200 && doc.body) {
        doc.querySelectorAll('script, style, noscript, nav, header, footer, aside, form').forEach(el => el.remove());
        const fallback = blockText(doc.body);
        if (fallback.length > text.length) text = fallback;
    }
    dom.window.close();

    return { title: article?.title?.trim() || pageTitle, text: normalizeText(text) };
}

function normalizeText(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/[ \t ]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, MAX_TEXT_CHARS);
}

// hash of extracted text so markup churn != change
export function contentHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}
