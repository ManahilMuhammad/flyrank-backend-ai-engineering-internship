import { PgBoss } from 'pg-boss';
import { env } from '../config.js';
import { finishRun } from '../db/harvests.js';
import { runHarvest } from '../services/harvester.js';
import { fetchRunSources } from '../services/sourceFetcher.js';

// background jobs live in postgres so queued harvests survive restarts
// harvest -> fetch sources (each step queues next after succeeding)

export const HARVEST_QUEUE = 'harvest';
export const FETCH_QUEUE = 'fetch-sources';
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
    // exclusive: one queued or active fetch per run (singletonKey = run id)
    await boss.createQueue(FETCH_QUEUE, {
        policy: 'exclusive',
        expireInSeconds: 60 * 60,
        retryLimit: 1,
        retryDelay: 60
    });

    await boss.work(HARVEST_QUEUE, async ([job]) => {
        let status;
        try {
            status = await runHarvest(job.data.runId, { signal: job.signal });
        } catch (err) {
            // retries resume run
            // only last attempt marks failed
            console.error(`Harvest ${job.data.runId} attempt ${job.retryCount + 1} crashed: `, err.message);
            if (job.retryCount >= HARVEST_RETRY_LIMIT) {
                await finishRun(job.data.runId, { status: 'failed', error: 'Harvest crashed, see server logs' });
            }
            throw err;
        }
        if (status === 'completed') await enqueueFetch(job.data.runId);
    });

    await boss.work(FETCH_QUEUE, async ([job]) => {
        await fetchRunSources(job.data.runId);
    });
}

export async function enqueueHarvest(runId) {
    if (!boss) throw new Error('Job queue is not started');
    return boss.send(HARVEST_QUEUE, { runId });
}

// returns null when fetch already queued or running
export async function enqueueFetch(runId) {
    if (!boss) throw new Error('Job queue is not started');
    return boss.send(FETCH_QUEUE, { runId }, { singletonKey: runId });
}

export async function stopJobs() {
    await boss?.stop({ graceful: true, timeout: 10_000 });
    boss = null;
}
