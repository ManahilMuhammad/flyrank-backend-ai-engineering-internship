<p align="center"> 
  <img src="https://github.com/user-attachments/assets/35da835f-3374-42ea-925a-b37de0e1b613" 
    alt="Task API — FlyRank AI Engineering Internship" 
    width="100%" /> 
</p> 

<div align="center">

![Node](https://img.shields.io/badge/Node.js-18+-3EF589?style=flat-square&labelColor=0C1E17)
![Express](https://img.shields.io/badge/Express-5-3EF589?style=flat-square&labelColor=0C1E17)
![SQLite](https://img.shields.io/badge/SQLite-3-3EF589?style=flat-square&labelColor=0C1E17)
![Status](https://img.shields.io/badge/status-working-3EF589?style=flat-square&labelColor=0C1E17)

</div>

---

## What this is

Task API is a small REST API built with **Node.js**, **Express**, and **SQLite** that manages a list of tasks. It supports the full set of CRUD operations — create, read, update, and delete — with data persisted to a SQLite database. Interactive documentation is served with Swagger UI at [`/docs`](http://localhost:3001/docs).

This builds on [BE-01](https://github.com/ManahilMuhammad/flyrank-backend-ai-engineering-internship/tree/main/BE-01) by replacing the in-memory array with a persistent SQLite database, so tasks survive server restarts.

Built during the **FlyRank Backend AI Engineering internship**.

## Install & Run

Requires Node.js 18+.

After cloning the root directory, run:

```bash
npm install --save-dev cross-env
```

Then start the server with:

```bash
npm run be-02
```

The server runs on `http://localhost:3001`, and Swagger docs are at `http://localhost:3001/docs`.
The database is created automatically on the first run with three seed tasks.

## Database

### Why SQLite?

SQLite was chosen for this project because:
- **Easy setup:** No server required and no installation beyond the npm package
- **Embedded:** The database is a single file (`tasks.db`) that lives in the project folder
- **Perfect for development:** Ideal for learning and prototyping without complexity

### Database File Location

The database file is stored inside the assignment folder:
```
flyrank-backend-ai-engineering-internship/
├── BE-01/
├── BE-02/
│ ├── tasks.db
│ ├── README.md
| ├── openapi.json
│ └── server.js
├── package.json
└── .gitignore
```

The file is automatically created the first time your application runs. It is excluded from version control (see `.gitignore`).

### Example SQL Query

Open the database in [DB Browser for SQLite](https://sqlitebrowser.org/) and run:

```sql
SELECT * FROM tasks WHERE done = 1;
```

This returns all completed tasks. Here is a screenshot of the database viewer:

![DB Browser SQLite](https://github.com/user-attachments/assets/bb3b9f0b-02e6-492a-a281-5f2b2345737a)

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | API name, version, and available endpoints |
| `GET` | `/health` | Health check — returns `{ "status": "ok" }` |
| `GET` | `/tasks` | List all tasks |
| `POST` | `/tasks` | Create a new task (body: `{ "title": "..." }`) |
| `GET` | `/tasks/:id` | Get a single task by ID |
| `PUT` | `/tasks/:id` | Update a task (body: `{ "title": "...", "done": true }`) |
| `DELETE` | `/tasks/:id` | Delete a task by ID |

## Example request

```console
$ curl -i -X POST http://localhost:3001/tasks -H "Content-Type: application/json" -d "{\"title\":\"Buy milk\"}"
HTTP/1.1 201 Created
X-Powered-By: Express
Content-Type: application/json; charset=utf-8
Content-Length: 40
ETag: W/"28-fT1VFSUPmXQzC9VdHn9hj/qmT9g"
Date: Wed, 22 Jul 2026 06:47:55 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":0,"title":"Buy milk","done":false}
```

## API Documentation (Swagger UI)

Interactive docs are generated from [`openapi.json`](./openapi.json) and served at `/docs`. The screenshot below shows the Swagger UI:

![Swagger UI](https://github.com/user-attachments/assets/84428bff-e73e-4637-96a6-0f49fa52780e)
