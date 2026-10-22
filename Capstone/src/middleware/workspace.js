import { uuid } from './validate.js';
import { getWorkspaceForUser, syncMemberEmail } from '../db/workspaces.js';

// requires req.user to be a member of workspaceId
// sets req.workspace = { id, name, created_at, role }
// non-members get 404 not 403 so one tenant can't know which workspace ids exist
export async function requireWorkspace(req, res, next) {
    const { workspaceId } = req.params;

    if (!uuid.safeParse(workspaceId).success) {
        return res.status(404).json({ error: 'Workspace not found' });
    }

    const workspace = await getWorkspaceForUser(workspaceId, req.user.id);
    if (!workspace) {
        return res.status(404).json({ error: 'Workspace not found' });
    }

    // keep member's email current for report delivery (no write unless it changed)
    const { email, ...rest } = workspace;
    if (req.user.email && email !== req.user.email) {
        await syncMemberEmail(workspace.id, req.user.id, req.user.email);
    }

    req.workspace = rest;
    next();
}

export function requireRole(role) {
    return (req, res, next) => {
        if (req.workspace.role !== role) {
            return res.status(403).json({ error: `Only a workspace ${role} can do this` });
        }
        next();
    };
}
