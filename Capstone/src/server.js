import { env } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { startJobs, stopJobs } from './lib/jobs.js';

// bring schema up to date before accepting requests
await migrate();
// job queue + harvest worker run in same process as api
await startJobs();

const app = createApp();

const server = app.listen(env.port, () => {
    console.log(`Priors API listening on port ${env.port}`);
});

// interrupted harvest retried by pg-boss
// resumes from saved answers
async function shutdown(signal) {
    console.log(`${signal} received, shutting down`);
    server.close();
    await stopJobs();
    process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
