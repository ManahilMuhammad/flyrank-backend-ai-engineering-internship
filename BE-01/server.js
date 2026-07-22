const express = require('express');
const app = express();
const port = 3000;

app.use(express.json());

// list of tasks in memory
let inMemory = [
    {
        "id": 0,
        "title": "Write project report",
        "done": false
    },
    {
        "id": 1,
        "title": "Review code",
        "done": false
    },
    {
        "id": 2,
        "title": "Finish Stage 2",
        "done": true
    }
];

app.get('/', (req, res) => {
    apiDescription = {
        "name": "Task API",
        "version": "1.0",
        "endpoints": ["/tasks"]
    };
    res.json(apiDescription);
});

// health
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// tasks -- return all tasks
app.get('/tasks', (req, res) => {
    res.json(inMemory);
});

// return task with specified ID
app.get('/tasks/:id', (req, res) => {
    const ID = req.params.id;
    let task = inMemory.find(task => task.id == ID);
    let errorMessage = `Task ${ID} not found`;
    
    if (task == undefined) {
        return res.status(404).json({ "error": errorMessage });
    }

    res.json(task);
});

// add new task
app.post('/tasks', (req, res) => {
    let title = req.body.title;
    let errorMessage = "No title provided";

    if (title == undefined || title == "") {
        return res.status(400).json({ "error": errorMessage });
    }

    let task = {
        "id": inMemory.length,
        "title": title,
        "done": false
    };

    inMemory.push(task);

    res.status(201).json(task);
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
