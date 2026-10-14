import express from 'express';
import swaggerUi from 'swagger-ui-express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import indexRoutes from './routes/index.js';
import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspaces.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const openapiSpec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../openapi.json'), 'utf-8'));

const swaggerUiOptions = {
    swaggerOptions: {
        persistAuthorization: true,
        deepLinking: true
    }
};

// app built separately from server so tests can use it without opening a port
export function createApp() {
    const app = express();

    app.use(express.json());

    app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, swaggerUiOptions));
    app.use('/', indexRoutes);
    app.use('/auth', authRoutes);
    app.use('/workspaces', workspaceRoutes);

    // unknown routes
    app.use((req, res) => {
        res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
    });

    // forward rejected promises from async handlers
    app.use((err, req, res, next) => {
        // Postgres unique violation, e.g. renaming a query to text that already exists in the category
        if (err.code === '23505') {
            return res.status(409).json({ error: 'That already exists' });
        }

        const status = err.status || 500;
        // client errors != server faults so only log stack traces for unexpected 5xx
        // (expected ones like an LLM outage are already logged where they happen)
        if (status >= 500 && !err.expose) console.error('Unhandled error: ', err);
        res.status(status).json({ error: err.expose ? err.message : 'Internal server error' });
    });

    return app;
}
