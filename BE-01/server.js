const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./openapi.json');
const app = express();
const port = 3000;

app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

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

    const ID = inMemory.length === 0 ? 0 : inMemory[inMemory.length - 1].id + 1;

    if (title == undefined || title == "") {
        return res.status(400).json({ "error": errorMessage });
    }

    let task = {
        "id": ID,
        "title": title,
        "done": false
    };

    inMemory.push(task);

    res.status(201).json(task);
});

// change task
app.put('/tasks/:id', (req, res) => {
    const ID = req.params.id;
    let title = req.body.title;
    let done = req.body.done;

    let task = inMemory.find(task => task.id == ID);
    let index = inMemory.findIndex(task => task.id == ID);

    let idError = `Task ${ID} not found`;
    let bodyError = "Empty or invalid title or done value provided";
    
    if (task == undefined) {
        return res.status(404).json({ "error": idError });
    }
    if (title == "" || title == undefined || typeof done !== "boolean") {
        return res.status(400).json({ "error": bodyError });
    }

    inMemory[index].title = title;
    inMemory[index].done = done;

    let updatedTask = inMemory[index];
    
    res.json(updatedTask);
});

// delete task
app.delete('/tasks/:id', (req, res) => {
    const ID = req.params.id;
    let index = inMemory.findIndex(task => task.id == ID);

    if (index === -1) {
        return res.status(404).send();
    }

    inMemory.splice(index, 1);

    return res.status(204).send();
});

// start server
app.listen(port, () => {
    console.log(`Task API listening on port ${port}`);
});
