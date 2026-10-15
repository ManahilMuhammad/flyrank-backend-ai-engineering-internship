import express from 'express';
import { z } from 'zod';
import { validateBody, uuid } from '../middleware/validate.js';
import * as harvests from '../db/harvests.js';
import { assertConfigured } from '../lib/gemini.js';
import { enqueueHarvest } from '../lib/jobs.js';
import { env } from '../config.js';

// mounted under /workspaces/:workspaceId/categories/:categoryId/runs
// after requireCategory
const router = express.Router({ mergeParams: true });

const createRunBody = z.object({
    // answers vary between calls 
    // so each query sampled several times
    samples_per_query: z.number().int().min(1).max(5).default(3)
}).strict();

const answersFilter = z.object({ query_id: uuid.optional() });

// loads runId within current category and sets req.run
async function requireRun(req, res, next) {
    const run = uuid.safeParse(req.params.runId).success
        ? await harvests.getRun(req.category.id, req.params.runId)
        : undefined;
    if (!run) return res.status(404).json({ error: 'Run not found' });
    req.run = run;
    next();
}

// queue harvest
// runs in the background, poll GET /runs/:runId for progress
router.post('/', validateBody(createRunBody), async (req, res) => {
    assertConfigured(); // refuse now rather than fail later

    const queries = await harvests.listActiveQueries(req.category.id);
    if (!queries.length) {
        return res.status(400).json({ error: 'Category has no active queries; generate or add some first' });
    }

    let run;
    try {
        run = await harvests.createRun(req.category.id, {
            model: env.geminiModel,
            samplesPerQuery: req.body.samples_per_query
        });
    } catch (err) {
        if (err.constraint === 'harvest_runs_one_active_idx') {
            return res.status(409).json({ error: 'A harvest is already queued or running for this category' });
        }
        throw err;
    }

    try {
        await enqueueHarvest(run.id);
    } catch (err) {
        await harvests.finishRun(run.id, { status: 'failed', error: 'Could not queue the harvest' });
        throw err;
    }

    res.status(202).json(run);
});

router.get('/', async (req, res) => {
    res.json(await harvests.listRuns(req.category.id));
});

router.get('/:runId', requireRun, (req, res) => {
    res.json(req.run);
});

router.get('/:runId/answers', requireRun, async (req, res) => {
    const filter = answersFilter.safeParse(req.query);
    if (!filter.success) return res.status(400).json({ error: 'query_id must be a UUID' });
    res.json(await harvests.listAnswers(req.run.id, { queryId: filter.data.query_id }));
});

export default router;
