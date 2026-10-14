import express from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, requireRole } from '../middleware/workspace.js';
import { validateBody } from '../middleware/validate.js';
import * as workspaces from '../db/workspaces.js';
import brandRoutes from './brands.js';

const router = express.Router();

const workspaceBody = z.object({
    name: z.string().trim().min(1).max(100)
}).strict();

// every workspace route needs logged in user
router.use(requireAuth);

router.post('/', validateBody(workspaceBody), async (req, res) => {
    const workspace = await workspaces.createWorkspace(req.user.id, req.body.name);
    res.status(201).json(workspace);
});

router.get('/', async (req, res) => {
    res.json(await workspaces.listWorkspacesForUser(req.user.id));
});

router.get('/:workspaceId', requireWorkspace, (req, res) => {
    res.json(req.workspace);
});

router.patch('/:workspaceId', requireWorkspace, requireRole('owner'), validateBody(workspaceBody), async (req, res) => {
    const workspace = await workspaces.renameWorkspace(req.workspace.id, req.body.name);
    res.json({ ...workspace, role: req.workspace.role });
});

router.delete('/:workspaceId', requireWorkspace, requireRole('owner'), async (req, res) => {
    await workspaces.deleteWorkspace(req.workspace.id);
    res.status(204).send();
});

// tenant owned resources live under /workspaces/:workspaceId/
router.use('/:workspaceId/brands', requireWorkspace, brandRoutes);

export default router;
