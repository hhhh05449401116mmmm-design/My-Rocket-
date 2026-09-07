// =========================================================
// database.js - نظام إدارة قاعدة البيانات المتكامل
// =========================================================

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

// =========================================================
// 1. إنشاء اتصال قاعدة البيانات
// =========================================================
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'rocket.db');
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
                    total_turnover REAL DEFAULT 0,
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
                    FOREIGN KEY (gift_id) REFERENCES gifts(id) ON DELETE CASCADE,
                    UNIQUE(user_id, gift_id)
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
                    status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'CASHED_OUT', 'LOST')),
                    cashout_multiplier REAL,
                    payout REAL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

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
                    type TEXT CHECK(type IN ('GIFT_WON', 'GIFT_LOST', 'BET_WON', 'BET_LOST', 'DEPOSIT', 'ACHIEVEMENT')),
                    message TEXT NOT NULL,
                    data TEXT,
                    is_read INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

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

            db.run('SELECT 1', error => {
                if (error) reject(error);
                else {
                    console.log('✅ All database tables created/verified');
                    resolve();
                }
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
                { id: 'hot', name: 'HOT', emoji: '🔥', rarity: 'rare', value: 1.98, collection: 'Trending' }
            ];

            gifts.forEach(g => {
                db.run(`
                    INSERT OR IGNORE INTO gifts 
                    (telegram_gift_id, name, emoji, rarity, value, collection)
                    VALUES (?, ?, ?, ?, ?, ?)
                `, [g.id, g.name, g.emoji, g.rarity, g.value, g.collection || null]);
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

            console.log('✅ Seed data inserted');
            resolve();
        });
    });
}

// =========================================================
// 5. دوال الأعمال (Business Logic)
// =========================================================

// ===== 5.1 إدارة المستخدمين =====
async function findOrCreateUser(telegramId, userData = {}) {
    let user = await get('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
    
    if (!user) {
        const result = await run(`
            INSERT INTO users (telegram_id, username, first_name, last_name, avatar_url)
            VALUES (?, ?, ?, ?, ?)
        `, [telegramId, userData.username, userData.first_name, userData.last_name, userData.avatar_url]);
        
        user = await get('SELECT * FROM users WHERE id = ?', [result.lastID]);
        
        // إنشاء إحصائيات للمستخدم الجديد
        await run(`
            INSERT INTO user_stats (user_id) VALUES (?)
        `, [result.lastID]);
    }
    
    return user;
}

async function getUserBalance(userId) {
    const user = await get('SELECT balance FROM users WHERE id = ?', [userId]);
    return user ? user.balance : 0;
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

async function cashoutBet(type, betId, userId, roundNumber, multiplier) {
    const config = type === 'TON'
        ? { table: 'ton_bets', amountColumn: 'amount', payoutColumn: 'payout' }
        : type === 'GIFT'
            ? { table: 'gift_bets', amountColumn: 'gift_value_at_bet', payoutColumn: 'payout' }
            : null;
    if (!config) throw new Error('Invalid bet type');
    if (!Number.isFinite(multiplier) || multiplier <= 1) {
        throw new Error('Cashout must be above 1.00x');
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
        const update = await run(`
            UPDATE ${config.table}
            SET status = 'CASHED_OUT', cashout_multiplier = ?, ${config.payoutColumn} = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'ACTIVE'
        `, [multiplier, payout, betId]);
        if (update.changes !== 1) throw new Error('Bet was settled concurrently');

        if (type === 'TON') {
            await run('UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [payout, userId]);
        } else {
            await run(`UPDATE user_gifts SET status = 'WON', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [bet.user_gift_id]);
        }

        await updateUserStats(userId, 'win', payout);
        return {
            payout,
            multiplier,
            amount: bet[config.amountColumn],
            giftValue: type === 'GIFT' ? bet.gift_value_at_bet : undefined
        };
    });
}

async function crashRound(roundNumber, multiplier) {
    return await transaction(async () => {
        const round = await getRoundByNumber(roundNumber);
        if (!round || round.phase === 'CRASH') return { settled: false, alreadySettled: true };

        const giftBets = await query(`
            SELECT user_gift_id FROM gift_bets
            WHERE round_id = ? AND status = 'ACTIVE'
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
            await run(`
                UPDATE user_gifts SET status = 'LOST', updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'IN_BET'
            `, [bet.user_gift_id]);
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
        SELECT g.*, ug.id as user_gift_id, ug.status as ownership_status, ug.received_at
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

async function updateGiftStatus(userGiftId, status) {
    const validStatuses = ['OWNED', 'LOCKED', 'IN_BET', 'WON', 'LOST', 'SENT', 'SOLD'];
    if (!validStatuses.includes(status)) throw new Error('Invalid status');
    
    await run('UPDATE user_gifts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, userGiftId]);
    return await get('SELECT * FROM user_gifts WHERE id = ?', [userGiftId]);
}

// ===== 5.3 نظام الرهان بالهدايا =====
async function placeGiftBet(userId, giftId, roundId, autoCashoutTarget = null) {
    const normalizedAutoCashoutTarget = normalizeAutoCashoutTarget(autoCashoutTarget);
    return await transaction(async () => {
        const round = await getRoundByNumber(roundId);
        if (!round || round.phase !== 'COUNTDOWN') throw new Error('Betting is closed for this round');

        // The client supplies only an identifier; value always comes from gifts.
        const gift = await getGiftById(giftId);
        if (!gift) throw new Error('Gift not found');

        // 1. التحقق من ملكية الهدية
        const userGift = await get(`
            SELECT * FROM user_gifts 
            WHERE user_id = ? AND gift_id = ? AND status = 'OWNED'
        `, [userId, gift.id]);
        
        if (!userGift) throw new Error('Gift not owned or not available');
        
        // 3. قفل الهدية
        await run(`
            UPDATE user_gifts 
            SET status = 'IN_BET', updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `, [userGift.id]);
        
        // 4. إنشاء سجل الرهان
        const result = await run(`
            INSERT INTO gift_bets 
            (user_id, user_gift_id, round_id, gift_value_at_bet, auto_cashout_target)
            VALUES (?, ?, ?, ?, ?)
        `, [userId, userGift.id, roundId, gift.value, normalizedAutoCashoutTarget]);
        
        return {
            betId: result.lastID,
            userGiftId: userGift.id,
            giftName: gift.name,
            giftValue: gift.value,
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

// ===== 5.4 نظام الرهان بـ TON =====
async function placeTonBet(userId, amount, roundId, autoCashoutTarget = null) {
    const normalizedAmount = Number(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
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
        
        return {
            betId: result.lastID,
            amount: normalizedAmount,
            roundId: roundId
        };
    });
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

// ===== 5.5 نظام الصناديق =====
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
        }

        return await get('SELECT * FROM deposits WHERE id = ?', [depositId]);
    });
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
    getUserBalance,
    updateUserBalance,
    createRoundRecord,
    getRoundByNumber,
    updateRoundState,
    getActiveBetsForRound,
    cashoutBet,
    crashRound,
    
    // إدارة الهدايا
    getUserGifts,
    getGiftById,
    addGiftToUser,
    updateGiftStatus,
    
    // الرهان بالهدايا
    placeGiftBet,
    cashoutGiftBet,
    
    // الرهان بـ TON
    placeTonBet,
    cashoutTonBet,
    
    // الصناديق
    openLootbox,
    
    // الإيداعات
    createDeposit,
    saveDepositBoc,
    creditVerifiedDeposit,
    updateDepositStatus,
    
    // الإحصائيات
    updateUserStats,
    
    // الإشعارات
    createNotification,
    getNotifications
};
