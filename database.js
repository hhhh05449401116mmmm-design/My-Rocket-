// =========================================================
// database.js - نظام إدارة قاعدة البيانات المتكامل
// =========================================================

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createFairRound, DEFAULT_CLIENT_SEED } = require('./crashFair');
const rocketGiftCatalog = require('./rocketGiftCatalog.json');

// =========================================================
// 1. إنشاء اتصال قاعدة البيانات
// =========================================================
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'rocket.db');
// Ensures a mounted-volume path like /data/rocket.db works even before the directory exists.
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new sqlite3.Database(dbPath);

// =========================================================
// 2. دوال مساعدة للاستعلامات (Promise-based)
// =========================================================
function query(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

let transactionTail = Promise.resolve();

function transaction(callback) {
    const operation = transactionTail.then(async () => {
        await run('BEGIN IMMEDIATE TRANSACTION');
        try {
            const result = await callback();
            await run('COMMIT');
            return result;
        } catch (error) {
            try {
                await run('ROLLBACK');
            } catch (rollbackError) {
                error.rollbackError = rollbackError;
            }
            throw error;
        }
    });

    transactionTail = operation.catch(() => undefined);
    return operation;
}

// هجرة آمنة وذرية بالكامل: تُزيل UNIQUE(user_id, gift_id) القديم فقط إن كان موجودًا،
// خطوة بخطوة مع تحقق صريح بعد كل خطوة، وROLLBACK فوري عند أي فشل قبل أي COMMIT.
async function migrateUserGiftsConstraint() {
    const tableInfo = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_gifts'");
    if (!tableInfo || !tableInfo.sql || !tableInfo.sql.includes('UNIQUE(user_id, gift_id)')) {
        return; // لا يوجد قيد قديم لإزالته — لا حاجة لأي تغيير.
    }

    // دفاعي: تأكد أن الجدول المصدر يحتوي كل الأعمدة التي سننسخها، بغض النظر عن ترتيب الاستدعاء
    // (مثلاً إن استُدعيت هذه الدالة مباشرة قبل إتمام إضافات الأعمدة الإضافية المعتادة في initDatabase).
    const existingColumns = await query('PRAGMA table_info(user_gifts)');
    const existingColumnNames = new Set(existingColumns.map(col => col.name));
    const requiredColumns = [
        ['loot_box_locked_until', 'DATETIME'],
        ['unique_collectible_id', 'TEXT'],
        ['telegram_gift_instance_id', 'TEXT'],
        ['collectible_number', 'INTEGER'],
        ['ownership_verified', 'INTEGER DEFAULT 0'],
        ['verified_metadata', 'TEXT'],
        ['telegram_thumbnail_file_id', 'TEXT']
    ];
    for (const [name, type] of requiredColumns) {
        if (!existingColumnNames.has(name)) {
            await run(`ALTER TABLE user_gifts ADD COLUMN ${name} ${type}`);
        }
    }

    console.log('🔄 Migrating user_gifts schema to remove UNIQUE(user_id, gift_id)...');

    const originalCount = await get('SELECT COUNT(*) AS count FROM user_gifts');
    const originalMax = await get('SELECT MAX(id) AS maxId FROM user_gifts');

    await run('BEGIN IMMEDIATE TRANSACTION');
    try {
        await run(`
            CREATE TABLE user_gifts_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                gift_id INTEGER NOT NULL,
                status TEXT DEFAULT 'OWNED' CHECK(status IN ('OWNED', 'LOCKED', 'IN_BET', 'WON', 'LOST', 'SENT', 'SOLD')),
                received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                loot_box_locked_until DATETIME,
                unique_collectible_id TEXT,
                telegram_gift_instance_id TEXT,
                collectible_number INTEGER,
                ownership_verified INTEGER DEFAULT 0,
                verified_metadata TEXT,
                telegram_thumbnail_file_id TEXT,
                loot_box_reward INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (gift_id) REFERENCES gifts(id) ON DELETE CASCADE
            )
        `);

        await run(`
            INSERT INTO user_gifts_new (
                id, user_id, gift_id, status, received_at, updated_at, loot_box_locked_until,
                unique_collectible_id, telegram_gift_instance_id, collectible_number,
                ownership_verified, verified_metadata, telegram_thumbnail_file_id, loot_box_reward
            )
            SELECT
                id, user_id, gift_id, status, received_at, updated_at, loot_box_locked_until,
                unique_collectible_id, telegram_gift_instance_id, collectible_number,
                ownership_verified, verified_metadata, telegram_thumbnail_file_id, loot_box_reward
            FROM user_gifts
        `);

        // يجب التحقق من الجدول الجديد قبل لمس الجدول الأصلي إطلاقًا.
        const newCount = await get('SELECT COUNT(*) AS count FROM user_gifts_new');
        if (!originalCount || !newCount || newCount.count !== originalCount.count) {
            throw new Error(`Row count mismatch after copy: original=${originalCount && originalCount.count}, new=${newCount && newCount.count}`);
        }
        const newMax = await get('SELECT MAX(id) AS maxId FROM user_gifts_new');
        const originalMaxId = originalMax ? originalMax.maxId : null;
        const newMaxId = newMax ? newMax.maxId : null;
        if (originalMaxId !== newMaxId) {
            throw new Error(`MAX(id) mismatch after copy: original=${originalMaxId}, new=${newMaxId}`);
        }

        await run('DROP TABLE user_gifts');
        await run('ALTER TABLE user_gifts_new RENAME TO user_gifts');

        // Backfill telegram_thumbnail_file_id from legacy verified_metadata JSON where the
        // dedicated column is still empty (older rows only ever stored it inside the JSON blob).
        const rowsNeedingBackfill = await query(`
            SELECT id, verified_metadata FROM user_gifts
            WHERE telegram_thumbnail_file_id IS NULL AND verified_metadata IS NOT NULL
        `);
        for (const row of rowsNeedingBackfill) {
            try {
                const metadata = JSON.parse(row.verified_metadata);
                if (metadata && metadata.stickerFileId) {
                    await run('UPDATE user_gifts SET telegram_thumbnail_file_id = ? WHERE id = ?', [metadata.stickerFileId, row.id]);
                }
            } catch { /* malformed legacy metadata — nothing to backfill */ }
        }

        await run(`DROP INDEX IF EXISTS idx_user_gifts_unique_collectible`);
        await run(`DROP INDEX IF EXISTS idx_user_gifts_telegram_instance`);
        await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_gifts_unique_collectible
            ON user_gifts(unique_collectible_id)
            WHERE unique_collectible_id IS NOT NULL
              AND status IN ('OWNED', 'IN_BET', 'LOCKED')`);
        await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_gifts_telegram_instance
            ON user_gifts(telegram_gift_instance_id)
            WHERE telegram_gift_instance_id IS NOT NULL
              AND status IN ('OWNED', 'IN_BET', 'LOCKED')`);
        await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_gifts_telegram_instance
            ON user_gifts(telegram_gift_instance_id) WHERE telegram_gift_instance_id IS NOT NULL`);
        await run(`CREATE INDEX IF NOT EXISTS idx_user_gifts_user_gift_lookup
            ON user_gifts(user_id, gift_id)`);

        const fkViolations = await query('PRAGMA foreign_key_check');
        if (fkViolations && fkViolations.length > 0) {
            throw new Error(`foreign_key_check reported ${fkViolations.length} violation(s) after migration`);
        }

        await run('COMMIT');
        console.log(`✅ user_gifts schema migration completed safely (rows preserved: ${newCount.count})`);
    } catch (error) {
        try {
            await run('ROLLBACK');
            console.error('❌ user_gifts migration failed — rolled back safely, no changes applied:', error.message);
        } catch (rollbackError) {
            console.error('❌ user_gifts migration failed AND rollback also failed — manual review required:', error.message, rollbackError.message);
        }
        throw error;
    }
}

// =========================================================
// 3. إنشاء جميع الجداول
// =========================================================
function initDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // ===== 3.1 جدول المستخدمين =====
            db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    telegram_id TEXT UNIQUE NOT NULL,
                    username TEXT,
                    first_name TEXT,
                    last_name TEXT,
                    avatar_url TEXT,
                    init_data TEXT,
                    balance REAL DEFAULT 0,
                    test_balance REAL DEFAULT 0,
                    total_turnover REAL DEFAULT 0,
                    referral_code TEXT UNIQUE,
                    referred_by_user_id INTEGER,
                    referral_earned REAL DEFAULT 0,
                    vip_level INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // ===== 3.2 جدول الهدايا (المرجع الرئيسي) =====
            db.run(`
                CREATE TABLE IF NOT EXISTS gifts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    telegram_gift_id TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    slug TEXT UNIQUE,
                    emoji TEXT,
                    image_url TEXT,
                    collection TEXT,
                    rarity TEXT CHECK(rarity IN ('common', 'rare', 'epic', 'legendary')),
                    value REAL NOT NULL,
                    total_supply INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // ===== 3.3 جدول هدايا المستخدم (المخزون) =====
            db.run(`
                CREATE TABLE IF NOT EXISTS user_gifts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    gift_id INTEGER NOT NULL,
                    status TEXT DEFAULT 'OWNED' CHECK(status IN ('OWNED', 'LOCKED', 'IN_BET', 'WON', 'LOST', 'SENT', 'SOLD')),
                    received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (gift_id) REFERENCES gifts(id) ON DELETE CASCADE
                )
            `);

            // ===== 3.4 جدول رهانات الهدايا =====
            db.run(`
                CREATE TABLE IF NOT EXISTS gift_bets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    user_gift_id INTEGER NOT NULL,
                    round_id INTEGER NOT NULL,
                    gift_value_at_bet REAL NOT NULL,
                    auto_cashout_target REAL,
                    status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'CASHED_OUT', 'LOST')),
                    cashout_multiplier REAL,
                    payout REAL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_gift_id) REFERENCES user_gifts(id) ON DELETE CASCADE
                )
            `);

            // ===== 3.5 جدول رهانات TON =====
            db.run(`
                CREATE TABLE IF NOT EXISTS ton_bets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    round_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    auto_cashout_target REAL,
                    bet_currency TEXT DEFAULT 'TON' CHECK(bet_currency IN ('TON', 'TEST')),
                    status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'CASHED_OUT', 'LOST')),
                    cashout_multiplier REAL,
                    payout REAL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

            // Rocket-only queue for TON bets placed during FLIGHT.
            // It is isolated from ton_bets so the existing bet/crash settlement schema remains unchanged.
            db.run(`
                CREATE TABLE IF NOT EXISTS queued_ton_bets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    round_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    auto_cashout_target REAL,
                    status TEXT DEFAULT 'QUEUED' CHECK(status = 'QUEUED'),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
            db.run(`CREATE INDEX IF NOT EXISTS idx_queued_ton_bets_round ON queued_ton_bets(round_id, status)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_queued_ton_bets_user ON queued_ton_bets(user_id, status)`);
            // Rocket-only queue for Gift bets placed during FLIGHT.
            // The gift is reserved in user_gifts as IN_BET until cancel or promotion.
            db.run(`
                CREATE TABLE IF NOT EXISTS queued_gift_bets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    round_id INTEGER NOT NULL,
                    user_gift_id INTEGER NOT NULL,
                    gift_value_at_bet REAL NOT NULL,
                    auto_cashout_target REAL,
                    previous_status TEXT NOT NULL CHECK(previous_status IN ('OWNED', 'WON')),
                    status TEXT DEFAULT 'QUEUED' CHECK(status = 'QUEUED'),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_gift_id) REFERENCES user_gifts(id) ON DELETE CASCADE
                )
            `);
            db.run(`CREATE INDEX IF NOT EXISTS idx_queued_gift_bets_round ON queued_gift_bets(round_id, status)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_queued_gift_bets_user ON queued_gift_bets(user_id, status)`);
            // Migration: add bet_currency column for existing databases (default TON, never affects real balance).
            db.run(`ALTER TABLE ton_bets ADD COLUMN bet_currency TEXT DEFAULT 'TON' CHECK(bet_currency IN ('TON', 'TEST'))`, error => {
                if (error && !error.message.includes('duplicate column name')) {
                    console.error('Failed to add ton_bets.bet_currency:', error.message);
                }
            });

            // ===== 3.6 جدول الإيداعات =====
            db.run(`
                CREATE TABLE IF NOT EXISTS deposits (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    wallet_address TEXT NOT NULL,
                    amount REAL NOT NULL,
                    transaction_hash TEXT,
                    transaction_boc TEXT,
                    payload TEXT,
                    status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'DETECTED', 'CONFIRMED', 'CREDITED', 'FAILED')),
                    failure_reason TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

            // ===== 3.6B طلبات سحب الأرباح =====
            db.run(`
                CREATE TABLE IF NOT EXISTS withdrawals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    wallet_address TEXT NOT NULL,
                    amount REAL NOT NULL,
                    status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED')),
                    transaction_hash TEXT,
                    failure_reason TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
            db.run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status)`);

            // ===== 3.7 جدول الصناديق =====
            db.run(`
                CREATE TABLE IF NOT EXISTS lootboxes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    emoji TEXT,
                    price REAL NOT NULL,
                    rarity TEXT CHECK(rarity IN ('common', 'rare', 'epic', 'legendary')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // ===== 3.8 جدول سجل فتح الصناديق =====
            db.run(`
                CREATE TABLE IF NOT EXISTS lootbox_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    lootbox_id INTEGER NOT NULL,
                    gift_id INTEGER,
                    status TEXT DEFAULT 'OPENED' CHECK(status IN ('OPENED', 'FAILED')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (lootbox_id) REFERENCES lootboxes(id) ON DELETE CASCADE,
                    FOREIGN KEY (gift_id) REFERENCES gifts(id) ON DELETE SET NULL
                )
            `);

            // ===== 3.9 جدول الجولات =====
            db.run(`
                CREATE TABLE IF NOT EXISTS rounds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    round_number INTEGER UNIQUE NOT NULL,
                    multiplier REAL DEFAULT 1.00,
                    phase TEXT DEFAULT 'COUNTDOWN' CHECK(phase IN ('COUNTDOWN', 'FLIGHT', 'CRASH')),
                    server_seed_hash TEXT,
                    server_seed TEXT,
                    client_seed TEXT,
                    nonce INTEGER,
                    crash_at REAL,
                    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                    end_time DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // ===== 3.10 جدول الإحصائيات =====
            db.run(`
                CREATE TABLE IF NOT EXISTS user_stats (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    total_rounds INTEGER DEFAULT 0,
                    total_wins INTEGER DEFAULT 0,
                    total_losses INTEGER DEFAULT 0,
                    total_profit REAL DEFAULT 0,
                    highest_multiplier REAL DEFAULT 1.00,
                    gifts_won INTEGER DEFAULT 0,
                    gifts_lost INTEGER DEFAULT 0,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    UNIQUE(user_id)
                )
            `);

            // ===== 3.11 جدول الإنجازات =====
            db.run(`
                CREATE TABLE IF NOT EXISTS achievements (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    description TEXT,
                    icon TEXT,
                    requirement_type TEXT CHECK(requirement_type IN ('wins', 'profit', 'gifts', 'streak')),
                    requirement_value REAL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // ===== 3.12 جدول إنجازات المستخدم =====
            db.run(`
                CREATE TABLE IF NOT EXISTS user_achievements (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    achievement_id INTEGER NOT NULL,
                    unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE,
                    UNIQUE(user_id, achievement_id)
                )
            `);

            // ===== 3.13 جدول الإشعارات =====
            db.run(`
                CREATE TABLE IF NOT EXISTS notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    type TEXT CHECK(type IN ('GIFT_WON', 'GIFT_LOST', 'BET_WON', 'BET_LOST', 'DEPOSIT', 'ACHIEVEMENT', 'BALANCE_WON', 'GIFT_SOLD')),
                    message TEXT NOT NULL,
                    data TEXT,
                    is_read INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

            // Migrate the existing notifications table to include BALANCE_WON.
            // SQLite cannot alter a CHECK constraint in place, so rebuild the table
            // while preserving all existing notification rows.
            db.run(`PRAGMA foreign_keys = OFF`, fkError => {
                if (fkError) {
                    console.error('Failed to disable foreign keys for notifications migration:', fkError.message);
                    return;
                }
                db.run(`ALTER TABLE notifications RENAME TO notifications_legacy`, renameError => {
                    if (renameError && !renameError.message.includes('already exists')) {
                        console.error('Failed to prepare notifications migration:', renameError.message);
                        return;
                    }
                    db.run(`CREATE TABLE IF NOT EXISTS notifications (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER NOT NULL,
                        type TEXT CHECK(type IN ('GIFT_WON', 'GIFT_LOST', 'BET_WON', 'BET_LOST', 'DEPOSIT', 'ACHIEVEMENT', 'BALANCE_WON', 'GIFT_SOLD')),
                        message TEXT NOT NULL,
                        data TEXT,
                        is_read INTEGER DEFAULT 0,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                    )`, createError => {
                        if (createError) {
                            console.error('Failed to create migrated notifications table:', createError.message);
                            return;
                        }
                        db.run(`INSERT OR IGNORE INTO notifications
                            (id, user_id, type, message, data, is_read, created_at)
                            SELECT id, user_id, type, message, data, is_read, created_at
                            FROM notifications_legacy`, copyError => {
                            if (copyError) {
                                console.error('Failed to copy notifications during migration:', copyError.message);
                                return;
                            }
                            db.run(`DROP TABLE IF EXISTS notifications_legacy`, dropError => {
                                if (dropError) console.error('Failed to remove legacy notifications table:', dropError.message);
                                db.run(`PRAGMA foreign_keys = ON`, restoreError => {
                                    if (restoreError) console.error('Failed to restore foreign keys after notifications migration:', restoreError.message);
                                });
                            });
                        });
                    });
                });
            });

            // Migrate databases created before the Provably Fair fields existed.
            const roundColumns = [
                ['server_seed_hash', 'TEXT'],
                ['server_seed', 'TEXT'],
                ['client_seed', 'TEXT'],
                ['nonce', 'INTEGER'],
                ['crash_at', 'REAL']
            ];
            roundColumns.forEach(([name, type]) => {
                db.run(`ALTER TABLE rounds ADD COLUMN ${name} ${type}`, error => {
                    if (error && !error.message.includes('duplicate column name')) {
                        console.error(`Failed to add rounds.${name}:`, error.message);
                    }
                });
            });
            db.run('ALTER TABLE deposits ADD COLUMN transaction_boc TEXT', error => {
                if (error && !error.message.includes('duplicate column name')) {
                    console.error('Failed to add deposits.transaction_boc:', error.message);
                }
            });
            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_transaction_hash
                ON deposits(transaction_hash) WHERE transaction_hash IS NOT NULL`, error => {
                if (error) console.error('Failed to index deposit transaction hashes:', error.message);
            });

            // Foundation for real unique Telegram collectibles (additive, does not touch existing data).
            const userGiftColumns = [
                ['loot_box_locked_until', 'DATETIME'],
                ['unique_collectible_id', 'TEXT'],
                ['telegram_gift_instance_id', 'TEXT'],
                ['collectible_number', 'INTEGER'],
                ['ownership_verified', 'INTEGER DEFAULT 0'],
                ['verified_metadata', 'TEXT'],
                ['telegram_thumbnail_file_id', 'TEXT'],
                ['loot_box_reward', 'INTEGER DEFAULT 0'],
                ['market_value_snapshot', 'REAL'],
                ['market_value', 'REAL']
            ];
            userGiftColumns.forEach(([name, type]) => {
                db.run(`ALTER TABLE user_gifts ADD COLUMN ${name} ${type}`, error => {
                    if (error && !error.message.includes('duplicate column name')) {
                        console.error(`Failed to add user_gifts.${name}:`, error.message);
                    }
                });
            });
            db.run(`DROP INDEX IF EXISTS idx_user_gifts_unique_collectible`, error => {
                if (error) console.error('Failed to drop legacy unique_collectible_id index:', error.message);
                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_gifts_unique_collectible
                    ON user_gifts(unique_collectible_id)
                    WHERE unique_collectible_id IS NOT NULL
                      AND status IN ('OWNED', 'IN_BET', 'LOCKED')`, indexError => {
                    if (indexError) console.error('Failed to create active unique_collectible_id index:', indexError.message);
                });
            });
            db.run(`DROP INDEX IF EXISTS idx_user_gifts_telegram_instance`, error => {
                if (error) console.error('Failed to drop legacy telegram_gift_instance_id index:', error.message);
                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_gifts_telegram_instance
                    ON user_gifts(telegram_gift_instance_id)
                    WHERE telegram_gift_instance_id IS NOT NULL
                      AND status IN ('OWNED', 'IN_BET', 'LOCKED')`, indexError => {
                    if (indexError) console.error('Failed to create active telegram_gift_instance_id index:', indexError.message);
                });
            });

            // Referral migrations.
            db.run(`ALTER TABLE users ADD COLUMN referral_code TEXT`, error => {
                if (error && !error.message.includes('duplicate column name')) console.error('Failed to add users.referral_code:', error.message);
                db.run(`UPDATE users SET referral_code = 'r' || id WHERE referral_code IS NULL OR referral_code = ''`, updateError => {
                    if (updateError) console.error('Failed to backfill users.referral_code:', updateError.message);
                    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`, indexError => {
                        if (indexError) console.error('Failed to index users.referral_code:', indexError.message);
                    });
                });
            });
            db.run(`ALTER TABLE users ADD COLUMN referred_by_user_id INTEGER`, error => {
                if (error && !error.message.includes('duplicate column name')) console.error('Failed to add users.referred_by_user_id:', error.message);
            });
            db.run(`ALTER TABLE users ADD COLUMN referral_earned REAL DEFAULT 0`, error => {
                if (error && !error.message.includes('duplicate column name')) console.error('Failed to add users.referral_earned:', error.message);
            });
            db.run(`
                CREATE TABLE IF NOT EXISTS referral_rewards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    inviter_user_id INTEGER NOT NULL,
                    invited_user_id INTEGER NOT NULL,
                    deposit_id INTEGER NOT NULL UNIQUE,
                    amount REAL NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (inviter_user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (invited_user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (deposit_id) REFERENCES deposits(id) ON DELETE CASCADE
                )
            `, error => {
                if (error) console.error('Failed to create referral_rewards:', error.message);
            });

            // Migration: add test_balance column for existing databases (default 0, never affects real balance).
            db.run(`ALTER TABLE users ADD COLUMN test_balance REAL DEFAULT 0`, error => {
                if (error && !error.message.includes('duplicate column name')) {
                    console.error('Failed to add users.test_balance:', error.message);
                }
            });

            // Short-lived server-side import intents (Phase 3A). No ownership is granted here.
            db.run(`
                CREATE TABLE IF NOT EXISTS collectible_import_intents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    intent_token TEXT UNIQUE NOT NULL,
                    status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'EXPIRED', 'CONSUMED')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    expires_at DATETIME NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

            // Persists the Telegram Business Connection across server restarts (single row, id=1).
            // Stores only public connection metadata — never BOT_TOKEN or any secret.
            db.run(`
                CREATE TABLE IF NOT EXISTS telegram_business_connection (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    connection_id TEXT,
                    business_user_id TEXT,
                    can_view_gifts_and_stars INTEGER DEFAULT 0,
                    can_transfer_and_upgrade_gifts INTEGER DEFAULT 0,
                    is_enabled INTEGER DEFAULT 0,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Idempotency guard for Telegram webhook retries (Telegram may redeliver the same update_id).
            db.run(`
                CREATE TABLE IF NOT EXISTS telegram_webhook_updates (
                    update_id INTEGER PRIMARY KEY,
                    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Migration for existing Railway databases created before gift-transfer rights were added.
            db.run(`ALTER TABLE telegram_business_connection ADD COLUMN can_transfer_and_upgrade_gifts INTEGER DEFAULT 0`, error => {
                if (error && !error.message.includes('duplicate column name')) {
                    console.error('Failed to add telegram_business_connection.can_transfer_and_upgrade_gifts:', error.message);
                }
            });

            // Store inventory of real collectibles available as crash rewards.
            // These are real Telegram unique gifts (verified) that the game holds in reserve
            // to grant as prizes when a player cashes out above 1.10x.
            db.run(`
                CREATE TABLE IF NOT EXISTS collectible_inventory (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    unique_collectible_id TEXT NOT NULL,
                    telegram_gift_instance_id TEXT,
                    collectible_number INTEGER,
                    gift_id INTEGER NOT NULL,
                    model_name TEXT,
                    collection_name TEXT,
                    symbol_name TEXT,
                    backdrop_name TEXT,
                    verified_metadata TEXT,
                    telegram_thumbnail_file_id TEXT,
                    market_value REAL NOT NULL,
                    ownership_status TEXT DEFAULT 'AVAILABLE' CHECK(ownership_status IN ('AVAILABLE', 'LOCKED', 'IN_BET', 'SENT', 'SOLD', 'CONSUMED')),
                    reserved_for_user_id INTEGER,
                    reserved_until DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (gift_id) REFERENCES gifts(id) ON DELETE CASCADE,
                    FOREIGN KEY (reserved_for_user_id) REFERENCES users(id) ON DELETE SET NULL
                )
            `);
            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_unique_collectible
                ON collectible_inventory(unique_collectible_id)`);

            // Audit trail for every collectible gift movement (deposit, bet, cashout, reward, withdrawal, crash).
            db.run(`
                CREATE TABLE IF NOT EXISTS gift_transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    user_gift_id INTEGER,
                    transaction_type TEXT NOT NULL CHECK(transaction_type IN (
                        'DEPOSIT', 'BET', 'CASHOUT_RETURN', 'CASHOUT_REWARD',
                        'REWARD_GRANT', 'CRASH_LOSE', 'WITHDRAWAL', 'PENDING_PAYOUT'
                    )),
                    amount REAL NOT NULL,
                    related_collectible_id TEXT,
                    related_bet_id INTEGER,
                    status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'COMPLETED', 'FAILED', 'ROLLED_BACK')),
                    reason TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_gift_id) REFERENCES user_gifts(id) ON DELETE SET NULL
                )
            `);
            db.run(`CREATE INDEX IF NOT EXISTS idx_gift_transactions_user ON gift_transactions(user_id)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_gift_transactions_collectible ON gift_transactions(related_collectible_id)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_gift_transactions_status ON gift_transactions(status)`);

            // ===== 5.10 نظام ألعاب الواجهة الخلفية (Mines, Plinko, Dice) =====
            db.run(`
                CREATE TABLE IF NOT EXISTS mini_games (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                     game_type TEXT NOT NULL CHECK(game_type IN ('MINES', 'PLINKO', 'DICE', 'LOTTERY')),
                    bet_amount REAL NOT NULL,
                    bet_currency TEXT NOT NULL CHECK(bet_currency IN ('TON', 'TEST', 'GIFT')),
                    game_data TEXT,
                    server_seed TEXT NOT NULL,
                    server_seed_hash TEXT NOT NULL,
                    result_multiplier REAL,
                    result_detail TEXT,
                    payout REAL,
                    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    completed_at DATETIME DEFAULT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
            db.run(`CREATE INDEX IF NOT EXISTS idx_mini_games_user ON mini_games(user_id)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_mini_games_status ON mini_games(status)`);

            // ===== 5.11 PvP Battle Rounds =====
            db.run(`
                CREATE TABLE IF NOT EXISTS pvp_rounds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    round_number INTEGER NOT NULL UNIQUE,
                    phase TEXT NOT NULL CHECK(phase IN ('WAITING', 'COUNTDOWN', 'LIVE', 'CRASH', 'RESULT')),
                    seconds_remaining INTEGER DEFAULT 0,
                    pool_ton REAL DEFAULT 0,
                    pool_gift_value REAL DEFAULT 0,
                    winner_user_id INTEGER,
                    winner_multiplier REAL,
                    crash_at REAL,
                    server_seed TEXT NOT NULL,
                    server_seed_hash TEXT NOT NULL,
                    nonce INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    started_at DATETIME,
                    ended_at DATETIME
                )
            `);
            db.run(`CREATE INDEX IF NOT EXISTS idx_pvp_rounds_phase ON pvp_rounds(phase)`);

            db.run(`
                CREATE TABLE IF NOT EXISTS pvp_participants (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pvp_round_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    bet_currency TEXT NOT NULL CHECK(bet_currency IN ('TON', 'GIFT')),
                    bet_amount REAL NOT NULL,
                    gift_unique_id TEXT,
                    participation_percent REAL NOT NULL,
                    crash_point REAL,
                    cashout_multiplier REAL,
                    payout REAL DEFAULT 0,
                    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'CASHED_OUT', 'LOST', 'WON')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (pvp_round_id) REFERENCES pvp_rounds(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
            db.run(`CREATE INDEX IF NOT EXISTS idx_pvp_participants_round ON pvp_participants(pvp_round_id)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_pvp_participants_user ON pvp_participants(user_id)`);
            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pvp_participant_unique ON pvp_participants(pvp_round_id, user_id)`);

            // ===== 5.13 Scheduled Lottery System =====
            db.run(`
                CREATE TABLE IF NOT EXISTS lottery_rounds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_key TEXT NOT NULL,
                    draw_at DATETIME NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('OPEN', 'DRAWING', 'DRAWN')),
                    ticket_price REAL NOT NULL,
                    jackpot REAL NOT NULL,
                    main_numbers_count INTEGER NOT NULL,
                    main_pick_count INTEGER NOT NULL,
                    bonus_numbers_count INTEGER NOT NULL,
                    bonus_pick_count INTEGER NOT NULL,
                    max_participants INTEGER NOT NULL,
                    participant_count INTEGER DEFAULT 0,
                    draw_numbers TEXT,
                    draw_bonus_numbers TEXT,
                    winner_count INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    drawn_at DATETIME,
                    UNIQUE(game_key, draw_at)
                )
            `);
            db.run(`CREATE INDEX IF NOT EXISTS idx_lottery_rounds_game_status ON lottery_rounds(game_key, status)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_lottery_rounds_draw_at ON lottery_rounds(draw_at)`);

            db.run(`
                CREATE TABLE IF NOT EXISTS lottery_entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    round_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    main_numbers TEXT NOT NULL,
                    bonus_numbers TEXT NOT NULL,
                    ticket_price REAL NOT NULL,
                    payout REAL DEFAULT 0,
                    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'WINNER', 'LOST')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    settled_at DATETIME,
                    FOREIGN KEY (round_id) REFERENCES lottery_rounds(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
            db.run(`CREATE INDEX IF NOT EXISTS idx_lottery_entries_round ON lottery_entries(round_id)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_lottery_entries_winner_lookup ON lottery_entries(round_id, main_numbers, bonus_numbers)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_lottery_entries_user ON lottery_entries(user_id)`);

            // ===== 5.12 PvP Rewards =====
            db.run(`
                CREATE TABLE IF NOT EXISTS pvp_rewards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pvp_round_id INTEGER NOT NULL,
                    winner_user_id INTEGER NOT NULL,
                    reward_gift_unique_id TEXT,
                    reward_value REAL NOT NULL,
                    claimed INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (pvp_round_id) REFERENCES pvp_rounds(id) ON DELETE CASCADE,
                    FOREIGN KEY (winner_user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
            db.run(`CREATE INDEX IF NOT EXISTS idx_pvp_rewards_winner ON pvp_rewards(winner_user_id)`);

            db.run('SELECT 1', error => {
                if (error) { reject(error); return; }
                // Schema creation/ALTERs above are queued on the same serialized connection,
                // so this callback only fires after all of them have completed.
                migrateUserGiftsConstraint()
                    .catch(migrationError => {
                        // Already rolled back safely inside migrateUserGiftsConstraint(); never
                        // block server startup on this — the old UNIQUE constraint simply stays in place.
                        console.error('⚠️ Continuing startup without the user_gifts migration:', migrationError.message);
                    })
                    .then(() => {
                        console.log('✅ All database tables created/verified');
                        resolve();
                    });
            });
        });
    });
}

// =========================================================
// 4. إدخال البيانات الأولية
// =========================================================
function seedDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // ===== 4.1 هدايا Telegram =====
            const gifts = [
                { id: 'nail_bracelet', name: 'Nail Bracelet', emoji: '📿', rarity: 'epic', value: 117.53, collection: 'Jewelry' },
                { id: 'bonded_ring', name: 'Bonded Ring', emoji: '💍', rarity: 'rare', value: 41.66, collection: 'Jewelry' },
                { id: 'signet_ring', name: 'Signet Ring', emoji: '🔮', rarity: 'rare', value: 33.44, collection: 'Jewelry' },
                { id: 'diamond_ring', name: 'Diamond Ring', emoji: '💎', rarity: 'epic', value: 30.32, collection: 'Jewelry' },
                { id: 'backpack', name: 'Backpack', emoji: '🎒', rarity: 'common', value: 22.47, collection: 'Gear' },
                { id: 'love_you', name: 'LOVE YOU', emoji: '❤️', rarity: 'rare', value: 1.11, collection: 'Emotions' },
                { id: 'b_day', name: 'B-DAY', emoji: '🎂', rarity: 'rare', value: 2.70, collection: 'Celebration' },
                { id: 'space', name: 'SPACE', emoji: '🚀', rarity: 'common', value: 0.91, collection: 'Space' },
                { id: 'punk42', name: 'PUNK42', emoji: '👾', rarity: 'epic', value: 2.97, collection: 'NFT' },
                { id: 'crypto', name: 'CRYPTO', emoji: '₿', rarity: 'common', value: 1.02, collection: 'Crypto' },
                { id: 'free24', name: 'FREE24', emoji: '🎁', rarity: 'epic', value: 2.19, collection: 'Promo' },
                { id: 'telegram', name: 'TELEGRAM', emoji: '✈️', rarity: 'common', value: 1.07, collection: 'Brand' },
                { id: 'invite', name: 'INVITE', emoji: '📨', rarity: 'common', value: 2.01, collection: 'Social' },
                { id: 'space_nft', name: 'SPACE NFT', emoji: '🌌', rarity: 'legendary', value: 1.72, collection: 'NFT' },
                { id: 'hot', name: 'HOT', emoji: '🔥', rarity: 'rare', value: 1.98, collection: 'Trending' },
                // Rocket rewards: deterministic Telegram collectibles with verified art.
                { id: 'mousse_cake', name: 'Mousse Cake', emoji: '🍰', rarity: 'rare', value: 5.06, collection: 'Telegram', image_url: 'https://cdn.changes.tg/gifts/models/Mousse%20Cake/png/Original.png' },
                { id: 'jester_hat', name: 'Jester Hat', emoji: '🎩', rarity: 'rare', value: 5.40, collection: 'Telegram', image_url: 'https://cdn.changes.tg/gifts/models/Jester%20Hat/png/Original.png' },
                { id: 'swag_bag', name: 'Swag Bag', emoji: '👜', rarity: 'rare', value: 5.53, collection: 'Telegram', image_url: 'https://cdn.changes.tg/gifts/models/Swag%20Bag/png/Original.png' },
                { id: 'winter_wreath', name: 'Winter Wreath', emoji: '🎄', rarity: 'rare', value: 5.60, collection: 'Telegram', image_url: 'https://cdn.changes.tg/gifts/models/Winter%20Wreath/png/Original.png' },
                { id: 'restless_jar', name: 'Restless Jar', emoji: '🫙', rarity: 'epic', value: 6.94, collection: 'Telegram', image_url: 'https://cdn.changes.tg/gifts/models/Restless%20Jar/png/Original.png' },
                { id: 'love_potion', name: 'Love Potion', emoji: '🧪', rarity: 'epic', value: 14.02, collection: 'Telegram', image_url: 'https://cdn.changes.tg/gifts/models/Love%20Potion/png/Original.png' },
                { id: 'trapped_heart', name: 'Trapped Heart', emoji: '💜', rarity: 'epic', value: 15.84, collection: 'Telegram', image_url: 'https://cdn.changes.tg/gifts/models/Trapped%20Heart/png/Original.png' },
                { id: 'electric_skull', name: 'Electric Skull', emoji: '💀', rarity: 'legendary', value: 25.75, collection: 'Telegram', image_url: 'https://cdn.changes.tg/gifts/models/Electric%20Skull/png/Original.png' },
                { id: 'sakura_flower', name: 'Sakura Flower', emoji: '🌸', rarity: 'legendary', value: 32.69, collection: 'Telegram', image_url: 'https://cdn.changes.tg/gifts/models/Sakura%20Flower/png/Original.png' },
                { id: 'magic_potion', name: 'Magic Potion', emoji: '🧪', rarity: 'legendary', value: 60.33, collection: 'Telegram', image_url: 'https://cdn.changes.tg/gifts/models/Magic%20Potion/png/Original.png' }
            ];

            gifts.forEach(g => {
                db.run(`
                    INSERT OR IGNORE INTO gifts 
                    (telegram_gift_id, name, emoji, rarity, value, collection, image_url)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [g.id, g.name, g.emoji, g.rarity, g.value, g.collection || null, g.image_url || null]);
            });
            // Keep every Telegram gift that can be shown in Rocket in one
            // price-sorted catalog. Existing Rocket rows are refreshed so the
            // preview, cashout reward, popup, Backpack, and sale use one value.
            (rocketGiftCatalog.gifts || []).forEach(g => {
                db.run(`
                    UPDATE gifts
                    SET value = ?, image_url = ?, collection = 'Telegram'
                    WHERE name = ? AND collection = 'Telegram'
                `, [g.value, g.image_url, g.name]);
                db.run(`
                    INSERT OR IGNORE INTO gifts
                    (telegram_gift_id, name, emoji, rarity, value, collection, image_url)
                    VALUES (?, ?, '🎁', 'common', ?, 'Telegram', ?)
                `, [g.id, g.name, g.value, g.image_url]);
            });

            // ===== 4.2 صناديق الحظ =====
            const lootboxes = [
                { name: 'FREE', emoji: '🎁', price: 0, rarity: 'common' },
                { name: '0.1 TON', emoji: '💎', price: 0.1, rarity: 'common' },
                { name: '0.5 TON', emoji: '💎', price: 0.5, rarity: 'common' },
                { name: '1 TON', emoji: '💎', price: 1, rarity: 'common' },
                { name: '2 TON', emoji: '💎', price: 2, rarity: 'rare' },
                { name: '5 TON', emoji: '💎', price: 5, rarity: 'rare' },
                { name: '12 TON', emoji: '💎', price: 12, rarity: 'epic' },
                { name: '15 TON', emoji: '💎', price: 15, rarity: 'epic' },
                { name: '25 TON', emoji: '💎', price: 25, rarity: 'epic' },
                { name: '50 TON', emoji: '💎', price: 50, rarity: 'legendary' },
                { name: '100 TON', emoji: '💎', price: 100, rarity: 'legendary' }
            ];

            lootboxes.forEach(lb => {
                db.run(`
                    INSERT OR IGNORE INTO lootboxes (name, emoji, price, rarity)
                    VALUES (?, ?, ?, ?)
                `, [lb.name, lb.emoji, lb.price, lb.rarity]);
            });

            // ===== 4.3 الإنجازات =====
            const achievements = [
                { name: '🎯 First Win', description: 'Win your first round', icon: '🎯', requirement_type: 'wins', requirement_value: 1 },
                { name: '💎 High Roller', description: 'Profit 100 TON', icon: '💎', requirement_type: 'profit', requirement_value: 100 },
                { name: '🎁 Gift Collector', description: 'Win 5 gifts', icon: '🎁', requirement_type: 'gifts', requirement_value: 5 },
                { name: '🍀 Lucky Streak', description: 'Win 3 rounds in a row', icon: '🍀', requirement_type: 'streak', requirement_value: 3 },
                { name: '🚀 Rocket Master', description: 'Cash out at 10x multiplier', icon: '🚀', requirement_type: 'profit', requirement_value: 10 }
            ];

            achievements.forEach(a => {
                db.run(`
                    INSERT OR IGNORE INTO achievements 
                    (name, description, icon, requirement_type, requirement_value)
                    VALUES (?, ?, ?, ?, ?)
                `, [a.name, a.description, a.icon, a.requirement_type, a.requirement_value]);
            });

            db.run('SELECT 1', error => {
                if (error) {
                    reject(error);
                    return;
                }
                console.log('✅ Seed data inserted');
                resolve();
            });
        });
    });
}

// =========================================================
// 5. دوال الأعمال (Business Logic)
// =========================================================

// ===== 5.1 إدارة المستخدمين =====
async function findOrCreateUser(telegramId, userData = {}) {
    const normalizedTelegramId = String(telegramId);
    let user = await get('SELECT * FROM users WHERE telegram_id = ?', [normalizedTelegramId]);
    
    if (!user) {
        const result = await run(`
            INSERT INTO users (telegram_id, username, first_name, last_name, avatar_url)
            VALUES (?, ?, ?, ?, ?)
        `, [normalizedTelegramId, userData.username, userData.first_name, userData.last_name, userData.avatar_url]);
        await run('UPDATE users SET referral_code = ? WHERE id = ?', ['r' + result.lastID, result.lastID]);
        user = await get('SELECT * FROM users WHERE id = ?', [result.lastID]);
        
        await run(`
            INSERT INTO user_stats (user_id) VALUES (?)
        `, [result.lastID]);
    }
    
    return user;
}

async function attachReferralToUser(userId, referralCode) {
    const code = String(referralCode || '').trim().slice(0, 100);
    if (!code || !/^r\d+$/.test(code)) return { attached: false, reason: 'invalid_code' };
    const user = await get('SELECT id, referred_by_user_id FROM users WHERE id = ?', [userId]);
    if (!user || user.referred_by_user_id) return { attached: false, reason: 'already_attached' };
    const inviter = await get('SELECT id FROM users WHERE referral_code = ?', [code]);
    if (!inviter || inviter.id === userId) return { attached: false, reason: 'invalid_inviter' };
    await run('UPDATE users SET referred_by_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND referred_by_user_id IS NULL', [inviter.id, userId]);
    return { attached: true, inviterUserId: inviter.id };
}

async function getReferralOverview(userId) {
    const user = await get('SELECT referral_code, referral_earned FROM users WHERE id = ?', [userId]);
    const invitees = await get('SELECT COUNT(*) AS count FROM users WHERE referred_by_user_id = ?', [userId]);
    const today = await get(`
        SELECT COALESCE(SUM(amount), 0) AS amount
        FROM referral_rewards
        WHERE inviter_user_id = ? AND created_at >= date('now')
    `, [userId]);
    return {
        referralCode: user?.referral_code || ('r' + userId),
        totalEarned: Number(user?.referral_earned || 0),
        earnedToday: Number(today?.amount || 0),
        inviteCount: Number(invitees?.count || 0)
    };
}

async function getUserBalance(userId) {
    const user = await get('SELECT balance FROM users WHERE id = ?', [userId]);
    return user ? user.balance : 0;
}

async function getUserTestBalance(userId) {
    const user = await get('SELECT test_balance FROM users WHERE id = ?', [userId]);
    return user ? user.test_balance : 0;
}

async function setTestBalance(userId, amount) {
    const testBalance = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    await run('UPDATE users SET test_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [testBalance, userId]);
    return testBalance;
}

async function resetTestBalance(userId) {
    await run('UPDATE users SET test_balance = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
    return 0;
}

async function getUserTestBalanceRaw(userId) {
    return await get('SELECT balance, test_balance FROM users WHERE id = ?', [userId]);
}

async function updateUserBalance(userId, amount, operation = 'add') {
    const currentBalance = await getUserBalance(userId);
    const newBalance = operation === 'add' ? currentBalance + amount : currentBalance - amount;
    await run('UPDATE users SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newBalance, userId]);
    return newBalance;
}

function normalizeAutoCashoutTarget(target) {
    if (target === null || target === undefined || target === '') return null;
    const normalizedTarget = Number(target);
    if (!Number.isFinite(normalizedTarget) || normalizedTarget < 1.01 || normalizedTarget > 1000) {
        throw new Error('Invalid auto cashout target');
    }
    return normalizedTarget;
}

async function createRoundRecord(round) {
    await run(`
        INSERT INTO rounds
        (round_number, multiplier, phase, server_seed_hash, server_seed, client_seed, nonce, crash_at, start_time)
        VALUES (?, 1.00, 'COUNTDOWN', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
        round.nonce,
        round.serverSeedHash,
        round.serverSeed,
        round.clientSeed,
        round.nonce,
        round.crashAt
    ]);

    return await getRoundByNumber(round.nonce);
}

async function getRoundByNumber(roundNumber) {
    return await get('SELECT * FROM rounds WHERE round_number = ?', [roundNumber]);
}

async function updateRoundState(roundNumber, phase, multiplier) {
    const endTime = phase === 'CRASH' ? 'CURRENT_TIMESTAMP' : 'end_time';
    await run(`
        UPDATE rounds
        SET phase = ?, multiplier = ?, end_time = ${endTime}
        WHERE round_number = ?
    `, [phase, multiplier, roundNumber]);
}

async function getActiveBetsForRound(roundNumber) {
    return await query(`
        SELECT id, user_id, 'TON' AS bet_type, auto_cashout_target AS target
        FROM ton_bets
        WHERE round_id = ? AND status = 'ACTIVE' AND auto_cashout_target IS NOT NULL
        UNION ALL
        SELECT id, user_id, 'GIFT' AS bet_type, auto_cashout_target AS target
        FROM gift_bets
        WHERE round_id = ? AND status = 'ACTIVE' AND auto_cashout_target IS NOT NULL
    `, [roundNumber, roundNumber]);
}

// Server-authoritative live player list for the current round (no telegram_id exposed).
async function getRoundPlayers(roundNumber) {
    return await query(`
        SELECT tb.id AS bet_id, tb.user_id, tb.amount AS amount, tb.status,
               CASE WHEN tb.status = 'LOST' THEN r.crash_at ELSE tb.cashout_multiplier END AS multiplier,
               u.first_name, u.last_name, u.avatar_url,
               NULL AS unique_collectible_id, NULL AS gift_image_url, NULL AS gift_name,
               'TON' AS bet_type
        FROM ton_bets tb
        JOIN users u ON u.id = tb.user_id
        JOIN rounds r ON r.round_number = tb.round_id
        WHERE tb.round_id = ?
        UNION ALL
        SELECT gb.id AS bet_id, gb.user_id, gb.gift_value_at_bet AS amount, gb.status,
               CASE WHEN gb.status = 'LOST' THEN r.crash_at ELSE gb.cashout_multiplier END AS multiplier,
               u.first_name, u.last_name, u.avatar_url,
               ug.unique_collectible_id, g.image_url AS gift_image_url, g.name AS gift_name,
               'GIFT' AS bet_type
        FROM gift_bets gb
        JOIN users u ON u.id = gb.user_id
        JOIN rounds r ON r.round_number = gb.round_id
        JOIN user_gifts ug ON ug.id = gb.user_gift_id
        JOIN gifts g ON g.id = ug.gift_id
        WHERE gb.round_id = ?
        ORDER BY bet_id ASC
    `, [roundNumber, roundNumber]);
}

async function selectRocketRewardForPayout(payout) {
    const numericPayout = Number(payout);
    if (!Number.isFinite(numericPayout) || numericPayout <= 0) return null;
    return await get(`
        SELECT id, telegram_gift_id, name, emoji, image_url, value, rarity
        FROM gifts
        WHERE collection = 'Telegram' AND value > 0 AND value <= ?
          AND image_url IS NOT NULL AND TRIM(image_url) <> ''
        ORDER BY value DESC, id ASC
        LIMIT 1
    `, [numericPayout]);
}

async function addRocketRewardGiftToUser(userId, giftId, marketValue = null) {
    const gift = await getGiftById(giftId);
    if (!gift) throw new Error('Gift not found');
    const requestedMarketValue = Number(marketValue);
    const storedMarketValue = Number.isFinite(requestedMarketValue) && requestedMarketValue > 0
        ? requestedMarketValue
        : Number(gift.value || 0);
    const result = await run(`
        INSERT INTO user_gifts (user_id, gift_id, status, ownership_verified, market_value, loot_box_locked_until, loot_box_reward)
        VALUES (?, ?, 'WON', 0, ?, NULL, 2)
    `, [userId, gift.id, storedMarketValue]);
    return await get('SELECT * FROM user_gifts WHERE id = ?', [result.lastID]);
}

async function grantRocketRewardGift(userId, payout) {
    const gift = await selectRocketRewardForPayout(payout);
    if (!gift) return null;
    // Rocket rewards are immediately actionable: Keep, Bet, or Sell.
    const stored = await addRocketRewardGiftToUser(userId, gift.id, gift.value);
    return {
        userGiftId: stored?.id || stored?.user_gift_id || null,
        giftId: gift.id,
        name: gift.name,
        emoji: gift.emoji || '🎁',
        imageUrl: gift.image_url,
        isTelegramCollectible: true,
        value: Number(gift.value),
        rewardType: 'ROCKET_PAYOUT_GIFT'
    };
}

async function cashoutBet(type, betId, userId, roundNumber, multiplier) {
    const config = type === 'TON'
        ? { table: 'ton_bets', amountColumn: 'amount', payoutColumn: 'payout' }
        : type === 'GIFT'
            ? { table: 'gift_bets', amountColumn: 'gift_value_at_bet', payoutColumn: 'payout' }
            : null;
    if (!config) throw new Error('Invalid bet type');
    const minimumCashoutMultiplier = type === 'TON' ? 1 : 1.01;
    if (!Number.isFinite(multiplier) || multiplier < minimumCashoutMultiplier || (type === 'TON' && multiplier <= 1)) {
        throw new Error(type === 'TON' ? 'Cashout must be above 1.00x' : `Cashout must be at least ${minimumCashoutMultiplier.toFixed(2)}x`);
    }

    return await transaction(async () => {
        const round = await getRoundByNumber(roundNumber);
        if (!round || round.phase !== 'FLIGHT' || multiplier > round.crash_at) {
            throw new Error('Round is not available for cashout');
        }

        const bet = await get(`
            SELECT * FROM ${config.table}
            WHERE id = ? AND user_id = ? AND round_id = ? AND status = 'ACTIVE'
        `, [betId, userId, roundNumber]);
        if (!bet) throw new Error('Bet not found or already settled');

        const payout = bet[config.amountColumn] * multiplier;
        // A TON Rocket cashout is converted into a Telegram collectible.
        // Do this inside the transaction so a payout without a valid gift cannot settle.
        let rocketGift = null;
        if (type === 'TON') {
            rocketGift = await grantRocketRewardGift(userId, payout);
            if (!rocketGift) throw new Error('No Telegram collectible is available for this payout');
        }
        const update = await run(`
            UPDATE ${config.table}
            SET status = 'CASHED_OUT', cashout_multiplier = ?, ${config.payoutColumn} = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'ACTIVE'
        `, [multiplier, payout, betId]);
        if (update.changes !== 1) throw new Error('Bet was settled concurrently');

        if (type === 'TON') {
            // No TON is credited here. The player chooses Keep, Bet, or Sell in the UI.
            await updateUserStats(userId, 'win', 0);
            return {
                payout,
                multiplier,
                amount: bet[config.amountColumn],
                giftValue: undefined,
                rocketGift
            };
        } else {
            return await settleGiftCashout(bet, userId, betId, multiplier, payout);
        }
    });
}

async function settleGiftCashout(bet, userId, betId, multiplier, payout) {
    const userGift = await get('SELECT * FROM user_gifts WHERE id = ?', [bet.user_gift_id]);
    if (!userGift) throw new Error('Bet gift not found');

    // Verified Telegram collectibles are consumed by the bet.
    // Their market value is converted to TON only when the player cashes out.
    // The crash calculation and round lifecycle are untouched.
    if (userGift.unique_collectible_id && userGift.ownership_verified === 1) {
        const update = await run(`
            UPDATE user_gifts
            SET status = 'LOST', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'IN_BET'
        `, [userGift.id]);
        if (update.changes !== 1) throw new Error('Collectible bet was settled concurrently');

        await run(`
            INSERT INTO gift_transactions
            (user_id, user_gift_id, transaction_type, amount, related_bet_id, status, reason)
            VALUES (?, ?, 'BET', ?, ?, 'COMPLETED', 'Verified Telegram collectible consumed by Rocket bet')
        `, [userId, userGift.id, bet.gift_value_at_bet, betId]);

        await run(
            'UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [payout, userId]
        );
        await updateUserStats(userId, 'win', payout);

        return {
            payout,
            multiplier,
            amount: bet.gift_value_at_bet,
            giftValue: bet.gift_value_at_bet,
            collectibleConsumed: true,
            originalCollectibleId: userGift.unique_collectible_id,
            message: 'Collectible consumed and paid in TON'
        };
    }

    // Existing non-collectible gift behavior stays unchanged.
    if (!userGift.unique_collectible_id) {
        await run("UPDATE user_gifts SET status = 'WON', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [bet.user_gift_id]);
        await updateUserStats(userId, 'win', payout);
        return {
            payout,
            multiplier,
            amount: bet.gift_value_at_bet,
            giftValue: bet.gift_value_at_bet
        };
    }

    // Legacy/unverified collectible path stays unchanged.
    if (multiplier <= 1.10) {
        await run(`
            UPDATE user_gifts
            SET status = 'OWNED', market_value_snapshot = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [bet.gift_value_at_bet, userGift.id]);
        await run(`
            INSERT INTO gift_transactions (user_id, user_gift_id, transaction_type, amount, related_bet_id, status)
            VALUES (?, ?, 'CASHOUT_RETURN', 0, ?, 'COMPLETED')
        `, [userId, userGift.id, betId]);
        await updateUserStats(userId, 'win', 0);
        return {
            payout: 0,
            multiplier,
            amount: bet.gift_value_at_bet,
            giftValue: bet.gift_value_at_bet,
            collectibleReturned: true,
            originalCollectibleId: userGift.unique_collectible_id,
            message: 'Collectible returned at <=1.10x'
        };
    }

    const targetPayoutValue = bet.gift_value_at_bet * multiplier;
    await run(`
        UPDATE user_gifts
        SET status = 'LOST', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'IN_BET'
    `, [userGift.id]);
    await run(`
        INSERT INTO gift_transactions (user_id, user_gift_id, transaction_type, amount, related_bet_id, status)
        VALUES (?, ?, 'BET', ?, ?, 'COMPLETED')
    `, [userId, userGift.id, bet.gift_value_at_bet, betId]);

    const reward = await selectRewardGiftType(targetPayoutValue);
    if (reward) {
        const pendingReward = await createPendingGiftReward(userId, reward.id, reward.value, betId);
        await updateUserStats(userId, 'win', 0);
        return {
            payout: 0,
            multiplier,
            amount: reward.value,
            giftValue: bet.gift_value_at_bet,
            rewardGranted: true,
            rewardGiftType: reward.name,
            rewardGiftId: reward.id,
            rewardUserGiftId: pendingReward.id,
            originalCollectibleId: userGift.unique_collectible_id,
            message: 'Gift type awarded; concrete Telegram collectible will be selected at withdrawal'
        };
    }

    await run(`
        INSERT INTO gift_transactions (user_id, user_gift_id, transaction_type, amount, related_bet_id, status, reason)
        VALUES (?, ?, 'PENDING_PAYOUT', ?, ?, 'PENDING', 'No suitable inventory collectible found')
    `, [userId, userGift.id, targetPayoutValue, betId]);
    await updateUserStats(userId, 'win', 0);
    return {
        payout: 0,
        multiplier,
        amount: 0,
        giftValue: bet.gift_value_at_bet,
        payoutPending: true,
        originalCollectibleId: userGift.unique_collectible_id,
        message: 'Payout pending - no suitable reward in inventory'
    };
}

async function crashRound(roundNumber, multiplier) {
    return await transaction(async () => {
        const round = await getRoundByNumber(roundNumber);
        if (!round || round.phase === 'CRASH') return { settled: false, alreadySettled: true };

        const giftBets = await query(`
            SELECT gb.id AS bet_id, gb.user_id, gb.user_gift_id, gb.gift_value_at_bet,
                   ug.unique_collectible_id
            FROM gift_bets gb
            JOIN user_gifts ug ON ug.id = gb.user_gift_id
            WHERE gb.round_id = ? AND gb.status = 'ACTIVE'
        `, [roundNumber]);

        const roundUpdate = await run(`
            UPDATE rounds
            SET phase = 'CRASH', multiplier = ?, end_time = CURRENT_TIMESTAMP
            WHERE round_number = ? AND phase != 'CRASH'
        `, [multiplier, roundNumber]);
        if (roundUpdate.changes !== 1) return { settled: false, alreadySettled: true };

        const tonLosses = await run(`
            UPDATE ton_bets SET status = 'LOST', updated_at = CURRENT_TIMESTAMP
            WHERE round_id = ? AND status = 'ACTIVE'
        `, [roundNumber]);
        const giftLosses = await run(`
            UPDATE gift_bets SET status = 'LOST', updated_at = CURRENT_TIMESTAMP
            WHERE round_id = ? AND status = 'ACTIVE'
        `, [roundNumber]);

        for (const bet of giftBets) {
            const update = await run(`
                UPDATE user_gifts SET status = 'LOST', updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'IN_BET'
            `, [bet.user_gift_id]);
            if (update.changes === 1 && bet.unique_collectible_id) {
                await run(`
                    INSERT INTO gift_transactions (user_id, user_gift_id, transaction_type, amount, related_bet_id, status, reason)
                    VALUES (?, ?, 'CRASH_LOSE', ?, ?, 'COMPLETED', 'Crashed before cashout')
                `, [bet.user_id, bet.user_gift_id, bet.gift_value_at_bet, bet.bet_id]);
            }
        }

        return {
            settled: true,
            tonLosses: tonLosses.changes,
            giftLosses: giftLosses.changes
        };
    });
}

// ===== 5.2 إدارة هدايا المستخدم =====
async function getUserGifts(userId, status = null) {
    let sql = `
        SELECT g.*, ug.id as user_gift_id, ug.status as ownership_status, ug.received_at,
               ug.market_value AS user_market_value
        FROM user_gifts ug
        JOIN gifts g ON ug.gift_id = g.id
        WHERE ug.user_id = ?
    `;
    const params = [userId];
    
    if (status) {
        sql += ' AND ug.status = ?';
        params.push(status);
    }
    
    sql += ' ORDER BY ug.received_at DESC';
    
    return await query(sql, params);
}

async function getGiftById(giftId) {
    return await get('SELECT * FROM gifts WHERE id = ? OR telegram_gift_id = ?', [giftId, giftId]);
}

async function addGiftToUser(userId, giftId) {
    // التحقق من وجود الهدية
    const gift = await getGiftById(giftId);
    if (!gift) throw new Error('Gift not found');
    
    // التحقق من أن المستخدم لا يملكها بالفعل
    const existing = await get('SELECT * FROM user_gifts WHERE user_id = ? AND gift_id = ?', [userId, gift.id]);
    if (existing) {
        if (existing.status === 'LOST') {
            // إعادة تفعيل الهدية المفقودة
            await run('UPDATE user_gifts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['OWNED', existing.id]);
            return existing;
        }
        throw new Error('Gift already owned');
    }
    
    const result = await run(`
        INSERT INTO user_gifts (user_id, gift_id, status)
        VALUES (?, ?, 'OWNED')
    `, [userId, gift.id]);
    
    return await get('SELECT * FROM user_gifts WHERE id = ?', [result.lastID]);
}


// صندوق الهدايا يحتاج ملكية متعددة لنفس نوع الهدية: كل فوز هو قطعة جديدة.
// هذا المسار لا يغيّر addGiftToUser() المستخدم في الملكية القديمة/الاستيراد.
const LOOT_BOX_LOCK_DAYS = 7;
const LOOT_BOX_LOCK_MS = LOOT_BOX_LOCK_DAYS * 24 * 60 * 60 * 1000;

function getLootBoxLockedUntil() {
    return new Date(Date.now() + LOOT_BOX_LOCK_MS).toISOString();
}

function isLootBoxGiftLocked(row) {
    if (!row?.loot_box_locked_until) return false;
    const raw = String(row.loot_box_locked_until);
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const until = new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z').getTime();
    return Number.isFinite(until) && until > Date.now();
}

async function addLootBoxGiftToUser(userId, giftId, marketValue = null) {
    const gift = await getGiftById(giftId);
    if (!gift) throw new Error('Gift not found');

    // Loot-box rewards are pending generic gift types until the player
    // chooses Sell, Bet, or Withdraw. Keep them in WON so the existing
    // pending-withdrawal flow can resolve a concrete Telegram collectible.
    // An isolated loot-box market snapshot may override the catalog value.
    const requestedMarketValue = Number(marketValue);
    const storedMarketValue = Number.isFinite(requestedMarketValue) && requestedMarketValue > 0
        ? requestedMarketValue
        : Number(gift.value || 0);
    const result = await run(`
        INSERT INTO user_gifts (user_id, gift_id, status, ownership_verified, market_value, loot_box_locked_until, loot_box_reward)
        VALUES (?, ?, 'WON', 0, ?, ?, 1)
    `, [userId, gift.id, storedMarketValue, getLootBoxLockedUntil()]);

    return await get('SELECT * FROM user_gifts WHERE id = ?', [result.lastID]);
}

async function sellLootBoxGiftForBalance(userId, userGiftId, sellValue) {
    return await transaction(async () => {
        const reward = await get(`
            SELECT ug.*, g.name AS gift_name, g.value AS gift_value
            FROM user_gifts ug
            JOIN gifts g ON ug.gift_id = g.id
            WHERE ug.id = ? AND ug.user_id = ? AND ug.status = 'WON'
            LIMIT 1
        `, [userGiftId, userId]);
        if (!reward) throw new Error('Loot-box gift not found or already used');
        const amount = Number(sellValue);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid gift sale value');

        const update = await run(`
            UPDATE user_gifts
            SET status = 'SOLD', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND status = 'WON'
        `, [userGiftId, userId]);
        if (update.changes !== 1) throw new Error('Gift was already used');

        const balance = Number(await getUserBalance(userId) || 0);
        const newBalance = balance + amount;
        await run(
            'UPDATE users SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [newBalance, userId]
        );

        return {
            userGiftId: reward.id,
            giftName: reward.gift_name,
            giftValue: Number(reward.gift_value || 0),
            saleValue: amount,
            balance: newBalance
        };
    });
}


async function markGiftAsLootBoxReward(userGiftId) {
    const lockedUntil = getLootBoxLockedUntil();
    await run('UPDATE user_gifts SET loot_box_locked_until = ?, loot_box_reward = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND loot_box_locked_until IS NULL', [lockedUntil, userGiftId]);
    return await get('SELECT * FROM user_gifts WHERE id = ?', [userGiftId]);
}

async function updateGiftStatus(userGiftId, status) {
    const validStatuses = ['OWNED', 'LOCKED', 'IN_BET', 'WON', 'LOST', 'SENT', 'SOLD'];
    if (!validStatuses.includes(status)) throw new Error('Invalid status');
    
    await run('UPDATE user_gifts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, userGiftId]);
    return await get('SELECT * FROM user_gifts WHERE id = ?', [userGiftId]);
}

// ===== 5.2.1 أساس ملكية Collectible Gifts الحقيقية (لا يُستخدم بعد من مسارات الرهان الحالية) =====

// كل هدايا المستخدم مع حقول الملكية الفريدة الجديدة، دون المساس بـ getUserGifts القائمة.
async function getUserCollectibles(userId, status = 'ACTIVE') {
    let sql = `
        SELECT g.*, ug.id AS user_gift_id, ug.status AS ownership_status,
               ug.unique_collectible_id, ug.telegram_gift_instance_id,
               ug.collectible_number, ug.ownership_verified, ug.verified_metadata,
               ug.loot_box_locked_until,
               ug.loot_box_reward,
               ug.market_value AS collectible_market_value,
               ug.received_at, ug.updated_at
        FROM user_gifts ug
        JOIN gifts g ON ug.gift_id = g.id
        WHERE ug.user_id = ?
    `;
    const params = [userId];
    if (status === 'ACTIVE') {
        sql += " AND (ug.status IN ('OWNED', 'IN_BET', 'LOCKED') OR (ug.status = 'WON' AND ug.loot_box_locked_until IS NOT NULL))";
    } else if (status) {
        sql += ' AND ug.status = ?';
        params.push(status);
    }
    sql += ' ORDER BY ug.received_at DESC';
    return await query(sql, params);
}

// Collectibles that are currently reserved by an active player inventory/bet/withdrawal.
// These Telegram identities must never be assigned to another game-awarded gift.
async function getActiveCollectibleUniqueIds() {
    const rows = await query(`
        SELECT unique_collectible_id
        FROM user_gifts
        WHERE unique_collectible_id IS NOT NULL
          AND status IN ('OWNED', 'IN_BET', 'LOCKED')
    `);
    return rows.map(row => String(row.unique_collectible_id)).filter(Boolean);
}

// جلب قطعة واحدة عبر هويتها الفريدة (وليس gift_id/type).
async function getCollectibleByUniqueId(uniqueCollectibleId) {
    return await get(`
        SELECT g.*, ug.id AS user_gift_id, ug.user_id, ug.status AS ownership_status,
               ug.unique_collectible_id, ug.telegram_gift_instance_id,
               ug.collectible_number, ug.ownership_verified, ug.verified_metadata,
               ug.market_value AS collectible_market_value,
               ug.received_at, ug.updated_at
        FROM user_gifts ug
        JOIN gifts g ON ug.gift_id = g.id
        WHERE ug.unique_collectible_id = ?
        ORDER BY
            CASE ug.status
                WHEN 'OWNED' THEN 0
                WHEN 'IN_BET' THEN 0
                WHEN 'LOCKED' THEN 0
                WHEN 'SENT' THEN 1
                WHEN 'WON' THEN 2
                WHEN 'LOST' THEN 3
                WHEN 'SOLD' THEN 3
                ELSE 4
            END,
            ug.id DESC
        LIMIT 1
    `, [uniqueCollectibleId]);
}

// فحص وجود قطعة مستوردة مسبقًا عبر معرّف Telegram الخاص بها (لمنع الاستيراد المكرر لاحقًا).
async function getCollectibleByTelegramInstanceId(telegramGiftInstanceId) {
    return await get('SELECT * FROM user_gifts WHERE telegram_gift_instance_id = ?', [telegramGiftInstanceId]);
}

// حجز قطعة فريدة للرهان: OWNED -> IN_BET، ذريًا، وفق نفس شروط placeGiftBet الحالية.
async function reserveCollectibleForBet(userId, uniqueCollectibleId) {
    return await transaction(async () => {
        const collectible = await getCollectibleByUniqueId(uniqueCollectibleId);
        if (!collectible) throw new Error('Collectible not found');
        if (collectible.user_id !== userId) throw new Error('Collectible not owned by this user');
        if (!collectible.unique_collectible_id) throw new Error('Collectible has no unique identity');
        if (collectible.ownership_status !== 'OWNED') throw new Error('Collectible is not available');

        const update = await run(`
            UPDATE user_gifts
            SET status = 'IN_BET', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'OWNED'
        `, [collectible.user_gift_id]);
        if (update.changes !== 1) throw new Error('Collectible was reserved concurrently');

        return collectible;
    });
}

// تسوية قطعة محجوزة: IN_BET -> WON أو LOST، ذريًا. لا يوجد أي تحويل خارجي فعلي عند WON.
async function releaseCollectible(uniqueCollectibleId, outcome) {
    if (outcome !== 'WON' && outcome !== 'LOST') throw new Error('Invalid collectible outcome');
    return await transaction(async () => {
        const update = await run(`
            UPDATE user_gifts
            SET status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE unique_collectible_id = ? AND status = 'IN_BET'
        `, [outcome, uniqueCollectibleId]);
        if (update.changes !== 1) throw new Error('Collectible is not reserved for a bet');
        return await getCollectibleByUniqueId(uniqueCollectibleId);
    });
}

// بيع قطعة مملوكة: OWNED -> SOLD، ذريًا.
async function sellCollectibleForBalance(userId, uniqueCollectibleId, sellValue) {
    return await transaction(async () => {
        const collectible = await getCollectibleByUniqueId(uniqueCollectibleId);
        if (!collectible) throw new Error('Collectible not found');
        if (collectible.user_id !== userId) throw new Error('Collectible not owned by this user');
        if (collectible.ownership_status !== 'OWNED') throw new Error('Collectible is not available for sale');

        const amount = Number(sellValue);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid collectible sale value');

        const update = await run(`
            UPDATE user_gifts
            SET status = 'SOLD', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'OWNED'
        `, [collectible.user_gift_id]);
        if (update.changes !== 1) throw new Error('Collectible was already used');

        const currentBalance = await getUserBalance(userId);
        const newBalance = currentBalance + amount;
        await run(
            'UPDATE users SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [newBalance, userId]
        );

        return {
            collectible,
            saleValue: amount,
            balance: newBalance
        };
    });
}

// إنشاء أو إعادة استخدام intent استيراد قصير العمر (لا يمنح أي ملكية). آمن ضد replay/spam.
async function createOrGetImportIntent(userId, ttlSeconds = 600) {
    return await transaction(async () => {
        const existing = await get(`
            SELECT * FROM collectible_import_intents
            WHERE user_id = ? AND status = 'PENDING' AND expires_at > CURRENT_TIMESTAMP
            ORDER BY created_at DESC LIMIT 1
        `, [userId]);
        if (existing) return existing;

        const intentToken = crypto.randomBytes(24).toString('hex');
        const result = await run(`
            INSERT INTO collectible_import_intents (user_id, intent_token, status, expires_at)
            VALUES (?, ?, 'PENDING', datetime('now', '+' || ? || ' seconds'))
        `, [userId, intentToken, ttlSeconds]);

        return await get('SELECT * FROM collectible_import_intents WHERE id = ?', [result.lastID]);
    });
}

// أحدث intent (أي حالة) للمستخدم — تُستخدم لعرض حالة التحقق في الواجهة فقط.
async function getLatestImportIntentForUser(userId) {
    return await get(`
        SELECT * FROM collectible_import_intents
        WHERE user_id = ?
        ORDER BY created_at DESC LIMIT 1
    `, [userId]);
}

// أحدث intent معلّق (PENDING وغير منتهٍ) يخص مستخدم Rocket المرتبط بـ telegram_id للمرسل الفعلي على Telegram.
// هذا هو آلية الربط الوحيدة المعتمدة بين الهدية الواردة وحساب اللاعب الصحيح — لا تخمين، لا مطابقة بالاسم.
async function getPendingIntentByTelegramSenderId(telegramSenderId) {
    if (!telegramSenderId) return null;
    return await get(`
        SELECT cii.*
        FROM collectible_import_intents cii
        JOIN users u ON u.id = cii.user_id
        WHERE u.telegram_id = ? AND cii.status = 'PENDING' AND cii.expires_at > CURRENT_TIMESTAMP
        ORDER BY cii.created_at DESC LIMIT 1
    `, [String(telegramSenderId)]);
}

// تحقق هل هذه القطعة الفريدة تم اعتمادها من قبل (idempotency ضد تكرار الاستطلاع/polling).
async function isCollectibleAlreadyCredited(uniqueCollectibleId, telegramGiftInstanceId, senderTelegramId = null) {
    const existing = await get(`
        SELECT *
        FROM user_gifts
        WHERE unique_collectible_id = ? OR telegram_gift_instance_id = ?
        ORDER BY id DESC
        LIMIT 1
    `, [uniqueCollectibleId, telegramGiftInstanceId]);

    if (!existing) return null;

    // Active ownership is authoritative and blocks duplicate ownership.
    if (['OWNED', 'IN_BET', 'LOCKED'].includes(existing.status)) {
        return existing;
    }

    // Legacy/diagnostic callers without sender context keep idempotent behavior.
    if (!senderTelegramId) return existing;

    const senderUser = await get(
        'SELECT id FROM users WHERE telegram_id = ?',
        [String(senderTelegramId)]
    );

    // The same sender seeing the same historical gift in Account 2 is normal
    // after a loss/sale; do not credit it again on every inventory sweep.
    if (senderUser && String(existing.user_id) === String(senderUser.id)) {
        return existing;
    }

    // A different player can legitimately bring the exact same Telegram
    // collectible back into the game after the previous ownership ended.
    return null;
}

// gifts is a shared gift-model catalog. Its slug must identify the model, never a
// specific collectible instance such as "FinePen-20454". Incoming Telegram payloads
// historically supplied instance slugs, which could collide with another model row.
// Build a deterministic model-level slug from the stable Telegram gift model id.
function buildVerifiedGiftModelSlug(telegramGiftModel) {
    const rawId = String(telegramGiftModel?.telegramGiftId || '').trim();
    const rawName = String(telegramGiftModel?.name || 'telegram-gift').trim();
    const normalize = value => value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

    const namePart = normalize(rawName) || 'telegram-gift';
    const idPart = normalize(rawId) || crypto.createHash('sha256').update(rawName).digest('hex').slice(0, 16);
    return `tg-model-${namePart}-${idPart}`;
}

// اعتماد قطعة Telegram الحقيقية ذريًا: تُنشئ/تُحدّث user_gifts، تضبط ownership_verified=1، وتُستهلك الـ intent.
// معلومات gift model تأتي حصرًا من بيانات Telegram الرسمية التي تم التحقق منها من السيرفر (لا مدخلات عميل).
async function creditVerifiedCollectible({
    intentId,
    userId,
    telegramGiftModel,
    uniqueCollectibleId,
    telegramGiftInstanceId,
    collectibleNumber,
    verifiedMetadata,
    stickerFileId
}) {
    return await transaction(async () => {
        // Only active ownership blocks a new credit here. LOST/SOLD/SENT
        // records are historical and may be followed by a new ownership cycle.
        const already = await get(`
            SELECT *
            FROM user_gifts
            WHERE (unique_collectible_id = ? OR telegram_gift_instance_id = ?)
              AND status IN ('OWNED', 'IN_BET', 'LOCKED')
            ORDER BY id DESC
            LIMIT 1
        `, [uniqueCollectibleId, telegramGiftInstanceId]);

        // A withdrawn collectible is marked SENT. If the same player sends the
        // exact same collectible back, restore that historical row.
        const sentReturn = await get(`
            SELECT *
            FROM user_gifts
            WHERE user_id = ? AND unique_collectible_id = ? AND status = 'SENT'
            ORDER BY id DESC
            LIMIT 1
        `, [userId, uniqueCollectibleId]);

        if (already && ['OWNED', 'IN_BET', 'LOCKED'].includes(already.status)) {
            return { alreadyCredited: true, userGift: already };
        }

        if (sentReturn) {
            const updated = await run(`
                UPDATE user_gifts
                SET status = 'OWNED',
                    telegram_gift_instance_id = ?,
                    collectible_number = ?,
                    ownership_verified = 1,
                    verified_metadata = ?,
                    telegram_thumbnail_file_id = ?,
                    market_value = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND user_id = ? AND status = 'SENT'
            `, [
                telegramGiftInstanceId,
                collectibleNumber,
                verifiedMetadata,
                stickerFileId || null,
                Number(telegramGiftModel.value || sentReturn.market_value || 0),
                sentReturn.id,
                userId
            ]);

            if (updated.changes !== 1) {
                throw new Error('Collectible return-to-game was changed concurrently');
            }

            if (intentId) {
                await run(`
                    UPDATE collectible_import_intents
                    SET status = 'CONSUMED'
                    WHERE id = ? AND status = 'PENDING'
                `, [intentId]);
            }

            return {
                alreadyCredited: false,
                reactivated: true,
                userGift: await get('SELECT * FROM user_gifts WHERE id = ?', [sentReturn.id])
            };
        }

        // LOST/SOLD/SENT rows are historical and do not reserve the Telegram
        // collectible for future assignment. The same exact unique collectible
        // can therefore receive a new ownership row for a later player.
        const telegramGiftId = String(telegramGiftModel.telegramGiftId || '').trim();
        if (!telegramGiftId) throw new Error('Verified Telegram gift model is missing telegramGiftId');

        let giftRow = await get('SELECT * FROM gifts WHERE telegram_gift_id = ?', [telegramGiftId]);
        if (!giftRow) {
            const modelSlug = buildVerifiedGiftModelSlug(telegramGiftModel);
            const slugOwner = await get('SELECT telegram_gift_id FROM gifts WHERE slug = ?', [modelSlug]);
            const finalSlug = slugOwner && String(slugOwner.telegram_gift_id) !== telegramGiftId
                ? `${modelSlug}-${crypto.createHash('sha256').update(telegramGiftId).digest('hex').slice(0, 12)}`
                : modelSlug;

            // INSERT OR IGNORE makes concurrent sweeps idempotent on telegram_gift_id.
            // The deterministic model slug above prevents collectible-instance slug
            // collisions from blocking a legitimate new collectible.
            await run(`
                INSERT OR IGNORE INTO gifts (telegram_gift_id, name, slug, emoji, image_url, collection, rarity, value, total_supply)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                telegramGiftId,
                telegramGiftModel.name,
                finalSlug,
                telegramGiftModel.emoji || null,
                telegramGiftModel.imageUrl || null,
                telegramGiftModel.collection || null,
                telegramGiftModel.rarity || 'common',
                telegramGiftModel.value || 0,
                telegramGiftModel.totalSupply || 0
            ]);

            giftRow = await get('SELECT * FROM gifts WHERE telegram_gift_id = ?', [telegramGiftId]);
            if (!giftRow) throw new Error('Verified Telegram gift model could not be persisted');
        }

        const inserted = await run(`
            INSERT INTO user_gifts (user_id, gift_id, status, unique_collectible_id, telegram_gift_instance_id, collectible_number, ownership_verified, verified_metadata, telegram_thumbnail_file_id, market_value)
            VALUES (?, ?, 'OWNED', ?, ?, ?, 1, ?, ?, ?)
        `, [userId, giftRow.id, uniqueCollectibleId, telegramGiftInstanceId, collectibleNumber, verifiedMetadata, stickerFileId || null, Number(telegramGiftModel.value || 0)]);

        const userGiftId = inserted.lastID;

        if (intentId) {
            await run(`UPDATE collectible_import_intents SET status = 'CONSUMED' WHERE id = ? AND status = 'PENDING'`, [intentId]);
        }

        return { alreadyCredited: false, userGift: await get('SELECT * FROM user_gifts WHERE id = ?', [userGiftId]) };
    });
}

// حفظ/تحديث حالة اتصال Telegram Business بشكل دائم (صف واحد ثابت id=1). لا تُخزَّن أي أسرار هنا.
async function savePersistedBusinessConnection({ connectionId, businessUserId, canViewGiftsAndStars, canTransferAndUpgradeGifts, isEnabled }) {
    await run(`
        INSERT INTO telegram_business_connection (id, connection_id, business_user_id, can_view_gifts_and_stars, can_transfer_and_upgrade_gifts, is_enabled, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            connection_id = excluded.connection_id,
            business_user_id = excluded.business_user_id,
            can_view_gifts_and_stars = excluded.can_view_gifts_and_stars,
            can_transfer_and_upgrade_gifts = excluded.can_transfer_and_upgrade_gifts,
            is_enabled = excluded.is_enabled,
            updated_at = CURRENT_TIMESTAMP
    `, [connectionId || null, businessUserId || null, canViewGiftsAndStars ? 1 : 0, canTransferAndUpgradeGifts ? 1 : 0, isEnabled ? 1 : 0]);
    return await getPersistedBusinessConnection();
}

// يقرأ آخر حالة اتصال Business محفوظة (تُستخدم عند إقلاع السيرفر لاستعادة الحالة بعد إعادة التشغيل).
async function getPersistedBusinessConnection() {
    return await get('SELECT * FROM telegram_business_connection WHERE id = 1');
}

// حماية idempotency ضد إعادة إرسال Telegram لنفس update_id عند فشل/تأخر الاستجابة.
async function hasProcessedWebhookUpdate(updateId) {
    if (!Number.isFinite(updateId)) return false;
    const existing = await get('SELECT update_id FROM telegram_webhook_updates WHERE update_id = ?', [updateId]);
    return !!existing;
}

async function markWebhookUpdateProcessed(updateId) {
    if (!Number.isFinite(updateId)) return;
    try {
        await run('INSERT INTO telegram_webhook_updates (update_id) VALUES (?)', [updateId]);
    } catch (error) {
        if (!error.message.includes('UNIQUE constraint failed')) throw error;
    }
}

// Update the market value of a collectible's gift model row.
async function updateCollectibleMarketValue(telegramGiftId, marketValue) {
    return await run(`
        UPDATE gifts SET value = ?, updated_at = CURRENT_TIMESTAMP
        WHERE telegram_gift_id = ?
    `, [marketValue, telegramGiftId]);
}

// Update the live market value for one verified collectible without changing the shared gift-model value.
async function updateUserCollectibleMarketValue(uniqueCollectibleId, marketValue, verifiedMetadata = null) {
    const value = Number(marketValue);
    if (!uniqueCollectibleId || !Number.isFinite(value) || value <= 0) return { changes: 0 };
    return await run(`
        UPDATE user_gifts
        SET market_value = ?,
            verified_metadata = COALESCE(?, verified_metadata),
            updated_at = CURRENT_TIMESTAMP
        WHERE unique_collectible_id = ? AND ownership_verified = 1
    `, [value, verifiedMetadata, uniqueCollectibleId]);
}

// ===== 5.3 نظام الرهان بالهدايا =====
async function placeGiftBet(userId, giftId, roundId, autoCashoutTarget = null) {
    const normalizedAutoCashoutTarget = normalizeAutoCashoutTarget(autoCashoutTarget);
    return await transaction(async () => {
        const round = await getRoundByNumber(roundId);
        if (!round || round.phase !== 'COUNTDOWN') throw new Error('Betting is closed for this round');

        // giftId can be user_gift.id, unique_collectible_id, or gift.id/telegram_gift_id
        let userGift = await get(`
            SELECT ug.*, g.name AS gift_name,
                   COALESCE(ug.market_value, g.value) AS gift_value
            FROM user_gifts ug
            JOIN gifts g ON ug.gift_id = g.id
            WHERE ug.user_id = ? AND (ug.id = ? OR ug.unique_collectible_id = ? OR g.id = ? OR g.telegram_gift_id = ?) AND ug.status IN ('OWNED', 'WON')
            ORDER BY ug.ownership_verified DESC, ug.id DESC LIMIT 1
        `, [userId, giftId, giftId, giftId, giftId]);
        
        if (!userGift) throw new Error('Gift not owned or not available');

        const isCollectible = !!userGift.unique_collectible_id && userGift.ownership_verified === 1;
        if (isCollectible) {
            if (userGift.ownership_verified !== 1) {
                throw new Error('Only verified Telegram collectibles can be bet');
            }
            if (!Number.isFinite(userGift.gift_value) || userGift.gift_value <= 0) {
                throw new Error('Collectible has no valid market valuation — cannot bet');
            }
        }

        const giftValue = userGift.gift_value || 0;
        
        // 3. قفل الهدية
        const update = await run(`
            UPDATE user_gifts 
            SET status = 'IN_BET', market_value_snapshot = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ? AND status IN ('OWNED', 'WON')
        `, [giftValue, userGift.id]);

        if (update.changes !== 1) throw new Error('Collectible was reserved concurrently');
        
        // 4. إنشاء سجل الرهان
        const result = await run(`
            INSERT INTO gift_bets 
            (user_id, user_gift_id, round_id, gift_value_at_bet, auto_cashout_target)
            VALUES (?, ?, ?, ?, ?)
        `, [userId, userGift.id, roundId, giftValue, normalizedAutoCashoutTarget]);

        // Track Rocket wagering volume for VIP/profile/leaderboard purposes.
        await run(
            'UPDATE users SET total_turnover = total_turnover + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [giftValue, userId]
        );
        
        return {
            betId: result.lastID,
            userGiftId: userGift.id,
            giftName: userGift.gift_name,
            giftValue: giftValue,
            roundId: roundId
        };
    });
}

async function cashoutGiftBet(betId, userId, multiplier) {
    return await transaction(async () => {
        // 1. التحقق من وجود الرهان
        const bet = await get(`
            SELECT * FROM gift_bets 
            WHERE id = ? AND user_id = ? AND status = 'ACTIVE'
        `, [betId, userId]);
        
        if (!bet) throw new Error('Bet not found or already cashed out');
        
        // 2. حساب المكسب
        const payout = bet.gift_value_at_bet * multiplier;
        
        // 3. تحديث الرهان
        await run(`
            UPDATE gift_bets 
            SET status = 'CASHED_OUT', cashout_multiplier = ?, payout = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [multiplier, payout, betId]);
        
        // 4. تحديث حالة الهدية إلى WON
        await run(`
            UPDATE user_gifts 
            SET status = 'WON', updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `, [bet.user_gift_id]);
        
        // 5. تحديث إحصائيات المستخدم
        await updateUserStats(userId, 'win', payout);
        
        return {
            payout: payout,
            multiplier: multiplier,
            giftValue: bet.gift_value_at_bet
        };
    });
}

// ===== 5.9 نظام مخزون الهدايا (Store Inventory) =====

// اختيار أفضل مكافأة من المخزون بناءً على القيمة المستهدفة.
// يجد القطعة الأقرب للقيمة المستهدفة دون تجاوزها.
// استعلام بسيط (بدون transaction) — يُستدعى داخل معاملة cashoutBet.
async function selectRewardFromInventory(targetValue) {
    if (!Number.isFinite(targetValue) || targetValue <= 0) return null;
    return await get(`
        SELECT * FROM collectible_inventory
        WHERE ownership_status = 'AVAILABLE'
          AND market_value <= ?
        ORDER BY ABS(market_value - ?) ASC, id ASC
        LIMIT 1
    `, [targetValue, targetValue]);
}

// Select only the gift TYPE for a game reward. The concrete Telegram collectible
// is deliberately not assigned until the player withdraws.
async function selectRewardGiftType(targetValue) {
    if (!Number.isFinite(targetValue) || targetValue <= 0) return null;
    return await get(`
        SELECT * FROM gifts
        WHERE value > 0 AND value <= ?
        ORDER BY ABS(value - ?) ASC, id ASC
        LIMIT 1
    `, [targetValue, targetValue]);
}

// Create a pending reward that exposes only the base gift type in the Backpack.
// No Telegram unique id, model, backdrop, or collectible number is assigned yet.
async function createPendingGiftReward(userId, giftId, rewardValue, betId = null) {
    const inserted = await run(`
        INSERT INTO user_gifts (user_id, gift_id, status, ownership_verified, market_value)
        VALUES (?, ?, 'WON', 0, ?)
    `, [userId, giftId, Number(rewardValue || 0)]);

    const userGift = await get('SELECT * FROM user_gifts WHERE id = ?', [inserted.lastID]);
    await run(`
        INSERT INTO gift_transactions (user_id, user_gift_id, transaction_type, amount, related_bet_id, status, reason)
        VALUES (?, ?, 'REWARD_GRANT', ?, ?, 'COMPLETED', 'Gift type awarded; concrete Telegram collectible selected at withdrawal')
    `, [userId, userGift.id, Number(rewardValue || 0), betId]);

    return userGift;
}

// Reserve a generic gift-type reward for the withdrawal operation.
async function reservePendingGiftForWithdrawal(userId, userGiftId) {
    return await transaction(async () => {
        const collectible = await get(`
            SELECT g.*, ug.id AS user_gift_id, ug.user_id, ug.status AS ownership_status,
                   ug.unique_collectible_id, ug.telegram_gift_instance_id,
                   ug.collectible_number, ug.ownership_verified, ug.verified_metadata,
                   ug.telegram_thumbnail_file_id, ug.market_value AS collectible_market_value,
                   ug.received_at, ug.updated_at
            FROM user_gifts ug
            JOIN gifts g ON ug.gift_id = g.id
            WHERE ug.id = ? AND ug.user_id = ?
        `, [userGiftId, userId]);
        if (!collectible) throw new Error('Gift reward not found');
        if (collectible.ownership_status !== 'WON' || collectible.unique_collectible_id) {
            throw new Error('Gift reward is not available for withdrawal');
        }

        const update = await run(`
            UPDATE user_gifts
            SET status = 'LOCKED', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND status = 'WON' AND unique_collectible_id IS NULL
        `, [userGiftId, userId]);
        if (update.changes !== 1) throw new Error('Gift reward was reserved concurrently');

        await run(`
            INSERT INTO gift_transactions (user_id, user_gift_id, transaction_type, amount, status, reason)
            VALUES (?, ?, 'WITHDRAWAL', 0, 'PENDING', 'Generic gift type reserved; Telegram collectible selected at withdrawal')
        `, [userId, userGiftId]);

        return await get(`
            SELECT g.*, ug.id AS user_gift_id, ug.user_id, ug.status AS ownership_status,
                   ug.unique_collectible_id, ug.telegram_gift_instance_id,
                   ug.collectible_number, ug.ownership_verified, ug.verified_metadata,
                   ug.telegram_thumbnail_file_id, ug.market_value AS collectible_market_value,
                   ug.received_at, ug.updated_at
            FROM user_gifts ug JOIN gifts g ON ug.gift_id = g.id
            WHERE ug.id = ?
        `, [userGiftId]);
    });
}

async function rollbackPendingGiftWithdrawal(userId, userGiftId, failureReason) {
    return await transaction(async () => {
        const row = await get('SELECT * FROM user_gifts WHERE id = ? AND user_id = ?', [userGiftId, userId]);
        if (!row || row.status !== 'LOCKED') {
            throw new Error('Gift reward is not reserved for rollback');
        }
        await run(`
            UPDATE user_gifts
            SET status = 'WON',
                unique_collectible_id = NULL,
                telegram_gift_instance_id = NULL,
                collectible_number = NULL,
                ownership_verified = 0,
                verified_metadata = NULL,
                telegram_thumbnail_file_id = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND status = 'LOCKED'
        `, [userGiftId, userId]);
        await run(`
            UPDATE gift_transactions
            SET status = 'ROLLED_BACK', reason = ?
            WHERE user_id = ? AND user_gift_id = ? AND transaction_type = 'WITHDRAWAL' AND status = 'PENDING'
        `, [failureReason, userId, userGiftId]);
        return await get('SELECT * FROM user_gifts WHERE id = ?', [userGiftId]);
    });
}

// Attach the concrete Telegram collectible only after Account 2 selected it.
async function attachPendingGiftCollectible(userId, userGiftId, details) {
    return await transaction(async () => {
        const row = await get('SELECT * FROM user_gifts WHERE id = ? AND user_id = ?', [userGiftId, userId]);
        if (!row || row.status !== 'LOCKED' || row.unique_collectible_id) {
            throw new Error('Gift reward is not reserved for assignment');
        }
        const update = await run(`
            UPDATE user_gifts
            SET unique_collectible_id = ?,
                telegram_gift_instance_id = ?,
                collectible_number = ?,
                ownership_verified = 1,
                verified_metadata = ?,
                telegram_thumbnail_file_id = ?,
                market_value = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND status = 'LOCKED' AND unique_collectible_id IS NULL
        `, [
            details.uniqueCollectibleId,
            details.telegramGiftInstanceId,
            details.collectibleNumber ?? null,
            details.verifiedMetadata || null,
            details.telegramThumbnailFileId || null,
            Number(details.marketValue || row.market_value || 0),
            userGiftId,
            userId
        ]);
        if (update.changes !== 1) throw new Error('Gift reward assignment was changed concurrently');

        await run(`
            UPDATE gift_transactions
            SET related_collectible_id = ?
            WHERE user_id = ? AND user_gift_id = ? AND transaction_type = 'WITHDRAWAL' AND status = 'PENDING'
        `, [details.uniqueCollectibleId, userId, userGiftId]);

        return await getCollectibleByUniqueId(details.uniqueCollectibleId);
    });
}

// استهلاك قطعة مخزون وإنشاء user_gifts للمستخدم.
// يُستدعى داخل معاملة حالية (cashoutBet) — يستخدم run/get مباشرة.
async function consumeInventoryReward(reward, userId, betId) {
    const update = await run(`
        UPDATE collectible_inventory
        SET ownership_status = 'CONSUMED',
            reserved_for_user_id = ?,
            reserved_until = datetime('now', '+1 minute'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND ownership_status = 'AVAILABLE'
    `, [userId, reward.id]);
    if (update.changes !== 1) throw new Error('Inventory collectible was reserved concurrently');

    await run(`
        INSERT INTO user_gifts (
            user_id, gift_id, status, unique_collectible_id, telegram_gift_instance_id,
            collectible_number, ownership_verified, verified_metadata,
            telegram_thumbnail_file_id, market_value_snapshot
        ) SELECT
            ?, gift_id, 'OWNED', unique_collectible_id, telegram_gift_instance_id,
            collectible_number, 1, verified_metadata,
            telegram_thumbnail_file_id, market_value
        FROM collectible_inventory WHERE id = ?
    `, [userId, reward.id]);
}

// قائمة مخزون الهدايا المتاحة (للمدير/الواجهة الخلفية).
async function getInventoryCollectibles(ownershipStatus = 'AVAILABLE') {
    const sql = `
        SELECT ci.*, g.name AS gift_name
        FROM collectible_inventory ci
        JOIN gifts g ON ci.gift_id = g.id
        WHERE ci.ownership_status = ?
        ORDER BY ci.market_value DESC, ci.created_at DESC
    `;
    if (ownershipStatus) return await query(sql, [ownershipStatus]);
    return await query(
        `SELECT ci.*, g.name AS gift_name FROM collectible_inventory ci JOIN gifts g ON ci.gift_id = g.id ORDER BY ci.market_value DESC, ci.created_at DESC`
    );
}

// إضافة قطعة إلى مخزون المتجر (للاستخدام من قبل المسؤول).
async function addCollectibleToInventory({
    uniqueCollectibleId, telegramGiftInstanceId, collectibleNumber,
    giftId, modelName, collectionName, symbolName, backdropName,
    verifiedMetadata, telegramThumbnailFileId, marketValue
}) {
    const result = await run(`
        INSERT INTO collectible_inventory (
            unique_collectible_id, telegram_gift_instance_id, collectible_number,
            gift_id, model_name, collection_name, symbol_name, backdrop_name,
            verified_metadata, telegram_thumbnail_file_id, market_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        uniqueCollectibleId, telegramGiftInstanceId, collectibleNumber,
        giftId, modelName, collectionName, symbolName, backdropName,
        verifiedMetadata, telegramThumbnailFileId, marketValue
    ]);
    return await get('SELECT * FROM collectible_inventory WHERE id = ?', [result.lastID]);
}

// ===== 5.10 سحب هدايا =====

// حجز قطعة للسحب ذريًا: OWNED -> LOCKED لمدة قصيرة.
// يُستخدم قبل استدعاء Telegram API لنقل الهدية.
async function reserveCollectibleForWithdrawal(userId, uniqueCollectibleId) {
    return await transaction(async () => {
        const collectible = await getCollectibleByUniqueId(uniqueCollectibleId);
        if (!collectible) throw new Error('Collectible not found');
        if (collectible.user_id !== userId) throw new Error('Collectible not owned by this user');
        if (!collectible.unique_collectible_id) throw new Error('Not a unique collectible');
        if (collectible.ownership_status !== 'OWNED') {
            throw new Error(`Collectible is not available for withdrawal (status: ${collectible.ownership_status})`);
        }

        const update = await run(`
            UPDATE user_gifts
            SET status = 'LOCKED', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'OWNED'
        `, [collectible.user_gift_id]);
        if (update.changes !== 1) throw new Error('Collectible was reserved concurrently');

        await run(`
            INSERT INTO gift_transactions (user_id, user_gift_id, transaction_type, amount, related_collectible_id, status)
            VALUES (?, ?, 'WITHDRAWAL', 0, ?, 'PENDING')
        `, [userId, collectible.user_gift_id, uniqueCollectibleId]);

        return await getCollectibleByUniqueId(uniqueCollectibleId);
    });
}

// إكمال سحب الهدية بعد نجاح Telegram API.
async function confirmGiftWithdrawal(userId, uniqueCollectibleId, transactionHash) {
    return await transaction(async () => {
        const collectible = await getCollectibleByUniqueId(uniqueCollectibleId);
        if (!collectible || collectible.user_id !== userId) throw new Error('Collectible not found or not owned');
        if (collectible.ownership_status !== 'LOCKED') throw new Error('Collectible is not reserved for withdrawal');

        await run(`
            UPDATE user_gifts
            SET status = 'SENT', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'LOCKED'
        `, [collectible.user_gift_id]);

        await run(`
            UPDATE gift_transactions
            SET status = 'COMPLETED', reason = ?
            WHERE user_id = ? AND related_collectible_id = ? AND transaction_type = 'WITHDRAWAL' AND status = 'PENDING'
        `, [transactionHash, userId, uniqueCollectibleId]);

        return await getCollectibleByUniqueId(uniqueCollectibleId);
    });
}

// إرجاع القطعة إلى OWNED إذا فشل النقل في Telegram.
async function rollbackGiftWithdrawal(userId, uniqueCollectibleId, failureReason) {
    return await transaction(async () => {
        const collectible = await getCollectibleByUniqueId(uniqueCollectibleId);
        if (!collectible || collectible.user_id !== userId) throw new Error('Collectible not found or not owned');

        await run(`
            UPDATE user_gifts
            SET status = 'OWNED', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'LOCKED'
        `, [collectible.user_gift_id]);

        await run(`
            UPDATE gift_transactions
            SET status = 'ROLLED_BACK', reason = ?
            WHERE user_id = ? AND related_collectible_id = ? AND transaction_type = 'WITHDRAWAL' AND status = 'PENDING'
        `, [failureReason, userId, uniqueCollectibleId]);

        return await getCollectibleByUniqueId(uniqueCollectibleId);
    });
}

// ===== 5.11 معاملات الهدايا =====

async function getGiftTransactions(userId, limit = 50) {
    return await query(`
        SELECT gt.*, ug.unique_collectible_id
        FROM gift_transactions gt
        LEFT JOIN user_gifts ug ON ug.id = gt.user_gift_id
        WHERE gt.user_id = ?
        ORDER BY gt.created_at DESC
        LIMIT ?
    `, [userId, limit]);
}

async function getPendingPayouts(userId) {
    return await query(`
        SELECT gt.*, ug.unique_collectible_id
        FROM gift_transactions gt
        LEFT JOIN user_gifts ug ON ug.id = gt.user_gift_id
        WHERE gt.user_id = ? AND gt.status = 'PENDING'
        ORDER BY gt.created_at DESC
    `, [userId]);
}

// ===== 5.4 نظام الرهان بـ TON =====
async function placeTonBet(userId, amount, roundId, autoCashoutTarget = null) {
    const normalizedAmount = Number(String(amount ?? '').trim().replace(',', '.'));
    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0.1) {
        throw new Error('Invalid amount');
    }
    const normalizedAutoCashoutTarget = normalizeAutoCashoutTarget(autoCashoutTarget);
    return await transaction(async () => {
        const round = await getRoundByNumber(roundId);
        if (!round || round.phase !== 'COUNTDOWN') throw new Error('Betting is closed for this round');

        // 1. التحقق من الرصيد
        const balance = await getUserBalance(userId);
        if (balance < normalizedAmount) throw new Error('Insufficient balance');
        
        // 2. خصم الرصيد
        const balanceUpdate = await run('UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?', [normalizedAmount, userId, normalizedAmount]);
        if (balanceUpdate.changes !== 1) throw new Error('Insufficient balance');
        
        // 3. إنشاء سجل الرهان
        const result = await run(`
            INSERT INTO ton_bets 
            (user_id, round_id, amount, auto_cashout_target)
            VALUES (?, ?, ?, ?)
        `, [userId, roundId, normalizedAmount, normalizedAutoCashoutTarget]);

        // Track Rocket wagering volume for VIP/profile/leaderboard purposes.
        await run(
            'UPDATE users SET total_turnover = total_turnover + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [normalizedAmount, userId]
        );
        
        return {
            betId: result.lastID,
            amount: normalizedAmount,
            roundId: roundId
        };
    });
}

async function queueTonBet(userId, amount, roundId, autoCashoutTarget = null) {
    const normalizedAmount = Number(String(amount ?? '').trim().replace(',', '.'));
    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0.1) {
        throw new Error('Invalid amount');
    }
    const normalizedAutoCashoutTarget = normalizeAutoCashoutTarget(autoCashoutTarget);

    return await transaction(async () => {
        const existing = await get(
            'SELECT id FROM queued_ton_bets WHERE user_id = ? AND status = \'QUEUED\' LIMIT 1',
            [userId]
        );
        if (existing) throw new Error('A queued bet already exists');

        const balance = await getUserBalance(userId);
        if (balance < normalizedAmount) throw new Error('Insufficient balance');

        const balanceUpdate = await run(
            'UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?',
            [normalizedAmount, userId, normalizedAmount]
        );
        if (balanceUpdate.changes !== 1) throw new Error('Insufficient balance');

        const result = await run(`
            INSERT INTO queued_ton_bets
            (user_id, round_id, amount, auto_cashout_target)
            VALUES (?, ?, ?, ?)
        `, [userId, roundId, normalizedAmount, normalizedAutoCashoutTarget]);

        return {
            betId: result.lastID,
            amount: normalizedAmount,
            roundId,
            status: 'QUEUED'
        };
    });
}

async function cancelQueuedTonBet(betId, userId, roundId) {
    return await transaction(async () => {
        const queued = await get(`
            SELECT * FROM queued_ton_bets
            WHERE id = ? AND user_id = ? AND round_id = ? AND status = 'QUEUED'
        `, [betId, userId, roundId]);

        if (!queued) throw new Error('Queued bet not found or already locked');

        const deleted = await run(
            'DELETE FROM queued_ton_bets WHERE id = ? AND status = \'QUEUED\'',
            [betId]
        );
        if (deleted.changes !== 1) throw new Error('Queued bet was settled concurrently');

        await run(
            'UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [queued.amount, userId]
        );

        return {
            betId,
            amount: Number(queued.amount),
            balance: await getUserBalance(userId)
        };
    });
}

async function promoteQueuedTonBets(roundId) {
    return await transaction(async () => {
        const queued = await query(`
            SELECT * FROM queued_ton_bets
            WHERE round_id = ? AND status = 'QUEUED'
            ORDER BY id ASC
        `, [roundId]);

        for (const bet of queued) {
            await run(`
                INSERT INTO ton_bets
                (user_id, round_id, amount, auto_cashout_target, bet_currency, status)
                VALUES (?, ?, ?, ?, 'TON', 'ACTIVE')
            `, [
                bet.user_id,
                bet.round_id,
                bet.amount,
                bet.auto_cashout_target
            ]);

            await run(
                'UPDATE users SET total_turnover = total_turnover + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [bet.amount, bet.user_id]
            );

            await run(
                'DELETE FROM queued_ton_bets WHERE id = ? AND status = \'QUEUED\'',
                [bet.id]
            );
        }

        return queued.length;
    });
}

async function getQueuedTonBetsForRound(roundId) {
    return await query(`
        SELECT qb.id AS bet_id, qb.user_id, qb.amount AS amount, qb.status,
               NULL AS multiplier, u.first_name, u.last_name, u.avatar_url,
               NULL AS unique_collectible_id, NULL AS gift_image_url, NULL AS gift_name,
               'TON' AS bet_type
        FROM queued_ton_bets qb
        JOIN users u ON u.id = qb.user_id
        WHERE qb.round_id = ? AND qb.status = 'QUEUED'
        ORDER BY qb.id ASC
    `, [roundId]);
}

// ===== Rocket queued Gift bets =====
async function queueGiftBet(userId, giftId, roundId, autoCashoutTarget = null) {
    const normalizedAutoCashoutTarget = normalizeAutoCashoutTarget(autoCashoutTarget);
    return await transaction(async () => {
        const existing = await get('SELECT id FROM queued_gift_bets WHERE user_id = ? AND status = \'QUEUED\' LIMIT 1', [userId]);
        if (existing) throw new Error('A queued bet already exists');
        const userGift = await get(`
            SELECT ug.*, g.name AS gift_name, COALESCE(ug.market_value, g.value) AS gift_value
            FROM user_gifts ug JOIN gifts g ON ug.gift_id = g.id
            WHERE ug.user_id = ? AND (ug.id = ? OR ug.unique_collectible_id = ? OR g.id = ? OR g.telegram_gift_id = ?)
              AND ug.status IN ('OWNED', 'WON')
            ORDER BY ug.ownership_verified DESC, ug.id DESC LIMIT 1
        `, [userId, giftId, giftId, giftId, giftId]);
        if (!userGift) throw new Error('Gift not owned or not available');
        const isCollectible = !!userGift.unique_collectible_id && userGift.ownership_verified === 1;
        if (isCollectible && (!Number.isFinite(userGift.gift_value) || userGift.gift_value <= 0)) throw new Error('Collectible has no valid market valuation — cannot bet');
        const giftValue = Number(userGift.gift_value || 0);
        if (!Number.isFinite(giftValue) || giftValue <= 0) throw new Error('Gift has no valid value');
        const reserve = await run(`
            UPDATE user_gifts SET status = 'IN_BET', market_value_snapshot = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('OWNED', 'WON')
        `, [giftValue, userGift.id]);
        if (reserve.changes !== 1) throw new Error('Collectible was reserved concurrently');
        const result = await run(`
            INSERT INTO queued_gift_bets
            (user_id, round_id, user_gift_id, gift_value_at_bet, auto_cashout_target, previous_status)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [userId, roundId, userGift.id, giftValue, normalizedAutoCashoutTarget, userGift.status]);
        return { betId: result.lastID, userGiftId: userGift.id, giftName: userGift.gift_name, giftValue, roundId, status: 'QUEUED' };
    });
}

async function cancelQueuedGiftBet(betId, userId, roundId) {
    return await transaction(async () => {
        const queued = await get(`SELECT * FROM queued_gift_bets WHERE id = ? AND user_id = ? AND round_id = ? AND status = 'QUEUED'`, [betId, userId, roundId]);
        if (!queued) throw new Error('Queued gift bet not found or already locked');
        const deleted = await run('DELETE FROM queued_gift_bets WHERE id = ? AND status = \'QUEUED\'', [betId]);
        if (deleted.changes !== 1) throw new Error('Queued gift bet was settled concurrently');
        const restored = await run('UPDATE user_gifts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = \'IN_BET\'', [queued.previous_status, queued.user_gift_id]);
        if (restored.changes !== 1) throw new Error('Queued gift ownership could not be restored');
        return { betId, userGiftId: queued.user_gift_id, giftValue: Number(queued.gift_value_at_bet) };
    });
}

async function promoteQueuedGiftBets(roundId) {
    return await transaction(async () => {
        const queued = await query(`SELECT * FROM queued_gift_bets WHERE round_id = ? AND status = 'QUEUED' ORDER BY id ASC`, [roundId]);
        for (const bet of queued) {
            await run(`
                INSERT INTO gift_bets (user_id, user_gift_id, round_id, gift_value_at_bet, auto_cashout_target, status)
                VALUES (?, ?, ?, ?, ?, 'ACTIVE')
            `, [bet.user_id, bet.user_gift_id, bet.round_id, bet.gift_value_at_bet, bet.auto_cashout_target]);
            await run('UPDATE users SET total_turnover = total_turnover + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [bet.gift_value_at_bet, bet.user_id]);
            await run('DELETE FROM queued_gift_bets WHERE id = ? AND status = \'QUEUED\'', [bet.id]);
        }
        return queued.length;
    });
}

async function getQueuedGiftBetsForRound(roundId) {
    return await query(`
        SELECT qb.id AS bet_id, qb.user_id, qb.gift_value_at_bet AS amount, qb.status,
               NULL AS multiplier, u.first_name, u.last_name, u.avatar_url,
               ug.unique_collectible_id, g.image_url AS gift_image_url, g.name AS gift_name,
               'GIFT' AS bet_type
        FROM queued_gift_bets qb JOIN users u ON u.id = qb.user_id
        JOIN user_gifts ug ON ug.id = qb.user_gift_id JOIN gifts g ON g.id = ug.gift_id
        WHERE qb.round_id = ? AND qb.status = 'QUEUED' ORDER BY qb.id ASC
    `, [roundId]);
}

async function cashoutTonBet(betId, userId, multiplier) {
    return await transaction(async () => {
        // 1. التحقق من وجود الرهان
        const bet = await get(`
            SELECT * FROM ton_bets 
            WHERE id = ? AND user_id = ? AND status = 'ACTIVE'
        `, [betId, userId]);
        
        if (!bet) throw new Error('Bet not found or already cashed out');
        
        // 2. حساب المكسب
        const payout = bet.amount * multiplier;
        
        // 3. تحديث الرهان
        await run(`
            UPDATE ton_bets 
            SET status = 'CASHED_OUT', cashout_multiplier = ?, payout = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [multiplier, payout, betId]);
        
        // 4. إضافة المكسب إلى الرصيد
        await updateUserBalance(userId, payout, 'add');
        
        // 5. تحديث إحصائيات المستخدم
        await updateUserStats(userId, 'win', payout);
        
        return {
            payout: payout,
            multiplier: multiplier,
            amount: bet.amount
        };
    });
}

// ===== 5.4b صرف الاختبار (TEST BET) — uses test_balance, NEVER real TON balance =====
// This function is completely isolated from real TON. Test balance cannot be
// withdrawn, converted to TON, or affect collectible ownership.
async function placeTestBet(userId, amount, roundId, autoCashoutTarget) {
    const normalizedAutoCashoutTarget = normalizeAutoCashoutTarget(autoCashoutTarget);
    return await transaction(async () => {
        const round = await getRoundByNumber(roundId);
        if (!round || round.phase !== 'COUNTDOWN') throw new Error('Betting is closed for this round');

        // Test balance check — uses test_balance column, never real balance
        if (!Number.isFinite(amount) || amount < 1) throw new Error('Invalid test bet amount (minimum 1 TEST)');
        const testBalance = await getUserTestBalance(userId);
        if (testBalance < amount) throw new Error('Insufficient test balance');

        const update = await run(
            'UPDATE users SET test_balance = test_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND test_balance >= ?',
            [amount, userId, amount]
        );
        if (update.changes !== 1) throw new Error('Insufficient test balance');

        const result = await run(`
            INSERT INTO ton_bets
            (user_id, round_id, amount, auto_cashout_target, bet_currency)
            VALUES (?, ?, ?, ?, 'TEST')
        `, [userId, roundId, amount, normalizedAutoCashoutTarget]);

        return {
            betId: result.lastID,
            amount,
            roundId
        };
    });
}

async function cashoutTestBet(betId, userId, multiplier) {
    return await transaction(async () => {
        const bet = await get(`
            SELECT * FROM ton_bets
            WHERE id = ? AND user_id = ? AND status = 'ACTIVE' AND bet_currency = 'TEST'
        `, [betId, userId]);

        if (!bet) throw new Error('Test bet not found or already settled');

        const payout = bet.amount * multiplier;

        await run(`
            UPDATE ton_bets
            SET status = 'CASHED_OUT', cashout_multiplier = ?, payout = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [multiplier, payout, betId]);

        // Add payout to test_balance — NEVER real balance
        await run('UPDATE users SET test_balance = test_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [payout, userId]);

        await updateUserStats(userId, 'win', payout);

        return {
            payout,
            multiplier,
            amount: bet.amount,
            isTest: true
        };
    });
}

async function settleTestBetLoss(betId, userId) {
    const bet = await get(`
        SELECT * FROM ton_bets
        WHERE id = ? AND user_id = ? AND status = 'ACTIVE' AND bet_currency = 'TEST'
    `, [betId, userId]);
    if (!bet) return;
    await run(`
        UPDATE ton_bets
        SET status = 'LOST', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [betId]);
}
async function openLootbox(userId, boxId) {
    return await transaction(async () => {
        // 1. الحصول على بيانات الصندوق
        const box = await get('SELECT * FROM lootboxes WHERE id = ?', [boxId]);
        if (!box) throw new Error('Lootbox not found');
        
        // 2. التحقق من الرصيد (إذا كان مدفوعاً)
        if (box.price > 0) {
            const balance = await getUserBalance(userId);
            if (balance < box.price) throw new Error('Insufficient balance');
            await updateUserBalance(userId, box.price, 'subtract');
        }
        
        // 3. اختيار هدية عشوائية
        const gifts = await query(`
            SELECT * FROM gifts 
            WHERE rarity = ? OR rarity = 'common'
            ORDER BY RANDOM() 
            LIMIT 1
        `, [box.rarity]);
        
        if (gifts.length === 0) throw new Error('No gifts available');
        
        const selectedGift = gifts[0];
        
        // 4. إضافة الهدية للمستخدم
        const userGift = await addGiftToUser(userId, selectedGift.id);
        
        // 5. تسجيل فتح الصندوق
        await run(`
            INSERT INTO lootbox_history (user_id, lootbox_id, gift_id, status)
            VALUES (?, ?, ?, 'OPENED')
        `, [userId, boxId, selectedGift.id]);
        
        return {
            gift: selectedGift,
            userGiftId: userGift.id,
            boxName: box.name
        };
    });
}

// ===== 5.6 نظام الإيداعات =====
async function createDeposit(userId, walletAddress, amount, payload) {
    const result = await run(`
        INSERT INTO deposits (user_id, wallet_address, amount, payload, status)
        VALUES (?, ?, ?, ?, 'PENDING')
    `, [userId, walletAddress, amount, payload]);
    
    return await get('SELECT * FROM deposits WHERE id = ?', [result.lastID]);
}

async function saveDepositBoc(depositId, userId, transactionBoc) {
    if (typeof transactionBoc !== 'string' || transactionBoc.length === 0 || transactionBoc.length > 200000) {
        throw new Error('Invalid transaction BOC');
    }
    const result = await run(`
        UPDATE deposits
        SET transaction_boc = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND status = 'PENDING'
    `, [transactionBoc, depositId, userId]);
    if (result.changes !== 1) throw new Error('Deposit is not pending');
    return await get('SELECT * FROM deposits WHERE id = ? AND user_id = ?', [depositId, userId]);
}

async function creditVerifiedDeposit(depositId, userId, transactionHash, transactionBoc = null) {
    return await transaction(async () => {
        const deposit = await get(
            'SELECT * FROM deposits WHERE id = ? AND user_id = ?',
            [depositId, userId]
        );
        if (!deposit) throw new Error('Deposit not found');
        if (deposit.status !== 'PENDING') {
            throw new Error('Deposit is not pending');
        }

        const used = await get(
            'SELECT id FROM deposits WHERE transaction_hash = ? AND id != ?',
            [transactionHash, depositId]
        );
        if (used) throw new Error('Transaction already used');

        const update = await run(`
            UPDATE deposits
            SET status = 'CREDITED', transaction_hash = ?, transaction_boc = COALESCE(?, transaction_boc), updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND status = 'PENDING'
        `, [transactionHash, transactionBoc, depositId, userId]);
        if (update.changes !== 1) {
            return await get('SELECT * FROM deposits WHERE id = ? AND user_id = ?', [depositId, userId]);
        }

        await run(
            'UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [deposit.amount, userId]
        );

        const referredUser = await get('SELECT referred_by_user_id FROM users WHERE id = ?', [userId]);
        const inviterId = Number(referredUser?.referred_by_user_id || 0);
        if (inviterId > 0 && inviterId !== Number(userId)) {
            const rewardAmount = Number((Number(deposit.amount) * 0.10).toFixed(9));
            if (rewardAmount > 0) {
                const rewardInsert = await run(`
                    INSERT OR IGNORE INTO referral_rewards
                    (inviter_user_id, invited_user_id, deposit_id, amount)
                    VALUES (?, ?, ?, ?)
                `, [inviterId, userId, depositId, rewardAmount]);
                if (rewardInsert.changes === 1) {
                    await run(
                        'UPDATE users SET balance = balance + ?, referral_earned = COALESCE(referral_earned, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [rewardAmount, rewardAmount, inviterId]
                    );
                }
            }
        }

        return await get('SELECT * FROM deposits WHERE id = ? AND user_id = ?', [depositId, userId]);
    });
}

async function updateDepositStatus(depositId, status, failureReason = null) {
    const validStatuses = ['PENDING', 'DETECTED', 'CONFIRMED', 'CREDITED', 'FAILED'];
    if (!validStatuses.includes(status)) throw new Error('Invalid status');

    return await transaction(async () => {
        const deposit = await get('SELECT * FROM deposits WHERE id = ?', [depositId]);
        if (!deposit) return null;
        if (status === 'CREDITED' && deposit.status !== 'PENDING') {
            throw new Error('Only pending deposits can be credited');
        }
        if (deposit.status === 'CREDITED') return deposit;

        const update = await run(`
            UPDATE deposits
            SET status = ?, failure_reason = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status != 'CREDITED' AND (? != 'CREDITED' OR status = 'PENDING')
        `, [status, failureReason, depositId, status]);

        if (status === 'CREDITED' && update.changes === 1) {
            await run(
                'UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [deposit.amount, deposit.user_id]
            );

            const referredUser = await get('SELECT referred_by_user_id FROM users WHERE id = ?', [deposit.user_id]);
            const inviterId = Number(referredUser?.referred_by_user_id || 0);
            if (inviterId > 0 && inviterId !== Number(deposit.user_id)) {
                const rewardAmount = Number((Number(deposit.amount) * 0.10).toFixed(9));
                if (rewardAmount > 0) {
                    const rewardInsert = await run(`
                        INSERT OR IGNORE INTO referral_rewards
                        (inviter_user_id, invited_user_id, deposit_id, amount)
                        VALUES (?, ?, ?, ?)
                    `, [inviterId, deposit.user_id, depositId, rewardAmount]);
                    if (rewardInsert.changes === 1) {
                        await run(
                            'UPDATE users SET balance = balance + ?, referral_earned = COALESCE(referral_earned, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                            [rewardAmount, rewardAmount, inviterId]
                        );
                    }
                }
            }
        }

        return await get('SELECT * FROM deposits WHERE id = ?', [depositId]);
    });
}

// ===== 5.6B سحب الأرباح =====
async function createWithdrawalRequest(userId, walletAddress, amount) {
    return await transaction(async () => {
        const user = await get('SELECT balance FROM users WHERE id = ?', [userId]);
        if (!user) throw new Error('User not found');
        const normalizedAmount = Number(Number(amount).toFixed(9));
        if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) throw new Error('Invalid withdrawal amount');
        if (normalizedAmount > Number(user.balance || 0)) throw new Error('Insufficient balance');

        const update = await run(
            'UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?',
            [normalizedAmount, userId, normalizedAmount]
        );
        if (update.changes !== 1) throw new Error('Insufficient balance');

        const result = await run(`
            INSERT INTO withdrawals (user_id, wallet_address, amount, status)
            VALUES (?, ?, ?, 'PENDING')
        `, [userId, walletAddress, normalizedAmount]);

        return await get('SELECT * FROM withdrawals WHERE id = ?', [result.lastID]);
    });
}

async function markWithdrawalProcessing(withdrawalId) {
    const result = await run(`UPDATE withdrawals SET status = 'PROCESSING', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDING'`, [withdrawalId]);
    if (result.changes !== 1) throw new Error('Withdrawal is no longer pending');
    return await get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
}

async function completeWithdrawal(withdrawalId, transactionHash) {
    const result = await run(`UPDATE withdrawals SET status = 'PAID', transaction_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PROCESSING'`, [transactionHash || null, withdrawalId]);
    if (result.changes !== 1) throw new Error('Withdrawal is no longer processing');
    return await get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
}
async function getUserWithdrawals(userId) {
    return await query(`
        SELECT id, wallet_address, amount, status, transaction_hash, failure_reason, created_at, updated_at
        FROM withdrawals
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 20
    `, [userId]);
}

async function refundFailedWithdrawal(withdrawalId, reason = 'Withdrawal failed') {
    return await transaction(async () => {
        const withdrawal = await get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
        if (!withdrawal) throw new Error('Withdrawal not found');
        if (withdrawal.status === 'PAID' || withdrawal.status === 'CANCELLED') return withdrawal;
        if (withdrawal.status === 'FAILED') return withdrawal;
        await run(`
            UPDATE withdrawals
            SET status = 'FAILED', failure_reason = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('PENDING', 'PROCESSING')
        `, [reason, withdrawalId]);
        await run(
            'UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [withdrawal.amount, withdrawal.user_id]
        );
        return await get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
    });
}

// ===== 5.7A ترتيب المتصدرين حسب إجمالي الصرف =====
async function getSpenderLeaderboard(limit = 200, userId = null) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 200));

    const spendingCte = `
        WITH spending AS (
            SELECT
                u.id,
                u.first_name,
                u.last_name,
                u.username,
                u.avatar_url,
                COALESCE(tb.spent, 0) + COALESCE(gb.spent, 0) AS total_spent
            FROM users u
            LEFT JOIN (
                SELECT user_id, SUM(amount) AS spent
                FROM ton_bets
                GROUP BY user_id
            ) tb ON tb.user_id = u.id
            LEFT JOIN (
                SELECT user_id, SUM(gift_value_at_bet) AS spent
                FROM gift_bets
                GROUP BY user_id
            ) gb ON gb.user_id = u.id
        )
    `;

    const topRows = await query(
        spendingCte + `
            SELECT id, first_name, last_name, username, avatar_url, total_spent
            FROM spending
            ORDER BY total_spent DESC, id ASC
            LIMIT ?
        `,
        [safeLimit]
    );

    let me = null;
    if (userId != null) {
        me = await get(
            spendingCte + `
                SELECT
                    id, first_name, last_name, username, avatar_url, total_spent,
                    (SELECT COUNT(*) + 1 FROM spending s2
                     WHERE s2.total_spent > spending.total_spent
                        OR (s2.total_spent = spending.total_spent AND s2.id < spending.id)) AS rank
                FROM spending
                WHERE id = ?
            `,
            [userId]
        );
    }

    return {
        players: topRows.map((row, index) => ({
            id: row.id,
            rank: index + 1,
            firstName: row.first_name,
            lastName: row.last_name,
            username: row.username,
            avatar: row.avatar_url,
            totalSpent: Number(row.total_spent || 0)
        })),
        me: me ? {
            id: me.id,
            rank: Number(me.rank || 1),
            firstName: me.first_name,
            lastName: me.last_name,
            username: me.username,
            avatar: me.avatar_url,
            totalSpent: Number(me.total_spent || 0)
        } : null
    };
}

// ===== 5.7 إحصائيات المستخدم =====
async function updateUserStats(userId, type, value) {
    const stats = await get('SELECT * FROM user_stats WHERE user_id = ?', [userId]);
    
    if (!stats) {
        await run('INSERT INTO user_stats (user_id) VALUES (?)', [userId]);
    }
    
    if (type === 'win') {
        await run(`
            UPDATE user_stats 
            SET total_rounds = total_rounds + 1,
                total_wins = total_wins + 1,
                total_profit = total_profit + ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?
        `, [value, userId]);
    } else if (type === 'lose') {
        await run(`
            UPDATE user_stats 
            SET total_rounds = total_rounds + 1,
                total_losses = total_losses + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?
        `, [userId]);
    } else if (type === 'gift_won') {
        await run(`
            UPDATE user_stats 
            SET gifts_won = gifts_won + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?
        `, [userId]);
    } else if (type === 'gift_lost') {
        await run(`
            UPDATE user_stats 
            SET gifts_lost = gifts_lost + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ?
        `, [userId]);
    }
}

// ===== 5.8 نظام الإشعارات =====
async function createNotification(userId, type, message, data = null) {
    const result = await run(`
        INSERT INTO notifications (user_id, type, message, data)
        VALUES (?, ?, ?, ?)
    `, [userId, type, message, JSON.stringify(data)]);
    
    return await get('SELECT * FROM notifications WHERE id = ?', [result.lastID]);
}

async function getNotifications(userId, limit = 20) {
    return await query(`
        SELECT * FROM notifications 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT ?
    `, [userId, limit]);
}

// =========================================================
// 6. تصدير الدوال
// =========================================================

// ===== 5.11 نظام ألعاب الواجهة الخلفية =====

// Generate a provably-fair server seed for mini-games using crypto.randomBytes.
function generateGameServerSeed() {
    return crypto.randomBytes(32).toString('hex');
}

function hashGameServerSeed(seed) {
    return crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
}

// SHA-256 hash of seed:clientSeed message, returns uniform [0,1).
function deriveGameUniform(serverSeed, clientSeed, nonce) {
    const message = `${clientSeed}:${nonce}`;
    const digest = crypto.createHmac('sha256', serverSeed).update(message, 'utf8').digest();
    const value = BigInt('0x' + digest.toString('hex').substring(0, 13));
    return Number(value) / Number(2n ** 52n);
}

function calculateMinesMultiplier(mineCount, safeReveals) {
    const mines = Number(mineCount);
    const reveals = Number(safeReveals);
    if (!Number.isInteger(mines) || mines < 1 || mines > 24) throw new Error('Mines must be between 1 and 24');
    if (!Number.isInteger(reveals) || reveals < 0 || reveals > 25 - mines) throw new Error('Invalid revealed tile count');
    if (reveals === 0) return 1.0;
    let multiplier = 0.975;
    for (let i = 0; i < reveals; i++) multiplier *= (25 - i) / (25 - mines - i);
    return Number(multiplier.toFixed(2));
}

async function createMinesGame(userId, betAmount, betCurrency, betGiftId, mineCount = 5) {
    return await transaction(async () => {
        const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
        if (!user) throw new Error('User not found');

        if (betCurrency === 'TON') {
            if (betAmount < 0.1) throw new Error('Invalid bet amount');
            const balance = await getUserBalance(userId);
            if (balance < betAmount) throw new Error('Insufficient balance');
            const update = await run(
                'UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?',
                [betAmount, userId, betAmount]
            );
            if (update.changes !== 1) throw new Error('Insufficient balance');
        } else if (betCurrency === 'TEST') {
            if (betAmount < 1) throw new Error('Invalid test bet amount');
            const testBalance = await getUserTestBalance(userId);
            if (testBalance < betAmount) throw new Error('Insufficient test balance');
            const update = await run(
                'UPDATE users SET test_balance = test_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND test_balance >= ?',
                [betAmount, userId, betAmount]
            );
            if (update.changes !== 1) throw new Error('Insufficient test balance');
        } else if (betCurrency === 'GIFT') {
            if (!betGiftId) throw new Error('giftId required for GIFT bet');
            const gift = await get(`
                SELECT ug.*, g.value AS gift_value, g.name AS gift_name
                FROM user_gifts ug
                JOIN gifts g ON ug.gift_id = g.id
                WHERE ug.user_id = ? AND (ug.unique_collectible_id = ? OR ug.id = ? OR g.telegram_gift_id = ?)
                AND ug.status = 'OWNED' AND ug.ownership_verified = 1
                ORDER BY ug.ownership_verified DESC, ug.id DESC LIMIT 1
            `, [userId, betGiftId, betGiftId, betGiftId]);
            if (!gift) throw new Error('Gift not owned or not available');
            if (!Number.isFinite(gift.gift_value) || gift.gift_value <= 0) {
                throw new Error('Collectible has no valid market valuation');
            }
            await run('UPDATE user_gifts SET status = \'IN_BET\' WHERE id = ? AND status = \'OWNED\'', [gift.id]);
            betAmount = gift.gift_value;
        } else {
            throw new Error('Invalid bet currency');
        }

        const normalizedMineCount = Number(mineCount);
        if (!Number.isInteger(normalizedMineCount) || normalizedMineCount < 1 || normalizedMineCount > 24) {
            throw new Error('Mines must be between 1 and 24');
        }

        const serverSeed = generateGameServerSeed();
        const serverSeedHash = hashGameServerSeed(serverSeed);

        const minePositions = new Set();
        while (minePositions.size < normalizedMineCount) minePositions.add(crypto.randomInt(0, 25));

        const gameData = JSON.stringify({
            boardSize: 25,
            mineCount: normalizedMineCount,
            minePositions: Array.from(minePositions),
            clientSeed: crypto.randomBytes(8).toString('hex'),
            multiplier: 1.0,
            revealed: []
        });

        const result = await run(`
            INSERT INTO mini_games (user_id, game_type, bet_amount, bet_currency, game_data, server_seed, server_seed_hash, status)
            VALUES (?, 'MINES', ?, ?, ?, ?, ?, 'ACTIVE')
        `, [userId, betAmount, betCurrency, gameData, serverSeed, serverSeedHash]);

        return { gameId: result.lastID, serverSeedHash, clientSeed: JSON.parse(gameData).clientSeed };
    });
}

async function revealMinesTile(gameId, userId, tileIndex) {
    return await transaction(async () => {
        const game = await get('SELECT * FROM mini_games WHERE id = ? AND user_id = ?', [gameId, userId]);
        if (!game) throw new Error('Game not found');
        if (game.status !== 'ACTIVE') throw new Error('Game already completed');

        const gameData = JSON.parse(game.game_data);
        if (tileIndex < 0 || tileIndex >= gameData.boardSize) throw new Error('Invalid tile index');
        if (!Number.isInteger(gameData.mineCount) || gameData.mineCount < 1 || gameData.mineCount > 24) {
            throw new Error('Invalid mine configuration');
        }
        if (gameData.revealed && gameData.revealed.includes(tileIndex)) throw new Error('Tile already revealed');

        const hitMine = gameData.minePositions.includes(tileIndex);
        if (!gameData.revealed) gameData.revealed = [];
        gameData.revealed.push(tileIndex);
        gameData.lastTile = tileIndex;
        gameData.hitMine = hitMine;
        gameData.tilesRevealed = gameData.revealed.length;

        if (hitMine) {
            gameData.multiplier = gameData.baseMultiplier || 1.0;
            await run('UPDATE mini_games SET game_data = ?, status = \'COMPLETED\', result_detail = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = \'ACTIVE\'',
                [JSON.stringify(gameData), JSON.stringify({ multiplier: gameData.multiplier, hitMine: true }), gameId]);
            return { hitMine: true, multiplier: gameData.multiplier };
        }

        // Reference Mines curve with a 2.5% house edge.
        const multiplier = calculateMinesMultiplier(gameData.mineCount, gameData.revealed.length);
        gameData.multiplier = multiplier;
        await run('UPDATE mini_games SET game_data = ? WHERE id = ?', [JSON.stringify(gameData), gameId]);
        return { hitMine: false, multiplier: gameData.multiplier, tilesRevealed: gameData.revealed.length };
    });
}

async function cashoutMinesGame(gameId, userId) {
    return await transaction(async () => {
        const game = await get('SELECT * FROM mini_games WHERE id = ? AND user_id = ?', [gameId, userId]);
        if (!game) throw new Error('Game not found');
        if (game.status !== 'ACTIVE') throw new Error('Game already completed');

        const gameData = JSON.parse(game.game_data);
        const multiplier = gameData.multiplier || 1.0;
        const payout = game.bet_amount * multiplier;

        let payoutDetail = {};
        if (game.bet_currency === 'TON') {
            await run('UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [payout, userId]);
            payoutDetail = { currency: 'TON', amount: payout, multiplier };
        } else if (game.bet_currency === 'TEST') {
            await run('UPDATE users SET test_balance = test_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [payout, userId]);
            payoutDetail = { currency: 'TEST', amount: payout, multiplier, isTest: true };
        } else {
            payoutDetail = { currency: 'GIFT', collectibleReturned: true, multiplier };
            // For GIFT bets, the collectible is returned (player chose to cash out before hitting a mine)
            await run('UPDATE user_gifts SET status = \'OWNED\', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = \'IN_BET\'', [userId]);
        }

        await run('UPDATE mini_games SET status = \'COMPLETED\', result_multiplier = ?, payout = ?, result_detail = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = \'ACTIVE\'',
            [multiplier, payout, JSON.stringify(payoutDetail), gameId]);
        return { gameId, paidOut: true, payout, multiplier, currency: game.bet_currency };
    });
}

async function createPlinkoGame(userId, betAmount, betCurrency, betGiftId, difficulty = 'easy') {
    return await transaction(async () => {
        const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
        if (!user) throw new Error('User not found');

        if (betCurrency === 'TON') {
            if (betAmount < 0.1) throw new Error('Invalid bet amount');
            const balance = await getUserBalance(userId);
            if (balance < betAmount) throw new Error('Insufficient balance');
            const update = await run(
                'UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?',
                [betAmount, userId, betAmount]
            );
            if (update.changes !== 1) throw new Error('Insufficient balance');
        } else if (betCurrency === 'TEST') {
            if (betAmount < 1) throw new Error('Invalid test bet amount');
            const testBalance = await getUserTestBalance(userId);
            if (testBalance < betAmount) throw new Error('Insufficient test balance');
            const update = await run(
                'UPDATE users SET test_balance = test_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND test_balance >= ?',
                [betAmount, userId, betAmount]
            );
            if (update.changes !== 1) throw new Error('Insufficient test balance');
        } else if (betCurrency === 'GIFT') {
            if (!betGiftId) throw new Error('giftId required');
            const gift = await get(`
                SELECT ug.*, g.value AS gift_value FROM user_gifts ug JOIN gifts g ON ug.gift_id = g.id
                WHERE ug.user_id = ? AND (ug.unique_collectible_id = ? OR ug.id = ? OR g.telegram_gift_id = ?)
                AND ug.status = 'OWNED' AND ug.ownership_verified = 1
                ORDER BY ug.id DESC LIMIT 1
            `, [userId, betGiftId, betGiftId, betGiftId]);
            if (!gift) throw new Error('Gift not owned or not available');
            if (!Number.isFinite(gift.gift_value) || gift.gift_value <= 0) throw new Error('No valid market valuation');
            await run('UPDATE user_gifts SET status = \'IN_BET\' WHERE id = ? AND status = \'OWNED\'', [gift.id]);
            betAmount = gift.gift_value;
        } else {
            throw new Error('Invalid bet currency');
        }

        const serverSeed = generateGameServerSeed();
        const serverSeedHash = hashGameServerSeed(serverSeed);
        const clientSeed = crypto.randomBytes(8).toString('hex');

        // Plinko difficulty presets mirror the reference layout.
        // The selected preset is stored with the game so the server result
        // always matches the board shown to the player.
        const PLINKO_SLOTS = {
            easy: [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
            medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
            hard: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000]
        };
        const selectedDifficulty = Object.prototype.hasOwnProperty.call(PLINKO_SLOTS, String(difficulty)) ? String(difficulty) : 'easy';
        const slots = PLINKO_SLOTS[selectedDifficulty];
        const gameData = JSON.stringify({ serverSeed, serverSeedHash, clientSeed, slots, difficulty: selectedDifficulty, nonce: 0 });

        const result = await run(`
            INSERT INTO mini_games (user_id, game_type, bet_amount, bet_currency, game_data, server_seed, server_seed_hash, status)
            VALUES (?, 'PLINKO', ?, ?, ?, ?, ?, 'ACTIVE')
        `, [userId, betAmount, betCurrency, gameData, serverSeed, serverSeedHash]);

        // Pre-compute result using HMAC — server only
        const uniform = deriveGameUniform(serverSeed, clientSeed, 0);
        const slotIndex = Math.floor(uniform * slots.length);
        return { gameId: result.lastID, serverSeedHash, clientSeed, slotMultiplier: slots[slotIndex] };
    });
}

async function dropPlinkoChip(gameId, userId) {
    return await transaction(async () => {
        const game = await get('SELECT * FROM mini_games WHERE id = ? AND user_id = ?', [gameId, userId]);
        if (!game) throw new Error('Game not found');
        if (game.status !== 'ACTIVE') throw new Error('Game already completed');

        const gameData = JSON.parse(game.game_data);
        const uniform = deriveGameUniform(game.server_seed, gameData.clientSeed, gameData.nonce);
        const slotIndex = Math.floor(uniform * gameData.slots.length);
        const multiplier = gameData.slots[slotIndex];
        const payout = game.bet_amount * multiplier;

        let payoutDetail = {};
        if (game.bet_currency === 'TON') {
            await run('UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [payout, userId]);
            payoutDetail = { currency: 'TON', amount: payout, multiplier, slotIndex };
        } else if (game.bet_currency === 'TEST') {
            await run('UPDATE users SET test_balance = test_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [payout, userId]);
            payoutDetail = { currency: 'TEST', amount: payout, multiplier, slotIndex, isTest: true };
        } else {
            if (multiplier >= 1.0) {
                payoutDetail = { currency: 'GIFT', collectibleWon: true, multiplier, slotIndex };
            } else {
                payoutDetail = { currency: 'GIFT', collectibleLost: true, multiplier, slotIndex };
                await run('UPDATE user_gifts SET status = \'LOST\', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = \'IN_BET\'', [userId]);
            }
        }

        await run('UPDATE mini_games SET status = \'COMPLETED\', result_multiplier = ?, payout = ?, result_detail = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = \'ACTIVE\'',
            [multiplier, payout, JSON.stringify(payoutDetail), gameId]);
        return { gameId, paidOut: multiplier >= 1.0, payout, multiplier, slotIndex };
    });
}

async function createDiceGame(userId, betAmount, betCurrency, betGiftId, target) {
    return await transaction(async () => {
        const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
        if (!user) throw new Error('User not found');

        if (betCurrency === 'TON') {
            if (betAmount < 0.1) throw new Error('Invalid bet amount');
            const balance = await getUserBalance(userId);
            if (balance < betAmount) throw new Error('Insufficient balance');
            const update = await run(
                'UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?',
                [betAmount, userId, betAmount]
            );
            if (update.changes !== 1) throw new Error('Insufficient balance');
        } else if (betCurrency === 'TEST') {
            if (betAmount < 1) throw new Error('Invalid test bet amount');
            const testBalance = await getUserTestBalance(userId);
            if (testBalance < betAmount) throw new Error('Insufficient test balance');
            const update = await run(
                'UPDATE users SET test_balance = test_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND test_balance >= ?',
                [betAmount, userId, betAmount]
            );
            if (update.changes !== 1) throw new Error('Insufficient test balance');
        } else if (betCurrency === 'GIFT') {
            if (!betGiftId) throw new Error('giftId required');
            const gift = await get(`
                SELECT ug.*, g.value AS gift_value FROM user_gifts ug JOIN gifts g ON ug.gift_id = g.id
                WHERE ug.user_id = ? AND (ug.unique_collectible_id = ? OR ug.id = ? OR g.telegram_gift_id = ?)
                AND ug.status = 'OWNED' AND ug.ownership_verified = 1
                ORDER BY ug.id DESC LIMIT 1
            `, [userId, betGiftId, betGiftId, betGiftId]);
            if (!gift) throw new Error('Gift not owned or not available');
            if (!Number.isFinite(gift.gift_value) || gift.gift_value <= 0) throw new Error('No valid market valuation');
            await run('UPDATE user_gifts SET status = \'IN_BET\' WHERE id = ? AND status = \'OWNED\'', [gift.id]);
            betAmount = gift.gift_value;
        } else {
            throw new Error('Invalid bet currency');
        }

        if (!Number.isInteger(target) || target < 1 || target > 99) {
            throw new Error('Target must be an integer between 1 and 99');
        }

        const serverSeed = generateGameServerSeed();
        const serverSeedHash = hashGameServerSeed(serverSeed);
        const clientSeed = crypto.randomBytes(8).toString('hex');
        const nonce = 0;

        // Server-authoritative roll using HMAC
        const uniform = deriveGameUniform(serverSeed, clientSeed, nonce);
        const roll = Math.floor(uniform * 100) + 1;

        // House edge 5%: win chance = target/100 * 0.95
        const winChance = (target / 100) * 0.95;
        const won = roll <= target;

        // Payout = bet / winChance when won
        const payout = won ? betAmount / winChance : 0;

        let payoutDetail = {};
        if (won) {
            if (betCurrency === 'TON') {
                await run('UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [payout, userId]);
                payoutDetail = { currency: 'TON', amount: payout, roll, target };
            } else if (betCurrency === 'TEST') {
                await run('UPDATE users SET test_balance = test_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [payout, userId]);
                payoutDetail = { currency: 'TEST', amount: payout, roll, target, isTest: true };
            } else {
                payoutDetail = { currency: 'GIFT', collectibleWon: true, roll, target };
            }
        } else {
            if (betCurrency === 'GIFT') {
                await run('UPDATE user_gifts SET status = \'LOST\', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = \'IN_BET\'', [userId]);
            }
            payoutDetail = { currency: betCurrency, collectibleLost: betCurrency === 'GIFT', roll, target };
        }

        const result = await run(`
            INSERT INTO mini_games (user_id, game_type, bet_amount, bet_currency, game_data, server_seed, server_seed_hash, result_multiplier, payout, result_detail, status, completed_at)
            VALUES (?, 'DICE', ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', CURRENT_TIMESTAMP)
        `, [userId, betAmount, betCurrency, JSON.stringify({ clientSeed, target }), serverSeed, serverSeedHash, roll, payout, JSON.stringify(payoutDetail)]);

        return { gameId: result.lastID, serverSeedHash, clientSeed, roll, won, payout, target };
    });
}

async function getMiniGame(gameId, userId) {
    const game = await get('SELECT * FROM mini_games WHERE id = ? AND user_id = ?', [gameId, userId]);
    if (!game) return null;
    const result = {
        gameId: game.id,
        gameType: game.game_type,
        betAmount: game.bet_amount,
        betCurrency: game.bet_currency,
        status: game.status,
        resultMultiplier: game.result_multiplier,
        payout: game.payout
    };
    if (game.status === 'ACTIVE' && game.game_type === 'MINES') {
        try {
            const gameData = JSON.parse(game.game_data);
            result.tilesRevealed = gameData.revealed ? gameData.revealed.length : 0;
            result.mineCount = gameData.mineCount;
            result.multiplier = gameData.multiplier || 1;
        } catch { /* ignore parse errors */ }
    }
    if (game.game_type === 'LOTTERY') {
        try {
            const gameData = JSON.parse(game.game_data);
            result.playerNumbers = gameData.playerNumbers;
            result.drawnNumbers = gameData.drawnNumbers;
            result.matches = gameData.matches;
            result.matchCount = gameData.matchCount;
        } catch { /* ignore parse errors */ }
    }
    return result;
}

// ===== LOTTERY GAME =====
// Pick 5 numbers from 1-50. Server draws 5 unique numbers. Prizes based on matches.
const LOTTERY_NUMBERS = 50;
const LOTTERY_PICK_COUNT = 5;
const LOTTERY_PRIZE_TABLE = {
    5: 1000000,
    4: 10000,
    3: 100,
    2: 5,
    1: 0,
    0: 0
};

function getLotteryPrize(matchCount, betAmount) {
    const multiplier = LOTTERY_PRIZE_TABLE[matchCount] || 0;
    return betAmount * multiplier;
}

const LOTTERY_GAME_CONFIGS = {
    classic: {
        key: 'classic',
        title: '3.5K TON',
        ticketPrice: 3,
        jackpot: 3500,
        mainNumbersCount: 50,
        mainPickCount: 5,
        bonusNumbersCount: 12,
        bonusPickCount: 1,
        maxParticipants: 2000000,
        drawWeekday: 6,
        drawHour: 20
    },
    mega: {
        key: 'mega',
        title: '15K TON',
        ticketPrice: 6,
        jackpot: 15000,
        mainNumbersCount: 60,
        mainPickCount: 6,
        bonusNumbersCount: 12,
        bonusPickCount: 1,
        maxParticipants: 2000000,
        drawWeekday: 2,
        drawHour: 20
    },
    ultra: {
        key: 'ultra',
        title: '100K TON',
        ticketPrice: 10,
        jackpot: 100000,
        mainNumbersCount: 60,
        mainPickCount: 7,
        bonusNumbersCount: 12,
        bonusPickCount: 2,
        maxParticipants: 2000000,
        drawWeekday: 4,
        drawHour: 20
    }
};

function getLotteryConfig(gameKey) {
    const config = LOTTERY_GAME_CONFIGS[gameKey];
    if (!config) throw new Error('Unknown lottery game');
    return config;
}

function normalizeLotteryNumbers(numbers, count, max, label) {
    if (!Array.isArray(numbers) || numbers.length !== count) {
        throw new Error(`You must select exactly ${count} ${label}`);
    }
    const seen = new Set();
    const normalized = numbers.map(Number).sort((a, b) => a - b);
    for (const num of normalized) {
        if (!Number.isInteger(num) || num < 1 || num > max) {
            throw new Error(`${label} must be integers between 1 and ${max}`);
        }
        if (seen.has(num)) throw new Error(`Duplicate ${label.toLowerCase()} are not allowed`);
        seen.add(num);
    }
    return normalized;
}

function lotteryNumbersSignature(numbers) {
    return JSON.stringify([...numbers].sort((a, b) => a - b));
}

function drawUniqueLotteryNumbers(count, max) {
    const set = new Set();
    while (set.size < count) set.add(crypto.randomInt(1, max + 1));
    return Array.from(set).sort((a, b) => a - b);
}

async function createLotteryRound(gameKey, drawAt) {
    const config = getLotteryConfig(gameKey);
    const existing = await get(
        'SELECT * FROM lottery_rounds WHERE game_key = ? AND draw_at = ? LIMIT 1',
        [gameKey, drawAt]
    );
    if (existing) return existing;

    const result = await run(`
        INSERT INTO lottery_rounds
        (game_key, draw_at, status, ticket_price, jackpot, main_numbers_count, main_pick_count,
         bonus_numbers_count, bonus_pick_count, max_participants, participant_count)
        VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, 0)
    `, [
        gameKey, drawAt, config.ticketPrice, config.jackpot, config.mainNumbersCount,
        config.mainPickCount, config.bonusNumbersCount, config.bonusPickCount, config.maxParticipants
    ]);
    return await get('SELECT * FROM lottery_rounds WHERE id = ?', [result.lastID]);
}

async function getOpenLotteryRound(gameKey) {
    return await get(
        `SELECT * FROM lottery_rounds
         WHERE game_key = ? AND status = 'OPEN'
         ORDER BY draw_at ASC LIMIT 1`,
        [gameKey]
    );
}

async function getLotteryRoundsForUser(userId) {
    return await query(`
        SELECT r.id, r.game_key, r.draw_at, r.status, r.ticket_price, r.jackpot,
               r.main_numbers_count, r.main_pick_count, r.bonus_numbers_count, r.bonus_pick_count,
               r.max_participants, r.participant_count, r.draw_numbers, r.draw_bonus_numbers,
               e.id AS entry_id, e.main_numbers, e.bonus_numbers, e.payout, e.status AS entry_status
        FROM lottery_rounds r
        LEFT JOIN lottery_entries e ON e.round_id = r.id AND e.user_id = ?
        WHERE julianday(r.draw_at) >= julianday('now', '-14 days')
        ORDER BY r.draw_at DESC, e.id DESC
        LIMIT 200
    `, [userId]);
}

async function getLotteryRoundsSummary() {
    return await query(`
        SELECT r.*,
               (SELECT COUNT(*) FROM lottery_entries e WHERE e.round_id = r.id) AS live_entry_count
        FROM lottery_rounds r
        WHERE r.status = 'OPEN'
        ORDER BY r.draw_at ASC
    `);
}

async function createLotteryTicket(userId, gameKey, mainNumbers, bonusNumbers) {
    const config = getLotteryConfig(gameKey);
    const normalizedMain = normalizeLotteryNumbers(mainNumbers, config.mainPickCount, config.mainNumbersCount, 'main numbers');
    const normalizedBonus = normalizeLotteryNumbers(bonusNumbers, config.bonusPickCount, config.bonusNumbersCount, 'bonus numbers');

    return await transaction(async () => {
        const round = await get(
            `SELECT * FROM lottery_rounds WHERE game_key = ? AND status = 'OPEN' ORDER BY draw_at ASC LIMIT 1`,
            [gameKey]
        );
        if (!round) throw new Error('No active draw is available yet');
        if (new Date(round.draw_at).getTime() <= Date.now()) throw new Error('This draw is closed');

        // A player may hold exactly ONE ticket in each lottery game for the current draw.
        // The three games are independent, so the same player may participate in all three.
        const existingEntry = await get(
            `SELECT e.id
             FROM lottery_entries e
             JOIN lottery_rounds r ON r.id = e.round_id
             WHERE r.game_key = ? AND r.status = 'OPEN' AND e.user_id = ?
             LIMIT 1`,
            [gameKey, userId]
        );
        if (existingEntry) throw new Error('You already have a ticket for this game');

        const countRow = await get('SELECT COUNT(*) AS count FROM lottery_entries WHERE round_id = ?', [round.id]);
        const count = Number(countRow?.count || 0);
        if (count >= config.maxParticipants) throw new Error('This lottery is full');

        const balance = await getUserBalance(userId);
        if (balance < config.ticketPrice) throw new Error('Insufficient balance');

        const debit = await run(
            'UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?',
            [config.ticketPrice, userId, config.ticketPrice]
        );
        if (debit.changes !== 1) throw new Error('Insufficient balance');

        const result = await run(`
            INSERT INTO lottery_entries
            (round_id, user_id, main_numbers, bonus_numbers, ticket_price, status)
            VALUES (?, ?, ?, ?, ?, 'ACTIVE')
        `, [
            round.id,
            userId,
            lotteryNumbersSignature(normalizedMain),
            lotteryNumbersSignature(normalizedBonus),
            config.ticketPrice
        ]);

        await run(
            'UPDATE lottery_rounds SET participant_count = participant_count + 1 WHERE id = ?',
            [round.id]
        );

        return {
            entryId: result.lastID,
            roundId: round.id,
            gameKey,
            ticketPrice: config.ticketPrice,
            jackpot: config.jackpot,
            mainNumbers: normalizedMain,
            bonusNumbers: normalizedBonus,
            drawAt: round.draw_at,
            participantCount: count + 1,
            maxParticipants: config.maxParticipants
        };
    });
}

async function drawLotteryRound(roundId) {
    return await transaction(async () => {
        const round = await get('SELECT * FROM lottery_rounds WHERE id = ?', [roundId]);
        if (!round) throw new Error('Lottery round not found');
        if (round.status === 'DRAWN') return { alreadyDrawn: true, round };

        const claimed = await run(
            `UPDATE lottery_rounds SET status = 'DRAWING' WHERE id = ? AND status = 'OPEN'`,
            [roundId]
        );
        if (claimed.changes !== 1) return { alreadyDrawing: true, round };

        const config = getLotteryConfig(round.game_key);
        const drawNumbers = drawUniqueLotteryNumbers(config.mainPickCount, config.mainNumbersCount);
        const drawBonusNumbers = drawUniqueLotteryNumbers(config.bonusPickCount, config.bonusNumbersCount);
        const mainSignature = lotteryNumbersSignature(drawNumbers);
        const bonusSignature = lotteryNumbersSignature(drawBonusNumbers);

        const winners = await query(
            `SELECT id, user_id FROM lottery_entries
             WHERE round_id = ? AND status = 'ACTIVE'
               AND main_numbers = ? AND bonus_numbers = ?`,
            [roundId, mainSignature, bonusSignature]
        );

        const winnerCount = winners.length;
        const perWinner = winnerCount > 0
            ? Math.floor((config.jackpot / winnerCount) * 1000000) / 1000000
            : 0;

        for (const winner of winners) {
            if (perWinner > 0) {
                await run(
                    'UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [perWinner, winner.user_id]
                );
            }
            await run(
                `UPDATE lottery_entries
                 SET status = 'WINNER', payout = ?, settled_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [perWinner, winner.id]
            );
        }

        await run(
            `UPDATE lottery_entries
             SET status = 'LOST', settled_at = CURRENT_TIMESTAMP
             WHERE round_id = ? AND status = 'ACTIVE'`,
            [roundId]
        );

        await run(
            `UPDATE lottery_rounds
             SET status = 'DRAWN',
                 participant_count = (SELECT COUNT(*) FROM lottery_entries WHERE round_id = ?),
                 draw_numbers = ?,
                 draw_bonus_numbers = ?,
                 winner_count = ?,
                 drawn_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [roundId, JSON.stringify(drawNumbers), JSON.stringify(drawBonusNumbers), winnerCount, roundId]
        );

        return {
            roundId,
            gameKey: round.game_key,
            drawNumbers,
            drawBonusNumbers,
            winnerCount,
            jackpot: config.jackpot,
            payoutPerWinner: perWinner,
            winners
        };
    });
}

async function createLotteryGame(userId, betAmount, betCurrency, betGiftId, playerNumbers) {
    return await transaction(async () => {
        const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
        if (!user) throw new Error('User not found');

        // Validate player numbers — must be exactly 5 unique numbers from 1-50
        if (!Array.isArray(playerNumbers) || playerNumbers.length !== LOTTERY_PICK_COUNT) {
            throw new Error(`You must select exactly ${LOTTERY_PICK_COUNT} numbers`);
        }

        const seen = new Set();
        for (const num of playerNumbers) {
            if (!Number.isInteger(num) || num < 1 || num > LOTTERY_NUMBERS) {
                throw new Error(`Numbers must be integers between 1 and ${LOTTERY_NUMBERS}`);
            }
            if (seen.has(num)) {
                throw new Error('Duplicate numbers not allowed');
            }
            seen.add(num);
        }

        if (betCurrency === 'TON') {
            if (betAmount < 0.1) throw new Error('Invalid bet amount');
            const balance = await getUserBalance(userId);
            if (balance < betAmount) throw new Error('Insufficient balance');
            const update = await run(
                'UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?',
                [betAmount, userId, betAmount]
            );
            if (update.changes !== 1) throw new Error('Insufficient balance');
        } else if (betCurrency === 'TEST') {
            if (betAmount < 1) throw new Error('Invalid test bet amount');
            const testBalance = await getUserTestBalance(userId);
            if (testBalance < betAmount) throw new Error('Insufficient test balance');
            const update = await run(
                'UPDATE users SET test_balance = test_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND test_balance >= ?',
                [betAmount, userId, betAmount]
            );
            if (update.changes !== 1) throw new Error('Insufficient test balance');
        } else {
            throw new Error('Invalid bet currency for Lottery');
        }

        const serverSeed = generateGameServerSeed();
        const serverSeedHash = hashGameServerSeed(serverSeed);
        const clientSeed = crypto.randomBytes(8).toString('hex');

        // Server-authoritative draw: pick 5 unique numbers from 1-50 using crypto.randomInt
        const drawnNumbers = new Set();
        while (drawnNumbers.size < LOTTERY_PICK_COUNT) {
            drawnNumbers.add(crypto.randomInt(1, LOTTERY_NUMBERS + 1));
        }
        const drawn = Array.from(drawnNumbers).sort((a, b) => a - b);

        // Sort player numbers for comparison
        const sortedPlayer = [...playerNumbers].sort((a, b) => a - b);
        const matches = sortedPlayer.filter(n => drawn.includes(n));
        const matchCount = matches.length;
        const payout = getLotteryPrize(matchCount, betAmount);

        const gameData = JSON.stringify({
            playerNumbers: sortedPlayer,
            drawnNumbers: drawn,
            matches: matches,
            matchCount: matchCount,
            serverSeedHash: serverSeedHash,
            clientSeed: clientSeed
        });

        let payoutDetail = {};
        if (payout > 0) {
            if (betCurrency === 'TON') {
                await run('UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [payout, userId]);
                payoutDetail = { currency: 'TON', amount: payout, matchCount, matches, drawnNumbers: drawn };
            } else if (betCurrency === 'TEST') {
                await run('UPDATE users SET test_balance = test_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [payout, userId]);
                payoutDetail = { currency: 'TEST', amount: payout, matchCount, matches, drawnNumbers: drawn, isTest: true };
            }
        } else {
            payoutDetail = { currency: betCurrency, matchCount, matches, drawnNumbers: drawn };
        }

        const result = await run(`
            INSERT INTO mini_games
            (user_id, game_type, bet_amount, bet_currency, game_data, server_seed, server_seed_hash, result_multiplier, payout, result_detail, status, completed_at)
            VALUES (?, 'LOTTERY', ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', CURRENT_TIMESTAMP)
        `, [userId, betAmount, betCurrency, gameData, serverSeed, serverSeedHash, matchCount, payout, JSON.stringify(payoutDetail)]);

        return {
            gameId: result.lastID,
            serverSeedHash,
            clientSeed,
            drawnNumbers: drawn,
            playerNumbers: sortedPlayer,
            matches: matches,
            matchCount: matchCount,
            payout: payout,
            won: payout > 0
        };
    });
}

// ===== 5.12 PvP Battle System =====
const MAX_PVP_PLAYERS = 75;
const DEFAULT_PVP_COUNTDOWN_SECONDS = 20;

async function getPvpActiveRound() {
    return await get('SELECT * FROM pvp_rounds WHERE phase IN (?, ?, ?) ORDER BY round_number DESC LIMIT 1', ['WAITING', 'COUNTDOWN', 'LIVE']);
}

async function createPvpRound(roundNumber) {
    const fairRound = createFairRound(roundNumber, DEFAULT_CLIENT_SEED);
    const result = await run(`
        INSERT INTO pvp_rounds
        (round_number, phase, seconds_remaining, pool_ton, pool_gift_value,
         crash_at, server_seed, server_seed_hash, nonce, created_at)
        VALUES (?, 'WAITING', ?, 0, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [roundNumber, DEFAULT_PVP_COUNTDOWN_SECONDS, fairRound.crashAt, fairRound.serverSeed, fairRound.serverSeedHash, fairRound.nonce]);

    return await get('SELECT * FROM pvp_rounds WHERE id = ?', [result.lastID]);
}

async function startPvpCountdown(roundId) {
    await run('UPDATE pvp_rounds SET phase = ?, seconds_remaining = ?, started_at = CURRENT_TIMESTAMP WHERE id = ?', ['COUNTDOWN', DEFAULT_PVP_COUNTDOWN_SECONDS, roundId]);
    return await get('SELECT * FROM pvp_rounds WHERE id = ?', [roundId]);
}

function calculateParticipationPercent(playerContribution, totalPool) {
    if (!totalPool || totalPool <= 0) return 0;
    return parseFloat((playerContribution / totalPool * 100).toFixed(2));
}

async function getLivePoolTotals(roundId) {
    const totals = await get(`
        SELECT COALESCE(SUM(CASE WHEN bet_currency = 'TON' THEN bet_amount ELSE 0 END), 0) AS pool_ton,
               COALESCE(SUM(CASE WHEN bet_currency = 'GIFT' THEN bet_amount ELSE 0 END), 0) AS pool_gift
        FROM pvp_participants WHERE pvp_round_id = ? AND status = 'ACTIVE'
    `, [roundId]);
    return { poolTon: totals.pool_ton || 0, poolGift: totals.pool_gift || 0 };
}

async function joinPvpRound(userId, betCurrency, betAmount, giftUniqueId) {
    return await transaction(async () => {
        const activeRound = await getPvpActiveRound();
        if (!activeRound) throw new Error('No active PvP round to join');
        if (activeRound.phase === 'LIVE' || activeRound.phase === 'RESULT') throw new Error('Round already started');

        const playerCount = await get('SELECT COUNT(*) as cnt FROM pvp_participants WHERE pvp_round_id = ? AND status = \'ACTIVE\'', [activeRound.id]);
        if (playerCount.cnt >= MAX_PVP_PLAYERS) throw new Error('PvP round is full');

        const existing = await get('SELECT * FROM pvp_participants WHERE pvp_round_id = ? AND user_id = ?', [activeRound.id, userId]);
        let actualBetAmount = betAmount;
        let giftToLock = null;

        if (betCurrency === 'TON') {
            if (!Number.isFinite(betAmount) || betAmount < 0.1) throw new Error('Invalid TON bet amount (min 0.1)');
            // Before the round goes LIVE, allow the same player to top up their
            // existing TON entry. The added amount is charged once and merged
            // into the original participant row, never creating a second entry.
            if (existing && existing.status === 'ACTIVE') {
                if (existing.bet_currency !== 'TON') {
                    throw new Error('You already joined this round with a gift; you cannot change its bet type');
                }
                const balance = await getUserBalance(userId);
                if (balance < betAmount) throw new Error('Insufficient TON balance');
                const debit = await run('UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?', [betAmount, userId, betAmount]);
                if (debit.changes !== 1) throw new Error('Insufficient balance');
                const newAmount = Number(existing.bet_amount || 0) + betAmount;
                const { poolTon, poolGift } = await getLivePoolTotals(activeRound.id);
                const totalPool = poolTon + poolGift + betAmount;
                const percent = calculateParticipationPercent(newAmount, totalPool);
                await run('UPDATE pvp_participants SET bet_amount = ?, participation_percent = ? WHERE id = ? AND status = ?', [newAmount, percent, existing.id, 'ACTIVE']);
                await run(`
                    UPDATE pvp_participants
                    SET participation_percent = (bet_amount * 100.0) / NULLIF(?, 0)
                    WHERE pvp_round_id = ? AND status = 'ACTIVE'
                `, [totalPool, activeRound.id]);
                const totalsAfter = await getLivePoolTotals(activeRound.id);
                return {
                    roundId: activeRound.id,
                    roundNumber: activeRound.round_number,
                    playerCount: playerCount.cnt,
                    maxPlayers: MAX_PVP_PLAYERS,
                    participationPercent: percent,
                    betAmount: newAmount,
                    addedBetAmount: betAmount,
                    betCurrency: 'TON',
                    poolTon: totalsAfter.poolTon,
                    poolGift: totalsAfter.poolGift,
                    toppedUp: true
                };
            }
            const balance = await getUserBalance(userId);
            if (balance < betAmount) throw new Error('Insufficient TON balance');
            const update = await run('UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?', [betAmount, userId, betAmount]);
            if (update.changes !== 1) throw new Error('Insufficient balance');
        } else if (betCurrency === 'GIFT') {
            if (existing && existing.status === 'ACTIVE') throw new Error('You already joined this round');
            if (!giftUniqueId) throw new Error('Gift collectible ID required');
            const collectible = await getCollectibleByUniqueId(giftUniqueId);
            if (!collectible) throw new Error('Collectible not found');
            if (collectible.user_id !== userId) throw new Error('Not your collectible');
            if (collectible.ownership_status !== 'OWNED') throw new Error('Collectible not available');
            actualBetAmount = Number(collectible.collectible_market_value ?? collectible.value ?? 0);
            if (actualBetAmount <= 0) throw new Error('Collectible has no value');
            const update = await run('UPDATE user_gifts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE unique_collectible_id = ? AND status = ?', ['IN_BET', giftUniqueId, 'OWNED']);
            if (update.changes !== 1) throw new Error('Could not lock collectible');
            const verifyLock = await get('SELECT status FROM user_gifts WHERE unique_collectible_id = ?', [giftUniqueId]);
            if (verifyLock.status !== 'IN_BET') throw new Error('Could not lock collectible');
            giftToLock = giftUniqueId;
        } else {
            throw new Error('Invalid bet currency');
        }

        const { poolTon, poolGift } = await getLivePoolTotals(activeRound.id);
        const totalPool = poolTon + poolGift + actualBetAmount;
        const percent = calculateParticipationPercent(actualBetAmount, totalPool);

        await run(`
            INSERT INTO pvp_participants
            (pvp_round_id, user_id, bet_currency, bet_amount, gift_unique_id,
             participation_percent, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', CURRENT_TIMESTAMP)
        `, [activeRound.id, userId, betCurrency, actualBetAmount, giftToLock, percent]);

        return {
            roundId: activeRound.id,
            roundNumber: activeRound.round_number,
            playerCount: playerCount.cnt + 1,
            maxPlayers: MAX_PVP_PLAYERS,
            participationPercent: percent,
            betAmount: actualBetAmount,
            betCurrency: betCurrency,
            poolTon: poolTon + actualBetAmount,
            poolGift: poolGift
        };
    });
}

async function cashoutPvpBet(participantId, userId) {
    return await transaction(async () => {
        const participant = await get(`
            SELECT * FROM pvp_participants
            WHERE id = ? AND user_id = ? AND status = 'ACTIVE'
        `, [participantId, userId]);
        if (!participant) throw new Error('Active PvP bet not found');

        return { participantId: participant.id };
    });
}

function derivePvpWinnerIndex(serverSeed, roundNumber, participants) {
    if (!participants.length) return -1;
    const message = `my-rocket-pvp-v1:${roundNumber}:winner`;
    const digest = crypto.createHmac('sha256', serverSeed).update(message, 'utf8').digest();
    const value = Number((digest.readBigUInt64BE(0) >> 12n)) / (2 ** 52);
    const totalWeight = participants.reduce((sum, p) => sum + Math.max(0, Number(p.bet_amount) || 0), 0);
    if (!(totalWeight > 0)) return 0;
    let cursor = value * totalWeight;
    for (let i = 0; i < participants.length; i++) {
        cursor -= Math.max(0, Number(participants[i].bet_amount) || 0);
        if (cursor < 0) return i;
    }
    return participants.length - 1;
}

async function settlePvpRound(roundId) {
    return await transaction(async () => {
        const round = await get('SELECT * FROM pvp_rounds WHERE id = ? AND phase = \'LIVE\'', [roundId]);
        if (!round) throw new Error('Round not in LIVE state');

        const participants = await query(`
            SELECT p.*, u.first_name, u.last_name, u.telegram_id,
                   ug.id AS user_gift_id, ug.gift_id AS locked_gift_id,
                   g.name AS gift_name, g.image_url AS gift_image_url
            FROM pvp_participants p
            JOIN users u ON u.id = p.user_id
            LEFT JOIN user_gifts ug ON ug.unique_collectible_id = p.gift_unique_id
            LEFT JOIN gifts g ON g.id = ug.gift_id
            WHERE p.pvp_round_id = ? AND p.status = 'ACTIVE'
            ORDER BY p.id ASC
        `, [roundId]);

        if (participants.length === 0) {
            await run('UPDATE pvp_rounds SET phase = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?', ['RESULT', roundId]);
            return { roundId, winnerUserId: null, totalPool: 0, poolTon: 0, poolGift: 0, winnerPayout: 0 };
        }

        const totalPool = participants.reduce((sum, p) => sum + Number(p.bet_amount || 0), 0);
        const poolTon = participants
            .filter(p => p.bet_currency === 'TON')
            .reduce((sum, p) => sum + Number(p.bet_amount || 0), 0);
        const poolGift = participants
            .filter(p => p.bet_currency === 'GIFT')
            .reduce((sum, p) => sum + Number(p.bet_amount || 0), 0);

        const winnerIndex = derivePvpWinnerIndex(round.server_seed, round.round_number, participants);
        const winner = participants[winnerIndex];
        const winnerPercent = calculateParticipationPercent(winner.bet_amount, totalPool);

        await run(
            'UPDATE pvp_participants SET status = ?, payout = ?, cashout_multiplier = ? WHERE id = ?',
            ['WON', totalPool, 1, winner.id]
        );
        await run(
            'UPDATE pvp_participants SET status = ?, payout = 0 WHERE pvp_round_id = ? AND id != ? AND status = ?',
            ['LOST', roundId, winner.id, 'ACTIVE']
        );

        if (poolTon > 0) {
            await run(
                'UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [poolTon, winner.user_id]
            );
        }

        const giftParticipants = participants.filter(p => p.bet_currency === 'GIFT' && p.gift_unique_id);
        for (const participant of giftParticipants) {
            const gift = await get(
                'SELECT * FROM user_gifts WHERE unique_collectible_id = ? AND status = ?',
                [participant.gift_unique_id, 'IN_BET']
            );
            if (!gift) continue;

            await run(
                'UPDATE user_gifts SET user_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE unique_collectible_id = ? AND status = ?',
                [winner.user_id, 'OWNED', participant.gift_unique_id, 'IN_BET']
            );

            await run(
                `INSERT INTO pvp_rewards
                 (pvp_round_id, winner_user_id, reward_gift_unique_id, reward_value, claimed, created_at)
                 VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
                [roundId, winner.user_id, participant.gift_unique_id, Number(participant.bet_amount || 0)]
            );
        }

        await run(
            `UPDATE pvp_rounds
             SET phase = ?, winner_user_id = ?, winner_multiplier = ?, pool_ton = ?, pool_gift_value = ?, ended_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            ['RESULT', winner.user_id, winnerPercent, poolTon, poolGift, roundId]
        );

        return {
            roundId,
            winnerUserId: winner.user_id,
            winnerName: [winner.first_name, winner.last_name].filter(Boolean).join(' ').trim() || 'Unknown',
            winnerParticipationPercent: winnerPercent,
            totalPool,
            poolTon,
            poolGift,
            winnerPayout: totalPool,
            serverSeed: round.server_seed,
            serverSeedHash: round.server_seed_hash
        };
    });
}

// Backwards-compatible name for older callers/tests. PvP is now a weighted pot, not a crash game.
async function crashPvpRound(roundId) {
    return settlePvpRound(roundId);
}

async function getPvpRoundWithParticipants(roundId) {
    const round = await get('SELECT * FROM pvp_rounds WHERE id = ?', [roundId]);
    if (!round) return null;
    const participants = await query(`
        SELECT p.*, u.first_name, u.last_name, u.username, u.telegram_id, u.avatar_url,
               g.name AS gift_name, g.image_url AS gift_image_url
        FROM pvp_participants p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN user_gifts ug ON ug.unique_collectible_id = p.gift_unique_id
        LEFT JOIN gifts g ON g.id = ug.gift_id
        WHERE p.pvp_round_id = ?
        ORDER BY p.bet_amount DESC, p.id ASC
    `, [roundId]);
    return { round, participants };
}

async function getLastPvpRoundNumber() {
    const row = await get('SELECT MAX(round_number) as max FROM pvp_rounds');
    return row.max ? row.max : 0;
}

module.exports = {
    // اتصال قاعدة البيانات
    db,
    
    // دوال مساعدة
    query,
    get,
    run,
    transaction,
    
    // تهيئة قاعدة البيانات
    initDatabase,
    seedDatabase,
    
     // إدارة المستخدمين
     findOrCreateUser,
     attachReferralToUser,
     getReferralOverview,
     getUserBalance,
     updateUserBalance,
     getUserTestBalance,
     setTestBalance,
     resetTestBalance,
     getUserTestBalanceRaw,
    createRoundRecord,
    getRoundByNumber,
    updateRoundState,
    getActiveBetsForRound,
    getRoundPlayers,
    getQueuedTonBetsForRound,
    queueTonBet,
    cancelQueuedTonBet,
    promoteQueuedTonBets,
    queueGiftBet,
    cancelQueuedGiftBet,
    promoteQueuedGiftBets,
    getQueuedGiftBetsForRound,
    cashoutBet,
    addRocketRewardGiftToUser,
    crashRound,
    
    // إدارة الهدايا
    getUserGifts,
    getGiftById,
    addGiftToUser,
    addLootBoxGiftToUser,
    sellLootBoxGiftForBalance,
    markGiftAsLootBoxReward,
    isLootBoxGiftLocked,
    updateGiftStatus,

    // أساس ملكية Collectible Gifts الحقيقية
    getUserCollectibles,
    getCollectibleByUniqueId,
    getCollectibleByTelegramInstanceId,
    reserveCollectibleForBet,
    releaseCollectible,
    sellCollectibleForBalance,
    updateCollectibleMarketValue,
    updateUserCollectibleMarketValue,
    createOrGetImportIntent,
    getLatestImportIntentForUser,
    getPendingIntentByTelegramSenderId,
    isCollectibleAlreadyCredited,
    creditVerifiedCollectible,
    savePersistedBusinessConnection,
    getPersistedBusinessConnection,
    hasProcessedWebhookUpdate,
    markWebhookUpdateProcessed,
    migrateUserGiftsConstraint,
    
    // الرهان بالهدايا
    placeGiftBet,
    cashoutGiftBet,
    
    // الرهان بـ TON
    placeTonBet,
    cashoutTonBet,
    
    // صرف الاختبار (TEST BET) — uses test_balance only, never real TON
    placeTestBet,
    cashoutTestBet,
    settleTestBetLoss,
    
    // الصناديق
    openLootbox,
    
    // المخزون والسحب
    selectRewardFromInventory,
    consumeInventoryReward,
    selectRewardGiftType,
    createPendingGiftReward,
    reservePendingGiftForWithdrawal,
    attachPendingGiftCollectible,
    rollbackPendingGiftWithdrawal,
    getInventoryCollectibles,
    addCollectibleToInventory,
    reserveCollectibleForWithdrawal,
    confirmGiftWithdrawal,
    rollbackGiftWithdrawal,
    getGiftTransactions,
    getPendingPayouts,
    
    // الإيداعات
    createDeposit,
    createWithdrawalRequest,
    markWithdrawalProcessing,
    completeWithdrawal,
    getUserWithdrawals,
    refundFailedWithdrawal,
    saveDepositBoc,
    creditVerifiedDeposit,
    updateDepositStatus,
    
    // الإحصائيات
    updateUserStats,
    getSpenderLeaderboard,
    
    // الإشعارات
    createNotification,
    getNotifications,

    // ألعاب الواجهة الخلفية (Mines, Plinko, Dice)
    generateGameServerSeed,
    hashGameServerSeed,
    deriveGameUniform,
    createMinesGame,
    revealMinesTile,
    cashoutMinesGame,
    createPlinkoGame,
    dropPlinkoChip,
    createDiceGame,
    getMiniGame,
    LOTTERY_GAME_CONFIGS,
    getLotteryConfig,
    createLotteryRound,
    getOpenLotteryRound,
    getLotteryRoundsForUser,
    getLotteryRoundsSummary,
    createLotteryTicket,
    drawLotteryRound,
    createLotteryGame,
    getLotteryPrize,
    getPvpActiveRound,
    createPvpRound,
    startPvpCountdown,
    joinPvpRound,
    cashoutPvpBet,
    crashPvpRound,
    getPvpRoundWithParticipants,
    getLastPvpRoundNumber,
    MAX_PVP_PLAYERS,
    calculateParticipationPercent
};
