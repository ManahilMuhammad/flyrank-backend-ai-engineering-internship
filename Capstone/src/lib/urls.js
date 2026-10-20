// query params that only track click 
// never change page
const TRACKING_PARAM = /^(utm_\w+|gclid|gbraid|wbraid|fbclid|msclkid|yclid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|srsltid|ref|ref_src)$/i;

// one url per page so same page cited from different links counts once
// returns null for non- http(s) url
export function canonicalizeUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    url.hostname = url.hostname.toLowerCase();
    url.username = '';
    url.password = '';
    url.hash = '';

    const params = [...url.searchParams]
        .filter(([key]) => !TRACKING_PARAM.test(key))
        .sort(([a], [b]) => a.localeCompare(b));
    url.search = new URLSearchParams(params).toString();

    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
}

// host without www
// used to group sources by site
export function domainOf(url) {
    return new URL(url).hostname.replace(/^www\./, '');
}

// only types that can be told from domain alone
// editorial vs vendor needs page itself so those stay null until audit
const SOURCE_TYPES = {
    forum: ['reddit.com', 'quora.com', 'news.ycombinator.com', 'stackexchange.com', 'stackoverflow.com', 'indiehackers.com'],
    review_platform: ['g2.com', 'capterra.com', 'trustradius.com', 'trustpilot.com', 'getapp.com', 'softwareadvice.com',
        'producthunt.com', 'sourceforge.net', 'saasworthy.com', 'gartner.com'],
    video: ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com']
};

const onDomain = (domain, d) => domain === d || domain.endsWith(`.${d}`);

export function sourceTypeFor(domain) {
    for (const [type, domains] of Object.entries(SOURCE_TYPES)) {
        if (domains.some(d => onDomain(domain, d))) return type;
    }
    return null;
}

// page on one of brand's own sites (subdomains included)
export function isOwnedDomain(domain, brandDomains) {
    return brandDomains.some(d => onDomain(domain, d));
}
