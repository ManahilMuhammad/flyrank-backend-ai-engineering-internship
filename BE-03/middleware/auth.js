import { supabase } from '../lib/supabaseClient.js';

export const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Access token required' });
    }

    // get characters after 'Bearer ' which is 7 characters long
    const token = authHeader.slice(7);

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const { data, error } = await supabase.auth.getUser(token);

        if (error || !data.user) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        // store user in request for the route to access
        req.user = data.user;
        next();
    } catch (err) {
        console.error('Token verification error: ', err);
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};