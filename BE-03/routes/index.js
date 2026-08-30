import express from 'express';
import {supabase} from '../lib/supabaseClient.js';

const router = express.Router();

router.get('/', (req, res) => {
    const apiDescription = {
        "name": "Task API",
        "version": "1.0",
        "endpoints": ["/tasks"]
    };

    res.json(apiDescription);
});

// health
router.get('/health', async (req, res) => {
    try {
        await supabase.auth.getSession()
        console.log('Server running and connected to Supabase');
        res.status(200).json({ status: 'ok', message: 'Connected to Supabase' });
    } catch (error) {
        console.error('Supabase connection failed: ', error);
        res.status(500).json({ error: 'Supabase connection failed' });
    }
});

export default router;