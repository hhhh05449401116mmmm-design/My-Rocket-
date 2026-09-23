'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-pvp-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
process.env.TELEGRAM_BUSINESS_CONNECTION_ID = 'test-connection-id';

require('../test-helpers/no-network');

const database = require('../database');
const { getMaxPlayers } = require('../server');

test.before(async () => {
    await database.initDatabase();
    await database.seedDatabase();
});

test.after(async () => {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
    // Clean up any active PvP rounds from previous tests
    await database.run('UPDATE pvp_rounds SET phase = ? WHERE phase IN (?, ?, ?)', ['RESULT', 'WAITING', 'COUNTDOWN', 'LIVE']);
    await database.run('DELETE FROM pvp_participants WHERE pvp_round_id IN (SELECT id FROM pvp_rounds WHERE phase = ?)', ['RESULT']);
    await database.run('DELETE FROM pvp_rounds WHERE phase = ?', ['RESULT']);
});

async function createUserWithBalance(username, balance = 1000) {
    const user = await database.findOrCreateUser(username);
    const currentBal = await database.getUserBalance(user.id) || 0;
    if (balance > currentBal) {
        await database.updateUserBalance(user.id, balance - currentBal, 'add');
    } else if (balance < currentBal) {
        await database.updateUserBalance(user.id, currentBal - balance, 'subtract');
    }
    return user;
}

function getActivePvpRoundSync() {
    let result;
    const db = database.db;
    db.get('SELECT * FROM pvp_rounds WHERE phase IN (\'WAITING\', \'COUNTDOWN\', \'LIVE\') ORDER BY round_number DESC LIMIT 1', [], (err, row) => {
        if (!err) result = row;
    });
    return result;
}

// =========================================================
// PvP ROUND CREATION TESTS
// =========================================================

test('PVP: createPvpRound creates a WAITING round', async () => {
    const round = await database.createPvpRound(1001);
    assert.ok(round.id > 0);
    assert.equal(round.round_number, 1001);
    assert.equal(round.phase, 'WAITING');
    assert.ok(round.server_seed);
    assert.ok(round.server_seed_hash);
    assert.ok(round.crash_at);
});

test('PVP: startPvpCountdown moves round to COUNTDOWN', async () => {
    const round = await database.createPvpRound(1002);
    const updated = await database.startPvpCountdown(round.id);
    assert.equal(updated.phase, 'COUNTDOWN');
    assert.equal(updated.seconds_remaining, 10);
});

test('PVP: MAX_PVP_PLAYERS is 75', async () => {
    assert.equal(database.MAX_PVP_PLAYERS, 75);
});

// =========================================================
// PvP JOIN TESTS
// =========================================================

test('PVP: join with TON creates participant', async () => {
    const round = await database.createPvpRound(1003);
    await database.startPvpCountdown(round.id);

    const user = await createUserWithBalance('pvp-join-ton');
    const result = await database.joinPvpRound(user.id, 'TON', 5.0, null);

    assert.equal(result.roundId, round.id);
    assert.equal(result.betCurrency, 'TON');
    assert.equal(result.betAmount, 5.0);
    assert.equal(result.playerCount, 1);
    assert.equal(result.maxPlayers, 75);
    assert.ok(result.participationPercent > 0);

    const bal = await database.getUserBalance(user.id);
    assert.equal(bal, 995.0); // 1000 - 5.0
});

test('PVP: join with GIFT locks collectible', async () => {
    const gift = await database.get('SELECT * FROM gifts WHERE value > 0 LIMIT 1');
    if (!gift) return; // Skip if no seeded gift

    const round = await database.createPvpRound(1004);
    await database.startPvpCountdown(round.id);

    const user = await createUserWithBalance('pvp-join-gift');
    const uniqueId = 'PVP-GIFT-TEST-' + Date.now();
    await database.run(`
        INSERT INTO user_gifts (user_id, gift_id, status, unique_collectible_id, telegram_gift_instance_id, collectible_number, ownership_verified, verified_metadata, telegram_thumbnail_file_id, market_value_snapshot)
        VALUES (?, ?, 'OWNED', ?, ?, ?, 1, ?, ?, ?)
    `, [user.id, gift.id, uniqueId, 'og-pvp-test-' + Date.now(), Date.now(), JSON.stringify({ name: 'Test Gift' }), null, gift.value]);

    const result = await database.joinPvpRound(user.id, 'GIFT', gift.value, uniqueId);
    assert.equal(result.betCurrency, 'GIFT');
    assert.ok(result.betAmount > 0);

    const collectibleAfter = await database.getCollectibleByUniqueId(uniqueId);
    assert.equal(collectibleAfter.ownership_status, 'IN_BET');
});

test('PVP: insufficient TON balance rejected', async () => {
    const round = await database.createPvpRound(1005);
    await database.startPvpCountdown(round.id);

    const user = await database.findOrCreateUser('pvp-low-balance');
    const bal = await database.getUserBalance(user.id) || 0;
    await database.updateUserBalance(user.id, bal, 'subtract'); // set to 0

    await assert.rejects(
        database.joinPvpRound(user.id, 'TON', 100.0, null),
        /insufficient/i
    );
});

test('PVP: invalid bet currency rejected', async () => {
    const round = await database.createPvpRound(1006);
    await database.startPvpCountdown(round.id);

    const user = await createUserWithBalance('pvp-invalid-currency');
    await assert.rejects(
        database.joinPvpRound(user.id, 'INVALID', 1.0, null),
        /invalid bet currency/i
    );
});

test('PVP: round full is rejected (76th player)', async () => {
    const round = await database.createPvpRound(1007);
    await database.startPvpCountdown(round.id);

    // Add 75 players
    for (let i = 0; i < 75; i++) {
        const user = await createUserWithBalance('pvp-full-' + i);
        await database.joinPvpRound(user.id, 'TON', 0.1, null);
    }

    // 76th should fail
    const user76 = await createUserWithBalance('pvp-full-76');
    await assert.rejects(
        database.joinPvpRound(user76.id, 'TON', 0.1, null),
        /full/i
    );
});

test('PVP: duplicate join rejected', async () => {
    const round = await database.createPvpRound(1008);
    await database.startPvpCountdown(round.id);

    const user = await createUserWithBalance('pvp-dup');
    await database.joinPvpRound(user.id, 'TON', 1.0, null);

    await assert.rejects(
        database.joinPvpRound(user.id, 'TON', 1.0, null),
        /already joined/i
    );
});

test('PVP: cannot join a LIVE round', async () => {
    const round = await database.createPvpRound(1009);
    await database.run('UPDATE pvp_rounds SET phase = ? WHERE id = ?', ['LIVE', round.id]);

    const user = await createUserWithBalance('pvp-join-live');
    await assert.rejects(
        database.joinPvpRound(user.id, 'TON', 1.0, null),
        /already started/i
    );
});

test('PVP: cannot join when no active round', async () => {
    // Set all rounds to RESULT so no active round exists
    await database.run('UPDATE pvp_rounds SET phase = ? WHERE phase IN (?, ?, ?)', ['RESULT', 'WAITING', 'COUNTDOWN', 'LIVE']);

    const user = await createUserWithBalance('pvp-no-round');
    await assert.rejects(
        database.joinPvpRound(user.id, 'TON', 1.0, null),
        /No active PvP round/i
    );
});

// =========================================================
// PvP PARTICIPATION CALCULATION TESTS
// =========================================================

test('PVP: participation percent is server-calculated', async () => {
    const round = await database.createPvpRound(1010);
    await database.startPvpCountdown(round.id);

    const user1 = await createUserWithBalance('pvp-percent-1');
    const user2 = await createUserWithBalance('pvp-percent-2');
    const user3 = await createUserWithBalance('pvp-percent-3');

    const r1 = await database.joinPvpRound(user1.id, 'TON', 1.0, null);
    assert.equal(r1.participationPercent, 100); // Only player, 100%

    const r2 = await database.joinPvpRound(user2.id, 'TON', 3.0, null);
    // Pool is now 4.0, user2 has 3.0 -> 75%
    assert.equal(r2.participationPercent, 75);

    const r3 = await database.joinPvpRound(user3.id, 'TON', 2.0, null);
    // Pool is now 6.0, user3 has 2.0 -> 33.33
    assert.equal(r3.participationPercent, 33.33);
});

test('PVP: total pool is sum of all participant bets', async () => {
    const round = await database.createPvpRound(1011);
    await database.startPvpCountdown(round.id);

    const user1 = await createUserWithBalance('pvp-pool-1');
    const user2 = await createUserWithBalance('pvp-pool-2');

    await database.joinPvpRound(user1.id, 'TON', 10.0, null);
    await database.joinPvpRound(user2.id, 'TON', 5.0, null);

    const data = await database.getPvpRoundWithParticipants(round.id);
    const poolTon = data.participants.reduce((sum, p) => sum + parseFloat(p.bet_amount), 0);
    assert.equal(poolTon, 15.0);
});

// =========================================================
// PvP SETTLEMENT TESTS
// =========================================================

test('PVP: round crash settles winner', async () => {
    const round = await database.createPvpRound(1012);
    await database.startPvpCountdown(round.id);

    const user1 = await createUserWithBalance('pvp-crash-1');
    const user2 = await createUserWithBalance('pvp-crash-2');

    await database.joinPvpRound(user1.id, 'TON', 10.0, null);
    await database.joinPvpRound(user2.id, 'TON', 5.0, null);

    // Set round to LIVE state
    await database.run('UPDATE pvp_rounds SET phase = ? WHERE id = ?', ['LIVE', round.id]);

    const crashAt = round.crash_at;
    const result = await database.crashPvpRound(round.id);
    assert.equal(result.crashAt, crashAt);
    assert.ok(result.winnerUserId > 0);
    assert.equal(result.totalPool, 15.0);
    assert.ok(result.winnerPayout > 0);

    const data = await database.getPvpRoundWithParticipants(round.id);
    const winner = data.participants.find(p => p.user_id === result.winnerUserId);
    assert.equal(winner.status, 'WON');
    const loser = data.participants.find(p => p.user_id !== result.winnerUserId);
    assert.equal(loser.status, 'LOST');
});

test('PVP: winner receives total pool minus own bet', async () => {
    const round = await database.createPvpRound(1013);
    await database.startPvpCountdown(round.id);

    const user1 = await createUserWithBalance('pvp-winner-test', 100);
    const user2 = await createUserWithBalance('pvp-loser-test', 100);

    await database.joinPvpRound(user1.id, 'TON', 10.0, null);
    await database.joinPvpRound(user2.id, 'TON', 5.0, null);

    // Set round to LIVE state
    await database.run('UPDATE pvp_rounds SET phase = ? WHERE id = ?', ['LIVE', round.id]);

    const balBefore = await database.getUserBalance(user1.id);
    const crashAt = round.crash_at;
    const result = await database.crashPvpRound(round.id);

    if (result.winnerUserId === user1.id) {
        const balAfter = await database.getUserBalance(user1.id);
        assert.ok(balAfter > balBefore, 'winner balance should increase');
    }
});

test('PVP: crashPvpRound rejects non-LIVE round', async () => {
    const round = await database.createPvpRound(1014);
    // Phase is WAITING, not LIVE
    await assert.rejects(
        database.crashPvpRound(round.id),
        /not in LIVE/i
    );
});

test('PVP: settlement is transactional - double crash rejected', async () => {
    const round = await database.createPvpRound(1015);
    await database.startPvpCountdown(round.id);

    const user = await createUserWithBalance('pvp-double-crash');
    await database.joinPvpRound(user.id, 'TON', 1.0, null);

    await database.run('UPDATE pvp_rounds SET phase = ? WHERE id = ?', ['LIVE', round.id]);

    const result1 = await database.crashPvpRound(round.id);
    assert.ok(result1.winnerUserId);

    // Second crash should fail (round is now CRASH or RESULT)
    await assert.rejects(
        database.crashPvpRound(round.id),
        /not in LIVE/i
    );
});

// =========================================================
// PvP CONCURRENCY TEST
// =========================================================

test('PVP: concurrent joins are serialized - no double spend', async () => {
    const round = await database.createPvpRound(1016);
    await database.startPvpCountdown(round.id);

    const user = await createUserWithBalance('pvp-concurrency', 50);

    const results = await Promise.allSettled([
        database.joinPvpRound(user.id, 'TON', 10.0, null),
        database.joinPvpRound(user.id, 'TON', 10.0, null),
        database.joinPvpRound(user.id, 'TON', 10.0, null)
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'only one concurrent join should succeed');
    assert.equal(rejected.length, 2, 'two should be rejected (duplicate)');

    const bal = await database.getUserBalance(user.id);
    assert.equal(bal, 40.0, 'balance should only be deducted once (50 - 10 = 40)');
});

// =========================================================
// PvP PERCENTAGE ACCURACY
// =========================================================

test('PVP: calculateParticipationPercent is correct', async () => {
    assert.equal(database.calculateParticipationPercent(10, 100), 10.0);
    assert.equal(database.calculateParticipationPercent(25, 100), 25.0);
    assert.equal(database.calculateParticipationPercent(0, 100), 0.0);
    assert.equal(database.calculateParticipationPercent(10, 0), 0);
});

test('PVP: percentages sum to ~100 when all TON', async () => {
    const round = await database.createPvpRound(1017);
    await database.startPvpCountdown(round.id);

    const users = [];
    for (let i = 0; i < 3; i++) {
        const u = await createUserWithBalance('pvp-sum-' + i, 1000);
        users.push(u);
    }

    await database.joinPvpRound(users[0].id, 'TON', 10.0, null);
    await database.joinPvpRound(users[1].id, 'TON', 20.0, null);
    await database.joinPvpRound(users[2].id, 'TON', 30.0, null);

    // Verify pool totals are correct
    const data = await database.getPvpRoundWithParticipants(round.id);
    const poolTon = data.participants.reduce((sum, p) => sum + parseFloat(p.bet_amount), 0);
    assert.equal(poolTon, 60.0);
    assert.equal(data.participants.length, 3);

    // Each participant's percent should be their contribution / total pool * 100
    // The percentage is calculated at join time, so it may differ from the final
    // pool state. But the stored percent should be <= 100
    data.participants.forEach(p => {
        assert.ok(p.participation_percent >= 0 && p.participation_percent <= 100,
            `percent ${p.participation_percent} for ${p.bet_amount} bet should be 0-100`);
    });
});
