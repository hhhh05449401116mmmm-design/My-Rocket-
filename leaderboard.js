// =========================================================
// leaderboard.js - Weekly activity leaderboard
// Isolated from Crash, betting settlement, reward probabilities, FREE/FREE24,
// and the core game loop.
// =========================================================

const {
    query,
    get,
    run,
    transaction
} = require('./database');

const CYCLE_MS = 7 * 24 * 60 * 60 * 1000;
const LEADERBOARD_LIMIT = 200;

const PRIZES = [
    { minRank: 1, maxRank: 1, name: "Durov's Cap" },
    { minRank: 2, maxRank: 2, name: "Precious Peach" },
    { minRank: 3, maxRank: 3, name: "Scared Cat" },
    { minRank: 4, maxRank: 5, name: "Gem Signet" },
    { minRank: 6, maxRank: 10, name: "Vintage Cigar" },
    { minRank: 11, maxRank: 50, name: "Electric Skull" },
    { minRank: 51, maxRank: 100, name: "Pretty Posy" },
    { minRank: 101, maxRank: 200, name: "Ice Cream" }
];

const schemaSql = [
    `CREATE TABLE IF NOT EXISTS leaderboard_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at DATETIME NOT NULL,
        ends_at DATETIME NOT NULL,
        settled_at DATETIME,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'SETTLED'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_leaderboard_cycles_status
        ON leaderboard_cycles(status)`,
    `CREATE TABLE IF NOT EXISTS leaderboard_winners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        points REAL NOT NULL,
        gift_name TEXT NOT NULL,
        user_gift_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (cycle_id) REFERENCES leaderboard_cycles(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (user_gift_id) REFERENCES user_gifts(id) ON DELETE SET NULL,
        UNIQUE(cycle_id, rank)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_leaderboard_winners_cycle
        ON leaderboard_winners(cycle_id, rank)`
];

let schemaReady = false;
let cycleLock = Promise.resolve();

function toSqlDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function prizeForRank(rank) {
    const numericRank = Number(rank);
    return PRIZES.find(prize => numericRank >= prize.minRank && numericRank <= prize.maxRank) || null;
}

const PRIZE_IMAGE_URLS = {
    "Durov's Cap": 'https://tg.me/api/media/gift-art/durovscap/thumb.webp',
    "Precious Peach": 'https://tg.me/api/media/gift-art/preciouspeach/thumb.webp',
    "Scared Cat": 'https://tg.me/api/media/gift-art/scaredcat/thumb.webp',
    "Gem Signet": 'https://tg.me/api/media/gift-art/gemsignet/thumb.webp',
    "Vintage Cigar": 'https://tg.me/api/media/gift-art/vintagecigar/thumb.webp',
    "Electric Skull": 'https://tg.me/api/media/gift-art/electricskull/thumb.webp',
    "Pretty Posy": 'https://tg.me/api/media/gift-art/prettyposy/thumb.webp',
    "Ice Cream": 'https://tg.me/api/media/gift-art/icecream/thumb.webp'
};

function prizeImage(name) {
    return PRIZE_IMAGE_URLS[String(name || '')] || '';
}

async function ensureSchema() {
    if (schemaReady) return;
    for (const sql of schemaSql) await run(sql);
    schemaReady = true;
}

async function ensurePrizeGift(name) {
    let gift = await get(
        'SELECT * FROM gifts WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY id ASC LIMIT 1',
        [name]
    );
    if (gift) {
        if (!gift.image_url) {
            await run(
                'UPDATE gifts SET image_url = ? WHERE id = ?',
                [prizeImage(name), gift.id]
            );
            gift = await get('SELECT * FROM gifts WHERE id = ?', [gift.id]);
        }
        return gift;
    }

    const slug = 'leaderboard-' + String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

    await run(
        `INSERT OR IGNORE INTO gifts
         (telegram_gift_id, name, slug, emoji, image_url, collection, rarity, value, total_supply)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            'leaderboard:' + slug,
            name,
            slug,
            '🎁',
            prizeImage(name),
            'LEADERBOARD',
            'legendary',
            0,
            0
        ]
    );

    return await get(
        'SELECT * FROM gifts WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY id ASC LIMIT 1',
        [name]
    );
}

function scoreCte(startAt, endAt) {
    return {
        sql: `
            WITH activity AS (
                SELECT user_id, (amount * 20.0) AS points
                FROM deposits
                WHERE status IN ('CONFIRMED', 'CREDITED')
                  AND created_at >= ?
                  AND created_at < ?

                UNION ALL

                SELECT user_id, (amount * 10.0 + 2.0) AS points
                FROM ton_bets
                WHERE bet_currency = 'TON'
                  AND created_at >= ?
                  AND created_at < ?

                UNION ALL

                SELECT user_id, (gift_value_at_bet * 10.0 + 2.0) AS points
                FROM gift_bets
                WHERE created_at >= ?
                  AND created_at < ?

                UNION ALL

                SELECT user_id, (bet_amount * 8.0 + 5.0) AS points
                FROM mini_games
                WHERE bet_currency IN ('TON', 'GIFT')
                  AND created_at >= ?
                  AND created_at < ?

                UNION ALL

                SELECT user_id, (bet_amount * 8.0 + 5.0) AS points
                FROM pvp_participants
                WHERE created_at >= ?
                  AND created_at < ?

                UNION ALL

                SELECT user_id, 10.0 AS points
                FROM lootbox_history
                WHERE status = 'OPENED'
                  AND created_at >= ?
                  AND created_at < ?

                UNION ALL

                SELECT referred_by_user_id AS user_id, 100.0 AS points
                FROM users
                WHERE referred_by_user_id IS NOT NULL
                  AND created_at >= ?
                  AND created_at < ?

                UNION ALL

                SELECT inviter_user_id AS user_id, (amount * 5.0) AS points
                FROM referral_rewards
                WHERE created_at >= ?
                  AND created_at < ?
            ),
            scores AS (
                SELECT
                    u.id,
                    u.first_name,
                    u.last_name,
                    u.username,
                    u.avatar_url,
                    ROUND(SUM(a.points), 2) AS points
                FROM activity a
                JOIN users u ON u.id = a.user_id
                GROUP BY u.id
                HAVING SUM(a.points) > 0
            )
        `,
        params: [
            startAt, endAt,
            startAt, endAt,
            startAt, endAt,
            startAt, endAt,
            startAt, endAt,
            startAt, endAt,
            startAt, endAt,
            startAt, endAt
        ]
    };
}

async function getActiveCycle() {
    return await get(
        "SELECT * FROM leaderboard_cycles WHERE status = 'ACTIVE' ORDER BY id DESC LIMIT 1"
    );
}

async function createCycle(startDate = new Date()) {
    const startAt = toSqlDateTime(startDate);
    const endAt = toSqlDateTime(new Date(startDate.getTime() + CYCLE_MS));
    const result = await run(
        `INSERT INTO leaderboard_cycles (started_at, ends_at, status)
         VALUES (?, ?, 'ACTIVE')`,
        [startAt, endAt]
    );
    return await get('SELECT * FROM leaderboard_cycles WHERE id = ?', [result.lastID]);
}

async function settleCycle(cycle) {
    const existing = await get(
        'SELECT id FROM leaderboard_cycles WHERE id = ? AND status = \'SETTLED\'',
        [cycle.id]
    );
    if (existing) return;

    const { sql, params } = scoreCte(cycle.started_at, cycle.ends_at);
    const rows = await query(
        sql + `
            SELECT id, first_name, last_name, username, avatar_url, points
            FROM scores
            ORDER BY points DESC, id ASC
            LIMIT ?
        `,
        [...params, LEADERBOARD_LIMIT]
    );

    await transaction(async () => {
        const lockedCycle = await get('SELECT * FROM leaderboard_cycles WHERE id = ?', [cycle.id]);
        if (!lockedCycle || lockedCycle.status !== 'ACTIVE') return;

        for (let index = 0; index < rows.length; index += 1) {
            const player = rows[index];
            const rank = index + 1;
            const prize = prizeForRank(rank);
            if (!prize) continue;

            const alreadyAwarded = await get(
                'SELECT id FROM leaderboard_winners WHERE cycle_id = ? AND rank = ?',
                [cycle.id, rank]
            );
            if (alreadyAwarded) continue;

            const gift = await ensurePrizeGift(prize.name);
            if (!gift) throw new Error('Leaderboard prize gift is unavailable: ' + prize.name);

            const insertedGift = await run(
                `INSERT INTO user_gifts
                 (user_id, gift_id, status, ownership_verified, market_value)
                 VALUES (?, ?, 'WON', 0, ?)`,
                [player.id, gift.id, Number(gift.value || 0)]
            );

            await run(
                `INSERT INTO leaderboard_winners
                 (cycle_id, user_id, rank, points, gift_name, user_gift_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [cycle.id, player.id, rank, Number(player.points || 0), prize.name, insertedGift.lastID]
            );
        }

        await run(
            `UPDATE leaderboard_cycles
             SET status = 'SETTLED', settled_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'ACTIVE'`,
            [cycle.id]
        );
    });

    return await get('SELECT * FROM leaderboard_cycles WHERE id = ?', [cycle.id]);
}

async function ensureCurrentCycle() {
    await ensureSchema();

    let cycle = await getActiveCycle();
    if (!cycle) return await createCycle();

    const endMs = new Date(String(cycle.ends_at).replace(' ', 'T') + 'Z').getTime();
    if (!Number.isFinite(endMs) || endMs > Date.now()) return cycle;

    await settleCycle(cycle);
    cycle = await getActiveCycle();
    return cycle || await createCycle();
}

async function withCycleLock(task) {
    const previous = cycleLock;
    let release;
    cycleLock = new Promise(resolve => { release = resolve; });
    await previous;
    try {
        return await task();
    } finally {
        release();
    }
}

async function settleExpiredLeaderboardCycle() {
    return await withCycleLock(async () => {
        await ensureSchema();
        const cycle = await getActiveCycle();
        if (!cycle) return await createCycle();

        const endMs = new Date(String(cycle.ends_at).replace(' ', 'T') + 'Z').getTime();
        if (!Number.isFinite(endMs) || endMs > Date.now()) return cycle;

        await settleCycle(cycle);
        return await getActiveCycle() || await createCycle();
    });
}

async function getWeeklyLeaderboard(userId = null) {
    return await withCycleLock(async () => {
        const cycle = await ensureCurrentCycle();
        const { sql, params } = scoreCte(cycle.started_at, cycle.ends_at);

        const rows = await query(
            sql + `
                SELECT id, first_name, last_name, username, avatar_url, points
                FROM scores
                ORDER BY points DESC, id ASC
                LIMIT ?
            `,
            [...params, LEADERBOARD_LIMIT]
        );

        const countRow = await get(
            sql + ' SELECT COUNT(*) AS count FROM scores',
            params
        );

        let me = null;
        if (userId != null) {
            me = await get(
                sql + `
                    SELECT id, first_name, last_name, username, avatar_url, points,
                           (SELECT COUNT(*) + 1 FROM scores s2
                            WHERE s2.points > scores.points
                               OR (s2.points = scores.points AND s2.id < scores.id)) AS rank
                    FROM scores
                    WHERE id = ?
                `,
                [...params, userId]
            );
        }

        const players = rows.map((row, index) => {
            const rank = index + 1;
            const prize = prizeForRank(rank);
            return {
                id: row.id,
                rank,
                firstName: row.first_name,
                lastName: row.last_name,
                username: row.username,
                avatar: row.avatar_url,
                points: Number(row.points || 0),
                prize: prize ? {
                    name: prize.name,
                    image: prizeImage(prize.name)
                } : null
            };
        });

        return {
            cycle: {
                id: cycle.id,
                startedAt: new Date(String(cycle.started_at).replace(' ', 'T') + 'Z').toISOString(),
                endsAt: new Date(String(cycle.ends_at).replace(' ', 'T') + 'Z').toISOString(),
                durationDays: 7
            },
            players,
            participantCount: Number(countRow?.count || 0),
            prizeCount: LEADERBOARD_LIMIT,
            me: me ? {
                id: me.id,
                rank: Number(me.rank || 1),
                firstName: me.first_name,
                lastName: me.last_name,
                username: me.username,
                avatar: me.avatar_url,
                points: Number(me.points || 0),
                prize: prizeForRank(Number(me.rank || 0)) ? {
                    name: prizeForRank(Number(me.rank || 0)).name,
                    image: prizeImage(prizeForRank(Number(me.rank || 0)).name)
                } : null
            } : null
        };
    });
}

function startLeaderboardCycleWorker() {
    if (startLeaderboardCycleWorker.timer) return;
    startLeaderboardCycleWorker.timer = setInterval(() => {
        settleExpiredLeaderboardCycle().catch(error => {
            console.error('Leaderboard cycle worker error:', error.message);
        });
    }, 60 * 1000);
    if (typeof startLeaderboardCycleWorker.timer.unref === 'function') {
        startLeaderboardCycleWorker.timer.unref();
    }
}

function stopLeaderboardCycleWorker() {
    if (!startLeaderboardCycleWorker.timer) return;
    clearInterval(startLeaderboardCycleWorker.timer);
    startLeaderboardCycleWorker.timer = null;
}

async function initializeLeaderboard() {
    await ensureSchema();
    await ensureCurrentCycle();
}

module.exports = {
    PRIZES,
    LEADERBOARD_LIMIT,
    initializeLeaderboard,
    getWeeklyLeaderboard,
    startLeaderboardCycleWorker,
    stopLeaderboardCycleWorker,
    settleExpiredLeaderboardCycle
};
