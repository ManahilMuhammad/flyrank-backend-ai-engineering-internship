import dns from 'dns/promises';
import net from 'net';
import robotsParser from 'robots-parser';

// identification for site owners
export const USER_AGENT = 'PriorsBot/0.1 (citation source research)';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024; // longer pages cut (main text near top)
const MAX_REDIRECTS = 5;
const TEXT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

// sites known to need browser or API marked unsupported
const UNSUPPORTED_DOMAINS = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'instagram.com', 'facebook.com', 'x.com', 'twitter.com'];

// cited urls come from llm so never point at own network
function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return lower === '::1' || lower === '::' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

async function assertPublicHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (addresses.some(a => isPrivateAddress(a.address))) throw new Error('refusing to fetch a private address');
}

export function isUnsupportedDomain(domain) {
    return UNSUPPORTED_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`));
}

// one robots.txt lookup per site per batch
async function robotsAllows(url, cache, allowPrivateHosts) {
    const origin = new URL(url).origin;
    if (!cache.has(origin)) {
        cache.set(origin, (async () => {
            if (!allowPrivateHosts) await assertPublicHost(new URL(origin).hostname);
            const robotsUrl = `${origin}/robots.txt`;
            const res = await fetch(robotsUrl, {
                headers: { 'User-Agent': USER_AGENT },
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            // RFC 9309: missing robots.txt = everything allowed 
            // server error = assume nothing is
            if (res.status >= 400 && res.status < 500) return null;
            if (!res.ok) throw new Error(`robots.txt returned ${res.status}`);
            return robotsParser(robotsUrl, await res.text());
        })());
    }
    const robots = await cache.get(origin);
    return !robots || robots.isAllowed(url, USER_AGENT) !== false;
}

// read at most MAX_BYTES of body
async function readCapped(res) {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
    }
    await reader.cancel().catch(() => {});

    const charset = /charset=([^;]+)/i.exec(res.headers.get('content-type') ?? '')?.[1]?.trim();
    let decoder;
    try {
        decoder = new TextDecoder(charset || 'utf-8');
    } catch {
        decoder = new TextDecoder('utf-8');
    }
    return decoder.decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

// fetch page politely: robots.txt, no private hosts, redirects checked hop by hop, conditional request
// returns { status, httpStatus, finalUrl, body, contentType, etag, lastModified, error }
// status: ok | not_modified | fetch_failed | blocked_robots | unsupported
export async function fetchPage(url, { etag, lastModified, robotsCache = new Map(), allowPrivateHosts = false } = {}) {
    let current = url;
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!allowPrivateHosts) await assertPublicHost(new URL(current).hostname);
            if (!(await robotsAllows(current, robotsCache, allowPrivateHosts))) {
                return { status: 'blocked_robots', finalUrl: current };
            }

            const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' };
            if (hop === 0 && etag) headers['If-None-Match'] = etag;
            if (hop === 0 && lastModified) headers['If-Modified-Since'] = lastModified;

            const res = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
            const location = res.headers.get('location');

            if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
                await res.body?.cancel();
                current = new URL(location, current).href;
                continue;
            }
            if (res.status === 304) return { status: 'not_modified', httpStatus: 304, finalUrl: current };
            if (!res.ok) {
                await res.body?.cancel();
                return { status: 'fetch_failed', httpStatus: res.status, finalUrl: current, error: `HTTP ${res.status}` };
            }

            const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
            if (contentType && !TEXT_TYPES.includes(contentType)) {
                await res.body?.cancel();
                return { status: 'unsupported', httpStatus: res.status, finalUrl: current, error: `content type ${contentType}` };
            }

            return {
                status: 'ok',
                httpStatus: res.status,
                finalUrl: current,
                contentType: contentType || 'text/html',
                body: await readCapped(res),
                etag: res.headers.get('etag'),
                lastModified: res.headers.get('last-modified')
            };
        }
        return { status: 'fetch_failed', finalUrl: current, error: 'too many redirects' };
    } catch (err) {
        const error = err.name === 'TimeoutError' ? 'timeout' : err.message;
        return { status: 'fetch_failed', finalUrl: current, error };
    }
}
