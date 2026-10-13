import express from 'express';
import { pool } from '../db/pool.js';

const router = express.Router();

router.get('/', (req, res) => {
    res.json({
        name: 'Priors API',
        version: '0.1.0',
        description: 'Maps and scores the third-party sources AI engines cite for a category',
        docs: '/docs'
    });
});

// health checks database and reports latest applied migration
router.get('/health', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1'
        );
        res.status(200).json({ status: 'ok', database: 'connected', migration: rows[0]?.name ?? null });
    } catch (error) {
        // connection errors have empty message so fall back to code
        console.error('Database health check failed: ', error.code || error.message);
        res.status(503).json({ status: 'degraded', database: 'unreachable' });
    }
});

export default router;
