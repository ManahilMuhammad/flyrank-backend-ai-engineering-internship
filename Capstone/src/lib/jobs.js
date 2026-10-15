import { PgBoss } from 'pg-boss';
import { env } from '../config.js';
import { finishRun } from '../db/harvests.js';
import { runHarvest } from '../services/harvester.js';

// background jobs live in postgres so queued harvests survive restarts

export const HARVEST_QUEUE = 'harvest';
const HARVEST_RETRY_LIMIT = 2;

let boss = null;

export async function startJobs() {
    boss = new PgBoss(env.databaseUrl);
    boss.on('error', err => console.error('Job queue error: ', err.message));
    await boss.start();

    await boss.createQueue(HARVEST_QUEUE, {
        expireInSeconds: 4 * 60 * 60,
        // crashed worker stops heartbeating
        // so job retried in minutes rather than at expiry
        heartbeatSeconds: 60,
        retryLimit: HARVEST_RETRY_LIMIT,
        retryDelay: 30
    });

    await boss.work(HARVEST_QUEUE, async ([job]) => {
        try {
            await runHarvest(job.data.runId, { signal: job.signal });
        } catch (err) {
            // retries resume run, only last attempt marks it failed
            console.error(`Harvest ${job.data.runId} attempt ${job.retryCount + 1} crashed: `, err.message);
            if (job.retryCount >= HARVEST_RETRY_LIMIT) {
                await finishRun(job.data.runId, { status: 'failed', error: 'Harvest crashed, see server logs' });
            }
            throw err;
        }
    });
}

export async function enqueueHarvest(runId) {
    if (!boss) throw new Error('Job queue is not started');
    return boss.send(HARVEST_QUEUE, { runId });
}

export async function stopJobs() {
    await boss?.stop({ graceful: true, timeout: 10_000 });
    boss = null;
}
