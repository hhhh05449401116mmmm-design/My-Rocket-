'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rocket-price-source-http-'));
process.env.DATABASE_PATH=path.join(dir,'source.sqlite');
for(const key of ['TELEGRAM_API_ID','TELEGRAM_API_HASH','TELEGRAM_SESSION_STRING'])delete process.env[key];
require('../test-helpers/no-network');
const database=require('../database');
const {app}=require('../server');
let listener,url,user;
test.before(async()=>{await database.initDatabase();await database.seedDatabase();user=await database.findOrCreateUser('source-probe-fixture');await database.updateUserBalance(user.id,42.5,'add');listener=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});url='http://127.0.0.1:'+listener.address().port;});
test.after(async()=>{listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));await new Promise(resolve=>database.db.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
test('public fixed source check works without account login and cannot change financial state',async()=>{
    const balance=await database.getUserBalance(user.id);
    const before=await database.get('SELECT COUNT(*) AS count FROM user_gifts');
    const history=await database.get('SELECT COUNT(*) AS count FROM lootbox_history');
    let response=await fetch(url+'/api/gift-pricing/source-check?name=Ignored&amount=999999');
    assert.ok([200,202].includes(response.status));
    let body=await response.json();
    for(let i=0;i<200&&body.phase!=='complete';i++){
        await new Promise(r=>setTimeout(r,5));response=await fetch(url+'/api/gift-pricing/source-check');body=await response.json();
    }
    assert.equal(response.status,200);assert.equal(body.phase,'complete');assert.equal(body.mode,'read-only-source-check');
    assert.equal(body.financialPricingChanged,false);assert.equal(body.scope,'all-official-telegram-types-and-game-specifications');assert.equal(body.officialCatalog.status,'unavailable');assert.equal(body.incomingGiftPricingChanged,false);assert.equal(body.coverage.totalGiftTypes,111);assert.equal(body.coverage.totalBoxes,15);assert.equal(body.checks.length,306);
    assert.ok(body.checks.every(q=>q.available===false&&q.marketValueTon===null));
    assert.equal(await database.getUserBalance(user.id),balance);
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM user_gifts')).count,before.count);
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM lootbox_history')).count,history.count);
    assert.ok(!JSON.stringify(body).includes('TELEGRAM_API_HASH'));
});
