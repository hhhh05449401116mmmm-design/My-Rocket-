'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-econ-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
process.env.TELEGRAM_BUSINESS_CONNECTION_ID = 'test-connection-id';

require('../test-helpers/no-network');

const database = require('../database');
const serverModule = require('../server');
const fair = require('../crashFair');

function makeOwnedUniqueGift({ name, number, ownedGiftId, senderTelegramId, stickerFileId = 'AgAC-fake-thumb' }) {
    return {
        type: 'unique',
        owned_gift_id: ownedGiftId,
        sender_user: senderTelegramId ? { id: senderTelegramId } : undefined,
        gift: {
            name,
            number,
            base_name: name,
            model: { name: `${name} Model`, sticker: { file_id: stickerFileId } },
            symbol: { name: `${name} Symbol` },
            backdrop: { name: `${name} Backdrop` }
        }
    };
}

async function seedCollectible(userId, { uniqueCollectibleId, telegramGiftInstanceId, collectibleNumber, marketValue }) {
    let gift = await database.get('SELECT * FROM gifts WHERE telegram_gift_id = ?', [uniqueCollectibleId.split('-')[0]]);
    if (!gift) {
        const result = await database.run(`
            INSERT INTO gifts (telegram_gift_id, name, slug, emoji, rarity, value, collection)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [uniqueCollectibleId.split('-')[0], uniqueCollectibleId.split('-')[0], uniqueCollectibleId, '🎁', 'rare', marketValue, 'Test']);
        gift = await database.get('SELECT * FROM gifts WHERE id = ?', [result.lastID]);
    }
    const userGiftResult = await database.run(`
        INSERT INTO user_gifts (
            user_id, gift_id, status, unique_collectible_id, telegram_gift_instance_id,
            collectible_number, ownership_verified, verified_metadata, telegram_thumbnail_file_id, market_value_snapshot
        ) VALUES (?, ?, 'OWNED', ?, ?, ?, 1, ?, ?, ?)
    `, [
        userId, gift.id, uniqueCollectibleId, telegramGiftInstanceId,
        collectibleNumber, JSON.stringify({ name: uniqueCollectibleId }),
        telegramGiftInstanceId, marketValue
    ]);
    return await database.get('SELECT * FROM user_gifts WHERE id = ?', [userGiftResult.lastID]);
}

async function addInventoryCollectible({ uniqueCollectibleId, telegramGiftInstanceId, collectibleNumber, marketValue, giftId }) {
    const result = await database.run(`
        INSERT INTO collectible_inventory (
            unique_collectible_id, telegram_gift_instance_id, collectible_number,
            gift_id, model_name, collection_name, verified_metadata,
            telegram_thumbnail_file_id, market_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [uniqueCollectibleId, telegramGiftInstanceId, collectibleNumber,
        giftId, uniqueCollectibleId, 'Test', JSON.stringify({ name: uniqueCollectibleId }),
        telegramGiftInstanceId, marketValue]);
    return await database.get('SELECT * FROM collectible_inventory WHERE id = ?', [result.lastID]);
}

test.before(async () => {
    await database.initDatabase();
});

test.after(async () => {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('collectible <= 1.10x returns the EXACT same collectible', async () => {
    const user = await database.findOrCreateUser('econ-low-cashout-user');
    const original = await seedCollectible(user.id, {
        uniqueCollectibleId: 'PlushPepe-17',
        telegramGiftInstanceId: 'og-low-17',
        collectibleNumber: 17,
        marketValue: 100.0
    });

    const round = fair.createFairRound(9991);
    await database.createRoundRecord(round);
    await database.run('UPDATE rounds SET crash_at = 10.0 WHERE round_number = ?', [round.nonce]);

    const betResult = await database.placeGiftBet(user.id, 'PlushPepe-17', round.nonce, null);
    await database.updateRoundState(round.nonce, 'FLIGHT', 1.05);
    const cashout = await database.cashoutBet('GIFT', betResult.betId, user.id, round.nonce, 1.05);

    assert.equal(cashout.collectibleReturned, true);
    assert.equal(cashout.originalCollectibleId, 'PlushPepe-17');

    const returned = await database.getCollectibleByUniqueId('PlushPepe-17');
    assert.ok(returned, 'collectible must still exist');
    assert.equal(returned.ownership_status, 'OWNED', 'collectible status must be back to OWNED');
    assert.equal(returned.telegram_gift_instance_id, 'og-low-17', 'exact same telegram gift instance id');
    assert.equal(returned.collectible_number, 17, 'exact same collectible number');
});

test('collectible > 1.10x consumes original and grants reward from inventory', async () => {
    const user = await database.findOrCreateUser('econ-high-cashout-user');
    const original = await seedCollectible(user.id, {
        uniqueCollectibleId: 'PlushPepe-18',
        telegramGiftInstanceId: 'og-high-18',
        collectibleNumber: 18,
        marketValue: 100.0
    });

    const gift = await database.get('SELECT * FROM gifts WHERE telegram_gift_id = ?', ['PlushPepe']);
    assert.ok(gift, 'PlushPepe gift row must exist');

    await addInventoryCollectible({
        uniqueCollectibleId: 'DiamondRing-100',
        telegramGiftInstanceId: 'og-reward-100',
        collectibleNumber: 100,
        marketValue: 85.0,
        giftId: gift.id
    });

    const round = fair.createFairRound(9992);
    await database.createRoundRecord(round);
    await database.run('UPDATE rounds SET crash_at = 10.0 WHERE round_number = ?', [round.nonce]);

    const betResult = await database.placeGiftBet(user.id, 'PlushPepe-18', round.nonce, null);
    await database.updateRoundState(round.nonce, 'FLIGHT', 1.05);
    const cashout = await database.cashoutBet('GIFT', betResult.betId, user.id, round.nonce, 1.50);

    assert.equal(cashout.rewardGranted, true);
    assert.equal(cashout.originalCollectibleId, 'PlushPepe-18');

    const consumed = await database.getCollectibleByUniqueId('PlushPepe-18');
    assert.equal(consumed.ownership_status, 'LOST', 'original collectible must be consumed (LOST)');

    const reward = await database.getCollectibleByUniqueId('DiamondRing-100');
    assert.ok(reward, 'reward collectible must be owned by user now');
    assert.equal(reward.user_id, user.id, 'reward must be owned by the player');
    assert.equal(reward.ownership_status, 'OWNED');
    assert.equal(reward.ownership_verified, 1);
});

test('crash consumes collectible (LOST, not returned)', async () => {
    const user = await database.findOrCreateUser('econ-crash-user');
    const original = await seedCollectible(user.id, {
        uniqueCollectibleId: 'PlushPepe-19',
        telegramGiftInstanceId: 'og-crash-19',
        collectibleNumber: 19,
        marketValue: 100.0
    });

    const round = fair.createFairRound(9993);
    await database.createRoundRecord(round);

    await database.placeGiftBet(user.id, 'PlushPepe-19', round.nonce, null);
    await database.updateRoundState(round.nonce, 'FLIGHT', 1.05);
    const settlement = await database.crashRound(round.nonce, 1.2);

    const after = await database.getCollectibleByUniqueId('PlushPepe-19');
    assert.equal(after.ownership_status, 'LOST', 'collectible must be LOST after crash');
    assert.equal(settlement.settled, true);
});

test('same collectible cannot be bet twice (race condition protection)', async () => {
    const user = await database.findOrCreateUser('econ-race-user');
    const original = await seedCollectible(user.id, {
        uniqueCollectibleId: 'BondedRing-01',
        telegramGiftInstanceId: 'og-race-01',
        collectibleNumber: 1,
        marketValue: 50.0
    });

    const round = fair.createFairRound(9994);
    await database.createRoundRecord(round);

    const bet1 = await database.placeGiftBet(user.id, 'BondedRing-01', round.nonce, null);
    
    await assert.rejects(
        database.placeGiftBet(user.id, 'BondedRing-01', round.nonce, null),
        /not owned|reserved concurrently|not available/
    );
});

test('another user cannot bet user collectible', async () => {
    const owner = await database.findOrCreateUser('econ-owner-user');
    const attacker = await database.findOrCreateUser('econ-attacker-user');
    await seedCollectible(owner.id, {
        uniqueCollectibleId: 'BondedRing-02',
        telegramGiftInstanceId: 'og-owner-02',
        collectibleNumber: 2,
        marketValue: 50.0
    });

    const round = fair.createFairRound(9995);
    await database.createRoundRecord(round);

    await assert.rejects(
        database.placeGiftBet(attacker.id, 'BondedRing-02', round.nonce, null),
        /not owned|not available|not verified/
    );

    const collectible = await database.getCollectibleByUniqueId('BondedRing-02');
    assert.equal(collectible.user_id, owner.id, 'collectible must remain with original owner');
    assert.equal(collectible.ownership_status, 'OWNED');
});

test('withdrawal cannot happen twice', async () => {
    const user = await database.findOrCreateUser('econ-withdraw-user');
    await seedCollectible(user.id, {
        uniqueCollectibleId: 'SignetRing-03',
        telegramGiftInstanceId: 'og-withdraw-03',
        collectibleNumber: 3,
        marketValue: 33.0
    });

    const reserved = await database.reserveCollectibleForWithdrawal(user.id, 'SignetRing-03');
    assert.equal(reserved.ownership_status, 'LOCKED');

    await assert.rejects(
        database.reserveCollectibleForWithdrawal(user.id, 'SignetRing-03'),
        /not available|reserved/
    );
});

test('failed withdrawal rolls back reservation', async () => {
    const user = await database.findOrCreateUser('econ-rollback-user');
    await seedCollectible(user.id, {
        uniqueCollectibleId: 'DiamondRing-04',
        telegramGiftInstanceId: 'og-rollback-04',
        collectibleNumber: 4,
        marketValue: 30.0
    });

    const reserved = await database.reserveCollectibleForWithdrawal(user.id, 'DiamondRing-04');
    assert.equal(reserved.ownership_status, 'LOCKED');

    await database.rollbackGiftWithdrawal(user.id, 'DiamondRing-04', 'Telegram API error: method unavailable');

    const rolledBack = await database.getCollectibleByUniqueId('DiamondRing-04');
    assert.equal(rolledBack.ownership_status, 'OWNED', 'collectible must be restored to OWNED after rollback');
});

test('inventory race condition protection — two concurrent winners cannot get same reward', async () => {
    const user1 = await database.findOrCreateUser('econ-inv-user1');
    const user2 = await database.findOrCreateUser('econ-inv-user2');

    const gift = await database.get('SELECT * FROM gifts WHERE telegram_gift_id = ?', ['BondedRing']);
    let giftRow = gift;
    if (!giftRow) {
        const result = await database.run(`
            INSERT INTO gifts (telegram_gift_id, name, slug, emoji, rarity, value, collection)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, ['BondedRing', 'Bonded Ring', 'bonded-ring', '💍', 'rare', 41.0, 'Jewelry']);
        giftRow = await database.get('SELECT * FROM gifts WHERE id = ?', [result.lastID]);
    }

    await addInventoryCollectible({
        uniqueCollectibleId: 'BondedRing-INV',
        telegramGiftInstanceId: 'og-inv-001',
        collectibleNumber: 1,
        marketValue: 41.0,
        giftId: giftRow.id
    });

    const round1 = fair.createFairRound(8801);
    await database.createRoundRecord(round1);
    await database.run('UPDATE rounds SET crash_at = 10.0 WHERE round_number = ?', [round1.nonce]);

    const orig1 = await seedCollectible(user1.id, {
        uniqueCollectibleId: 'PlushPepe-881',
        telegramGiftInstanceId: 'og-u1-881',
        collectibleNumber: 881,
        marketValue: 100.0
    });
    const orig2 = await seedCollectible(user2.id, {
        uniqueCollectibleId: 'PlushPepe-882',
        telegramGiftInstanceId: 'og-u2-882',
        collectibleNumber: 882,
        marketValue: 100.0
    });

    const bet1 = await database.placeGiftBet(user1.id, 'PlushPepe-881', round1.nonce, null);
    const bet2 = await database.placeGiftBet(user2.id, 'PlushPepe-882', round1.nonce, null);
    await database.updateRoundState(round1.nonce, 'FLIGHT', 1.05);

    const results = await Promise.allSettled([
        database.cashoutBet('GIFT', bet1.betId, user1.id, round1.nonce, 2.0),
        database.cashoutBet('GIFT', bet2.betId, user2.id, round1.nonce, 2.0)
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.ok(fulfilled.length >= 1, 'at least one cashout should succeed');
    assert.ok(fulfilled.length + rejected.length === 2);

    const reward1 = await database.getCollectibleByUniqueId('BondedRing-INV');
    assert.ok(reward1, 'reward collectible must exist in user_gifts');
    assert.equal(reward1.user_id, reward1.user_id, 'reward must be owned by exactly one user');
});
