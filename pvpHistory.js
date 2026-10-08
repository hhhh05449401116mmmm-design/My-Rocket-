'use strict';
const { query } = require('./database');

async function getPvpHistory(userId, options = {}) {
    const mine = options.scope === 'mine';
    const limit = Math.min(30, Math.max(1, Math.floor(Number(options.limit) || 20)));
    const before = Math.max(0, Math.floor(Number(options.before) || 0));
    const params = [];
    let filter = "r.phase = 'RESULT' AND r.winner_user_id IS NOT NULL";
    if (mine) {
        filter += ' AND EXISTS (SELECT 1 FROM pvp_participants mine WHERE mine.pvp_round_id = r.id AND mine.user_id = ?)';
        params.push(userId);
    }
    if (before) { filter += ' AND r.round_number < ?'; params.push(before); }
    params.push(limit + 1);
    const rows = await query(`
        SELECT r.id, r.round_number, r.ended_at, r.pool_ton, r.pool_gift_value,
               r.winner_user_id, r.winner_multiplier,
               u.username, u.first_name, u.last_name, u.avatar_url,
               (SELECT COUNT(DISTINCT p.user_id) FROM pvp_participants p WHERE p.pvp_round_id = r.id) AS player_count
        FROM pvp_rounds r
        LEFT JOIN users u ON u.id = r.winner_user_id
        WHERE ${filter}
        ORDER BY r.round_number DESC LIMIT ?
    `, params);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const bets = selected.length ? await query(`
        SELECT p.pvp_round_id, p.bet_currency, p.bet_amount, p.gift_unique_id,
               g.name AS gift_name, g.image_url AS gift_image
        FROM pvp_participants p
        LEFT JOIN user_gifts ug ON ug.unique_collectible_id = p.gift_unique_id
        LEFT JOIN gifts g ON g.id = ug.gift_id
        WHERE p.pvp_round_id IN (${selected.map(() => '?').join(',')})
        ORDER BY p.id ASC
    `, selected.map(r => r.id)) : [];
    return {
        rounds: selected.map(r => ({
            roundId: r.id,
            roundNumber: r.round_number,
            endedAt: r.ended_at,
            playerCount: Number(r.player_count || 0),
            poolTon: Number(r.pool_ton || 0),
            poolGift: Number(r.pool_gift_value || 0),
            totalPool: Number(r.pool_ton || 0) + Number(r.pool_gift_value || 0),
            winner: {
                userId: r.winner_user_id,
                username: r.username || null,
                name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.username || 'Player',
                avatar: r.avatar_url || null,
                chance: Number(r.winner_multiplier || 0)
            },
            gifts: bets.filter(b => b.pvp_round_id === r.id && b.bet_currency === 'GIFT').map(b => ({
                uniqueId: b.gift_unique_id,
                name: b.gift_name || 'Gift',
                image: b.gift_image || '/assets/gift-icon.svg',
                value: Number(b.bet_amount || 0)
            }))
        })),
        hasMore,
        nextBefore: hasMore && selected.length ? selected[selected.length - 1].round_number : null
    };
}
module.exports = { getPvpHistory };
