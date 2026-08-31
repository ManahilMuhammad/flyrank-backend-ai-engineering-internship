<p align="center"> 
  <img src="https://github.com/user-attachments/assets/4cc29149-68e0-49c1-97ab-035f8c90db0e" 
    alt="The Polite Scraper — FlyRank AI Engineering Internship" 
    width="100%" /> 
</p> 

<div align="center">

![Node](https://img.shields.io/badge/Node.js-18+-3EF589?style=flat-square&labelColor=0C1E17)
![Status](https://img.shields.io/badge/status-working-3EF589?style=flat-square&labelColor=0C1E17)

</div>

---

## What this is

A Node.js web scraper that extracts book data from [Books to Scrape](https://books.toscrape.com/), a sandbox site built for learning web scraping.

## Target Classification

**Site:** Books to Scrape (books.toscrape.com)

**Why:** The site explicitly states it is a sandbox built for practicing web scraping.

**Scope:** First 3 catalogue pages only (60 books total).

**Data Collected:** 
- Book title
- Product URL
- Price (GBP)
- Availability status
- Star rating
- Description
- Source page and fetch timestamp

**Appropriateness:** This site is built for scraping practice and explicitly permits it. Scraping is limited to 3 pages to minimise server load.

## Robots.txt Check

Requested: `https://books.toscrape.com/robots.txt`

**Result:** No robots.txt file found (404 Not Found)

While a missing robots.txt file does not signify permission to scrape, Books to Scrape explicitly states on its homepage that it is built for practicing web scraping, which provides clear permission for this assignment.

## Install & Run

Requires Node.js 18+.

After cloning the root directory, run:

```bash
npm install --save-dev cross-env
```

Dependencies:
- `axios` HTTP client with timeouts and retry logic
- `cheerio` HTML parsing
- `zod` Schema validation

To start, run:

```bash
npm run be-05
```

This will:
1. Fetch the first 3 catalogue pages (with caching)
2. Extract details from all 60 book pages
3. Validate and normalize the data
4. Write `output/books.json` and `output/run-report.json`

**Total time:** ~2-3 minutes on first run (all pages cached after) and instant on subsequent runs.

## Record Schema

Each book is stored as a validated record:

```json
{
  "title": "string (required)",
  "product_url": "string (URL, required, used as unique identifier)",
  "price_text": "string | null (raw price from page, e.g. '£51.77')",
  "price_gbp": "number | null (normalised price for sorting)",
  "availability_text": "string | null (e.g. 'In stock (22 available)')",
  "rating_text": "string | null (e.g. 'Three')",
  "description": "string | null (product description, may be missing)",
  "source_page": "string (URL of catalogue page where link was found)",
  "fetched_at": "ISO 8601 timestamp (when this record was extracted)"
}
```

## Politeness Rules

This scraper follows best practices for ethical web scraping:

**User-Agent:** Identifies itself as `FlyRankInternshipA9/1.0` with a link to the repo source code. Site owners can find out who you are from their logs.

**Delays:** Waits 500ms between real HTTP requests to the site. Cached pages are read instantly so no delay is imposed on the site for repeat runs.

**Timeouts:** Every request has a 5-second timeout. The scraper gives up immediately after this.

**Status Checks:** Only accepts HTTP 200 responses. Errors are logged and the page is skipped.

**Retries:** Retries once on timeout or 5xx errors. Does NOT retry 404 (page doesn't exist) or 403 (site said no).

**Idempotency:** Running the scraper twice produces identical `books.json`. Duplicate product URLs are automatically deduplicated.

## Sample Run Report

```json
{
  "start_time": "2026-08-31T14:23:45.123Z",
  "end_time": "2026-08-31T14:25:12.456Z",
  "duration_seconds": "15.33",
  "pages_fetched": 63,
  "cache_hits": 0,
  "valid_records": 60,
  "invalid_records": 0,
  "failed_pages": 0
}
```

First run fetches all 60 book pages + 3 catalogue pages = 63 fetches. Second run hits cache and completes in <1 second.

## Why No Browser?

This scraper uses Cheerio (HTML parsing) instead of Puppeteer (headless browser) because **the data is already in the HTML the server sends**. Books to Scrape is a static site which means that no JavaScript runs on load. Using a browser would add latency, memory overhead, and complexity without gaining anything. A browser is needed only when:
- The page renders content via JavaScript (React, Vue, Angular)
- You need to interact with the page (clicks, scrolls, filling forms)
- You need to handle dynamic content or infinite scroll

For static HTML, a simple HTTP client + parser is the right tool.

## Ethics & Responsibility

**Use official APIs when they exist.** If a site offers an API, use it instead of scraping.

**Never bypass authentication or paywalls.** Do not scrape behind login walls or paid content.

**Never ignore robots.txt or Terms of Service.** If a site explicitly disallows scraping (in robots.txt or ToS), respect it.

**Collect only what you need.** Extract the minimum data required. Don't download entire pages for one field. Don't store personal information you don't need.

**Identify yourself.** Always send a User-Agent that identifies who you are. This allows site owners to contact you if there's a problem.

**Be respectful of resources.** Add delays between requests. Cache results. Limit your scope. 

This assignment scrapes a sandbox site that *explicitly welcomes* scrapers for learning. Always verify permission before scraping any real site.

## Limitations

This scraper only handles Books to Scrape, which is purpose-built and simple. A real-world scraper would need:
- Error recovery for malformed HTML
- Handling of pagination via JavaScript (Puppeteer needed)
- Request rate limiting and backoff strategies
- Database storage instead of JSON files
- Scheduled runs with alerting
- IP rotation for sites with rate limits
- Proxy support for geo-blocked content

## Ethical Statement

**I will not reuse this code on another site without checking its rules and terms first.**
