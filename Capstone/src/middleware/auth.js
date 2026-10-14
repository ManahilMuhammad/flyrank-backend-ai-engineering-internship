import { getUserFromToken } from '../lib/supabase.js';

// requires a valid supabase access token then sets req.user = { id, email }
export async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Access token required' });
    }

    // get characters after 'Bearer ' which is 7 characters long
    const token = authHeader.slice(7).trim();
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    const user = await getUserFromToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = user;
    next();
}
