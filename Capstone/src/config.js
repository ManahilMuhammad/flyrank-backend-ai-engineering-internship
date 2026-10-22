import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../.env'), quiet: true }); // load env variables from root env file

export const env = {
    // own variable because shared env sets port for BE-03
    port: Number(process.env.PRIORS_PORT) || 3010,
    // separate variable so it doesnt clash with BE-04 database url in shared env
    databaseUrl: process.env.PRIORS_DATABASE_URL || 'postgresql://postgres:password@localhost:5433/priors',
    geminiApiKey: process.env.GEMINI_API_KEY,
    // model for query generation and classification
    // overridable without code changes
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    // which engine new harvests ask: 'gemini' (google search grounding) or 'groq' (open model + browser search)
    answerEngine: process.env.ANSWER_ENGINE || 'gemini',
    groqApiKey: process.env.GROQ_API_KEY,
    groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    // gap between grounded calls in a harvest
    // 7s keeps under a 10 requests/minute free tier
    harvestMinIntervalMs: Number(process.env.HARVEST_MIN_INTERVAL_MS ?? 7000),
    // how many of run's top sources get fetched and audited
    fetchTopN: Number(process.env.FETCH_TOP_N ?? 40),
    // page checked more recently than this not fetched again (runs are weekly)
    fetchTtlHours: Number(process.env.FETCH_TTL_HOURS ?? 144),
    // when weekly re-harvest runs (cron syntax; 'off' disables it): Mondays 06:00
    harvestCron: process.env.HARVEST_CRON || '0 6 * * 1',
    harvestCronTz: process.env.HARVEST_CRON_TZ || 'UTC',
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    // mailpit in development; point at a real provider (and set user/pass) to deliver for real
    smtpHost: process.env.SMTP_HOST || 'localhost',
    smtpPort: Number(process.env.SMTP_PORT) || 1025,
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    smtpFrom: process.env.SMTP_FROM || 'Priors <reports@priors.local>',
    // link back to api in report emails
    publicUrl: process.env.PRIORS_PUBLIC_URL || `http://localhost:${Number(process.env.PRIORS_PORT) || 3010}`
};
