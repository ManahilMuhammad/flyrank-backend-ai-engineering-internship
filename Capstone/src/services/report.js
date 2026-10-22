import PDFDocument from 'pdfkit';
import { env } from '../config.js';
import * as reports from '../db/reports.js';
import { listActions, listUnaudited } from '../db/leverage.js';
import { listRunShifts } from '../db/shifts.js';
import { getRunBrand } from '../db/standings.js';
import { listOwnerEmails } from '../db/workspaces.js';
import { isOwnedDomain } from '../lib/urls.js';
import { sendMail } from '../lib/mailer.js';

const TOP_ACTIONS = 10;

export const ACTION_LABELS = {
    correct_stale_info: 'ask them to correct outdated facts',
    get_included: 'get included',
    address_criticism: 'respond to the criticism',
    improve_mention: 'strengthen the mention'
};

const pct = x => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);
const day = d => new Date(d).toISOString().slice(0, 10);
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// "up 5 points" / "down 3 points" / "unchanged"
function pointsChange(now, before) {
    if (now == null || before == null) return null;
    const points = Math.round((now - before) * 100);
    if (points === 0) return 'unchanged';
    return `${points > 0 ? 'up' : 'down'} ${Math.abs(points)} point${Math.abs(points) === 1 ? '' : 's'}`;
}

// everything pdf and email show
// gathered once
export async function buildReportData(runId) {
    const ctx = await reports.getReportContext(runId);
    if (!ctx?.stats?.headline) return null; // not audited yet: nothing to report
    const brand = await getRunBrand(runId);
    const [actions, unaudited, shifts] = await Promise.all([
        listActions(runId, TOP_ACTIONS),
        listUnaudited(runId, env.fetchTopN),
        listRunShifts(runId)
    ]);
    return {
        runId,
        brand: ctx.brand_name,
        category: ctx.category_name,
        engine: capitalize(ctx.engine),
        model: ctx.model,
        runDate: day(ctx.created_at),
        queries: ctx.stats.queries,
        samplesPerQuery: ctx.samples_per_query,
        headline: ctx.stats.headline,
        prevHeadline: ctx.prev_headline,
        prevDate: ctx.prev_created_at ? day(ctx.prev_created_at) : null,
        actions,
        unaudited: unaudited.filter(r => !isOwnedDomain(r.domain, brand.domains)),
        shifts,
        recipients: ctx.report_recipients,
        workspaceId: ctx.workspace_id,
        categoryId: ctx.category_id
    };
}

// plain-language summary at top of report and email (no llm: every number is from run)
export function summaryParagraph(d) {
    const h = d.headline;
    const p = d.prevHeadline;
    const sentences = [];

    const mentionChange = pointsChange(h.brand_mention_rate, p?.brand_mention_rate);
    sentences.push(`${d.engine} named ${d.brand} in ${pct(h.brand_mention_rate)} of ${h.answers} answers` +
        (mentionChange ? ` (${mentionChange} since ${d.prevDate})` : '') + '.');
    if (h.owned_citation_rate != null) {
        sentences.push(`${pct(h.owned_citation_rate)} of answers cited ${d.brand}'s own pages.`);
    }
    if (h.top5_concentration != null) {
        sentences.push(`The 5 most influential pages carry ${pct(h.top5_concentration)} of all citation influence.`);
    }
    if (h.audit_coverage != null) {
        let s = `Of the third-party influence we could audit (${pct(h.audit_coverage)} of it), ` +
            `${pct(h.stance_mix.absent)} never mentions ${d.brand}`;
        if (h.stale_share) s += ` and ${pct(h.stale_share)} repeats outdated facts`;
        sentences.push(`${s}.`);
    }
    const top = d.actions[0];
    if (top) sentences.push(`Top fix: ${ACTION_LABELS[top.action]} on ${top.domain}.`);
    sentences.push(d.prevDate
        ? `${d.shifts.length} change${d.shifts.length === 1 ? '' : 's'} since the previous run.`
        : 'This is the first audited run, so there is nothing to compare with yet.');
    return sentences.join(' ');
}

// one line per shift event in words
export function describeShift(e) {
    const where = e.domain ?? '';
    switch (e.type) {
        case 'source_entered':
            return `New source: ${where} is now cited in ${pct(e.payload.citation_rate)} of answers.`;
        case 'source_exited':
            return `Dropped out: ${where} (was cited in ${pct(e.payload.previous_citation_rate)} of answers).`;
        case 'standing_changed': {
            const label = s => `${s.stance}${s.is_stale ? ', with outdated facts' : ''}`;
            return `${where} now describes the brand as ${label(e.payload.to)} (was ${label(e.payload.from)}).`;
        }
        case 'citation_rate_changed':
            if (!e.source_id) {
                const name = { brand_mention_rate: 'Brand mention rate', owned_citation_rate: 'Own-page citation rate' }[e.payload.metric];
                return `${name}: ${pct(e.payload.from)} -> ${pct(e.payload.to)}.`;
            }
            return `${where} cited in ${pct(e.payload.to)} of answers (was ${pct(e.payload.from)}).`;
        default:
            return `${e.type} ${where}`;
    }
}

// pdf standard fonts only cover windows-1252
// anything else would print as garbage
const PDF_SAFE = /[^\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ\n]/g;
export const pdfSafe = text => String(text ?? '').replace(PDF_SAFE, '?');

const GREY = '#555555';

function section(doc, title) {
    doc.moveDown(1).font('Helvetica-Bold').fontSize(13).fillColor('black').text(title).moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
}

// render report 
// compress: false keeps text greppable (tests)
export function renderReportPdf(d, { compress = true } = {}) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 50, compress, info: { Title: `${d.brand} source report ${d.runDate}` } });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        const text = (s, opts) => doc.text(pdfSafe(s), opts);

        doc.font('Helvetica-Bold').fontSize(18);
        text(`${d.brand}: ${d.category}`);
        doc.font('Helvetica').fontSize(10).fillColor(GREY);
        text(`Priors source report, run of ${d.runDate}. ${d.engine} (${d.model}), ${d.queries} queries x ${d.samplesPerQuery} samples.`);
        doc.fillColor('black');

        section(doc, 'Summary');
        text(summaryParagraph(d), { lineGap: 2 });

        const h = d.headline;
        section(doc, 'Key numbers');
        const numbers = [
            ['Brand mention rate', pct(h.brand_mention_rate), d.prevHeadline ? pct(d.prevHeadline.brand_mention_rate) : null],
            ['Answers citing own pages', pct(h.owned_citation_rate), d.prevHeadline ? pct(d.prevHeadline.owned_citation_rate) : null],
            ['Answers with any citation', pct(h.grounded_answer_rate), null],
            ['Distinct pages cited', String(h.sources), null],
            ['Top-5 concentration', pct(h.top5_concentration), null],
            ['Audit coverage', pct(h.audit_coverage), null],
            ['Stance mix (audited influence)', `favorable ${pct(h.stance_mix.favorable)}, neutral ${pct(h.stance_mix.neutral)}, ` +
                `unfavorable ${pct(h.stance_mix.unfavorable)}, absent ${pct(h.stance_mix.absent)}`, null],
            ['Influence on stale pages', pct(h.stale_share), null]
        ];
        for (const [label, value, before] of numbers) {
            text(`${label}: ${value}${before ? `   (previous: ${before})` : ''}`);
        }

        section(doc, `Top actions (by leverage = influence x deficit)`);
        if (!d.actions.length) text('Nothing to fix among the audited sources.');
        for (const a of d.actions) {
            doc.font('Helvetica-Bold');
            text(`${a.leverage_rank}. ${a.domain}: ${ACTION_LABELS[a.action]}  (leverage ${a.leverage.toFixed(3)})`);
            doc.font('Helvetica').fillColor(GREY);
            text(a.url);
            text(`Stance ${a.stance}${a.is_stale ? `, stale: ${a.stale_reason}` : ''}. ` +
                `Influence ${pct(a.influence)}, cited in ${pct(a.citation_rate)} of answers across ${a.query_count} queries.`);
            doc.fillColor('black');
            if (a.evidence_passage) text(`"${truncate(a.evidence_passage, 320)}"`, { oblique: true });
            doc.moveDown(0.5);
        }

        section(doc, d.prevDate ? `What changed since ${d.prevDate}` : 'What changed');
        if (!d.prevDate) text('First audited run: nothing to compare with yet.');
        else if (!d.shifts.length) text('No changes above the noise thresholds.');
        for (const e of d.shifts) text(`- ${describeShift(e)}`);

        section(doc, 'Influential sources we could not audit');
        if (!d.unaudited.length) text('None: every top third-party source was read and audited.');
        for (const u of d.unaudited) {
            text(`- ${u.domain} (influence ${pct(u.influence)}): ${u.audit_note ?? u.fetch_status ?? 'not fetched'}`);
        }

        doc.moveDown(1.5).fontSize(8).fillColor(GREY);
        text('Method: each query is asked several times with search grounding; a page\'s influence is its average share of ' +
            'grounding support per answer. Standings are LLM verdicts whose quoted evidence is checked word for word ' +
            'against the page. Pages that block automated access (robots.txt, 403) cannot be audited and are listed above. ' +
            'Measured on one engine; other assistants may cite different sources.');
        doc.end();
    });
}

function emailBody(d) {
    const link = `${env.publicUrl}/workspaces/${d.workspaceId}/categories/${d.categoryId}/runs/${d.runId}/leverage`;
    const top = d.actions.slice(0, 3).map(a => `${a.leverage_rank}. ${a.domain}: ${ACTION_LABELS[a.action]}`);
    const text = [
        summaryParagraph(d),
        '',
        top.length ? `Top actions:\n${top.join('\n')}` : 'Nothing to fix among the audited sources.',
        '',
        `The full report is attached. Live data (API, sign-in required): ${link}`
    ].join('\n');
    const escape = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const html = `<p>${escape(summaryParagraph(d))}</p>` +
        (top.length ? `<p><strong>Top actions</strong><br>${top.map(escape).join('<br>')}</p>` : '') +
        `<p>The full report is attached.</p>`;
    return { subject: `Priors report: ${d.brand} in ${d.category} (${d.runDate})`, text, html };
}

// build, store and (by default) email run's report
// returns { generated, recipients, emailed, error }
export async function generateReport(runId, { send = true } = {}) {
    const data = await buildReportData(runId);
    if (!data) return { generated: false, reason: 'run has not been audited' };

    const pdf = await renderReportPdf(data);
    await reports.saveReport(runId, pdf);
    if (!send) return { generated: true, recipients: [], emailed: false };

    const recipients = data.recipients.length ? data.recipients : await listOwnerEmails(data.workspaceId);
    if (!recipients.length) {
        await reports.markEmailed(runId, { recipients, error: 'no recipients: set report_recipients on the category' });
        return { generated: true, recipients, emailed: false, error: 'no recipients' };
    }

    try {
        await sendMail({
            to: recipients,
            ...emailBody(data),
            attachments: [{ filename: `priors-${data.runDate}-${runId.slice(0, 8)}.pdf`, content: pdf, contentType: 'application/pdf' }]
        });
    } catch (err) {
        await reports.markEmailed(runId, { recipients, error: `email failed: ${err.message}` });
        throw err; // let job retry
    }
    await reports.markEmailed(runId, { recipients });
    console.log(`Report for run ${runId} emailed to ${recipients.join(', ')}`);
    return { generated: true, recipients, emailed: true };
}
