import express from 'express';
import { z } from 'zod';
import { validateBody, uuid } from '../middleware/validate.js';
import * as categories from '../db/categories.js';
import { getBrand } from '../db/brands.js';
import queryRoutes from './queries.js';

// mounted under /workspaces/:workspaceId/categories 
// after requireWorkspace so req.workspace is set
const router = express.Router({ mergeParams: true });

const categoryFields = {
    name: z.string().trim().min(1).max(100),
    // fed to query generator so context improves query set
    description: z.string().trim().max(1000).nullable()
};

const createCategoryBody = z.object({
    brand_id: uuid,
    name: categoryFields.name,
    description: categoryFields.description.optional()
}).strict();

const updateCategoryBody = z.object(categoryFields).partial().strict().refine(
    v => Object.keys(v).length > 0,
    'Provide at least one of: name, description'
);

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

router.use('/:categoryId/queries', requireCategory, queryRoutes);

export default router;
