'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-crash-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');

const fair = require('../crashFair');
const database = require('../database');

let user;

function roundAtLeast(nonce, minimum) {
    let round;
    do {
        round = fair.createFairRound(nonce);
    } while (round.crashAt < minimum);
    return round;
}

test.after(async () => {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('HMAC result is deterministic and verifiable', () => {
    const serverSeed = 'a'.repeat(64);
    const first = fair.calculateCrashAtFromSeed(serverSeed, 'client-seed', 7);
    const second = fair.calculateCrashAtFromSeed(serverSeed, 'client-seed', 7);
    assert.equal(first, second);
    assert.notEqual(first, fair.calculateCrashAtFromSeed(serverSeed, 'other-client-seed', 7));
    assert.notEqual(first, fair.calculateCrashAtFromSeed(serverSeed, 'client-seed', 8));
    assert.equal(
        fair.verifyFairRound(serverSeed, fair.hashServerSeed(serverSeed), 'client-seed', 7, first),
        true
    );
});

test('distribution has a 5% house edge target and a natural long tail', () => {
    const samples = 20000;
    const targets = [2, 5, 25, 30, 50];
    const returns = targets.map(target => {
        let reached = 0;
        for (let nonce = 1; nonce <= samples; nonce++) {
            const round = fair.createFairRound(nonce);
            if (round.crashAt >= target) reached++;
        }
        return { target, value: target * reached / samples };
    });

    assert.ok(returns[0].value > 0.93 && returns[0].value < 0.97, JSON.stringify(returns));
    assert.ok(returns[2].value > 0.75 && returns[2].value < 1.10, JSON.stringify(returns));
    assert.ok(returns[3].value > 0.70 && returns[3].value < 1.10, JSON.stringify(returns));
    assert.ok(returns[4].value > 0.65 && returns[4].value < 1.15, JSON.stringify(returns));
});

test('1.00x is immediate and cannot trigger cashout', () => {
    assert.equal(fair.calculateCrashAt(0), 1);
    assert.equal(fair.shouldAutoCashout(1, 1, 1), false);
    assert.equal(fair.shouldAutoCashout(2, 2, 1), false);
    assert.equal(fair.shouldAutoCashout(2, 2, 2), true);
    assert.equal(fair.shouldAutoCashout(3, 2, 2), false);
});

test('database cashout is one-time and crash settlement is atomic', async () => {
    await database.initDatabase();
    user = await database.findOrCreateUser('test-crash-user');
    await database.updateUserBalance(user.id, 100, 'add');

    const cashoutRound = roundAtLeast(1001, 2);
    await database.createRoundRecord(cashoutRound);
    const cashoutBet = await database.placeTonBet(user.id, 10, 1001, 2);
    await database.updateRoundState(1001, 'FLIGHT', 1.5);

    await assert.rejects(
        database.cashoutBet('TON', cashoutBet.betId, user.id, 1001, 1),
        /above 1.00x/
    );
    const payout = await database.cashoutBet('TON', cashoutBet.betId, user.id, 1001, 2);
    assert.equal(payout.payout, 20);
    await assert.rejects(
        database.cashoutBet('TON', cashoutBet.betId, user.id, 1001, 2),
        /already settled|not found/
    );

    const crashRound = fair.createFairRound(1002);
    await database.createRoundRecord(crashRound);
    const losingBet = await database.placeTonBet(user.id, 10, 1002, 3);
    await database.updateRoundState(1002, 'FLIGHT', 1.5);
    const settlement = await database.crashRound(1002, 2.5);
    assert.equal(settlement.settled, true);
    const storedBet = await database.get('SELECT status FROM ton_bets WHERE id = ?', [losingBet.betId]);
    assert.equal(storedBet.status, 'LOST');
    const repeatedSettlement = await database.crashRound(1002, 2.5);
    assert.equal(repeatedSettlement.alreadySettled, true);
});
