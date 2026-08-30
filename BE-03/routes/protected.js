import express from 'express';

const router = express.Router();

// protected profile
router.get('/profile', (req, res) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Access token required' });
    }

    // get characters after 'Bearer ' which is 7 characters long
    const token = authHeader.slice(7);

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    res.status(200).json({ message: 'Token received', token });
});

export default router;
