import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../.env'), quiet: true }); // load env variables from root env file

export const env = {
    // own variable because the shared env sets port for BE-03
    port: Number(process.env.PRIORS_PORT) || 3010,
    // separate variable so it doesn't clash with BE-04 database url in shared env
    databaseUrl: process.env.PRIORS_DATABASE_URL || 'postgresql://postgres:password@localhost:5433/priors',
    geminiApiKey: process.env.GEMINI_API_KEY,
    // model for query generation and classification; overridable without code changes
    // (gemini-2.5-flash is no longer offered to new api keys)
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    // gap between grounded calls in a harvest; 7s keeps under a 10 requests/minute free tier
    harvestMinIntervalMs: Number(process.env.HARVEST_MIN_INTERVAL_MS ?? 7000),
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    smtpHost: process.env.SMTP_HOST || 'localhost',
    smtpPort: Number(process.env.SMTP_PORT) || 1025
};
