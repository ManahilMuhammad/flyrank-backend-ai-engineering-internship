<p align="center"> 
  <img src="https://github.com/user-attachments/assets/b82e4d9c-d246-4bfd-a675-95bb6586a71e" 
    alt="Task API — FlyRank AI Engineering Internship" 
    width="100%" /> 
</p> 

<div align="center">

![Node](https://img.shields.io/badge/Node.js-18+-3EF589?style=flat-square&labelColor=0C1E17)
![Express](https://img.shields.io/badge/Express-5-3EF589?style=flat-square&labelColor=0C1E17)
![Status](https://img.shields.io/badge/status-working-3EF589?style=flat-square&labelColor=0C1E17)

</div>

---

## What this is

Task API is a small REST API built with **Node.js** and **Express** that manages a list of tasks. It supports the full set of CRUD operations — create, read, update, and delete — plus a health check and a root info endpoint. Interactive documentation is served with Swagger UI at [`/docs`](http://localhost:3000/docs).

Built during the **FlyRank Backend AI Engineering internship**.

> **Note:** tasks are stored in memory, so the list resets to its seed data each time the server restarts.

## Install & Run

Requires Node.js 18+.

```bash
npm install
```

Then start the server with a single command:

```bash
npm start
```

The server runs on `http://localhost:3000`, and Swagger docs are at `http://localhost:3000/docs`.

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
$ curl -i -X POST http://localhost:3000/tasks -H "Content-Type: application/json" -d "{\"title\":\"Buy milk\"}"
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
