'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-collectibles-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
// Configured so runCollectibleVerificationSweep() proceeds without a live Telegram business connection.
process.env.TELEGRAM_BUSINESS_CONNECTION_ID = 'test-connection-id';

const database = require('../database');
const serverModule = require('../server');

function makeOwnedUniqueGift({ name, number, ownedGiftId, senderTelegramId, stickerFileId = 'AgAC-fake-file-id' }) {
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

test.before(async () => {
    await database.initDatabase();
});

test.after(async () => {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('extractUniqueCollectibleIdentity rejects non-unique gifts and star gifts', () => {
    assert.equal(serverModule.extractUniqueCollectibleIdentity(null), null);
    assert.equal(serverModule.extractUniqueCollectibleIdentity({ type: 'regular', gift: {} }), null);
    assert.equal(serverModule.extractUniqueCollectibleIdentity({ type: 'unique', gift: { name: 'X' } }), null); // missing number
});

test('extractUniqueCollectibleIdentity extracts a real unique collectible identity', () => {
    const owned = makeOwnedUniqueGift({ name: 'PlushPepe', number: 17, ownedGiftId: 'og-1', senderTelegramId: 555 });
    const identity = serverModule.extractUniqueCollectibleIdentity(owned);
    assert.equal(identity.uniqueCollectibleId, 'PlushPepe-17');
    assert.equal(identity.telegramGiftInstanceId, 'og-1');
    assert.equal(identity.collectibleNumber, 17);
    assert.equal(identity.senderTelegramId, 555);
    assert.equal(identity.stickerFileId, 'AgAC-fake-file-id');
    assert.equal(identity.telegramGiftModel.imageUrl, null, 'raw file_id must never be used as a browser image URL');
});

test('sweep credits the correct Rocket user via sender_user.id, never by name/guess', async () => {
    const user = await database.findOrCreateUser('sender-match-user');
    const owned = makeOwnedUniqueGift({ name: 'GoldRing', number: 1, ownedGiftId: 'og-match-1', senderTelegramId: 'sender-match-user' });

    const result = await serverModule.runCollectibleVerificationSweep(async () => [owned]);
    assert.equal(result.configured, true);
    assert.equal(result.credited, 1);

    const collectibles = await database.getUserCollectibles(user.id);
    const credited = collectibles.find(c => c.unique_collectible_id === 'GoldRing-1');
    assert.ok(credited, 'collectible must be credited to the matched sender');
    assert.equal(credited.ownership_verified, 1);
});

test('sweep leaves the collectible unmatched when sender identity is hidden', async () => {
    const owned = makeOwnedUniqueGift({ name: 'HiddenSender', number: 2, ownedGiftId: 'og-hidden-1', senderTelegramId: null });
    const result = await serverModule.runCollectibleVerificationSweep(async () => [owned]);
    assert.equal(result.unmatched, 1);
    assert.equal(result.credited, 0);

    const anyOwner = await database.getCollectibleByUniqueId('HiddenSender-2');
    assert.equal(anyOwner, undefined, 'a collectible with no verifiable sender must never be assigned to any user');
});

test('sweep leaves the collectible unmatched when sender does not map to any Rocket user', async () => {
    const owned = makeOwnedUniqueGift({ name: 'UnknownSender', number: 3, ownedGiftId: 'og-unknown-1', senderTelegramId: 'no-such-rocket-user' });
    const result = await serverModule.runCollectibleVerificationSweep(async () => [owned]);
    assert.equal(result.unmatched, 1);
    assert.equal(result.credited, 0);
});

test('the same real collectible is never credited twice (duplicate prevention)', async () => {
    const user = await database.findOrCreateUser('dup-prevention-user');
    const owned = makeOwnedUniqueGift({ name: 'DupModel', number: 5, ownedGiftId: 'og-dup-1', senderTelegramId: 'dup-prevention-user' });

    const first = await serverModule.runCollectibleVerificationSweep(async () => [owned]);
    const second = await serverModule.runCollectibleVerificationSweep(async () => [owned]);
    assert.equal(first.credited, 1);
    assert.equal(second.credited, 0, 'second sweep of the same owned gift must not credit again');

    const rows = await database.getUserCollectibles(user.id, 'OWNED');
    const matches = rows.filter(r => r.unique_collectible_id === 'DupModel-5');
    assert.equal(matches.length, 1);
});

test('a user can own multiple distinct instances of the same gift model', async () => {
    const user = await database.findOrCreateUser('multi-instance-user');
    const first = makeOwnedUniqueGift({ name: 'SameModel', number: 10, ownedGiftId: 'og-multi-1', senderTelegramId: 'multi-instance-user' });
    const second = makeOwnedUniqueGift({ name: 'SameModel', number: 11, ownedGiftId: 'og-multi-2', senderTelegramId: 'multi-instance-user' });

    await serverModule.runCollectibleVerificationSweep(async () => [first]);
    await serverModule.runCollectibleVerificationSweep(async () => [second]);

    const rows = await database.getUserCollectibles(user.id, 'OWNED');
    const owned = rows.filter(r => r.unique_collectible_id === 'SameModel-10' || r.unique_collectible_id === 'SameModel-11');
    assert.equal(owned.length, 2, 'both unique instances of the same model must be owned simultaneously');
});

test('concurrent credit attempts for the identical collectible never double-credit (race safety)', async () => {
    const user = await database.findOrCreateUser('race-user');
    const owned = makeOwnedUniqueGift({ name: 'RaceModel', number: 9, ownedGiftId: 'og-race-1', senderTelegramId: 'race-user' });

    await Promise.all([
        serverModule.runCollectibleVerificationSweep(async () => [owned]),
        serverModule.runCollectibleVerificationSweep(async () => [owned])
    ]);

    const rows = await database.getUserCollectibles(user.id, 'OWNED');
    const matches = rows.filter(r => r.unique_collectible_id === 'RaceModel-9');
    assert.equal(matches.length, 1, 'concurrent sweeps must never insert the same unique collectible twice');
});

test('migration preserves telegram_thumbnail_file_id when rebuilding user_gifts', async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-rocket-legacy-'));
    const legacyDbPath = path.join(legacyDir, 'legacy.sqlite');
    const sqlite3 = require('sqlite3').verbose();
    const legacyDb = new sqlite3.Database(legacyDbPath);

    await new Promise((resolve, reject) => {
        legacyDb.serialize(() => {
            legacyDb.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT UNIQUE)`);
            legacyDb.run(`CREATE TABLE gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_gift_id TEXT UNIQUE, name TEXT, slug TEXT, emoji TEXT, image_url TEXT, collection TEXT, rarity TEXT, value REAL, total_supply INTEGER)`);
            legacyDb.run(`
                CREATE TABLE user_gifts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    gift_id INTEGER NOT NULL,
                    status TEXT DEFAULT 'OWNED',
                    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    unique_collectible_id TEXT,
                    telegram_gift_instance_id TEXT,
                    collectible_number INTEGER,
                    ownership_verified INTEGER DEFAULT 0,
                    verified_metadata TEXT,
                    UNIQUE(user_id, gift_id)
                )
            `);
            legacyDb.run(`INSERT INTO users (id, telegram_id) VALUES (1, 'legacy-user')`);
            legacyDb.run(`INSERT INTO gifts (id, telegram_gift_id, name, value) VALUES (1, 'legacy-model', 'Legacy', 0)`);
            legacyDb.run(`
                INSERT INTO user_gifts (id, user_id, gift_id, status, unique_collectible_id, telegram_gift_instance_id, ownership_verified, verified_metadata)
                VALUES (1, 1, 1, 'OWNED', 'Legacy-1', 'og-legacy-1', 1, ?)
            `, [JSON.stringify({ name: 'Legacy', number: 1, stickerFileId: 'legacy-thumb-file-id' })], error => {
                if (error) reject(error); else resolve();
            });
        });
    });
    await new Promise((resolve, reject) => legacyDb.close(error => error ? reject(error) : resolve()));

    process.env.DATABASE_PATH = legacyDbPath;
    delete require.cache[require.resolve('../database')];
    const legacyDatabaseModule = require('../database');

    await legacyDatabaseModule.migrateUserGiftsConstraint();

    const migratedRow = await new Promise((resolve, reject) => {
        const raw = new sqlite3.Database(legacyDbPath);
        raw.get('SELECT * FROM user_gifts WHERE id = 1', (error, row) => {
            raw.close();
            if (error) reject(error); else resolve(row);
        });
    });

    assert.equal(migratedRow.telegram_thumbnail_file_id, 'legacy-thumb-file-id', 'thumbnail file id must be backfilled from legacy verified_metadata');
    assert.equal(migratedRow.unique_collectible_id, 'Legacy-1');
    assert.equal(migratedRow.id, 1, 'existing row id must be preserved by the migration');

    await new Promise((resolve, reject) => legacyDatabaseModule.db.close(error => error ? reject(error) : resolve()));
    fs.rmSync(legacyDir, { recursive: true, force: true });

    // Restore the shared test database path for any subsequent tests in this file.
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    delete require.cache[require.resolve('../database')];
});
