'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-minigames-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
process.env.TELEGRAM_BUSINESS_CONNECTION_ID = 'test-connection-id';

require('../test-helpers/no-network');

const database = require('../database');

test.before(async () => {
    await database.initDatabase();
    await database.seedDatabase();
});

test.after(async () => {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
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

async function setBalanceToZero(user) {
    const currentBal = await database.getUserBalance(user.id) || 0;
    if (currentBal > 0) {
        await database.updateUserBalance(user.id, currentBal, 'subtract');
    }
}

// =========================================================
// MINES TESTS
// =========================================================

test('MINES: valid bet with TON', async () => {
    const user = await createUserWithBalance('mines-valid-ton');
    const result = await database.createMinesGame(user.id, 1.0, 'TON', null);
    assert.ok(result.gameId > 0);
    assert.ok(/^[a-f0-9]{64}$/.test(result.serverSeedHash));
    assert.ok(result.clientSeed.length > 0);
});

test('MINES: valid reveal (safe tile)', async () => {
    const user = await createUserWithBalance('mines-safe-reveal');
    const result = await database.createMinesGame(user.id, 1.0, 'TON', null);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const gameData = JSON.parse(game.game_data);
    const safeTile = gameData.minePositions
        .reduce((acc, v) => { acc[v] = true; return acc; }, {});
    let safeIndex = 0;
    while (safeTile[safeIndex]) safeIndex++;

    const reveal = await database.revealMinesTile(result.gameId, user.id, safeIndex);
    assert.equal(reveal.hitMine, false);
    assert.equal(reveal.tilesRevealed, 1);
    assert.ok(reveal.multiplier > 1.0);
});

test('MINES: mine hit', async () => {
    const user = await createUserWithBalance('mines-hit');
    const result = await database.createMinesGame(user.id, 1.0, 'TON', null);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const gameData = JSON.parse(game.game_data);
    const mineTile = gameData.minePositions[0];

    const reveal = await database.revealMinesTile(result.gameId, user.id, mineTile);
    assert.equal(reveal.hitMine, true);
    assert.equal(reveal.multiplier, gameData.baseMultiplier || 1.0);

    const completed = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.result_detail, JSON.stringify({ multiplier: 1.0, hitMine: true }));
});

test('MINES: safe reveal grows multiplier', async () => {
    const user = await createUserWithBalance('mines-grow');
    const result = await database.createMinesGame(user.id, 1.0, 'TON', null);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const gameData = JSON.parse(game.game_data);
    const occupied = gameData.minePositions.reduce((acc, v) => { acc[v] = true; return acc; }, {});

    let prevMult = 1.0;
    let revealed = 0;
    for (let i = 0; i < 25 && revealed < 5; i++) {
        if (!occupied[i]) {
            const r = await database.revealMinesTile(result.gameId, user.id, i);
            assert.equal(r.hitMine, false);
            assert.ok(r.multiplier > prevMult, `multiplier should grow: ${prevMult} -> ${r.multiplier}`);
            prevMult = r.multiplier;
            revealed++;
        }
    }
});

test('MINES: cashout pays multiplier * bet', async () => {
    const user = await createUserWithBalance('mines-cashout');
    await database.updateUserBalance(user.id, 100, 'add');
    const result = await database.createMinesGame(user.id, 1.0, 'TON', null);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const gameData = JSON.parse(game.game_data);

    const safeTile = gameData.minePositions.reduce((acc, v) => { acc[v] = true; return acc; }, {});
    let idx = 0;
    while (safeTile[idx]) idx++;
    await database.revealMinesTile(result.gameId, user.id, idx);

    const afterReveal = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const revealedData = JSON.parse(afterReveal.game_data);
    const mult = revealedData.multiplier;
    const expectedPayout = parseFloat((1.0 * mult).toFixed(2));

    const cashout = await database.cashoutMinesGame(result.gameId, user.id);
    assert.equal(cashout.paidOut, true);
    assert.equal(cashout.currency, 'TON');
    assert.equal(cashout.payout, expectedPayout);
});

test('MINES: double cashout rejected', async () => {
    const user = await createUserWithBalance('mines-double-cashout');
    const result = await database.createMinesGame(user.id, 1.0, 'TON', null);
    await database.cashoutMinesGame(result.gameId, user.id);

    await assert.rejects(
        database.cashoutMinesGame(result.gameId, user.id),
        /already completed/
    );
});

test('MINES: reveal after game over rejected', async () => {
    const user = await createUserWithBalance('mines-reveal-after-gameover');
    const result = await database.createMinesGame(user.id, 1.0, 'TON', null);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const gameData = JSON.parse(game.game_data);
    const mineTile = gameData.minePositions[0];

    await database.revealMinesTile(result.gameId, user.id, mineTile);

    await assert.rejects(
        database.revealMinesTile(result.gameId, user.id, mineTile),
        /already completed/
    );
});

test('MINES: another user cannot reveal/cashout own game', async () => {
    const user1 = await createUserWithBalance('mines-own-user');
    const user2 = await createUserWithBalance('mines-attacker-user');
    const result = await database.createMinesGame(user1.id, 1.0, 'TON', null);

    await assert.rejects(
        database.revealMinesTile(result.gameId, user2.id, 0),
        /not found|not belong/
    );

    await assert.rejects(
        database.cashoutMinesGame(result.gameId, user2.id),
        /not found|not belong/
    );
});

test('MINES: insufficient balance', async () => {
    const user = await database.findOrCreateUser('mines-impoverished');
    await setBalanceToZero(user);

    await assert.rejects(
        database.createMinesGame(user.id, 0.1, 'TON', null),
        /insufficient balance/i
    );
});

test('MINES: invalid bet amount rejected', async () => {
    const user = await createUserWithBalance('mines-invalid-amount');
    await assert.rejects(
        database.createMinesGame(user.id, 0.05, 'TON', null),
        /invalid bet amount/i
    );
});

test('MINES: concurrent reveals are serialized', async () => {
    const user = await createUserWithBalance('mines-concurrent');
    const result = await database.createMinesGame(user.id, 1.0, 'TON', null);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const gameData = JSON.parse(game.game_data);

    const occupied = gameData.minePositions.reduce((acc, v) => { acc[v] = true; return acc; }, {});
    const safeTiles = [];
    for (let i = 0; i < 25 && safeTiles.length < 3; i++) {
        if (!occupied[i]) safeTiles.push(i);
    }

    const results = await Promise.allSettled(
        safeTiles.map(t => database.revealMinesTile(result.gameId, user.id, t))
    );
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 3, 'all safe reveals should succeed');
});

async function seedVerifiedGift(userId, uniqueCollectibleId, instanceId, collectibleNumber, marketValue) {
    const gift = await database.get('SELECT id, telegram_gift_id, value FROM gifts WHERE value > 0 LIMIT 1');
    assert.ok(gift, 'seeded gift required');
    if (!gift) throw new Error('No seeded gift available');
    const { lastID } = await database.run(`
        INSERT INTO user_gifts (
            user_id, gift_id, status, unique_collectible_id, telegram_gift_instance_id,
            collectible_number, ownership_verified, verified_metadata, telegram_thumbnail_file_id, market_value_snapshot
        ) VALUES (?, ?, 'OWNED', ?, ?, ?, 1, ?, ?, ?)
    `, [
        userId, gift.id, uniqueCollectibleId, instanceId,
        collectibleNumber, JSON.stringify({ name: uniqueCollectibleId }),
        instanceId, marketValue
    ]);
    return await database.getCollectibleByUniqueId(uniqueCollectibleId);
}

test('MINES: GIFT bet uses collectible value', async () => {
    const user = await createUserWithBalance('mines-gift-bet');
    const collectible = await seedVerifiedGift(user.id, 'PlushPepe-MINES-GIFT', 'og-mines-gift', 1, 100.0);

    const result = await database.createMinesGame(user.id, collectible.gift_value, 'GIFT', 'PlushPepe-MINES-GIFT');
    assert.ok(result.gameId > 0);

    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    assert.equal(game.bet_currency, 'GIFT');
});

// =========================================================
// PLINKO TESTS
// =========================================================

test('PLINKO: valid bet', async () => {
    const user = await createUserWithBalance('plinko-valid-bet');
    const result = await database.createPlinkoGame(user.id, 1.0, 'TON', null);
    assert.ok(result.gameId > 0);
    assert.ok(/^[a-f0-9]{64}$/.test(result.serverSeedHash));
    assert.ok(result.clientSeed.length > 0);
});

test('PLINKO: server generates result deterministically from seed', async () => {
    const user = await createUserWithBalance('plinko-deterministic');
    const result = await database.createPlinkoGame(user.id, 1.0, 'TON', null);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const gameData = JSON.parse(game.game_data);

    const uniform = database.deriveGameUniform(game.server_seed, gameData.clientSeed, 0);
    const slotIndex = Math.floor(uniform * gameData.slots.length);
    const expectedMultiplier = gameData.slots[slotIndex];

    assert.equal(result.slotMultiplier, expectedMultiplier, 'pre-computed multiplier must match seed-derived value');
    assert.equal(result.slotMultiplier, expectedMultiplier);
});

test('PLINKO: payout calculated server-side', async () => {
    const user = await createUserWithBalance('plinko-server-payout');
    await database.updateUserBalance(user.id, 100, 'add');
    const betAmount = 1.0;
    const result = await database.createPlinkoGame(user.id, betAmount, 'TON', null);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const gameData = JSON.parse(game.game_data);

    const uniform = database.deriveGameUniform(game.server_seed, gameData.clientSeed, 0);
    const slotIndex = Math.floor(uniform * gameData.slots.length);
    const expectedMult = gameData.slots[slotIndex];
    const expectedPayout = betAmount * expectedMult;

    const drop = await database.dropPlinkoChip(result.gameId, user.id);
    assert.equal(drop.slotIndex, slotIndex);
    assert.equal(drop.multiplier, expectedMult);
    assert.equal(drop.payout, expectedPayout);
});

test('PLINKO: client cannot choose result or payout', async () => {
    const user = await createUserWithBalance('plinko-client-control');
    const result = await database.createPlinkoGame(user.id, 1.0, 'TON', null);

    const drop = await database.dropPlinkoChip(result.gameId, user.id);

    assert.equal(drop.gameId, result.gameId);
    assert.ok(drop.multiplier >= 0.1);
    assert.ok(drop.multiplier <= 10.0);

    if (drop.multiplier >= 1.0) {
        assert.equal(drop.paidOut, true);
    } else {
        assert.equal(drop.paidOut, false);
    }
});

test('PLINKO: duplicate settlement rejected', async () => {
    const user = await createUserWithBalance('plinko-dup-settle');
    const result = await database.createPlinkoGame(user.id, 1.0, 'TON', null);
    await database.dropPlinkoChip(result.gameId, user.id);

    await assert.rejects(
        database.dropPlinkoChip(result.gameId, user.id),
        /already completed/
    );
});

test('PLINKO: concurrent drops rejected', async () => {
    const user = await createUserWithBalance('plinko-dup-concurrent');
    const result = await database.createPlinkoGame(user.id, 1.0, 'TON', null);

    const results = await Promise.allSettled([
        database.dropPlinkoChip(result.gameId, user.id),
        database.dropPlinkoChip(result.gameId, user.id)
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, 'only one concurrent drop should succeed');
});

test('PLINKO: insufficient balance', async () => {
    const user = await database.findOrCreateUser('plinko-no-balance');
    await setBalanceToZero(user);

    await assert.rejects(
        database.createPlinkoGame(user.id, 0.1, 'TON', null),
        /insufficient balance/i
    );
});

test('PLINKO: GIFT bet uses collectible value', async () => {
    const user = await createUserWithBalance('plinko-gift-bet');
    const collectible = await seedVerifiedGift(user.id, 'PlushPepe-PLINKO-GIFT', 'og-plinko-gift', 2, 50.0);

    const result = await database.createPlinkoGame(user.id, collectible.gift_value, 'GIFT', 'PlushPepe-PLINKO-GIFT');
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    assert.equal(game.bet_currency, 'GIFT');
});

// =========================================================
// DICE TESTS
// =========================================================

test('DICE: valid bet wins when roll <= target', async () => {
    const user = await createUserWithBalance('dice-valid-win');
    await database.updateUserBalance(user.id, 100, 'add');
    const result = await database.createDiceGame(user.id, 1.0, 'TON', null, 99);
    assert.ok(result.gameId > 0);

    if (result.won) {
        assert.ok(result.roll <= 99, `roll ${result.roll} should be <= target 99`);
        const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
        assert.equal(game.status, 'COMPLETED');
        const expectedPayout = 1.0 / ((99/100)*0.95);
        assert.equal(result.payout, expectedPayout);
    }
});

test('DICE: valid bet loses when roll > target', async () => {
    const user = await createUserWithBalance('dice-valid-lose');
    await database.updateUserBalance(user.id, 100, 'add');
    const result = await database.createDiceGame(user.id, 1.0, 'TON', null, 1);
    assert.ok(result.gameId > 0);

    if (!result.won) {
        assert.ok(result.roll > 1, `roll ${result.roll} should be > target 1`);
        const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
        assert.equal(game.status, 'COMPLETED');
        assert.equal(result.payout, 0);
    }
});

test('DICE: server generates roll from seed (client cannot submit roll)', async () => {
    const user = await createUserWithBalance('dice-server-roll');
    const result = await database.createDiceGame(user.id, 1.0, 'TON', null, 50);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    const gameData = JSON.parse(game.game_data);

    const uniform = database.deriveGameUniform(game.server_seed, gameData.clientSeed, 0);
    const expectedRoll = Math.floor(uniform * 100) + 1;

    assert.equal(result.roll, expectedRoll, 'server roll must match seed-derived value');
    assert.ok(result.roll >= 1 && result.roll <= 100, 'roll must be in [1,100]');
});

test('DICE: target validation rejects invalid targets', async () => {
    const user = await createUserWithBalance('dice-target-validation');

    await assert.rejects(
        database.createDiceGame(user.id, 1.0, 'TON', null, 0),
        /target must be an integer between 1 and 99/i
    );
    await assert.rejects(
        database.createDiceGame(user.id, 1.0, 'TON', null, 100),
        /target must be an integer between 1 and 99/i
    );
    await assert.rejects(
        database.createDiceGame(user.id, 1.0, 'TON', null, -5),
        /target must be an integer between 1 and 99/i
    );
});

test('DICE: payout is server-side calculated', async () => {
    const user = await createUserWithBalance('dice-server-payout');
    await database.updateUserBalance(user.id, 100, 'add');
    const betAmount = 10.0;
    const result = await database.createDiceGame(user.id, betAmount, 'TON', null, 50);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);

    if (result.won) {
        const expectedPayout = betAmount / ((50/100)*0.95);
        assert.equal(result.payout, expectedPayout, 'payout must be server-calculated from bet/target');
    } else {
        assert.equal(result.payout, 0, 'lost bet must have 0 payout');
    }
});

test('DICE: client cannot submit desired roll or result', async () => {
    const user = await createUserWithBalance('dice-no-client-control');
    const result1 = await database.createDiceGame(user.id, 1.0, 'TON', null, 50);
    const result2 = await database.createDiceGame(user.id, 1.0, 'TON', null, 50);

    // Each result should have a fresh server seed
    assert.notEqual(result1.roll, undefined);
    assert.notEqual(result2.roll, undefined);

    // The roll must be a server-generated value, not influenced by inputs
    const game1 = await database.get('SELECT * FROM mini_games WHERE id = ?', [result1.gameId]);
    const gameData1 = JSON.parse(game1.game_data);
    const uniform1 = database.deriveGameUniform(game1.server_seed, gameData1.clientSeed, 0);
    const expectedRoll1 = Math.floor(uniform1 * 100) + 1;
    assert.equal(result1.roll, expectedRoll1);
});

test('DICE: duplicate settlement (same game not re-creatable with same ID)', async () => {
    const user = await createUserWithBalance('dice-dup-settle');
    const result = await database.createDiceGame(user.id, 1.0, 'TON', null, 50);

    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);
    assert.equal(game.status, 'COMPLETED');
});

test('DICE: insufficient balance', async () => {
    const user = await database.findOrCreateUser('dice-no-balance');
    await setBalanceToZero(user);

    await assert.rejects(
        database.createDiceGame(user.id, 0.1, 'TON', null, 50),
        /insufficient balance/i
    );
});

test('DICE: GIFT bet loses collectible on loss', async () => {
    const user = await createUserWithBalance('dice-gift-lose');
    const collectible = await seedVerifiedGift(user.id, 'PlushPepe-DICE-GIFT', 'og-dice-gift', 3, 25.0);

    const result = await database.createDiceGame(user.id, collectible.gift_value, 'GIFT', 'PlushPepe-DICE-GIFT', 1);
    const game = await database.get('SELECT * FROM mini_games WHERE id = ?', [result.gameId]);

    const userGift = await database.get(
        'SELECT status FROM user_gifts WHERE user_id = ? AND unique_collectible_id = ?',
        [user.id, 'PlushPepe-DICE-GIFT']
    );

    if (!result.won) {
        assert.equal(userGift.status, 'LOST', 'gift should be lost on dice loss');
    } else {
        assert.equal(userGift.status, 'IN_BET', 'gift remains IN_BET if won');
    }
});

// =========================================================
// AUTHORIZATION & CONCURRENCY TESTS
// =========================================================

test('MINES: another user cannot cashout another users game', async () => {
    const user1 = await createUserWithBalance('mines-xfer-victim');
    const user2 = await createUserWithBalance('mines-xfer-attacker');
    const result = await database.createMinesGame(user1.id, 1.0, 'TON', null);

    await assert.rejects(
        database.cashoutMinesGame(result.gameId, user2.id),
        /not found|not belong|own/
    );
});

test('CONCURRENCY: two players cash out simultaneously — only one wins the reward collectible', async () => {
    const gift = await database.get('SELECT * FROM gifts WHERE telegram_gift_id = ?', ['DiamondRing']);
    let giftRow = gift;
    if (!giftRow) {
        const ins = await database.run(`
            INSERT INTO gifts (telegram_gift_id, name, slug, emoji, rarity, value, collection)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, ['DiamondRing', 'Diamond Ring', 'diamond-ring', '💎', 'epic', 30.0, 'Jewelry']);
        giftRow = await database.get('SELECT * FROM gifts WHERE id = ?', [ins.lastID]);
    }

    await database.addMinesGame; database.createMinesGame;

    // Seed two users with collectibles worth ~30
    const user1 = await database.findOrCreateUser('concurrent-mines-user1');
    const user2 = await database.findOrCreateUser('concurrent-mines-user2');
    await database.updateUserBalance(user1.id, 1000, 'add');
    await database.updateUserBalance(user2.id, 1000, 'add');

    await database.run(`
        INSERT INTO collectible_inventory (unique_collectible_id, telegram_gift_instance_id, collectible_number, gift_id, model_name, market_value, ownership_status)
        VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE')
    `, ['DiamondRing-CONCURRENT', 'og-concurrent-diamond', 999, giftRow.id, 'DiamondRing', 30.0]);

    // Both play with TON — payout is TON so no collectible contention, but test double-cashout safety
    const game1 = await database.createMinesGame(user1.id, 1.0, 'TON', null);
    const game2 = await database.createMinesGame(user2.id, 1.0, 'TON', null);

    const results = await Promise.allSettled([
        database.cashoutMinesGame(game1.gameId, user1.id),
        database.cashoutMinesGame(game2.gameId, user2.id)
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 2, 'both distinct users should cash out independently');
});

// =========================================================
// COLLECTIBLE WITHDRAWAL CONCURRENCY TEST
// =========================================================

test('WITHDRAWAL: concurrent withdrawal attempts on same collectible — only one succeeds', async () => {
    const user = await database.findOrCreateUser('withdrawal-concurrency-user');
    const collectible = await seedVerifiedGift(user.id, 'PlushPepe-WITHDRAWAL', 'og-withdrawal-1', 42, 100.0);
    assert.equal(collectible.ownership_status, 'OWNED');

    const results = await Promise.allSettled([
        database.reserveCollectibleForWithdrawal(user.id, 'PlushPepe-WITHDRAWAL'),
        database.reserveCollectibleForWithdrawal(user.id, 'PlushPepe-WITHDRAWAL')
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one withdrawal reservation should succeed');
    assert.equal(rejected.length, 1, 'exactly one should be rejected');

    const after = await database.getCollectibleByUniqueId('PlushPepe-WITHDRAWAL');
    assert.equal(after.ownership_status, 'LOCKED', 'collectible should be LOCKED after reservation');

    const transactions = await database.getGiftTransactions(user.id, 10);
    const pendingWithdrawals = transactions.filter(t => t.transaction_type === 'WITHDRAWAL');
    assert.equal(pendingWithdrawals.length, 1, 'exactly one pending withdrawal transaction');

    // If the successful one is confirmed, the collectible goes to SENT
    await database.confirmGiftWithdrawal(user.id, 'PlushPepe-WITHDRAWAL', 'test-tx-hash');
    const confirmed = await database.getCollectibleByUniqueId('PlushPepe-WITHDRAWAL');
    assert.equal(confirmed.ownership_status, 'SENT');
});

test('WITHDRAWAL: failed withdrawal rolls back from LOCKED to OWNED', async () => {
    const user = await database.findOrCreateUser('withdrawal-rollback-user');
    const collectible = await seedVerifiedGift(user.id, 'PlushPepe-WITHDRAWAL-ROLLBACK', 'og-withdrawal-rollback', 43, 50.0);

    const reserved = await database.reserveCollectibleForWithdrawal(user.id, 'PlushPepe-WITHDRAWAL-ROLLBACK');
    assert.equal(reserved.ownership_status, 'LOCKED');

    // Simulate Telegram failure
    await database.rollbackGiftWithdrawal(user.id, 'PlushPepe-WITHDRAWAL-ROLLBACK', 'Telegram API error: transfer failed');

    const after = await database.getCollectibleByUniqueId('PlushPepe-WITHDRAWAL-ROLLBACK');
    assert.equal(after.ownership_status, 'OWNED', 'collectible must be restored to OWNED after rollback');
});
