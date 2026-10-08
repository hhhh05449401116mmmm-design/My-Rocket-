'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocket-pvp-api-'));
process.env.DATABASE_PATH = path.join(dir, 'api.sqlite');
require('../test-helpers/no-network');
const database = require('../database');
const { app, getPvpStateSnapshot } = require('../server');
let listener, url, user, gift, round;
test.before(async () => {
  await database.initDatabase(); await database.seedDatabase();
  user = await database.findOrCreateUser('pvp-api-test-user');
  await database.updateUserBalance(user.id, 100, 'add');
  gift = await database.get('SELECT * FROM gifts WHERE value > 0 LIMIT 1');
  round = await database.createPvpRound(9876); await database.startPvpCountdown(round.id);
  for (const [id, verified, status] of [['api-owned', 1, 'OWNED'], ['api-unverified', 0, 'OWNED'], ['api-locked', 1, 'LOCKED']]) {
    await database.run(`INSERT INTO user_gifts (user_id,gift_id,status,unique_collectible_id,ownership_verified,market_value,telegram_gift_instance_id) VALUES (?,?,?,?,?,?,?)`, [user.id,gift.id,status,id,verified,7.25,id]);
  }
  listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  url = 'http://127.0.0.1:' + listener.address().port;
});
test.after(async () => {
  listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve));
  await new Promise(resolve => database.db.close(resolve)); fs.rmSync(dir,{recursive:true,force:true});
});
async function request(route, body) {
  const response = await fetch(url + route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+user.id,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
}
test('PvP collectibles expose eligible identity and server market valuation', async () => {
  const result = await request('/api/collectibles');
  assert.equal(result.status,200);
  const owned=result.data.collectibles.find(g=>g.id==='api-owned');
  const locked=result.data.collectibles.find(g=>g.id==='api-locked');
  assert.equal(owned.pvpEligible,true);assert.equal(owned.pvpBetValue,7.25);assert.equal(owned.pvpGiftUniqueId,'api-owned');
  assert.equal(locked.pvpEligible,false);
});
test('PvP HTTP join refuses unverified gifts without reserving them', async () => {
  const result = await request('/api/pvp/join',{betCurrency:'GIFT',betAmount:99,giftUniqueId:'api-unverified'});
  assert.equal(result.status,400);assert.match(result.data.error,/Verified owned/);
  assert.equal((await database.getCollectibleByUniqueId('api-unverified')).ownership_status,'OWNED');
});
test('PvP HTTP accepts eligible gift and uses server valuation', async () => {
  const result = await request('/api/pvp/join',{betCurrency:'GIFT',betAmount:999,giftUniqueId:'api-owned'});
  assert.equal(result.status,200);assert.equal(result.data.betAmount,7.25);
  assert.equal((await database.getCollectibleByUniqueId('api-owned')).ownership_status,'IN_BET');
});
test('PvP state API retains authoritative timing and participants contract', async () => {
  const result=await request('/api/pvp/state');
  assert.equal(result.status,200);assert.ok(Array.isArray(result.data.state.participants));
  assert.ok(Object.hasOwn(result.data.state,'countdownEndsAt'));
  assert.ok(Number.isFinite(result.data.state.serverTime));
  assert.equal(getPvpStateSnapshot().serverSeed,null);
});
