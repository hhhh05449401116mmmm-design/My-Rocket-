// One-time Telegram webhook activation — NOT an HTTP route, no public exposure.
// Run manually once from the Railway dashboard shell/one-off command panel:
//   node scripts/setup-telegram-webhook.js
// Reads BOT_TOKEN only from process.env (Railway's injected service env vars).
// Never logs BOT_TOKEN or any secret — only safe Telegram response fields.
require('dotenv').config();
const https = require('https');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = 'https://my-rocket-production.up.railway.app/telegram-webhook';

function callTelegramBotApi(method, payload = {}) {
    return new Promise((resolve, reject) => {
        if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
            reject(new Error('BOT_TOKEN is not configured'));
            return;
        }
        const body = JSON.stringify(payload);
        const request = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, response => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { raw += chunk; });
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(raw);
                    if (!parsed.ok) {
                        reject(new Error(`Telegram API error: ${parsed.description || 'unknown error'}`));
                        return;
                    }
                    resolve(parsed.result);
                } catch (error) { reject(error); }
            });
        });
        request.setTimeout(10000, () => request.destroy(new Error('Telegram API timeout')));
        request.on('error', reject);
        request.write(body);
        request.end();
    });
}

(async () => {
    try {
        await callTelegramBotApi('setWebhook', { url: WEBHOOK_URL });
        console.log('✅ setWebhook succeeded for:', WEBHOOK_URL);

        const info = await callTelegramBotApi('getWebhookInfo', {});
        console.log('ℹ️ getWebhookInfo:', JSON.stringify({
            hasUrl: !!info.url,
            urlMatches: info.url === WEBHOOK_URL,
            pendingUpdateCount: info.pending_update_count,
            lastErrorMessage: info.last_error_message || null,
            hasCustomCertificate: !!info.has_custom_certificate
        }, null, 2));
        process.exit(0);
    } catch (error) {
        console.error('❌ Webhook activation failed:', error.message);
        process.exit(1);
    }
})();
