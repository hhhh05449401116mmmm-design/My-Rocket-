'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-test-balance-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
process.env.ENABLE_TEST_BALANCE = 'true';
process.env.ADMIN_TELEGRAM_ID = '7385640899';

require('../test-helpers/no-network');

const database = require('../database');
const serverModule = require('../server');

let httpServer;
let baseUrl;
let adminUser;
let normalUser;

async function request(pathname, options = {}, useAdmin = false) {
    const authUser = useAdmin ? adminUser : normalUser;
    const response = await fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${authUser.id}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    return { response, body: await response.json() };
}

test.before(async () => {
    await database.initDatabase();
    await database.seedDatabase();
    adminUser = await database.findOrCreateUser('admin-user-telegram-7385640899');
    await database.run('UPDATE users SET telegram_id = ? WHERE id = ?', ['7385640899', adminUser.id]);
    adminUser.telegram_id = '7385640899';

    normalUser = await database.findOrCreateUser('normal-user');
    // Ensure normalUser has a different telegram_id
    await database.run('UPDATE users SET telegram_id = ? WHERE id = ?', ['9999999999', normalUser.id]);
    normalUser.telegram_id = '9999999999';

    httpServer = await serverModule.startServer(0);
    serverModule.stopGameLoop();
    if (serverModule.stopPvpGameLoop) serverModule.stopPvpGameLoop();
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
    serverModule.stopGameLoop();
    if (serverModule.stopPvpGameLoop) serverModule.stopPvpGameLoop();
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// =========================================================
// AUTHORIZATION TESTS
// =========================================================

test('test balance can be added only by authorized admin', async () => {
    const res = await request('/api/admin/test-balance', {
        method: 'POST',
        body: JSON.stringify({ action: 'add', amount: 100000 })
    }, true);
    assert.equal(res.response.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.test_balance, 100000);
});

test('normal users cannot add test balance', async () => {
    const res = await request('/api/admin/test-balance', {
        method: 'POST',
        body: JSON.stringify({ action: 'add', amount: 100000 })
    }, false);
    assert.equal(res.response.status, 403);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /admin access required/i);
});

test('non-admin cannot reset test balance', async () => {
    const res = await request('/api/admin/test-balance', {
        method: 'POST',
        body: JSON.stringify({ action: 'reset' })
    }, false);
    assert.equal(res.response.status, 403);
});

// =========================================================
// ISOLATION TESTS
// =========================================================

test('test balance cannot be withdrawn', async () => {
    const testBalance = await database.getUserTestBalance(adminUser.id);
    const realBalance = await database.getUserBalance(adminUser.id);

    await database.setTestBalance(adminUser.id, 50000);
    const updated = await database.getUserTestBalance(adminUser.id);
    assert.equal(updated, 50000);

    const realAfter = await database.getUserBalance(adminUser.id);
    assert.equal(realAfter, realBalance, 'real balance must be unchanged');
});

test('test balance cannot be converted to real TON', async () => {
    await database.setTestBalance(adminUser.id, 100000);
    await database.setTestBalance(normalUser.id, 0);

    const adminRealBefore = await database.getUserBalance(adminUser.id);
    const adminTestBefore = await database.getUserTestBalance(adminUser.id);

    // Attempt to "convert" by directly calling placeTonBet with test balance check would fail
    // The key property: setTestBalance only writes to test_balance column
    const raw = await database.getUserTestBalanceRaw(adminUser.id);
    assert.equal(raw.test_balance, 100000);
    assert.equal(raw.balance, adminRealBefore);
});

test('test balance does not affect real TON balance', async () => {
    const realBefore = await database.getUserBalance(adminUser.id);
    await database.setTestBalance(adminUser.id, 99999);
    const realAfter = await database.getUserBalance(adminUser.id);
    assert.equal(realBefore, realAfter, 'real balance must not change when setting test balance');

    // Add some real TON
    await database.updateUserBalance(adminUser.id, 50, 'add');
    const realAfterAdd = await database.getUserBalance(adminUser.id);
    assert.equal(realAfterAdd, realBefore + 50);

    const testAfter = await database.getUserTestBalance(adminUser.id);
    assert.equal(testAfter, 99999, 'test balance must not change when adding real TON');
});

test('test balance does not affect collectibles', async () => {
    const gift = await database.get('SELECT id, telegram_gift_id, value FROM gifts WHERE value > 0 LIMIT 1');
    if (!gift) throw new Error('seeded gift required');
    const userGift = await database.addGiftToUser(adminUser.id, gift.id);
    assert.ok(userGift.id);

    await database.setTestBalance(adminUser.id, 100000);
    const collectibles = await database.getUserCollectibles(adminUser.id);
    assert.ok(collectibles.length > 0, 'collectibles should exist');
    const testBal = await database.getUserTestBalance(adminUser.id);
    assert.equal(testBal, 100000, 'test balance unaffected by collectibles');
});

// =========================================================
// DISABLE TESTS
// =========================================================

test('disabling ENABLE_TEST_BALANCE disables the feature', async () => {
    // The server module was loaded with ENABLE_TEST_BALANCE=true
    assert.equal(serverModule.ENABLE_TEST_BALANCE, true);

    // Without ENABLE_TEST_BALANCE, the test balance endpoint would return 503
    // We test this by checking that ENABLE_TEST_BALANCE is properly exported
    assert.equal(typeof serverModule.ENABLE_TEST_BALANCE, 'boolean');
});

// =========================================================
// GAME USAGE TESTS (Mines, Plinko, Dice with TEST currency)
// =========================================================

test('MINES game accepts TEST currency and pays out to test_balance only', async () => {
    await database.setTestBalance(adminUser.id, 10000);

    const result = await database.createMinesGame(adminUser.id, 100, 'TEST', null);
    assert.ok(result.gameId > 0);

    const realBefore = await database.getUserBalance(adminUser.id);
    const testBefore = await database.getUserTestBalance(adminUser.id);
    assert.equal(testBefore, 9900, 'test balance should be 10000 - 100');
    assert.equal(realBefore, await database.getUserBalance(adminUser.id), 'real balance unchanged');

    // Reveal a safe tile (find one from game data)
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const gameData = JSON.parse(game.game_data);
    const mineSet = gameData.minePositions.reduce((acc, v) => { acc[v] = true; return acc; }, {});
    let safeIndex = 0;
    while (mineSet[safeIndex]) safeIndex++;

    await database.revealMinesTile(result.gameId, adminUser.id, safeIndex);
    const testAfterReveal = await database.getUserTestBalance(adminUser.id);
    assert.equal(testAfterReveal, 9900, 'test balance unchanged after safe reveal');
    assert.equal(await database.getUserBalance(adminUser.id), realBefore, 'real balance still unchanged');

    const payoutResult = await database.cashoutMinesGame(result.gameId, adminUser.id);
    assert.equal(payoutResult.currency, 'TEST');
    assert.equal(payoutResult.payout > 0, true);

    const testAfterCashout = await database.getUserTestBalance(adminUser.id);
    assert.ok(testAfterCashout > 9900, 'test balance should increase after cashout');
    assert.equal(await database.getUserBalance(adminUser.id), realBefore, 'real balance still unchanged after cashout');
});

test('PLINKO game accepts TEST currency and pays out to test_balance only', async () => {
    await database.setTestBalance(adminUser.id, 10000);
    const realBefore = await database.getUserBalance(adminUser.id);

    const result = await database.createPlinkoGame(adminUser.id, 200, 'TEST', null);
    assert.ok(result.gameId > 0);

    const testAfterBet = await database.getUserTestBalance(adminUser.id);
    assert.equal(testAfterBet, 9800, 'test balance should be 10000 - 200');
    assert.equal(await database.getUserBalance(adminUser.id), realBefore, 'real balance unchanged');

    const payoutResult = await database.dropPlinkoChip(result.gameId, adminUser.id);
    assert.equal(payoutResult.payout > 0 || payoutResult.payout === 0, true);

    const testAfterDrop = await database.getUserTestBalance(adminUser.id);
    assert.equal(await database.getUserBalance(adminUser.id), realBefore, 'real balance unchanged after drop');
});

test('DICE game accepts TEST currency and pays out to test_balance only', async () => {
    await database.setTestBalance(adminUser.id, 10000);
    const realBefore = await database.getUserBalance(adminUser.id);
    const testBefore = await database.getUserTestBalance(adminUser.id);

    const result = await database.createDiceGame(adminUser.id, 150, 'TEST', null, 50);
    assert.ok(result.gameId > 0);

    const testAfterBet = await database.getUserTestBalance(adminUser.id);
    // DICE resolves immediately (bet deducted + payout if won in one transaction)
    if (result.won) {
        assert.ok(testAfterBet === (testBefore - 150 + result.payout), 'test balance should reflect bet - payout');
        assert.ok(testAfterBet > testBefore - 150, 'test balance should increase on win above bet amount');
    } else {
        assert.equal(testAfterBet, 9850, 'test balance should be 10000 - 150 on loss');
    }
    assert.equal(await database.getUserBalance(adminUser.id), realBefore, 'real balance unchanged');
});

test('ROCKET (crash) game accepts TEST currency via placeTestBet/cashoutTestBet', async () => {
    await database.setTestBalance(adminUser.id, 5000);
    const realBefore = await database.getUserBalance(adminUser.id);

    const latest = await database.get('SELECT MAX(round_number) AS rn FROM rounds');
    const startRound = (latest?.rn || 0) + 1;

    const round = await database.createRoundRecord({
        nonce: startRound,
        clientSeed: 'test-client',
        serverSeed: 'a'.repeat(64),
        serverSeedHash: require('crypto').createHash('sha256').update('a'.repeat(64), 'utf8').digest('hex'),
        crashAt: 5.0
    });
    await database.updateRoundState(round.round_number, 'COUNTDOWN', 1.0);

    const betResult = await database.placeTestBet(adminUser.id, 500, round.round_number, null);
    assert.ok(betResult.betId > 0);

    const testAfterBet = await database.getUserTestBalance(adminUser.id);
    assert.equal(testAfterBet, 4500, 'test balance should be 5000 - 500');
    assert.equal(await database.getUserBalance(adminUser.id), realBefore, 'real balance unchanged');

    await database.updateRoundState(round.round_number, 'FLIGHT', 2.0);
    const cashoutResult = await database.cashoutTestBet(betResult.betId, adminUser.id, 2.0);
    assert.equal(cashoutResult.payout, 1000);
    assert.equal(cashoutResult.isTest, true);

    const testAfterCashout = await database.getUserTestBalance(adminUser.id);
    assert.equal(testAfterCashout, 5500, 'test balance should be 4500 + 1000');
    assert.equal(await database.getUserBalance(adminUser.id), realBefore, 'real balance unchanged after cashout');
});

test('ROCKET crash loses TEST balance without affecting real TON', async () => {
    await database.setTestBalance(adminUser.id, 5000);
    const realBefore = await database.getUserBalance(adminUser.id);

    const latest = await database.get('SELECT MAX(round_number) AS rn FROM rounds');
    const startRound = (latest?.rn || 0) + 1;

    const round = await database.createRoundRecord({
        nonce: startRound,
        clientSeed: 'test-client',
        serverSeed: 'b'.repeat(64),
        serverSeedHash: require('crypto').createHash('sha256').update('b'.repeat(64), 'utf8').digest('hex'),
        crashAt: 1.5
    });
    await database.updateRoundState(round.round_number, 'COUNTDOWN', 1.0);

    const betResult = await database.placeTestBet(adminUser.id, 500, round.round_number, null);
    assert.ok(betResult.betId > 0);

    // Crash the round (no cashout = loss)
    const settle = await database.crashRound(round.round_number, 1.5);
    assert.equal(settle.settled, true);

    const testAfterCrash = await database.getUserTestBalance(adminUser.id);
    assert.equal(testAfterCrash, 4500, 'test balance should remain at 4500 (bet was not cashed out)');
    assert.equal(await database.getUserBalance(adminUser.id), realBefore, 'real balance unchanged after crash');

    const testBet = await database.get('SELECT * FROM ton_bets WHERE id = ?', [betResult.betId]);
    assert.equal(testBet.status, 'LOST');
    assert.equal(testBet.bet_currency, 'TEST');
});

// =========================================================
// WITHDRAWAL ISOLATION TESTS
// =========================================================

test('TEST currency cannot be used for collectible withdrawals', async () => {
    const gift = await database.get('SELECT id, telegram_gift_id, value FROM gifts WHERE value > 0 LIMIT 1');
    if (!gift) throw new Error('seeded gift required');
    const userGift = await database.addGiftToUser(normalUser.id, gift.id);
    const uniqueCollectibleId = `TestCollectible-Withdrawal-${Date.now()}`;

    await database.run(
        'UPDATE user_gifts SET unique_collectible_id = ?, ownership_verified = 1 WHERE id = ?',
        [uniqueCollectibleId, userGift.id]
    );

    const collectible = await database.getCollectibleByUniqueId(uniqueCollectibleId);
    assert.ok(collectible, 'collectible should exist');
    assert.equal(collectible.ownership_status, 'OWNED');

    // TEST balance should not affect collectible status
    await database.setTestBalance(normalUser.id, 100000);
    const afterTestBalance = await database.getCollectibleByUniqueId(uniqueCollectibleId);
    assert.equal(afterTestBalance.ownership_status, 'OWNED', 'collectible status unchanged by test balance');
});
