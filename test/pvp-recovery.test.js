'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-recovery-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
require('../test-helpers/no-network');
const database = require('../database');
const { restoreOrStartPvpRound, getPvpStateSnapshot, stopPvpGameLoop } = require('../server');
test.before(async () => { await database.initDatabase(); await database.seedDatabase(); });
test.after(async () => { await new Promise(resolve => database.db.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
test.beforeEach(async () => {
  stopPvpGameLoop();
  await database.run("UPDATE pvp_rounds SET phase='RESULT', ended_at='2000-01-01 00:00:00' WHERE phase IN ('WAITING','COUNTDOWN','LIVE','RESULT')");
});

test('PvP recovery keeps an existing COUNTDOWN and its balances/participants/deadline', async () => {
  const user = await database.findOrCreateUser('recovery-player');
  await database.updateUserBalance(user.id, 100, 'add');
  const round = await database.createPvpRound(9001);
  await database.startPvpCountdown(round.id);
  await database.joinPvpRound(user.id, 'TON', 5, null);
  const second = await database.findOrCreateUser('recovery-second'); await database.updateUserBalance(second.id,100,'add'); await database.joinPvpRound(second.id,'TON',1,null);
  const row = await database.get('SELECT * FROM pvp_rounds WHERE id=?', [round.id]);
  const balance = await database.getUserBalance(user.id);
  const count = (await database.get('SELECT COUNT(*) AS n FROM pvp_rounds')).n;
  await restoreOrStartPvpRound();
  const state = getPvpStateSnapshot();
  assert.equal(state.roundId, round.id); assert.equal(state.phase, 'COUNTDOWN');
  assert.equal(state.participants.length, 2); assert.equal(state.totalPool, 6);
  assert.equal(state.countdownEndsAt, Date.parse(row.started_at.replace(' ', 'T')+'Z')+20000);
  assert.equal(await database.getUserBalance(user.id), balance);
  assert.equal((await database.get('SELECT COUNT(*) AS n FROM pvp_rounds')).n, count);
});

test('PvP recovery keeps LIVE gift lock and resumes timing without payout or reseeding', async () => {
  const user = await database.findOrCreateUser('recovery-gift-player');
  const gift = await database.get('SELECT * FROM gifts WHERE value > 0 LIMIT 1');
  const id = 'pvp-recovery-gift';
  await database.run("INSERT INTO user_gifts (user_id,gift_id,status,unique_collectible_id,ownership_verified,market_value,telegram_gift_instance_id) VALUES (?,?,'OWNED',?,1,3.25,?)", [user.id,gift.id,id,id]);
  const round = await database.createPvpRound(9002); await database.startPvpCountdown(round.id);
  await database.joinPvpRound(user.id,'GIFT',999,id);
  const liveStartedAt = Date.now() - 5000;
  await database.run("UPDATE pvp_rounds SET phase='LIVE',started_at=? WHERE id=?",[new Date(liveStartedAt).toISOString(),round.id]);
  await restoreOrStartPvpRound(); const state=getPvpStateSnapshot();
  assert.equal(state.roundId,round.id);assert.equal(state.phase,'LIVE');
  assert.equal(state.liveStartedAt,liveStartedAt);assert.equal(state.winnerUserId,null);
  assert.equal(state.participants.length,1);assert.equal(state.participants[0].giftUniqueId,id);
  assert.equal((await database.getCollectibleByUniqueId(id)).ownership_status,'IN_BET');
  assert.equal((await database.get('SELECT status FROM pvp_participants WHERE pvp_round_id=?',[round.id])).status,'ACTIVE');
});

test('PvP creates an empty real round only when no active round remains', async () => {
  await restoreOrStartPvpRound(); const state=getPvpStateSnapshot();
  assert.equal(state.phase,'WAITING'); assert.equal(state.participants.length,0); assert.equal(state.countdownEndsAt,null);
  assert.equal(state.totalPool,0); assert.equal(state.winnerUserId,null);
  assert.equal((await database.get("SELECT COUNT(*) AS n FROM pvp_participants WHERE pvp_round_id=?",[state.roundId])).n,0);
});


test('PvP recovery preserves a recently settled RESULT without paying twice or dropping the winner', async () => {
  const user=await database.findOrCreateUser('result-recovery-player');
  await database.updateUserBalance(user.id,100,'add');
  const round=await database.createPvpRound(9004);await database.startPvpCountdown(round.id);
  await database.joinPvpRound(user.id,'TON',5,null);
  await database.run("UPDATE pvp_rounds SET phase='LIVE' WHERE id=?",[round.id]);
  const result=await database.crashPvpRound(round.id),balance=await database.getUserBalance(user.id);
  const count=(await database.get('SELECT COUNT(*) AS n FROM pvp_rounds')).n;
  await restoreOrStartPvpRound();const state=getPvpStateSnapshot();
  assert.equal(state.phase,'RESULT');assert.equal(state.roundId,round.id);
  assert.equal(state.winnerUserId,result.winnerUserId);assert.ok(state.resultAt);
  assert.equal(state.participants[0].status,'WON');assert.equal(state.totalPool,5);
  assert.equal(await database.getUserBalance(user.id),balance);
  assert.equal((await database.get('SELECT COUNT(*) AS n FROM pvp_rounds')).n,count);
  stopPvpGameLoop();
});
