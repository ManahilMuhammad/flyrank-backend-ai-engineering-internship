<p align="center"> 
  <img src="https://github.com/user-attachments/assets/87398ce4-9416-449a-b3d0-0c078d86becf" 
    alt="Task API — FlyRank AI Engineering Internship" 
    width="100%" /> 
</p> 

<div align="center">

![Node](https://img.shields.io/badge/Node.js-18+-3EF589?style=flat-square&labelColor=0C1E17)
![Express](https://img.shields.io/badge/Express-5-3EF589?style=flat-square&labelColor=0C1E17)
![Postgres](https://img.shields.io/badge/Postgres-16-3EF589?style=flat-square&labelColor=0C1E17)
![Supabase](https://img.shields.io/badge/Supabase-Auth-3EF589?style=flat-square&labelColor=0C1E17)
![Status](https://img.shields.io/badge/status-working-3EF589?style=flat-square&labelColor=0C1E17)

</div>

---

## What this is

Task API is a secure REST API built with **Node.js**, **Express**, **Postgres**, and **Supabase** that implements complete authentication patterns: signup, login, logout, token verification, and protected routes with JWT middleware.

This builds on [BE-04](https://github.com/ManahilMuhammad/flyrank-backend-ai-engineering-internship/tree/main/BE-04) by adding the **security layer** on top of the persistent database infrastructure. While BE-04 focused on data persistence with Docker and Postgres, BE-03 adds **authentication and authorization** to control who can access and modify data.

Features:
- **Public endpoints** accessible to anyone
- **Protected endpoints** requiring a valid JWT token
- **Auth middleware** that validates tokens before route execution
- **Swagger UI** for interactive API documentation with bearer auth

Built during the **FlyRank Backend AI Engineering internship**.

## Setup

### Prerequisites
- Node.js 18+
- Docker Desktop (for Postgres)
- Supabase account (free tier also works)

### Environment Variables

After cloning the root directory, create a `.env` file at the root (copy from `.env.example`) including the following:
```
DATABASE_URL=postgresql://postgres:password@localhost:5432/tasks_db
NODE_ENV=development

SUPABASE_URL=your_project_url
SUPABASE_KEY=your_anon_key
PORT=3002
```

Replace the placeholders with your own Supabase values. These can be found by following the steps below:
- Go to [supabase.com](https://supabase.com)
- Create a new project
- Navigate to **Settings -> API**
- Copy your **Project URL** and **Anon Key**

### Running Locally

Open two terminals and navigate to the root directory in both of them.

**Terminal 1:** Start Postgres
```bash
docker compose up
```

**Terminal 2:** Install dependencies and start the server
```bash
npm install --save-dev cross-env
npm run be-03
```

The server runs on `http://localhost:3002`.

## API Reference

| Method | Endpoint | Auth Required | Description |
|--------|----------|---------------|-------------|
| `GET` | `/` | ❌ | API info and available endpoints |
| `GET` | `/health` | ❌ | Health check (Supabase connection) |
| `GET` | `/public/info` | ❌ | Public information |
| `POST` | `/auth/signup` | ❌ | Register a new account |
| `POST` | `/auth/login` | ❌ | Login and receive JWT tokens |
| `POST` | `/auth/logout` | ✅ | Logout (invalidate session) |
| `GET` | `/protected/profile` | ✅ | Get authenticated user's profile |
| `GET` | `/protected/dashboard` | ✅ | Get user's dashboard |

### Authentication

Protected endpoints require an `Authorization` header with a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" http://localhost:3002/protected/profile
```

## Example Workflow

**1. Sign up:**
```bash
curl -X POST http://localhost:3002/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'
```

**2. Login:**
```bash
curl -X POST http://localhost:3002/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'
```

Response includes `access_token`.

**3. Access protected route:**
```bash
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  http://localhost:3002/protected/profile
```

**Note:** On Windows, curl requires double quotes to be escaped with backslashes. If you're using `cmd.exe`, replace single quotes with double quotes and escape inner quotes. For example:

**macOS/Linux:**
```bash
curl -d '{"email":"user@example.com","password":"password123"}'
```

**Windows (cmd.exe):**
```bash
curl -d "{\"email\":\"user@example.com\",\"password\":\"password123\"}"
```

Alternatively, use **PowerShell** or **Git Bash** which handle quotes like Unix shells.

## Swagger UI

Interactive API documentation is available at [`/docs`](http://localhost:3002/docs). You can:
- Click the "Authorize" button to paste your JWT token
- Test all endpoints directly from your browser
- See request/response schemas

![Swagger UI](https://github.com/user-attachments/assets/87b74a53-ae75-4f1a-802b-48234d731720)

## Architecture

- **Routes**: Organised by concern (auth, protected, public)
- **Middleware**: Token verification extracted into reusable `verifyToken` middleware
- **Database**: Postgres for task persistence
- **Auth**: Supabase handles user management and JWT issuance
