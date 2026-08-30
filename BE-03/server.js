import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') }); // load environment variables from root .env file

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import fs from 'fs';

const openapiSpec = JSON.parse(fs.readFileSync(path.join(__dirname, './openapi.json'), 'utf-8'));

// get routes
import indexRoutes from  './routes/index.js';
import tasksRoutes from './routes/tasks.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// assign routes
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
app.use('/', indexRoutes);
app.use('/tasks', tasksRoutes);

// start server
app.listen(port, () => {
    console.log(`Task API listening on port ${port}`);
});