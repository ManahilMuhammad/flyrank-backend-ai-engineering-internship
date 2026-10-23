<p align="center"> 
  <img src="https://github.com/user-attachments/assets/76124d7f-6088-46ed-bf0a-c66cf0d2fa18" 
    alt="Priors — FlyRank AI Engineering Internship" 
    width="100%" /> 
</p>

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-ESM-3EF589?style=flat-square&labelColor=0C1E17)
![Express](https://img.shields.io/badge/Express-5-3EF589?style=flat-square&labelColor=0C1E17)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-3EF589?style=flat-square&labelColor=0C1E17)
![Supabase](https://img.shields.io/badge/Supabase-Auth-3EF589?style=flat-square&labelColor=0C1E17)
![Gemini](https://img.shields.io/badge/Gemini-API-3EF589?style=flat-square&labelColor=0C1E17)
![Groq](https://img.shields.io/badge/Groq-API-3EF589?style=flat-square&labelColor=0C1E17)
![Status](https://img.shields.io/badge/status-production-3EF589?style=flat-square&labelColor=0C1E17)

</div>

---

# Priors

**Which third-party pages do AI assistants build their answers from, what do those pages say about your brand, and which ones are worth fixing first?**

Priors asks an AI assistant the questions buyers in a category actually ask, records which web pages each answer was grounded in, reads those pages, and audits how each one describes the brand: absent, neutral, favorable or unfavorable, whether it repeats outdated facts, and a word-for-word quote as evidence. It then ranks the pages by **leverage = influence × deficit** (how much the answers lean on the page × how far the page is from describing the brand well) and alerts when the set of pages shifts from one week to the next. Each run ends in a PDF report, emailed to the team.

It was built for FlyRank as a capstone project, with FlyRank as the demo brand in the category "AI search visibility / GEO tools". FlyRank's own platform already tracks *whether* a brand is cited and offers sources and citations reporting. Priors goes further: a per-source audit with evidence, an action list ranked by leverage, and alerts when the source corpus changes.

> **Status, 23 Oct 2026.** The whole pipeline is built, tested (183 tests) and has run end to end on real data. A first real run for FlyRank is complete, report included (see [Real results](#real-results)), and the classifier has been evaluated against reference labels (see [Evaluation](#evaluation)).

---

## How it works

```
 queries ──► harvest ──► influence ──► fetch ──► audit ──► leverage ──► shifts ──► report
 (LLM)      (answer     (rank pages   (read     (LLM      (rank       (diff vs   (PDF +
            engine with  by grounding  pages,    verdict   fixes)      last run)  email)
            web search)  share)        cache)    + quote)
```

Each step is a background job (pg-boss on Postgres) that queues the next when it succeeds; a weekly cron starts the chain for every category that opts in. Everything is scoped to a workspace, and one tenant can't see or touch another's data.

| Stage | What it does |
|---|---|
| **Queries** | An LLM expands a category into ~60 conversational questions in groups of paraphrases, tagged by intent (recommendation, comparison, alternatives, pricing, use case, evaluation, how-to). Duplicates and any question that names the brand are dropped, so the measurement stays about the category. |
| **Harvest** | Each active query is asked several times (answers vary between samples) to an answer engine with web search on. Every answer is stored with the pages it was grounded in and how much of the answer each page supports. |
| **Influence** | A page's influence = its average share of grounding support across all of a run's answers, including answers that cited nothing. Also per site, plus a co-citation graph of which pages get cited together. |
| **Fetch** | The top 40 pages are fetched politely (robots.txt respected, one request at a time per site, private addresses refused). The main text is extracted with Mozilla Readability and hashed. A page checked in the last 6 days isn't requested again; a stale one is re-requested with ETag/Last-Modified, and unchanged text never creates a new snapshot. |
| **Audit** | For each page and the brand: if the brand is never named, it is `absent` by rule (no LLM call). Otherwise an LLM gets the brand, its aliases, its **fact sheet** (current prices, plans, features), the page excerpts and today's date, and returns stance, staleness, a reason and a quote. **The quote must appear in the stored page text**, allowing only spacing, quote-mark and dash differences, or the verdict is rejected after one retry. Verdicts are cached per (page text hash, brand, prompt version). |
| **Leverage** | Deficit: absent 1.0, unfavorable 0.9, neutral 0.4, favorable 0; stale facts make it at least 0.8. Leverage = influence × deficit, ranked, each with an action: correct stale info, get included, address criticism, improve mention. The brand's own pages are excluded, and pages that couldn't be read are listed separately rather than dropped. |
| **Shifts** | Each run is compared with the previous audited run: pages entering or leaving the answers, citation rate moves of 10+ points, brand mention rate moves of 5+ points, and pages whose verdict changed. Page-level alerts need 3+ citations, so sampling noise doesn't trigger them. |
| **Report** | A one-page PDF (summary, key numbers vs last run, top 10 actions with evidence, what changed, what couldn't be audited), emailed to the category's recipients or the workspace owners. |

### Answer engines

| Engine | How it grounds | Notes |
|---|---|---|
| `gemini` | Gemini with Google Search grounding; grounding redirect links are resolved to the real page URLs (cached) | Designed for this, but **Google gives this project's API key no free quota for grounding** |
| `groq` | `openai/gpt-oss-120b` on Groq with its built-in browser search; sources are the pages it opened and cited (`【n†Lx-Ly】` markers) | Free tier, used for the real run. About 120,000–200,000 tokens per answer against a 200,000 tokens/day limit, so runs pause and resume automatically when the daily quota runs out |

The standing audit and query generation always use Gemini (plain calls, which the free tier allows).

---

## Results

Collected between 15 and 23 Oct 2026. Small samples, stated as they are.

### The first real run: FlyRank in "AI search visibility / GEO tools"

The whole pipeline ran end to end on real data: query generation, harvest, fetch, audit, leverage, shifts and the emailed PDF report.

- **Queries.** Gemini 3.8 Flash generated 60 queries live, none dropped by the filters. 10 seeds covering all 7 intents were scheduled.
- **Engine.** Groq's `openai/gpt-oss-120b` with browser search, 1 sample per query. **6 of the 10 queries were answered** before the free quota made the rest a multi-day wait, and the run was closed at 6 answers. The 6 answers used about 1.14 million tokens (~190,000 each), almost all of it web pages the model read.
- **The 6 answers were grounded in 17 distinct pages,** with every answer citing at least one (100% grounded).

**Headline**

| | |
|---|---|
| Answers that name FlyRank | **0 of 6 (0%)** |
| Answers citing a flyrank.ai page | 0% |
| Influence held by the top 5 pages | 62% |
| Top pages readable and audited | 16 of 17 (83% of the influence) |
| Audited pages that mention FlyRank | **0 of 16** |

**Top of the action list** (leverage = influence × deficit; every audited page is `absent`, so the action is "get included"):

| # | Page | Influence | Cited for |
|---|---|---|---|
| — | clutch.co (GEO agency directory) | 16.7% | *best agencies for GEO*. **Not readable** (blocks automated access), so listed as unaudited |
| 1 | get-ryze.ai: AI visibility vs rank tracking | 15.2% | *traditional rank tracking vs AI visibility tools* |
| 2 | rankability.com: what to pay for AI visibility tracking | 12.4% | *how much do AI search visibility tools cost* |
| 3 | digiton.ai: questions to ask an AI agency | 9.6% | *how to evaluate a GEO agency* |
| 4 | theseoagent.ai: free AI SEO tools | 7.8% | *free alternatives to enterprise GEO tools* |
| 5 | usetellr.com: picking a GEO agency | 7.0% | *how to evaluate a GEO agency* |

The rest are open-source GEO tool lists on GitHub, cited.so, geotoolindex.com, technotize.io, moz.com, zapier.com, and Ahrefs/Google/Screaming Frog tool pages.

**What it says:** for the questions this assistant was asked, the pages it reads to answer them (pricing guides, agency checklists, free-tool roundups) don't mention FlyRank, and neither do its answers. One sample per query is not enough to call these pages stable sources, but the pattern is consistent across all 6 answers. The report is in Mailpit as "Priors report: FlyRank in AI search visibility / GEO tools". Being the first run, it has no shifts to compare against.

### Other live checks

**Reading the sources (live).**
- Readable: Wikipedia's GEO article, flyrank.ai/pricing, and all 10 GEO comparison and roundup pages in the evaluation set (nogood.io, superlines.io ×2, europeanbusinessmagazine.com, alhena.ai, dupple.com, airops.com, getairefs.com, get-ryze.ai, zapier.com).
- Blocked: **every review listing that carries FlyRank's price**: G2, TrustRadius, Capterra, GetApp (×3), Software Advice (×2) answer 403, and Trustpilot and Reddit disallow crawlers in robots.txt.

**Audit (live, Gemini).**
- Three GEO roundups were audited for Peec AI: all favorable (confidence 0.95–1.0), and every quote passed the word-for-word check against the page.
- For FlyRank, the same roundups were `absent` by rule: none of the readable roundups mentions FlyRank. Under leverage, those are exactly the pages to get included in.
- The FlyRank price those review listings show (\$1,499/mo vs \$1,999/mo on flyrank.ai) is the stale-fact case the audit exists for, but they can't be fetched.

**Plumbing (live).** The weekly cron fired on a real every-minute schedule (then reset), and report emails arrived in Mailpit with the PDF attached.

---

## Evaluation

**What is measured:** does the standing classifier agree with a human?

**Set:** 10 real, readable pages in the category × 4 brands (FlyRank, Peec AI, Profound, Semrush) = 40 cases (`eval/cases.json`). Each page's text is fetched once and frozen. Every case is audited by the same code the pipeline uses (`auditPage`), then labelled with `eval/labels.csv` and [`eval/LABELING.md`](eval/LABELING.md).

**Who labelled:** the reference labels were made by **a second LLM (Claude), not a human**. It worked from the frozen page texts and the labelling guide without reading the classifier's outputs, and each row's `notes` gives the reason. The numbers below are therefore **agreement between two different models** (Gemini as classifier, Claude as reference), not accuracy against human judgement. They show where the classifier is consistent and where it diverges, not how often a person would agree. Rows a human has checked can be marked in `notes`, and the score re-run.

**Metrics:**
- stance accuracy and Cohen's kappa (agreement beyond chance);
- per-stance precision and recall;
- a confusion matrix;
- for brands with a fact sheet, staleness precision and recall.

Because "brand never named" cases are free and almost always right, results are reported **with and without** them; the LLM-only row is the honest number.

```bash
npm run eval:build   # fetch + freeze pages, run the classifier, write the blind labelling sheet
npm run eval:score   # compare with your labels; rewrites the section below
```

<!-- eval:start -->
Scored 2026-10-23 (classifier: gemini-3.8-flash, prompt standing-v1). 40 of 40 cases labelled; **6 labelled cases have no classifier prediction yet** (LLM quota) and are not scored.

| | cases | stance accuracy | Cohen's kappa |
|---|---|---|---|
| All cases | 34 | 88% | 0.80 |
| **LLM-decided only** (rule's "absent" calls removed) | 15 | **73%** | **0.47** |

The "brand never named" rule decided 19 cases; the reference label agreed with "absent" in 19.

**Per stance (LLM-decided cases):**

| stance | label count | precision | recall | F1 |
|---|---|---|---|---|
| absent | 0 | 0% | n/a | n/a |
| neutral | 6 | 100% | 33% | 0.50 |
| favorable | 9 | 82% | 100% | 0.90 |
| unfavorable | 0 | 0% | n/a | n/a |

**Confusion matrix (all cases):**

| label \ model | absent | neutral | favorable | unfavorable |
|---|---|---|---|---|
| **absent** | **19** | 0 | 0 | 0 |
| **neutral** | 1 | **2** | 2 | 1 |
| **favorable** | 0 | 0 | **9** | 0 |
| **unfavorable** | 0 | 0 | 0 | **0** |

**Staleness** (27 cases where the brand had a fact sheet): accuracy 96%, precision 88%, recall 100% (7 caught, 1 false alarms, 0 missed).
<!-- eval:end -->

**Reading the results (first scoring, 34 of 40 cases).**
- **Staleness is where the classifier is strongest.** It caught all 7 pages quoting retired or wrong plans (mostly Profound's old \$89/\$99 "Starter" and \$399 "Growth" tiers, and Peec AI prompt counts that don't match its pricing page), with one false alarm.
- **Stance agreement is good on clear cases and weak on "neutral".** Every page the reference called favorable, Gemini did too. The disagreements are all pages the reference called neutral: balanced head-to-head comparisons, a competitor's mixed review, a passing mention. Gemini tends to read those as favorable or unfavorable. That is where the line between neutral and favorable is fuzzy, and where a human label would be the deciding vote.
- **The "never named" rule was right every time** (19 of 19). It also means headline accuracy over all cases (88%) flatters the LLM, which is why the LLM-only row is the one to quote.
- **Caveats:** 15 LLM-decided cases is a small set; the reference labels come from another LLM, not a person; and 6 cases are still waiting for a prediction (re-run `npm run eval:build`, then `npm run eval:score`).

---

## Limitations

- **One engine (and not the one it was designed for).** The real data comes from an open model (gpt-oss-120b) with Groq's browser search, because Gemini's search grounding needs a paid plan for the key used. That engine's searches and source choices are not Gemini's, ChatGPT's or Perplexity's. The method carries over but the specific sources don't.
- **The search behaviour is prompted.** The Groq engine is told "Search the web before answering and cite the pages you used", like an assistant's search mode. Without that, it often answers from memory.
- **Small samples.** The free quota makes grounded answers slow and expensive, so the first real run is 6 answered queries × 1 sample, not 60 × 3. Influence from one sample per query is noisy (every page here has the same citation rate, 1 in 6), and the shift thresholds were set with larger runs in mind.
- **Citation mapping for Groq is matched by content.** The number in a `【n†Lx-Ly】` marker is supposed to say which page is cited. On real answers it drifts once the model runs find or python steps, so each citation is assigned to the opened page whose lines x–y actually share words with the claim. Citations with no such page are dropped: 20 of 111 (18%) on the stored answers, against 41% when trusting the numbers. The first answer predates raw-response storage and keeps its original mapping.
- **The pages that matter most often block reading.** Review platforms (G2, Capterra, GetApp, TrustRadius, Software Advice), Trustpilot and Reddit refuse automated access. They still appear in the influence ranking, marked unaudited, but the stale-price case on FlyRank's listings can't be audited automatically. A headless browser or Reddit's official API would be the next step; ignoring robots.txt is not an option.
- **Staleness depends on the fact sheet.** It's entered by hand on purpose as it is the ground truth, and only facts it lists can be checked. In the evaluation, competitors' fact sheets contain only what their own pricing pages showed; Peec AI's prices are drawn client-side and weren't captured.
- **LLM verdicts.** The quote check stops invented evidence, not a wrong judgement about real text which is what the evaluation measures. Page text is passed as untrusted data, but a page could still try to steer the classifier.
- **Owned vs third-party is by domain only.** A brand's pages on other sites (a G2 profile it manages, a guest post) count as third-party.

## Future work

- Run the same queries on several engines (ChatGPT search, Perplexity, Gemini) and compare their source sets.
- Read the blocked sources through official APIs (Reddit) or a browser where terms allow.
- Track the fact sheet against the brand's own site and flag when it drifts.
- Larger samples once quota allows; tune the shift thresholds against observed week-to-week noise.

---

## Running it

```bash
cd Capstone
docker compose up -d   # Postgres on 5433, Mailpit on 1025 (SMTP) / 8025 (inbox at http://localhost:8025)
npm install
npm run dev            # migrations, job workers, weekly cron, API on http://localhost:3010 (docs at /docs)
npm test               # needs the Postgres and Mailpit containers
```

The job workers run inside the API process, so a harvest only progresses while `npm run dev` is running. A paused run resumes when the server is up again.

Configuration comes from the repository's root `.env`:

| Variable | Default | |
|---|---|---|
| `PRIORS_DATABASE_URL`, `PRIORS_PORT` | local Docker Postgres, 3010 | |
| `SUPABASE_URL`, `SUPABASE_KEY` | | auth |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | `gemini-3.8-flash` | query generation and the audit |
| `ANSWER_ENGINE` | `gemini` | `gemini` or `groq` for new harvests (also settable per run) |
| `GROQ_API_KEY`, `GROQ_MODEL` | `openai/gpt-oss-120b` | |
| `HARVEST_MIN_INTERVAL_MS` | 7000 | pacing between LLM calls |
| `FETCH_TOP_N`, `FETCH_TTL_HOURS` | 40, 144 | pages fetched and audited per run; re-check interval |
| `HARVEST_CRON`, `HARVEST_CRON_TZ` | `0 6 * * 1`, `UTC` | weekly schedule (`off` disables) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Mailpit | point at a real provider to deliver email |

## API

Interactive docs at `/docs` (OpenAPI 3). Log in with `POST /auth/login`, then send `Authorization: Bearer <token>`. Everything below lives under `/workspaces/{id}`.

| | |
|---|---|
| `brands` | brand, aliases, owned `domains`, `fact_sheet` |
| `categories` | category, `weekly_harvest`, `report_recipients`; `…/shifts` alert feed |
| `categories/{id}/queries` | `POST …/generate` (LLM, preview or save), add, edit, deactivate |
| `categories/{id}/runs` | `POST` starts a harvest (`engine`, `samples_per_query`); `GET …/{runId}` progress and stats |
| `…/runs/{runId}/answers` | answers with their citations |
| `…/runs/{runId}/sources`, `…/graph` | influence ranking (by page or site), co-citation graph |
| `…/runs/{runId}/fetch`, `…/standings`, `…/audit` | re-fetch; verdicts with evidence; re-audit |
| `…/runs/{runId}/leverage` | the action list, headline numbers, unaudited sources |
| `…/runs/{runId}/shifts` | changes since the previous run |
| `…/runs/{runId}/report.pdf`, `…/report` | the PDF; email status and resend |

## Layout

```
migrations/        plain SQL, applied in order at startup (001 schema … 010 raw engine responses)
src/config.js      environment
src/routes/        Express routers (workspace-scoped)
src/middleware/    auth (Supabase JWT), workspace membership, validation
src/db/            one module per table group; every query filters by workspace or a pre-checked id
src/services/      queryGenerator, harvester, sourceFetcher, standingAuditor, leverage, shifts, scheduler, report, evaluation
src/lib/           gemini, groq, fetchPage, extract, evidence (quote check), urls, jobs (pg-boss), mailer, csv
scripts/           eval-build, eval-score
eval/              evaluation cases, labelling guide, labels, predictions, results
test/              vitest + supertest, against the Docker Postgres and Mailpit
```
