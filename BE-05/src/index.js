import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { z } from 'zod';

const CACHE_DIR = './cache'; // cache directory
const OUTPUT_DIR = './output'; // output directory
const BASE_URL = 'https://books.toscrape.com/';
const USER_AGENT = 'FlyRankInternshipA9/1.0 (https://github.com/ManahilMuhammad/flyrank-backend-ai-engineering-internship)';
const DETAIL_CACHE_DIR = path.join(CACHE_DIR, 'books'); // details cache directory

// verify that directories exist; if not, create them
[CACHE_DIR, OUTPUT_DIR, DETAIL_CACHE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recurisve: true });
});

// book schema definition
const BookSchema = z.object({
    title: z.string().min(1),
    product_url: z.string().min(1),
    price_text: z.string().nullable(),
    price_dbp: z.number().nonnegative().nullable(),
    availability_text: z.string().nullable(),
    rating_text: z.string().nullable(),
    description: z.string().nullable(),
    source_page: z.string().url(),
    fetched_at: z.string().datetime()
});

// get file path of cache
function getCachePath(pageNum) {
    return path.join(CACHE_DIR, `catalogue-page-${pageNum}.html`); // create distinct file path using page number
}

// get file path of 
function getBookCachePath(url) {
    const parts = url.split('/').filter(Boolean);
    const bookSlug = parts[parts.length - 2]; // get the folder name, not index
    return path.join(DETAIL_CACHE_DIR, `${bookSlug}.html`);
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

// get book page using URL
async function getBookPage(url) {
    const cache = getBookCachePath(url);

    // get from cache if already exists there
    if (fs.existsSync(cache)) {
        return fs.readFileSync(cache, 'utf-8');
    }

    // otherwise fetch it
    await new Promise(resolve => setTimeout(resolve, 500));
    const html = await fetchPage(url);

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

function extractDetails(html, bookUrl, sourceUrl) {
    const $ = cheerio.load(html);
    const fetchedAt = new Date().toISOString();

    // extract details
    const title = $('h1').text().trim();
    const price = $('.price_color').text().trim();
    const availability = $('.instock.availability').text().trim();
    const rating = $('p.star-rating').attr('class');
    const description = $('#product_description').next('p').text().trim();

    // return extracted details
    return {
        title: title || null,
        product_url: bookUrl,
        price_text: price || null,
        availability_text: availability || null,
        rating_text: rating ? rating.split(' ')[1] : null,
        description: description || null,
        source_page: sourceUrl,
        fetched_at: fetchedAt
    };
}

// clean price
function cleanPrice(priceText) {
    if (!priceText) return null;

    // remove the sign from it and covert it to a number
    const match = priceText.match(/[\d.]+/);
    return match ? parseFloat(match[0]) : null;
}

// normalise record
function normaliseRecord(record) {
    return {
        ...record,
        price_gbp: cleanPrice(record.price_text)
    };
}

// validate and store records
function validateAndStore(records) {
    const valid = [];
    const errors = [];
    const seen = new Set();

    for (const record of records) {
        const normalised = normaliseRecord(record);

        // deduplication
        if (seen.has(normalised.product_url)) {
            continue;
        }

        try {
            BookSchema.parse(normalised);
            valid.push(normalised);
            seen.add(normalised.product_url);
        } catch (err) {
            errors.push({
                record: normalised,
                error: err.message
            });
        }
    }

    // write valid records
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'books.json'),
        JSON.stringify(valid, null, 2)
    );

    // write errors (if any)
    if (errors.length > 0) {
        fs.writeFileSync(
            path.join(OUTPUT_DIR, 'errors.json'),
            JSON.stringify(errors, null, 2)
        );
    }

    return { valid, errors };
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

async function extractAllDetails(urls, sourceUrl) {
    const records = [];

    // get each book page
    for (const url of urls) {
        const html = await getBookPage(url);
        if (html) {
            const record = extractDetails(html, url, sourceUrl); // extract details from page
            records.push(record);
        }
    }

    return records;
}

async function main() {
    const bookUrls = await crawler(); // get book urls
    const sourceUrl = `${BASE_URL}catalogue/page-1.html`;
    const records = await extractAllDetails(bookUrls, sourceUrl); // get details

    const { valid, errors } = validateAndStore(records);

    console.log(`\nValidation Results: `);
    console.log(`detail_pages=${valid.length}`);
    console.log(`errors=${errors.length}`);

    if (valid.length > 0) {
        console.log('Sample record: ');
        console.log(JSON.stringify(valid[0], null, 2));
    }
}

await main();
