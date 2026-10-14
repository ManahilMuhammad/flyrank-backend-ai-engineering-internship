import { createClient } from '@supabase/supabase-js';
import { env } from '../config.js';
import { httpError } from './errors.js';

let client = null;

// created on first use so server (and tests) can start without supabase configured
function getClient() {
    if (!env.supabaseUrl || !env.supabaseKey) {
        throw httpError(500, 'Authentication is not configured (missing SUPABASE_URL / SUPABASE_KEY)');
    }
    if (!client) {
        client = createClient(env.supabaseUrl, env.supabaseKey, {
            // server is shared by every user so must never hold on to anyone's session
            auth: { persistSession: false, autoRefreshToken: false }
        });
    }
    return client;
}

// return { id, email } for valid access token or null if invalid/expired
export async function getUserFromToken(token) {
    const { data, error } = await getClient().auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email };
}

export async function signUp(email, password) {
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (error) throw httpError(400, error.message);
    return data;
}

export async function signIn(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) throw httpError(401, 'Invalid login credentials');
    return data.session;
}
