import express from 'express';
import { supabase } from '../lib/supabaseClient.js';

const router = express.Router();

// protected profile
router.get('/profile', async (req, res) => {
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

        return res.status(200).json({
            id: data.user.id,
            email: data.user.email,
            created_at: data.user.created_at
        });
    } catch (err) {
        console.error('Token verification error: ', err);
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
});

export default router;
