// build classifier evaluation set: fetch and freeze each page's text, audit every (page, brand) pair
// with real classifier, write blind labelling sheet
// safe to re-run: pages already saved not re-fetched, cases already predicted not re-asked,
// and labels already filled in never touched
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../src/config.js';
import { fetchPage } from '../src/lib/fetchPage.js';
import { extractText, contentHash } from '../src/lib/extract.js';
import { auditPage, PROMPT_VERSION } from '../src/services/standingAuditor.js';
import { toCsv, parseCsv } from '../src/lib/csv.js';

const EVAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../eval');
const file = name => path.join(EVAL_DIR, name);
const readJson = (name, fallback) => (fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : fallback);
const writeJson = (name, data) => fs.writeFileSync(file(name), JSON.stringify(data, null, 2) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const LABEL_COLUMNS = ['id', 'brand', 'url', 'page_file', 'human_stance', 'human_is_stale', 'notes'];

const cases = readJson('cases.json');
const pages = readJson('pages.json', {}); // url -> { key, file, hash, title, status, fetched_at }
const predictions = readJson('predictions.json', { cases: {} });
fs.mkdirSync(file('pages'), { recursive: true });

// 1. pages: fetched once, then frozen
const robotsCache = new Map();
for (const page of cases.pages) {
    const known = pages[page.url];
    if (known?.status === 'ok' && fs.existsSync(file(known.file))) continue;
    const res = await fetchPage(page.url, { robotsCache });
    if (res.status !== 'ok') {
        pages[page.url] = { key: page.key, status: res.status, error: res.error ?? null, fetched_at: new Date().toISOString() };
        console.log(`${page.key} ${page.url}: ${res.status} ${res.error ?? ''}`);
        continue;
    }
    const { title, text } = extractText(res.body, { url: res.finalUrl, contentType: res.contentType });
    const pageFile = `pages/${page.key}.txt`;
    fs.writeFileSync(file(pageFile), text + '\n');
    pages[page.url] = { key: page.key, file: pageFile, hash: contentHash(text), title, chars: text.length, status: 'ok', fetched_at: new Date().toISOString() };
    console.log(`${page.key} saved (${text.length} chars): ${title}`);
}
writeJson('pages.json', pages);

// 2. predictions: every page x brand paced like pipeline
predictions.prompt_version = PROMPT_VERSION;
predictions.model = env.geminiModel;
let lastCall = 0;
for (const page of cases.pages) {
    const info = pages[page.url];
    if (info?.status !== 'ok') continue;
    const text = fs.readFileSync(file(info.file), 'utf8').trimEnd();
    for (const [brandKey, brand] of Object.entries(cases.brands)) {
        const id = `${page.key}:${brandKey}`;
        const existing = predictions.cases[id];
        if (existing && !existing.error && existing.page_hash === info.hash) continue;

        await sleep(Math.max(0, lastCall + env.harvestMinIntervalMs - Date.now()));
        try {
            const verdict = await auditPage({ brand, url: page.url, title: info.title, text });
            if (verdict.model !== 'rule') lastCall = Date.now();
            predictions.cases[id] = { ...verdict, page_hash: info.hash, predicted_at: new Date().toISOString() };
            console.log(`${id}: ${verdict.rejected ? `rejected (${verdict.rejected})` : `${verdict.stance}${verdict.isStale ? ' + stale' : ''} [${verdict.model}]`}`);
        } catch (err) {
            lastCall = Date.now();
            if (!err.expose) throw err;
            predictions.cases[id] = { error: err.message, page_hash: info.hash };
            console.log(`${id}: failed (${err.message}); re-run later to retry`);
        }
        writeJson('predictions.json', predictions); // after every case so interruption loses nothing
    }
}

// 3. labelling sheet: blind (no model verdicts), existing labels kept
const labelRows = fs.existsSync(file('labels.csv')) ? parseCsv(fs.readFileSync(file('labels.csv'), 'utf8')) : [];
const have = new Set(labelRows.map(r => r.id));
for (const page of cases.pages) {
    const info = pages[page.url];
    if (info?.status !== 'ok') continue;
    for (const [brandKey, brand] of Object.entries(cases.brands)) {
        const id = `${page.key}:${brandKey}`;
        if (!have.has(id)) labelRows.push({ id, brand: brand.name, url: page.url, page_file: info.file, human_stance: '', human_is_stale: '', notes: '' });
    }
}
fs.writeFileSync(file('labels.csv'), toCsv(LABEL_COLUMNS, labelRows));

const done = Object.values(predictions.cases).filter(p => !p.error).length;
const failed = Object.values(predictions.cases).filter(p => p.error).length;
console.log(`\n${labelRows.length} cases in eval/labels.csv, ${done} predicted${failed ? `, ${failed} failed (re-run to retry)` : ''}`);
