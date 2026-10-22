import { env } from '../config.js';
import { listScheduledCategories } from '../db/shifts.js';
import { createRun } from '../db/harvests.js';
import { assertConfigured } from '../lib/gemini.js';
import { engineModel } from './harvester.js';

// what weekly cron runs: new harvest for every category that opted in
// rest of pipeline (fetch, audit, leverage, shifts) follows from harvest job
// enqueue passed in (jobs.js) so module doesnt import queue it is called from
export async function runScheduledHarvests({ enqueue, samplesPerQuery = 3 }) {
    const engine = env.answerEngine;
    let model;
    try {
        model = engineModel(engine);
        assertConfigured(); // audit after harvest always uses gemini
    } catch (err) {
        console.warn(`Weekly harvest skipped: ${err.message}`);
        return { started: 0, skipped: 0, reason: 'llm not configured' };
    }

    const categories = await listScheduledCategories();
    const result = { started: 0, skipped: 0, runs: [] };
    for (const category of categories) {
        let run;
        try {
            run = await createRun(category.id, { engine, model, samplesPerQuery });
        } catch (err) {
            // last week's run still going: dont stack another on top
            if (err.constraint !== 'harvest_runs_one_active_idx') throw err;
            result.skipped++;
            continue;
        }
        await enqueue(run.id);
        result.started++;
        result.runs.push(run.id);
    }
    console.log(`Weekly harvest: started ${result.started}, skipped ${result.skipped} (already running)`);
    return result;
}
