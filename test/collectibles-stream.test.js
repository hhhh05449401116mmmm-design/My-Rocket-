'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-cstream-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
// Configured so runCollectibleVerificationSweep() proceeds even without a live Telegram business connection.
process.env.TELEGRAM_BUSINESS_CONNECTION_ID = 'test-connection-id';

require('../test-helpers/no-network');

const database = require('../database');
const serverModule = require('../server');

let httpServer;
let baseUrl;

test.before(async () => {
    httpServer = await serverModule.startServer(0);
    serverModule.stopGameLoop();
    if (serverModule.stopPvpGameLoop) serverModule.stopPvpGameLoop();
    if (serverModule.stopCollectibleReconciliationWorker) serverModule.stopCollectibleReconciliationWorker();
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
    serverModule.stopGameLoop();
    if (serverModule.stopPvpGameLoop) serverModule.stopPvpGameLoop();
    if (serverModule.stopCollectibleReconciliationWorker) serverModule.stopCollectibleReconciliationWorker();
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// A single reader is held open for the lifetime of one response (ReadableStream locks to one reader).
// The owning fetch is aborted at the end of each test, which destroys the socket and lets
// httpServer.close() complete. read() is raced against a short tick so the deadline is enforced
// even when the server sends nothing (no 15s heartbeat wait blocks the suite).
async function readUntil(reader, decoder, state, predicate, { timeoutMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let chunk;
        try {
            chunk = await Promise.race([reader.read(), new Promise(r => setTimeout(r, 1000, null))]);
        } catch {
            break; // stream errored/closed
        }
        if (chunk === null) continue; // tick expired, keep polling the deadline
        if (!chunk || chunk.done) break;
        state.buffer += decoder.decode(chunk.value, { stream: true });
        if (predicate(state.buffer)) return { buffer: state.buffer, found: true };
    }
    return { buffer: state.buffer, found: false };
}

async function openStream(userId, ac) {
    return fetch(`${baseUrl}/api/collectibles-stream?token=${userId}`, {
        headers: { 'Accept': 'text/event-stream' },
        cache: 'no-store',
        signal: ac.signal
    });
}

test('GET /api/collectibles-stream rejects requests without a token', async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/collectibles-stream`, { signal: ac.signal });
    assert.equal(res.status, 401);
    ac.abort();
    try { await res.body.cancel(); } catch { /* already closed */ }
});

test('GET /api/collectibles-stream pushes a collectible-credited event to the owning user only', async () => {
    const ac = new AbortController();
    const user = await database.findOrCreateUser('sse-creditor');
    const res = await openStream(user.id, ac);
    try {
        assert.equal(res.status, 200, 'authenticated user may open the collectibles stream');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const state = { buffer: '' };

        const connected = await readUntil(reader, decoder, state, b => b.includes(': connected'));
        assert.equal(connected.found, true, 'stream must announce itself on open');
        assert.ok(!state.buffer.includes('BOT_TOKEN'), 'stream must never leak BOT_TOKEN');

        serverModule.notifyCollectibleClients(user.id, {
            type: 'collectible-credited',
            uniqueCollectibleId: 'PlushPepe-7',
            collectibleNumber: 7,
            receivedAt: new Date().toISOString()
        });

        const event = await readUntil(reader, decoder, state, b => b.includes('event: collectible-credited'));
        assert.equal(event.found, true, 'credited user must receive the collectible-credited event');
        assert.ok(state.buffer.includes('PlushPepe-7'));
        assert.ok(state.buffer.includes('"collectibleNumber":7'));
        assert.ok(!state.buffer.includes('file_id'), 'stream must never leak file_id');
        assert.ok(!state.buffer.includes('sender_user'), 'stream must never leak raw sender payload');
    } finally {
        ac.abort();
        try { await res.body.cancel(); } catch { /* already closed */ }
    }
});

test('collectible-credited events are scoped per user (no cross-user leakage)', async () => {
    const acOther = new AbortController();
    const acCreditor = new AbortController();
    const creditor = await database.findOrCreateUser('sse-creditor-scoped');
    const other = await database.findOrCreateUser('sse-other-scoped');

    const resOther = await openStream(other.id, acOther);
    try {
        assert.equal(resOther.status, 200);
        const readerOther = resOther.body.getReader();
        const stateOther = { buffer: '' };
        const connectedOther = await readUntil(readerOther, new TextDecoder(), stateOther, b => b.includes(': connected'));
        assert.equal(connectedOther.found, true);

        const resCreditor = await openStream(creditor.id, acCreditor);
        try {
            await readUntil(resCreditor.body.getReader(), new TextDecoder(), { buffer: '' }, b => b.includes(': connected'));
        } finally {
            acCreditor.abort();
            try { await resCreditor.body.cancel(); } catch { /* already closed */ }
        }

        // لا إشعار للمستخدم other — فقط creditor.
        serverModule.notifyCollectibleClients(creditor.id, {
            type: 'collectible-credited',
            uniqueCollectibleId: 'GoldRing-1',
            collectibleNumber: 1,
            receivedAt: new Date().toISOString()
        });

        const leaked = await readUntil(readerOther, new TextDecoder(), stateOther, b => b.includes('event: collectible-credited'), { timeoutMs: 800 });
        assert.equal(leaked.found, false, 'only the credited user receives the event');
    } finally {
        acOther.abort();
        try { await resOther.body.cancel(); } catch { /* already closed */ }
    }
});

test('a stale/disconnected client is not written to when notify is sent (no throw)', async () => {
    const ac = new AbortController();
    const user = await database.findOrCreateUser('sse-stale');
    const res = await openStream(user.id, ac);
    try {
        assert.equal(res.status, 200);
        const connected = await readUntil(res.body.getReader(), new TextDecoder(), { buffer: '' }, b => b.includes(': connected'));
        assert.equal(connected.found, true);
    } finally {
        ac.abort();
        try { await res.body.cancel(); } catch { /* already closed */ }
    }

    // بعد إغلاق الاتصال، يجب أن ينطلق عملية إزالة العميل على الخادم.
    await new Promise(resolve => setTimeout(resolve, 200));

    // لا يجب أن يرمي ولا يكتب إلى عميل مغلق.
    const sent = serverModule.notifyCollectibleClients(user.id, {
        type: 'collectible-credited',
        uniqueCollectibleId: 'AfterClose-1',
        collectibleNumber: 1,
        receivedAt: new Date().toISOString()
    });
    assert.equal(sent, 0, 'no message should be written to a closed client');
});
