<p align="center"> 
  <img src="https://github.com/user-attachments/assets/2a5eed97-312b-476d-bf6b-4d876c42f149" 
    alt="Task API — FlyRank AI Engineering Internship" 
    width="100%" /> 
</p> 

<div align="center">

![Node](https://img.shields.io/badge/Node.js-18+-3EF589?style=flat-square&labelColor=0C1E17)
![Express](https://img.shields.io/badge/Express-5-3EF589?style=flat-square&labelColor=0C1E17)
![Postgres](https://img.shields.io/badge/Postgres-16-3EF589?style=flat-square&labelColor=0C1E17)
![Status](https://img.shields.io/badge/status-working-3EF589?style=flat-square&labelColor=0C1E17)

</div>

---

## What this is

Task API is a small REST API built with **Node.js**, **Express**, and **Postgres** that manages a list of tasks. It supports the full set of CRUD operations — create, read, update, and delete — with data persisted to a Postgres database in Docker. Interactive documentation is served with Swagger UI at [`/docs`](http://localhost:3003/docs).

This builds on [BE-02](https://github.com/ManahilMuhammad/flyrank-backend-ai-engineering-internship/tree/main/BE-02) by replacing SQLite with Postgres and containerising the database with Docker, so data persists across container restarts. The **service and routes remain unchanged**.

Built during the **FlyRank Backend AI Engineering internship**.

## Install & Run

Requires Node.js 18+ and Docker Desktop.

After cloning the root directory, run:

```bash
npm install --save-dev cross-env
```

Then in two separate terminals:

**Terminal 1:** Start Postgres
```bash
docker compose up
```

**Terminal 2:** Start the app
```bash
npm run be-04
```

## Persistence Test

To verify that data survives restarts:

1. In a 3rd terminal, create a task by running `curl -X POST http://localhost:3003/tasks -H "Content-Type: application/json" -d '{"title":"Test"}'` (for Windows, the final part would be `"{\"title\":\"Test\"}"`)
2. Verify it exists by running `curl http://localhost:3003/tasks`
3. Stop terminals 1 and 2 by pressing Ctrl+C
4. Restart terminals 1 and 2 by running `docker compose up` and `npm run be-04` again as mentioned in the previous section
5. Query the app again by running `curl http://localhost:3003/tasks` in the 3rd terminal

The task will persist across restarts because Postgres stores data on a Docker volume (`postgres_data`).

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
$ curl -i -X POST http://localhost:3003/tasks -H "Content-Type: application/json" -d "{\"title\":\"Buy milk\"}"
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
