# What this is

A Node.js web scraper that extracts book data from [Books to Scrape](https://books.toscrape.com/), a sandbox site built for learning web scraping.

## Target Classification

**Site:** Books to Scrape (books.toscrape.com)

**Why:** The site explicitly states it is a sandbox built for practicing web scraping.

**Scope:** First 3 catalogue pages only (36 books total).

**Data Collected:** 
- Book title
- Price
- Availability status
- Star rating

**Appropriateness:** This site is built for scraping practice and explicitly permits it. Scraping is limited to 3 pages to minimise server load.

## Robots.txt Check

Requested: `https://books.toscrape.com/robots.txt`

**Result:** No robots.txt file found (404 Not Found)

While a missing robots.txt file does not signify permission to scrape, Books to Scrape explicitly states on its homepage that it is built for practicing web scraping, which provides clear permission for this assignment.

## Ethical Statement

**I will not reuse this code on another site without checking its rules and terms first.**

## Install & Run

Requires Node.js 18+.

After cloning the root directory, run:

```bash
npm install --save-dev cross-env
```

To start, run:

```bash
npm run be-05
```
