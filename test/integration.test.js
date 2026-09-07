'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-http-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');

const database = require('../database');
const serverModule = require('../server');
const fair = require('../crashFair');

let httpServer;
let baseUrl;
let user;

async function request(pathname, options = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${user.id}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    return { response, body: await response.json() };
}

async function startHighRound() {
    let state = serverModule.getGameStateSnapshot();
    let round = await database.getRoundByNumber(state.roundId);
    while (state.phase !== 'COUNTDOWN' || round.crash_at <= 1.01) {
        await serverModule.startRound(state.roundId + 1);
        state = serverModule.getGameStateSnapshot();
        round = await database.getRoundByNumber(state.roundId);
    }
    return state;
}

test.before(async () => {
    httpServer = await serverModule.startServer(0);
    serverModule.stopGameLoop();
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    user = await database.findOrCreateUser('http-integration-user');
    await database.updateUserBalance(user.id, 1000, 'add');
});

test.after(async () => {
    serverModule.stopGameLoop();
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('HTTP, SSE, fair reveal, auto cashout, and cashout/crash race', async () => {
    const initial = await request('/api/game/state');
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.state.phase, 'COUNTDOWN');
    assert.match(initial.body.state.serverSeedHash, /^[a-f0-9]{64}$/);
    assert.equal(initial.body.state.serverSeed, null);

    const streamResponse = await fetch(`${baseUrl}/api/game-stream?token=${user.id}`);
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    const firstChunk = await reader.read();
    const firstText = new TextDecoder().decode(firstChunk.value);
    const streamData = JSON.parse(firstText.match(/data: (.+)\n/)[1]);
    assert.equal(streamData.serverSeed, null);
    await reader.cancel();

    const gift = await database.get('SELECT id, telegram_gift_id, value FROM gifts LIMIT 1');
    await database.addGiftToUser(user.id, gift.id);
    const giftBet = await request('/api/bet/gift', {
        method: 'POST',
        body: JSON.stringify({ giftId: gift.telegram_gift_id, amount: 999999, giftValue: 999999 })
    });
    assert.equal(giftBet.response.status, 200);
    assert.equal(giftBet.body.bet.giftValue, gift.value);
    const storedGiftBet = await database.get('SELECT gift_value_at_bet FROM gift_bets WHERE id = ?', [giftBet.body.bet.betId]);
    assert.equal(storedGiftBet.gift_value_at_bet, gift.value);

    const tonBet = await request('/api/bet/ton', {
        method: 'POST',
        body: JSON.stringify({ amount: 10, giftValue: 999999 })
    });
    assert.equal(tonBet.response.status, 200);

    await serverModule.launchRound();
    const flight = await request('/api/game/state');
    assert.equal(flight.body.state.phase, 'FLIGHT');
    assert.equal(flight.body.state.serverSeed, null);

    const earlyCashout = await request('/api/cashout/ton', {
        method: 'POST',
        body: JSON.stringify({ betId: tonBet.body.bet.betId })
    });
    assert.equal(earlyCashout.response.status, 400);

    await serverModule.crashCurrentRound();
    const crashed = await request('/api/game/state');
    assert.equal(crashed.body.state.phase, 'CRASH');
    assert.ok(crashed.body.state.serverSeed);
    assert.equal(
        fair.verifyFairRound(
            crashed.body.state.serverSeed,
            crashed.body.state.serverSeedHash,
            crashed.body.state.clientSeed,
            crashed.body.state.nonce,
            crashed.body.state.crashAt
        ),
        true
    );

    const autoState = await startHighRound();
    const autoBet = await request('/api/bet/ton', {
        method: 'POST',
        body: JSON.stringify({ amount: 10, autoCashoutTarget: 1.01 })
    });
    assert.equal(autoBet.response.status, 200);
    await serverModule.launchRound();
    serverModule.updateGameState({ multiplier: 1.01 });
    await serverModule.processAutoCashouts(1.01);
    const autoStored = await database.get('SELECT status, cashout_multiplier FROM ton_bets WHERE id = ?', [autoBet.body.bet.betId]);
    assert.equal(autoStored.status, 'CASHED_OUT');
    assert.equal(autoStored.cashout_multiplier, 1.01);
    await serverModule.crashCurrentRound();

    const raceState = await startHighRound();
    const raceBet = await request('/api/bet/ton', {
        method: 'POST',
        body: JSON.stringify({ amount: 10 })
    });
    await serverModule.launchRound();
    serverModule.updateGameState({ multiplier: 1.01 });
    const raceResults = await Promise.allSettled([
        request('/api/cashout/ton', {
            method: 'POST',
            body: JSON.stringify({ betId: raceBet.body.bet.betId })
        }),
        serverModule.crashCurrentRound()
    ]);
    const raceStored = await database.get('SELECT status FROM ton_bets WHERE id = ?', [raceBet.body.bet.betId]);
    assert.ok(['CASHED_OUT', 'LOST'].includes(raceStored.status));
    assert.notEqual(raceStored.status, 'ACTIVE');
    assert.equal(raceResults.length, 2);
    assert.ok(autoState.roundId < raceState.roundId);
});
