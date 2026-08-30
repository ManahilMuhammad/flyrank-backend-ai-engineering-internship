import express from 'express';
import { supabase } from '../lib/supabaseClient.js';

const router = express.Router();

// create an account
router.post('/signup', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const { data, error } = await supabase.auth.signUp({
            email,
            password
        });

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        return res.status(201).json(data.user);
    } catch (err) {
        console.error('Signup error: ', err);
        return res.status(500).json({ error: 'Signup failed' });
    }
});

// log in using an existing account
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            return res.status(401).json({ error: 'Invalid login credentials' });
        }

        return res.status(200).json({
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token
        });
    } catch (err) {
        console.error('Login error: ', err);
        return res.status(500).json({ error: 'Login failed' });
    }
});

export default router;
