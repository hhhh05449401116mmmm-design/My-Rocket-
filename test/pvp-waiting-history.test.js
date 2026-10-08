'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-waiting-history-'));
process.env.DATABASE_PATH = path.join(dir,'db.sqlite');
require('../test-helpers/no-network');
const db = require('../database');
const { app, restoreOrStartPvpRound, triggerPvpCountdown, launchPvpRound, getPvpStateSnapshot, stopPvpGameLoop } = require('../server');
let users, url, listener;
test.before(async () => {
  await db.initDatabase(); await db.seedDatabase();
  users = await Promise.all(['one','two','three'].map(n => db.findOrCreateUser('waiting-test-'+n, {first_name:n,username:n})));
  for (const u of users) await db.updateUserBalance(u.id,100,'add');
  listener = await new Promise(resolve => {const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
  url='http://127.0.0.1:'+listener.address().port;
});
test.beforeEach(async()=>{
  stopPvpGameLoop();
  await db.run("UPDATE pvp_rounds SET phase='RESULT',ended_at='2000-01-01 00:00:00' WHERE phase IN ('WAITING','COUNTDOWN','LIVE','RESULT')");
  await restoreOrStartPvpRound();
});
test.after(async()=>{
  stopPvpGameLoop();listener.closeAllConnections();await new Promise(r=>listener.close(r));await new Promise(r=>db.db.close(r));fs.rmSync(dir,{recursive:true,force:true});
});
async function request(user,route,body){
 const r=await fetch(url+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+user.id,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 return{status:r.status,data:await r.json()};
}
async function join(user,amount=1){return request(user,'/api/pvp/join',{betCurrency:'TON',betAmount:amount});}

test('One TON bettor stays visible with stake and no countdown until a different second bettor joins',async()=>{
 const first=await join(users[0],1.25);assert.equal(first.status,200);
 const s=first.data.state;assert.equal(s.phase,'WAITING');assert.equal(s.countdownEndsAt,null);assert.equal(s.participants.length,1);
 assert.equal(s.totalPool,1.25);assert.equal(s.participants[0].name,'one');assert.equal(s.participants[0].betAmount,1.25);
 const balance=await db.getUserBalance(users[0].id),round=s.roundId;
 assert.equal(await triggerPvpCountdown(),false);
 const duplicate=await join(users[0],2);assert.equal(duplicate.status,400);assert.equal(await db.getUserBalance(users[0].id),balance);
 await restoreOrStartPvpRound();assert.equal(getPvpStateSnapshot().phase,'WAITING');assert.equal(getPvpStateSnapshot().roundId,round);
 assert.equal(getPvpStateSnapshot().participants.length,1);
 const second=await join(users[1],2);assert.equal(second.status,200);assert.equal(second.data.state.phase,'COUNTDOWN');
 assert.equal(second.data.state.participants.length,2);assert.equal(second.data.state.totalPool,3.25);
 const deadline=second.data.state.countdownEndsAt;assert.ok(deadline>Date.now()+19000);
 const third=await join(users[2],.5);assert.equal(third.status,200);assert.equal(third.data.state.countdownEndsAt,deadline);
 assert.equal(await triggerPvpCountdown(),false);assert.equal(getPvpStateSnapshot().countdownEndsAt,deadline);
});

test('Concurrent triggers start exactly once and never reset the authoritative deadline',async()=>{
 await db.joinPvpRound(users[0].id,'TON',1,null);await db.joinPvpRound(users[1].id,'TON',1,null);
 const changes=await Promise.all([triggerPvpCountdown(),triggerPvpCountdown(),triggerPvpCountdown()]);assert.equal(changes.filter(Boolean).length,1);
 const deadline=getPvpStateSnapshot().countdownEndsAt;
 const row=await db.get('SELECT * FROM pvp_rounds WHERE id=?',[getPvpStateSnapshot().roundId]);assert.equal(deadline,Date.parse(row.started_at)+20000);
});

test('Legacy COUNTDOWN with one player resumes WAITING without losing the bet or starting a new round',async()=>{
 const s=getPvpStateSnapshot();await db.joinPvpRound(users[0].id,'TON',2,null);await db.startPvpCountdown(s.roundId);
 const balance=await db.getUserBalance(users[0].id);
 await restoreOrStartPvpRound();assert.equal(getPvpStateSnapshot().phase,'WAITING');assert.equal(getPvpStateSnapshot().roundId,s.roundId);
 assert.equal(getPvpStateSnapshot().totalPool,2);assert.equal(await db.getUserBalance(users[0].id),balance);
 assert.equal((await db.get('SELECT phase FROM pvp_rounds WHERE id=?',[s.roundId])).phase,'WAITING');
});

test('One eligible gift waits locked, then a second TON player starts countdown and LIVE rejects later bets',async()=>{
 const gift=await db.get('SELECT * FROM gifts WHERE value>0 LIMIT 1'),id='one-waiting-gift';
 await db.run("INSERT INTO user_gifts(user_id,gift_id,status,unique_collectible_id,ownership_verified,market_value,telegram_gift_instance_id) VALUES (?,?,'OWNED',?,1,4.25,?)",[users[0].id,gift.id,id,id]);
 const first=await request(users[0],'/api/pvp/join',{betCurrency:'GIFT',betAmount:99,giftUniqueId:id});assert.equal(first.status,200);assert.equal(first.data.state.phase,'WAITING');
 assert.equal(first.data.state.poolGift,4.25);assert.equal((await db.getCollectibleByUniqueId(id)).ownership_status,'IN_BET');
 await restoreOrStartPvpRound();assert.equal(getPvpStateSnapshot().phase,'WAITING');assert.equal((await db.getCollectibleByUniqueId(id)).ownership_status,'IN_BET');
 await join(users[1],.5);assert.equal(getPvpStateSnapshot().phase,'COUNTDOWN');await launchPvpRound();assert.equal(getPvpStateSnapshot().phase,'LIVE');
 const balance=await db.getUserBalance(users[2].id),rejected=await join(users[2],1);assert.equal(rejected.status,400);assert.equal(await db.getUserBalance(users[2].id),balance);
 const result=await db.crashPvpRound(getPvpStateSnapshot().roundId);assert.equal(result.totalPool,4.75);
 const all=await request(users[2],'/api/pvp/history');assert.equal(all.status,200);assert.equal(all.data.rounds.length,1);
 const r=all.data.rounds[0];assert.equal(r.playerCount,2);assert.equal(r.totalPool,4.75);assert.equal(r.poolTon,.5);assert.equal(r.gifts[0].name,gift.name);
 assert.equal(r.winner.userId,result.winnerUserId);assert.equal(r.winner.chance,result.winnerParticipationPercent);
 assert.equal(Object.hasOwn(r,'serverSeed'),false);
 assert.equal((await request(users[0],'/api/pvp/history?scope=mine')).data.rounds.length,1);
 assert.equal((await request(users[2],'/api/pvp/history?scope=mine&userId='+users[0].id)).data.rounds.length,0);
});

test('History is authenticated, paginated, excludes waiting and no-winner rows, and never emits seed secrets',async()=>{
 for(let i=0;i<3;i++){
  const row=await db.createPvpRound(50000+i);await db.run("UPDATE pvp_rounds SET phase='RESULT',winner_user_id=?,pool_ton=3,ended_at=CURRENT_TIMESTAMP WHERE id=?",[users[0].id,row.id]);
 }
 const r=await request(users[0],'/api/pvp/history?limit=2');assert.equal(r.status,200);assert.equal(r.data.rounds.length,2);assert.equal(r.data.hasMore,true);
 assert.equal(r.data.rounds[0].roundNumber,50002);assert.equal(r.data.nextBefore,50001);
 const next=await request(users[0],'/api/pvp/history?limit=2&before='+r.data.nextBefore);assert.ok(next.data.rounds.every(x=>x.roundNumber<50001));
 assert.equal(JSON.stringify(r.data).includes('server_seed'),false);
 const unauthorized=await fetch(url+'/api/pvp/history');assert.equal(unauthorized.status,401);
});
