import { env } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';

// bring schema up to date before accepting requests
await migrate();

const app = createApp();

app.listen(env.port, () => {
    console.log(`Priors API listening on port ${env.port}`);
});
