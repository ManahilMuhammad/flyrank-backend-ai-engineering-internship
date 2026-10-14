import { z } from 'zod';

// reusable schemas
export const uuid = z.string().uuid();

// validate req.body against zod schema and replace with parsed (trimmed, defaulted) value
export function validateBody(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body ?? {});
        if (!result.success) {
            return res.status(400).json({
                error: 'Invalid request body',
                details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
            });
        }
        req.body = result.data;
        next();
    };
}

// malformed id cant match any row so treat as not found
export function requireUuidParam(name, label) {
    return (req, res, next) => {
        if (!uuid.safeParse(req.params[name]).success) {
            return res.status(404).json({ error: `${label} not found` });
        }
        next();
    };
}
