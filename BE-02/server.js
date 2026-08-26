const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./openapi.json');
const app = express();
const port = process.env.PORT || 3000;

// connect database
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('tasks.db');

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

// create the table of tasks if not already created
db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    done BOOLEAN DEFAULT 0
    )
`);

// add default tasks if first time running
db.get('SELECT COUNT(*) as count FROM tasks', (err, row) => {
    if (err) {
        console.log("Could not select row count: ", err);
        return;
    }

    if (row.count == 0) {
        for (i = 0; i < inMemory.length; i++) {
            db.run('INSERT INTO tasks (title, done) VALUES (?, ?)', [inMemory[i].title, inMemory[i].done]);
        }
    }
});

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
    db.all('SELECT * FROM tasks', (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        res.json(rows);
    });
});

// return task with specified ID
app.get('/tasks/:id', (req, res) => {
    const ID = req.params.id;

    db.get('SELECT * FROM tasks WHERE id = ?', [ID], (err, row) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) {
            return res.status(404).json({ error: `Task ${ID} not found` });
        }

        res.json(row);
    });
});

// add new task
app.post('/tasks', (req, res) => {
    let title = req.body.title;

    if (title == undefined || title == "") {
        return res.status(400).json({ error: 'No title provided' });
    }

    db.run('INSERT INTO tasks (title, done) VALUES (?, ?)', [title, 0], function (err) {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        const task = {
            id: this.lastID,
            title: title,
            done: 0
        };

        res.status(201).json(task);
    });
});

// update task
app.put('/tasks/:id', (req, res) => {
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

    db.run('UPDATE tasks SET title = ?, done = ? WHERE id = ?', [title, done, ID], function (err) {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: `Task ${ID} not found` });
        }

        const task = {
            id: ID,
            title: title,
            done: done
        };

        res.json(task);
    });
});

// delete task
app.delete('/tasks/:id', (req, res) => {
    const ID = req.params.id;

    db.run('DELETE FROM tasks WHERE id = ?', [ID], function (err) {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (this.changes === 0) {
            return res.status(404).send();
        }

        return res.status(204).send();
    });
});

// start server
app.listen(port, () => {
    console.log(`Task API listening on port ${port}`);
});