import nodemailer from 'nodemailer';
import { env } from '../config.js';

let transport = null;

// smtp transport created on first use 
// mailpit (localhost:1025) catches everything in development
function getTransport() {
    if (!transport) {
        transport = nodemailer.createTransport({
            host: env.smtpHost,
            port: env.smtpPort,
            secure: env.smtpPort === 465,
            auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined
        });
    }
    return transport;
}

// returns smtp message id
export async function sendMail({ to, subject, text, html, attachments }) {
    const info = await getTransport().sendMail({ from: env.smtpFrom, to, subject, text, html, attachments });
    return info.messageId;
}
