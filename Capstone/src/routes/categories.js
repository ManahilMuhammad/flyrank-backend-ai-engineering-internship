import express from 'express';
import { z } from 'zod';
import { validateBody, uuid } from '../middleware/validate.js';
import * as categories from '../db/categories.js';
import { getBrand } from '../db/brands.js';
import queryRoutes from './queries.js';
import harvestRoutes from './harvests.js';
import { listCategoryShifts } from '../db/shifts.js';

// mounted under /workspaces/:workspaceId/categories 
// after requireWorkspace so req.workspace is set
const router = express.Router({ mergeParams: true });

const categoryFields = {
    name: z.string().trim().min(1).max(100),
    // fed to query generator so context improves query set
    description: z.string().trim().max(1000).nullable(),
    // opt in to weekly re-harvest (each run spends llm quota)
    weekly_harvest: z.boolean(),
    // who gets each run's report
    // empty = workspace owners
    report_recipients: z.array(z.string().trim().toLowerCase().email()).max(20)
};

const createCategoryBody = z.object({
    brand_id: uuid,
    name: categoryFields.name,
    description: categoryFields.description.optional(),
    weekly_harvest: categoryFields.weekly_harvest.optional(),
    report_recipients: categoryFields.report_recipients.optional()
}).strict();

const updateCategoryBody = z.object(categoryFields).partial().strict().refine(
    v => Object.keys(v).length > 0,
    'Provide at least one of: name, description, weekly_harvest, report_recipients'
);

const SHIFT_TYPES = ['source_entered', 'source_exited', 'standing_changed', 'citation_rate_changed'];
const shiftsFilter = z.object({
    type: z.enum(SHIFT_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
});

// loads categoryId within current workspace and sets req.category
export async function requireCategory(req, res, next) {
    const { categoryId } = req.params;
    const category = uuid.safeParse(categoryId).success
        ? await categories.getCategory(req.workspace.id, categoryId)
        : undefined;

    if (!category) return res.status(404).json({ error: 'Category not found' });
    req.category = category;
    next();
}

router.post('/', validateBody(createCategoryBody), async (req, res) => {
    // brand must belong to this workspace 
    // otherwise tenant could attach another tenant's brand
    const brand = await getBrand(req.workspace.id, req.body.brand_id);
    if (!brand) {
        return res.status(400).json({
            error: 'Invalid request body',
            details: [{ path: 'brand_id', message: 'Brand not found in this workspace' }]
        });
    }

    const category = await categories.createCategory(req.workspace.id, req.body);
    res.status(201).json(category);
});

router.get('/', async (req, res) => {
    res.json(await categories.listCategories(req.workspace.id));
});

router.get('/:categoryId', requireCategory, (req, res) => {
    res.json(req.category);
});

router.patch('/:categoryId', requireCategory, validateBody(updateCategoryBody), async (req, res) => {
    res.json(await categories.updateCategory(req.workspace.id, req.category.id, req.body));
});

router.delete('/:categoryId', requireCategory, async (req, res) => {
    await categories.deleteCategory(req.workspace.id, req.category.id);
    res.status(204).send();
});

// alert feed: how category's cited sources and brand's standing moved between runs
router.get('/:categoryId/shifts', requireCategory, async (req, res) => {
    const filter = shiftsFilter.safeParse(req.query);
    if (!filter.success) {
        return res.status(400).json({
            error: 'Invalid query parameters',
            details: filter.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
        });
    }
    res.json(await listCategoryShifts(req.category.id, filter.data));
});

router.use('/:categoryId/queries', requireCategory, queryRoutes);
router.use('/:categoryId/runs', requireCategory, harvestRoutes);

export default router;
