import { PgBoss } from 'pg-boss';
import { env } from '../config.js';
import { finishRun } from '../db/harvests.js';
import { runHarvest } from '../services/harvester.js';
import { fetchRunSources } from '../services/sourceFetcher.js';
import { auditRunSources } from '../services/standingAuditor.js';
import { detectShifts } from '../services/shifts.js';
import { runScheduledHarvests } from '../services/scheduler.js';
import { generateReport } from '../services/report.js';

// background jobs live in postgres so queued harvests survive restarts
// weekly cron -> harvest -> fetch sources -> audit standings (+ leverage, shifts)
// each step queues next after succeeding

export const HARVEST_QUEUE = 'harvest';
export const FETCH_QUEUE = 'fetch-sources';
export const AUDIT_QUEUE = 'audit-standings';
export const SCHEDULE_QUEUE = 'weekly-harvest';
export const REPORT_QUEUE = 'send-report';
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

    // one queued or active audit per run 
    // run's audit can take time on paced llm calls
    await boss.createQueue(AUDIT_QUEUE, {
        policy: 'exclusive',
        expireInSeconds: 2 * 60 * 60,
        retryLimit: 1,
        retryDelay: 60
    });

    await boss.work(FETCH_QUEUE, async ([job]) => {
        await fetchRunSources(job.data.runId);
        await enqueueAudit(job.data.runId);
    });

    // audit also scores leverage
    // run complete enough to compare with last week's
    await boss.work(AUDIT_QUEUE, async ([job]) => {
        await auditRunSources(job.data.runId);
        await detectShifts(job.data.runId);
        await enqueueReport(job.data.runId);
    });

    // last step: pdf + email. separate job so a mail server outage retries only the email part
    await boss.createQueue(REPORT_QUEUE, { policy: 'exclusive', retryLimit: 2, retryDelay: 120 });
    await boss.work(REPORT_QUEUE, async ([job]) => {
        await generateReport(job.data.runId);
    });

    // weekly cron: pg-boss stores schedule in postgres and sends one job per tick
    // even with several app instances running
    await boss.createQueue(SCHEDULE_QUEUE, { retryLimit: 1, retryDelay: 300 });
    await boss.work(SCHEDULE_QUEUE, async () => {
        await runScheduledHarvests({ enqueue: enqueueHarvest });
    });
    if (env.harvestCron === 'off') {
        await boss.unschedule(SCHEDULE_QUEUE);
    } else {
        await boss.schedule(SCHEDULE_QUEUE, env.harvestCron, null, { tz: env.harvestCronTz });
        console.log(`Weekly harvest scheduled: "${env.harvestCron}" (${env.harvestCronTz})`);
    }
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

// returns null when audit already queued or running
export async function enqueueAudit(runId) {
    if (!boss) throw new Error('Job queue is not started');
    return boss.send(AUDIT_QUEUE, { runId }, { singletonKey: runId });
}

// returns null when report for run already queued or being sent
export async function enqueueReport(runId) {
    if (!boss) throw new Error('Job queue is not started');
    return boss.send(REPORT_QUEUE, { runId }, { singletonKey: runId });
}

export async function stopJobs() {
    await boss?.stop({ graceful: true, timeout: 10_000 });
    boss = null;
}
