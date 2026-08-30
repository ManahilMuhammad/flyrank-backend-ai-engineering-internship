import express from 'express';
import { verifyToken } from '../middleware/auth.js';

const router = express.Router();

// protected profile
router.get('/profile', verifyToken, async (req, res) => {
    res.status(200).json({
        id: req.user.id,
        email: req.user.email,
        created_at: req.user.created_at
    });
});

// dashboard
router.get('/dashboard', verifyToken, async (req, res) => {
    res.status(200).json({
        message: `Welcome ${req.user.email}! This is your dashboard`,
        user_id: req.user.id
    });
});

export default router;
