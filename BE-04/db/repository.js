const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

module.exports = {
  // get all tasks
  getTasks: async () => {
    const result = await pool.query('SELECT * FROM tasks');
    return result.rows;
  },

  // get a task by its ID
  getTaskById: async (id) => {
    const result = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    return result.rows[0];
  },

  // create a new task
  createTask: async (title) => {
    const result = await pool.query(
      'INSERT INTO tasks (title, done) VALUES ($1, $2) RETURNING *',
      [title, false]
    );
    return result.rows[0];
  },

  // update an existing task
  updateTask: async (id, title, done) => {
    const result = await pool.query(
      'UPDATE tasks SET title = $1, done = $2 WHERE id = $3 RETURNING *',
      [title, done, id]
    );
    return result.rows[0];
  },

  // delete a task
  deleteTask: async (id) => {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    return result.rowCount > 0;
  }
};
