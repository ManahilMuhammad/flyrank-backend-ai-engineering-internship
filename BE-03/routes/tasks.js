import express from 'express';
import db from '../db/repository.js';

const router = express.Router();

// tasks -- return all tasks
router.get('/', async (req, res) => {
    const tasks = await db.getTasks();
    res.json(tasks);
});

// add new task
router.post('/', async (req, res) => {
    let title = req.body.title;

    if (title == undefined || title == "") {
        return res.status(400).json({ error: 'No title provided' });
    }

    const task = await db.createTask(title);

    res.status(201).json(task);
});

// return task with specified ID
router.get('/:id', async (req, res) => {
    const ID = req.params.id;
    const task = await db.getTaskById(ID);

    if (!task) {
        return res.status(404).json({ error: `Task ${ID} not found` });
    }

    res.json(task);
});

// update task
router.put('/:id', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
    const ID = req.params.id;

    const deleted = await db.deleteTask(ID);

    if (!deleted) {
        return res.status(404).send();
    }

    return res.status(204).send();
});

export default router;