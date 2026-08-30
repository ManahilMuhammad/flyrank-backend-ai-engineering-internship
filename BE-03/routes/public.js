import express from 'express';

const router = express.Router();

// public info
router.get('/info', (req, res) => {
    res.status(200).json({ message: 'Welcome stranger! This info is public.' });
});

export default router;
