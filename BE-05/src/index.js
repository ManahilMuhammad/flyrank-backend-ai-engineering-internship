import fs from 'fs';
import path from 'path';
import axios from 'axios';

const CACHE_DIR = './cache';
const CACHE_FILE = path.join(CACHE_DIR, 'catalogue-page-1.html');
const URL = 'https://books.toscrape.com/catalogue/page-1.html';

// verify that cache directory exists; if not, create it
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

// fetch page (first time)
async function fetchPage() {
    const userAgent = 'FlyRankInternshipA9/1.0 (https://github.com/ManahilMuhammad/flyrank-backend-ai-engineering-internship)';

    try {
        const response = await axios.get(URL, {
            headers: {
                'User-Agent': userAgent
            },
            timeout: 5000 // 5 seconf timeout
        });

        if (response.status !== 200) {
            console.error(`Failed to fetch: status ${response.status}`);
            return null;
        }

        const html = response.data;
        const sizeKB = (Buffer.byteLength(html) / 1024).toFixed(2);

        // save to cache
        fs.writeFileSync(CACHE_FILE, html);
        console.log(`FETCH - Response size:  ${sizeKB} KB`);

        return html;
    } catch (err) {
        console.error(`Fetch error:`, err);
        return null;
    }
}

// read cache (after first time)
function readCache() {
    if (fs.existsSync(CACHE_FILE)) {
        const html = fs.readFileSync(CACHE_FILE, 'utf-8'); // get from cache
        const sizeKB = (Buffer.byteLength(html) / 1024).toFixed(2);

        console.log(`CACHE HIT - Response size: ${sizeKB} KB`);
        return html;
    }
    return null;
}

async function main() {
    // try cache first
    let html = readCache();

    // if no cache then fetch instead
    if (!html) {
        html = await fetchPage();
    }

    if (html) {
        console.log('Page loaded successfully!');
    }
}

main();