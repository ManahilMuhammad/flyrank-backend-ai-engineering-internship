import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';

const CACHE_DIR = './cache';
const BASE_URL = 'https://books.toscrape.com/';
const USER_AGENT = 'FlyRankInternshipA9/1.0 (https://github.com/ManahilMuhammad/flyrank-backend-ai-engineering-internship)';

// verify that cache directory exists; if not, create it
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

// get file path of cache
function getCachePath(pageNum) {
    return path.join(CACHE_DIR, `catalogue-page-${pageNum}.html`); // create distinct file path using page number
}

// fetch page (first time)
async function fetchPage(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': USER_AGENT
            },
            timeout: 5000 // 5 second timeout
        });

        // if failed to fetch
        if (response.status !== 200) {
            console.error(`Failed to fetch: status ${response.status}`);
            return null;
        }

        return response.data;
    } catch (err) {
        console.error(`Fetch error: ${err?.message || 'Unknown error'}`);
        return null;
    }
}

async function getPage(num, url) {
    const cache = getCachePath(num);

    // try to get page from cache first
    if (fs.existsSync(cache)) {
        console.log(`CACHE HIT - page ${num}`);
        return fs.readFileSync(cache, 'utf-8');
    }

    // if page not in cache, fetch from site
    console.log(`FETCH - page ${num}`);
    await new Promise(resolve => setTimeout(resolve, 500)); // wait half a second
    const html = await fetchPage(url);

    // write fetched page to cache
    if (html) {
        fs.writeFileSync(cache, html);
    }

    return html;
}

// extract links
function extractLinks(html, url) {
    const $ = cheerio.load(html);
    const links = [];

    $('article.product_pod h3 a').each((i, elem) => {
        const href = $(elem).attr('href'); // relative url
        if (href) {
            try {
                const absUrl = new URL(href, url).href; // convert relative to absolute url
                links.push(absUrl);
            } catch (err) {
                console.error(`Invalid URL: ${href}`);
            }
        }
    });

    return links;
}

// get next URL
function getNextUrl(html, currUrl) {
    const $ = cheerio.load(html);
    const nextUrl = $('li.next a').attr('href');

    if (nextUrl) {
        try {
            return new URL(nextUrl, currUrl).href;
        } catch (err) {
            console.error(`Invalid next URL: ${nextUrl}`);
        }
    }

    return null;
}

async function crawler() {
    let allLinks = [];
    let pageNum = 1;
    let currUrl = `${BASE_URL}catalogue/page-1.html`;

    while (pageNum <= 3) {
        const html = await getPage(pageNum, currUrl);

        if (!html) {
            console.error(`Failed to get page ${pageNum}`);
            break;
        }

        // get links
        const links = extractLinks(html, currUrl);
        allLinks = allLinks.concat(links);

        // find next page
        const nextUrl = getNextUrl(html, currUrl);
        if (nextUrl && pageNum < 3) {
            currUrl = nextUrl;
            pageNum++;
        } else {
            break;
        }
    }

    // remove duplicates
    const uniqLinks = [...new Set(allLinks)];

    console.log(`\ncatalogue_pages=${pageNum}`);
    console.log(`discovered=${allLinks.length}`);
    console.log(`unique_urls=${uniqLinks.length}`);

    return uniqLinks;
}

await crawler();