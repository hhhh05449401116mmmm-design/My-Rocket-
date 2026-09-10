'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-webhook-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret-value';

require('../test-helpers/no-network');

const database = require('../database');
const serverModule = require('../server');

// Polls an async condition instead of a fixed sleep, to avoid flakiness under CPU contention
// while still waiting for the webhook handler's post-response async work to actually complete.
async function waitFor(conditionFn, { timeoutMs = 2000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await conditionFn()) return true;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return false;
}

let httpServer;
let baseUrl;

test.before(async () => {
    httpServer = await serverModule.startServer(0);
    serverModule.stopGameLoop();
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
    serverModule.stopGameLoop();
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('webhook rejects requests missing/mismatching the configured secret token', async () => {
    const wrongSecret = await fetch(`${baseUrl}/telegram-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
        body: JSON.stringify({ update_id: 1, business_connection: { id: 'x', is_enabled: true } })
    });
    assert.equal(wrongSecret.status, 401);

    const missingSecret = await fetch(`${baseUrl}/telegram-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 2, business_connection: { id: 'x', is_enabled: true } })
    });
    assert.equal(missingSecret.status, 401);
});

test('webhook accepts a request with the correct secret token and persists the business connection', async () => {
    const response = await fetch(`${baseUrl}/telegram-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret-value' },
        body: JSON.stringify({
            update_id: 100,
            business_connection: {
                id: 'conn-abc',
                user: { id: 999 },
                is_enabled: true,
                rights: { can_view_gifts_and_stars: true }
            }
        })
    });
    assert.equal(response.status, 200);

    // Wait for the webhook handler's post-response async work to finish persisting the connection.
    const persistedInTime = await waitFor(async () => {
        const row = await database.getPersistedBusinessConnection();
        return !!(row && row.connection_id === 'conn-abc');
    });
    assert.equal(persistedInTime, true, 'business connection must be persisted within a reasonable time');

    const persisted = await database.getPersistedBusinessConnection();
    assert.ok(persisted, 'business connection must be persisted to survive a restart');
    assert.equal(persisted.can_view_gifts_and_stars, 1);
    assert.equal(persisted.is_enabled, 1);
});

test('webhook silently ignores unrelated update types', async () => {
    const response = await fetch(`${baseUrl}/telegram-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret-value' },
        body: JSON.stringify({ update_id: 101, message: { text: 'hello' } })
    });
    assert.equal(response.status, 200);
});

test('webhook is idempotent for a redelivered update_id', async () => {
    const payload = {
        update_id: 202,
        business_connection: {
            id: 'conn-retry',
            user: { id: 42 },
            is_enabled: true,
            rights: { can_view_gifts_and_stars: false }
        }
    };
    const first = await fetch(`${baseUrl}/telegram-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret-value' },
        body: JSON.stringify(payload)
    });
    assert.equal(first.status, 200);

    const processedInTime = await waitFor(() => database.hasProcessedWebhookUpdate(202));
    assert.equal(processedInTime, true, 'update_id must be recorded as processed within a reasonable time');

    // Redeliver the identical update_id (simulating a Telegram retry) — must not throw or duplicate work.
    const second = await fetch(`${baseUrl}/telegram-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret-value' },
        body: JSON.stringify(payload)
    });
    assert.equal(second.status, 200);
});

test('GET /api/collectibles/verification-status never creates ownership by itself (read-only)', async () => {
    const user = await database.findOrCreateUser('verification-status-user');
    const before = await database.getUserCollectibles(user.id);

    const response = await fetch(`${baseUrl}/api/collectibles/verification-status`, {
        headers: { Authorization: `Bearer ${user.id}` }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);

    const after = await database.getUserCollectibles(user.id);
    assert.equal(after.length, before.length, 'checking verification status must never insert a collectible');
});

test('GET /api/collectible-media returns 404 for an unknown or unverified collectible id (no arbitrary file_id accepted)', async () => {
    const response = await fetch(`${baseUrl}/api/collectible-media/${encodeURIComponent('does-not-exist-123')}`);
    assert.equal(response.status, 404);
});

test('a user can never bet with another user\'s verified collectible (authorization)', async () => {
    // A prior test in this file already delivered a business_connection update, so
    // runtimeBusinessConnection.id is populated on this same running server instance.
    const owner = await database.findOrCreateUser('collectible-owner-user');
    const attacker = await database.findOrCreateUser('collectible-attacker-user');

    const ownedGift = {
        type: 'unique',
        owned_gift_id: 'og-auth-1',
        sender_user: { id: 'collectible-owner-user' },
        gift: {
            name: 'AuthTestGift',
            number: 1,
            base_name: 'AuthTestGift',
            model: { name: 'AuthTestGift Model', sticker: { file_id: 'fake' } }
        }
    };
    const sweepResult = await serverModule.runCollectibleVerificationSweep(async () => [ownedGift]);
    assert.equal(sweepResult.credited, 1);

    const response = await fetch(`${baseUrl}/api/bet/gift`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${attacker.id}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ giftId: 'AuthTestGift-1' })
    });
    const body = await response.json();
    assert.equal(response.ok, false, 'a different user must never be able to bet with someone else\'s collectible');
    assert.equal(body.ok, false);

    const ownerCollectibles = await database.getUserCollectibles(owner.id, 'OWNED');
    const stillOwned = ownerCollectibles.find(c => c.unique_collectible_id === 'AuthTestGift-1');
    assert.ok(stillOwned, 'the collectible must remain untouched and owned by the real owner');
});
