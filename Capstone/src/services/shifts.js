import * as shifts from '../db/shifts.js';
import { deficitFor } from './leverage.js';

// answers vary between samples so small moves are noise
export const MIN_CITATIONS = 3;        // source must be cited this often (in run where it matters) to alert
export const SOURCE_RATE_DELTA = 0.10; // source citation rate must move by 10 points (or cross 10% when entering/leaving)
export const BRAND_RATE_DELTA = 0.05;  // brand-level rates averaged over every answer so 5 points meaningful

const round = n => Number(n.toFixed(4));

// compare two runs of a category - returns events to store
// prev/curr: { sources: rows from listRunSourceState, headline: stats.headline }
export function diffRuns(prev, curr) {
    const events = [];
    const before = new Map(prev.sources.map(s => [s.source_id, s]));
    const after = new Map(curr.sources.map(s => [s.source_id, s]));
    const cited = s => (s?.citation_count ?? 0) > 0;

    for (const s of after.values()) {
        const p = before.get(s.source_id);
        const sourcePayload = { url: s.url, domain: s.domain };

        if (!cited(p)) {
            if (s.citation_count >= MIN_CITATIONS && s.citation_rate >= SOURCE_RATE_DELTA) {
                events.push({
                    type: 'source_entered', sourceId: s.source_id, delta: round(s.citation_rate),
                    payload: { ...sourcePayload, citation_rate: s.citation_rate, citation_count: s.citation_count, influence: s.influence }
                });
            }
        } else {
            const change = s.citation_rate - p.citation_rate;
            if (Math.abs(change) >= SOURCE_RATE_DELTA && Math.max(s.citation_count, p.citation_count) >= MIN_CITATIONS) {
                events.push({
                    type: 'citation_rate_changed', sourceId: s.source_id, delta: round(change),
                    payload: { ...sourcePayload, metric: 'source_citation_rate', from: p.citation_rate, to: s.citation_rate }
                });
            }
        }

        // page's verdict changing is content change, not sampling noise
        // no citation minimum
        if (p?.stance && s.stance && (p.stance !== s.stance || p.is_stale !== s.is_stale)) {
            events.push({
                type: 'standing_changed', sourceId: s.source_id,
                delta: round(deficitFor(s) - deficitFor(p)), // positive = page got worse for brand
                payload: {
                    ...sourcePayload,
                    from: { stance: p.stance, is_stale: p.is_stale },
                    to: { stance: s.stance, is_stale: s.is_stale },
                    stale_reason: s.stale_reason,
                    evidence_passage: s.evidence_passage
                }
            });
        }
    }

    for (const p of before.values()) {
        if (cited(after.get(p.source_id))) continue;
        if (p.citation_count >= MIN_CITATIONS && p.citation_rate >= SOURCE_RATE_DELTA) {
            events.push({
                type: 'source_exited', sourceId: p.source_id, delta: round(-p.citation_rate),
                payload: { url: p.url, domain: p.domain, previous_citation_rate: p.citation_rate, previous_citation_count: p.citation_count }
            });
        }
    }

    // brand level rates: no source, metric name says which
    for (const metric of ['brand_mention_rate', 'owned_citation_rate']) {
        const from = prev.headline?.[metric];
        const to = curr.headline?.[metric];
        if (from == null || to == null) continue;
        if (Math.abs(to - from) >= BRAND_RATE_DELTA) {
            events.push({ type: 'citation_rate_changed', sourceId: null, delta: round(to - from), payload: { metric, from, to } });
        }
    }

    return events;
}

// diff run against category's previous audited run and store events
// category's first run has nothing to compare with and records no events
export async function detectShifts(runId) {
    const run = await shifts.getRunWithPrevious(runId);
    if (!run) return null;

    let events = [];
    if (run.prev_id) {
        const [prevSources, currSources] = await Promise.all([
            shifts.listRunSourceState(run.prev_id),
            shifts.listRunSourceState(run.id)
        ]);
        events = diffRuns(
            { sources: prevSources, headline: run.prev_stats.headline },
            { sources: currSources, headline: run.stats.headline }
        );
    }

    const byType = {};
    for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
    const summary = { previous_run_id: run.prev_id ?? null, total: events.length, by_type: byType };

    await shifts.replaceShiftEvents(run, run.prev_id ?? null, events, summary);
    console.log(`Shifts for run ${runId}: ${JSON.stringify(summary)}`);
    return summary;
}
