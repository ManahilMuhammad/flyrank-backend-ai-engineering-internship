// load environment variables from root .env file
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./openapi.json');
const app = express();
const port = process.env.PORT || 3000;

// connect database
const db = require('../db/repository');

app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));

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
app.get('/tasks', async (req, res) => {
    const tasks = await db.getTasks();
    res.json(tasks);
});

// return task with specified ID
app.get('/tasks/:id', async (req, res) => {
    const ID = req.params.id;
    const task = await db.getTaskById(ID);

    if (!task) {
        return res.status(404).json({ error: `Task ${ID} not found` });
    }

    res.json(task);
});

// add new task
app.post('/tasks', async (req, res) => {
    let title = req.body.title;

    if (title == undefined || title == "") {
        return res.status(400).json({ error: 'No title provided' });
    }

    const task = await db.createTask(title);

    res.status(201).json(task);
});

// update task
app.put('/tasks/:id', async (req, res) => {
    const ID = req.params.id;
    let title = req.body.title;
    let doneVal = req.body.done;

    // validate so only true, false, 0, 1, 'true', 'false' allowed as done values
    if (
        typeof doneVal !== 'boolean'
        && doneVal !== 0 && doneVal !== 1 &&
        doneVal !== 'true' && doneVal !== 'false'
    ) {
        return res.status(400).json({ error: 'Empty or invalid done value provided' });
    }

    // convert from other boolean representations to 0/1 so sql understands
    let done = doneVal === true || doneVal === 1 || doneVal === 'true' ? 1 : 0;

    if (title == "" || title == undefined) {
        return res.status(400).json({ error: 'Empty or invalid title value provided' });
    }

    const task = await db.updateTask(ID, title, done);

    if (!task) {
        return res.status(404).json({ error: `Tasl ${ID} not found` });
    }

    res.json(task);
});

// delete task
app.delete('/tasks/:id', async (req, res) => {
    const ID = req.params.id;

    const deleted = await db.deleteTask(ID);

    if (!deleted) {
        return res.status(404).send();
    }

    return res.status(204).send();
});

// start server
app.listen(port, () => {
    console.log(`Task API listening on port ${port}`);
});