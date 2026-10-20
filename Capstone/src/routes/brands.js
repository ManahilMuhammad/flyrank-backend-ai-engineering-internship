import express from 'express';
import { z } from 'zod';
import { validateBody, requireUuidParam } from '../middleware/validate.js';
import * as brands from '../db/brands.js';

// mounted under /workspaces/:workspaceId/brands after requireWorkspace
// so req.workspace is set
const router = express.Router({ mergeParams: true });

const MAX_FACT_SHEET_CHARS = 20000;

const brandFields = {
    name: z.string().trim().min(1).max(100),
    // up to 20 other names the brand appears as e.g. 'FlyRank AI' & 'flyrank.ai'
    aliases: z.array(z.string().trim().min(1).max(100)).max(20),
    // sites brand owns e.g. 'flyrank.ai' own pages not audited as third party sources
    domains: z.array(
        z.string().trim().toLowerCase()
            .transform(d => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''))
            .pipe(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'must be a domain like flyrank.ai'))
    ).max(20),
    // for staleness checks
    fact_sheet: z.record(z.unknown()).refine(
        v => JSON.stringify(v).length <= MAX_FACT_SHEET_CHARS,
        `fact_sheet must be at most ${MAX_FACT_SHEET_CHARS} characters of JSON`
    )
};

const createBrandBody = z.object({
    name: brandFields.name,
    aliases: brandFields.aliases.default([]),
    domains: brandFields.domains.default([]),
    fact_sheet: brandFields.fact_sheet.default({})
}).strict();

const updateBrandBody = z.object(brandFields).partial().strict().refine(
    v => Object.keys(v).length > 0,
    'Provide at least one of: name, aliases, domains, fact_sheet'
);

router.post('/', validateBody(createBrandBody), async (req, res) => {
    const brand = await brands.createBrand(req.workspace.id, req.body);
    res.status(201).json(brand);
});

router.get('/', async (req, res) => {
    res.json(await brands.listBrands(req.workspace.id));
});

router.get('/:brandId', requireUuidParam('brandId', 'Brand'), async (req, res) => {
    const brand = await brands.getBrand(req.workspace.id, req.params.brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json(brand);
});

router.patch('/:brandId', requireUuidParam('brandId', 'Brand'), validateBody(updateBrandBody), async (req, res) => {
    const brand = await brands.updateBrand(req.workspace.id, req.params.brandId, req.body);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json(brand);
});

router.delete('/:brandId', requireUuidParam('brandId', 'Brand'), async (req, res) => {
    const deleted = await brands.deleteBrand(req.workspace.id, req.params.brandId);
    if (!deleted) return res.status(404).json({ error: 'Brand not found' });
    res.status(204).send();
});

export default router;
