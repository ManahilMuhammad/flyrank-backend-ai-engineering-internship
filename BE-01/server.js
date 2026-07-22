const express = require('express');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
    apiDescription = {
        "name": "Task API",
        "version": "1.0",
        "endpoints": ["/tasks"]
    }
    res.json(apiDescription)
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
