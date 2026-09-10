// ONE-TIME READ-ONLY diagnostic — reports only safe booleans/counts/statuses.
// Never prints BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, connection IDs, file IDs, gift instance IDs,
// Telegram user IDs, or any other private metadata. Does not modify the database or credit anything.
// Run from Railway shell/one-off command:
//   node scripts/diagnose-collectibles.js
'use strict';

require('dotenv').config();

const database = require('../database');
// Reused as-is (pure function, no side effects): the exact same identity extraction
// production crediting uses, so this diagnostic reflects reality, not a guess.
const { extractUniqueCollectibleIdentity } = require('../server');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = '7385640899';

function callTelegramBotApi(method, payload = {}) {
    const https = require('https');
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
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, response => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { raw += chunk; });
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(raw);
                    if (!parsed.ok) { reject(new Error(parsed.description || 'unknown Telegram API error')); return; }
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
    const report = {
        envConfigured: !!process.env.TELEGRAM_BUSINESS_CONNECTION_ID,
        persistedConnectionExists: false,
        businessConnectionEnabled: false,
        canViewGiftsAndStars: false,
        getBusinessAccountGiftsSucceeded: false,
        telegramApiErrorMessage: null,
        giftsReturned: 0,
        uniqueCollectibleGiftsReturned: 0,
        withSenderUser: 0,
        alreadyCredited: 0,
        senderMapsToRocketUser: 0,
        withPendingImportIntent: 0,
        wouldBeCreditable: 0,
        adminLastImportIntentStatus: null,
        adminLastImportIntentExpired: null
    };

    try {
        const persisted = await database.getPersistedBusinessConnection();
        if (persisted && persisted.connection_id) {
            report.persistedConnectionExists = true;
            report.businessConnectionEnabled = !!persisted.is_enabled;
            report.canViewGiftsAndStars = !!persisted.can_view_gifts_and_stars;
        }

        const connectionId = process.env.TELEGRAM_BUSINESS_CONNECTION_ID || (persisted ? persisted.connection_id : null);

        if (!connectionId) {
            report.telegramApiErrorMessage = 'No business connection configured (env or persisted) — skipped getBusinessAccountGifts call.';
        } else {
            try {
                const result = await callTelegramBotApi('getBusinessAccountGifts', { business_connection_id: connectionId });
                const ownedGifts = Array.isArray(result?.gifts) ? result.gifts : [];
                report.getBusinessAccountGiftsSucceeded = true;
                report.giftsReturned = ownedGifts.length;

                for (const ownedGift of ownedGifts) {
                    const identity = extractUniqueCollectibleIdentity(ownedGift);
                    if (!identity) continue;
                    report.uniqueCollectibleGiftsReturned++;

                    const alreadyCredited = await database.isCollectibleAlreadyCredited(
                        identity.uniqueCollectibleId,
                        identity.telegramGiftInstanceId
                    );
                    if (alreadyCredited) { report.alreadyCredited++; continue; }

                    if (!identity.senderTelegramId) continue;
                    report.withSenderUser++;

                    const user = await database.get('SELECT id FROM users WHERE telegram_id = ?', [String(identity.senderTelegramId)]);
                    if (!user) continue;
                    report.senderMapsToRocketUser++;
                    report.wouldBeCreditable++;

                    const intent = await database.getPendingIntentByTelegramSenderId(identity.senderTelegramId);
                    if (intent) report.withPendingImportIntent++;
                }
            } catch (error) {
                report.telegramApiErrorMessage = error.message;
            }
        }

        const adminUser = await database.get('SELECT id FROM users WHERE telegram_id = ?', [ADMIN_TELEGRAM_ID]);
        if (adminUser) {
            const intent = await database.getLatestImportIntentForUser(adminUser.id);
            if (intent) {
                report.adminLastImportIntentStatus = intent.status;
                report.adminLastImportIntentExpired = new Date(intent.expires_at) <= new Date();
            }
        }
    } catch (error) {
        report.telegramApiErrorMessage = report.telegramApiErrorMessage || error.message;
    }

    console.log('🔍 Collectible diagnostic report (safe fields only):');
    console.log(JSON.stringify(report, null, 2));

    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
})();
