import express from 'express';
import { z } from 'zod';
import { validateBody, requireUuidParam } from '../middleware/validate.js';
import * as queries from '../db/queries.js';
import { getBrand } from '../db/brands.js';
import { generateQueries, INTENTS } from '../services/queryGenerator.js';

// mounted under /workspaces/:workspaceId/categories/:categoryId/queries 
// after requireCategory
const router = express.Router({ mergeParams: true });

const queryText = z.string().trim().min(3).max(500);
const intent = z.enum(INTENTS);

const generateBody = z.object({
    count: z.number().int().min(5).max(100).default(60),
    // false = preview only so set can be reviewed before used for harvesting
    save: z.boolean().default(false)
}).strict();

const addQueriesBody = z.object({
    queries: z.array(z.object({ text: queryText, intent: intent.optional() }).strict()).min(1).max(100)
}).strict();

const updateQueryBody = z.object({
    text: queryText,
    intent: intent.nullable(),
    active: z.boolean() // inactive queries kept for history but skipped by harvests
}).partial().strict().refine(v => Object.keys(v).length > 0, 'Provide at least one of: text, intent, active');

const listFilter = z.object({ active: z.enum(['true', 'false']).optional() });

// llm expand category into conversational query set
router.post('/generate', validateBody(generateBody), async (req, res) => {
    const brand = await getBrand(req.workspace.id, req.category.brand_id);
    const existingTexts = await queries.listQueryTexts(req.category.id);

    const result = await generateQueries({
        category: req.category,
        brand,
        count: req.body.count,
        existingTexts
    });

    if (!req.body.save) {
        return res.json({ saved: false, ...result });
    }

    const saved = await queries.saveGeneratedQueries(req.category.id, result.queries, result.model);
    res.status(201).json({ saved: true, ...result, queries: saved });
});

router.get('/', async (req, res) => {
    const filter = listFilter.safeParse(req.query);
    const active = filter.success && filter.data.active !== undefined ? filter.data.active === 'true' : undefined;
    res.json(await queries.listQueries(req.category.id, { active }));
});

// add queries by hand (e.g. ones client cares about that generator missed)
router.post('/', validateBody(addQueriesBody), async (req, res) => {
    const saved = await queries.addManualQueries(req.category.id, req.body.queries);
    res.status(201).json({ added: saved.length, skipped_duplicates: req.body.queries.length - saved.length, queries: saved });
});

router.patch('/:queryId', requireUuidParam('queryId', 'Query'), validateBody(updateQueryBody), async (req, res) => {
    const query = await queries.updateQuery(req.category.id, req.params.queryId, req.body);
    if (!query) return res.status(404).json({ error: 'Query not found' });
    res.json(query);
});

router.delete('/:queryId', requireUuidParam('queryId', 'Query'), async (req, res) => {
    const deleted = await queries.deleteQuery(req.category.id, req.params.queryId);
    if (!deleted) return res.status(404).json({ error: 'Query not found' });
    res.status(204).send();
});

export default router;
