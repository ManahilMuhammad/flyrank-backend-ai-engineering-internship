import express from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { signUp, signIn } from '../lib/supabase.js';

const router = express.Router();

const credentials = z.object({
    email: z.string().trim().email(),
    password: z.string().min(6)
}).strict();

// create account
router.post('/signup', validateBody(credentials), async (req, res) => {
    const { user, session } = await signUp(req.body.email, req.body.password);
    res.status(201).json({
        user: { id: user.id, email: user.email },
        confirmation_required: !session
    });
});

// exchange email + password for access token to send as 'Authorization: Bearer <token>'
router.post('/login', validateBody(credentials), async (req, res) => {
    const session = await signIn(req.body.email, req.body.password);
    res.status(200).json({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at
    });
});

// who token belongs to
router.get('/me', requireAuth, (req, res) => {
    res.status(200).json(req.user);
});

export default router;
