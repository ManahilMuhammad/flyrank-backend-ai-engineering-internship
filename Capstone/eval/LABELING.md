# Labelling guide

`labels.csv` has one row per (page, brand). For each row, read the page text in `page_file` (the exact text the classifier saw, captured by `npm run eval:build`), decide how the page describes that brand, and fill in two columns. Don't look at `predictions.json` first: the point is an independent second opinion.

## `human_stance`: one of

| value | use when the page… |
|---|---|
| `favorable` | recommends the brand, praises it, or ranks it near the top |
| `unfavorable` | criticises it, warns against it, or ranks it below alternatives |
| `neutral` | mentions or describes it without judging it (listed among many, facts only) |
| `absent` | doesn't discuss the brand at all (including when the name only refers to something else, e.g. "a profound shift") |

A page that praises one aspect and criticises another: pick the overall impression a reader would leave with, and say why in `notes`.

## `human_is_stale`: `yes` or `no`

`yes` only when the page states something about the brand that **contradicts its fact sheet** in `cases.json` (prices, plans, features, supported engines), or presents as current something the fact sheet says has changed. Old or incomplete is not stale. Leave it blank (or `no`) for Semrush, which has no fact sheet; those rows aren't scored for staleness.

## `notes`

Optional: anything ambiguous, and the sentence you based the label on if it wasn't obvious.

## When you're done

```bash
npm run eval:score   # prints the results and writes them into README.md
```

You can score partway through: unlabelled rows are counted and skipped.
