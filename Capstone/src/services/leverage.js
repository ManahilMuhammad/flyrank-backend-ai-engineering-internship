import * as leverage from '../db/leverage.js';
import { getRunBrand } from '../db/standings.js';
import { isOwnedDomain } from '../lib/urls.js';

// how far source is from describing brand well 
// 0 = nothing to fix
// 1 = brand missing
export const DEFICIT = { absent: 1.0, unfavorable: 0.9, neutral: 0.4, favorable: 0 };
// wrong facts need fixing even on page that likes brand
export const STALE_MIN_DEFICIT = 0.8;

export function deficitFor({ stance, is_stale }) {
    const base = DEFICIT[stance];
    return is_stale ? Math.max(base, STALE_MIN_DEFICIT) : base;
}

// what to do about source
// stale facts come first because they are cheapest fix
export function actionFor({ stance, is_stale }) {
    if (is_stale) return 'correct_stale_info';
    return { absent: 'get_included', unfavorable: 'address_criticism', neutral: 'improve_mention', favorable: null }[stance];
}

const round = (n, places = 4) => (n === null || n === undefined ? null : Number(n.toFixed(places)));
const sum = (rows, key) => rows.reduce((total, r) => total + (r[key] ?? 0), 0);

// headline numbers for run: how visible brand is + how concentrated source corpus is
// rows = every scored source of run (ordered by influence)
// answers = answer level brand/owned counts
export function computeHeadline({ rows, answers, brandDomains, topN }) {
    const totalInfluence = sum(rows, 'influence');
    const share = part => (totalInfluence ? round(part / totalInfluence) : null);
    const top = rows.filter(r => r.rank <= topN);
    const thirdPartyTop = top.filter(r => !isOwnedDomain(r.domain, brandDomains));
    const audited = thirdPartyTop.filter(r => r.stance);
    const auditedInfluence = sum(audited, 'influence');

    // of audited third-party influence, how much sits with each stance
    const stanceMix = {};
    for (const stance of Object.keys(DEFICIT)) {
        const part = sum(audited.filter(r => r.stance === stance), 'influence');
        stanceMix[stance] = auditedInfluence ? round(part / auditedInfluence) : null;
    }

    return {
        answers: answers.total,
        // answers naming brand at all
        brand_mention_rate: answers.total ? round(answers.mentioned / answers.total) : null,
        // answers grounded in one of brand's own pages
        owned_citation_rate: answers.total ? round(answers.citing_owned / answers.total) : null,
        grounded_answer_rate: answers.total ? round(answers.grounded / answers.total) : null,
        sources: rows.length,
        // share of all influence held by 5 most influential sources
        // high = few pages decide answers
        top5_concentration: share(sum(rows.slice(0, 5), 'influence')),
        owned_influence_share: share(sum(rows.filter(r => isOwnedDomain(r.domain, brandDomains)), 'influence')),
        // share of top sources' third-party influence that has a verdict (blocked/failed pages lower it)
        audit_coverage: sum(thirdPartyTop, 'influence') ? round(auditedInfluence / sum(thirdPartyTop, 'influence')) : null,
        stance_mix: stanceMix,
        stale_share: auditedInfluence ? round(sum(audited.filter(r => r.is_stale), 'influence') / auditedInfluence) : null,
        // sum of leverage: how much influence is currently working against the brand
        total_leverage: round(sum(audited, 'leverage_value'))
    };
}

// score every audited top source, store deficit/leverage/action and headline on the run
// called at end of audit (safe to call again)
export async function scoreLeverage(runId, { topN }) {
    const brand = await getRunBrand(runId);
    const rows = await leverage.listScoredSources(runId);

    const scored = rows.map(r => {
        const owned = isOwnedDomain(r.domain, brand.domains);
        if (owned || !r.stance || r.rank > topN) return { ...r, deficit: null, leverage_value: null, action: null };
        const deficit = deficitFor(r);
        return { ...r, deficit, leverage_value: r.influence * deficit, action: actionFor(r) };
    });

    // rank only sources with something to fix
    // ties go to more influential source
    let leverageRank = 0;
    const ranked = scored
        .filter(r => r.leverage_value > 0)
        .sort((a, b) => b.leverage_value - a.leverage_value || a.rank - b.rank)
        .map(r => ({ ...r, leverage_rank: ++leverageRank }));
    const rankBySource = new Map(ranked.map(r => [r.source_id, r.leverage_rank]));

    await leverage.saveLeverage(runId, scored.map(r => ({
        sourceId: r.source_id,
        deficit: r.deficit,
        leverage: r.leverage_value,
        leverageRank: rankBySource.get(r.source_id) ?? null,
        action: r.leverage_value > 0 ? r.action : null
    })));

    const answers = await leverage.countAnswers(runId, brand.domains);
    const headline = computeHeadline({ rows: scored, answers, brandDomains: brand.domains, topN });
    await leverage.saveHeadline(runId, headline);
    return headline;
}
