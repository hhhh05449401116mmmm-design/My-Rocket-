'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createReadOnlyGiftPriceProbe,SPECIFICATIONS,CATALOG_SPECIFICATIONS,catalogSpecifications}=require('../giftPricingSourceProbe');
const {SOURCE,keyFor}=require('../telegramGiftPricing');
async function waitComplete(probe){for(let i=0;i<1000;i++){const report=probe.getReport();if(report.statusCode===200)return report;await new Promise(r=>setTimeout(r,1));}throw Error('probe did not finish');}
function quote(spec,clock){return {available:true,scanComplete:true,source:SOURCE,currency:'TON',specification:spec,value:5,priceNano:'5000000000',baseGiftId:'777',observedAt:clock,expiresAt:clock+300000,pagesScanned:2};}

test('catalog source probe covers all 306 specs, 111 types and 15 boxes with at most four in flight',async()=>{
    let calls=0,clock=1000,active=0,peak=0;
    const engine={quote:async specification=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return quote(specification,clock);}};
    const probe=createReadOnlyGiftPriceProbe({engine,now:()=>clock});
    for(let i=0;i<10;i++)assert.equal(probe.getReport().statusCode,202);
    assert.ok(calls<=4);const result=await waitComplete(probe);
    assert.equal(calls,306);assert.equal(result.body.scope,'all-game-catalog');assert.equal(result.body.financialPricingChanged,false);
    assert.equal(result.body.coverage.totalGiftTypes,111);assert.equal(result.body.coverage.totalBoxes,15);
    assert.equal(result.body.checks.length,306);assert.equal(peak,4);
    assert.deepEqual(new Set(result.body.checks.map(q=>keyFor(q.specification))),new Set(SPECIFICATIONS.map(keyFor)));
    probe.getReport();assert.equal(calls,306);
    clock+=90001;assert.equal(probe.getReport().statusCode,202);await waitComplete(probe);assert.equal(calls,612);
});

test('unavailable source scans every catalog specification without fake or zero prices',async()=>{
    const probe=createReadOnlyGiftPriceProbe({engine:{quote:async()=>({available:false,reason:'telegram_user_session_required',observedAt:1000})}});
    const result=await waitComplete(probe);assert.equal(result.body.coverage.processed,306);
    assert.equal(result.body.coverage.reasons.telegram_user_session_required,306);
    assert.ok(result.body.checks.every(q=>q.marketValueTon===null&&q.available===false));
});

test('source module has no database, purchase, debit, bet or gift transfer call and no fixed gift-name scope',()=>{
    const source=fs.readFileSync(require.resolve('../giftPricingSourceProbe'),'utf8');
    assert.doesNotMatch(source,/require\(['"]\.\/database|sendStarsForm|transferStarGift|UPDATE users|createPendingLootBoxGiftReward|placeGiftBet|joinPvpRound|Plush Pepe/);
});

test('catalog identity deduplicates only identical gift+traits and keeps box membership',()=>{
    const rows=catalogSpecifications({boxes:{a:{id:'a',entries:[{name:'Gift',backdropName:'Black'}]},b:{id:'b',entries:[{name:'Gift',backdropName:'Black'},{name:'Gift',backdropName:'Onyx Black'},{name:'Gift',modelName:'M'}]}}});
    assert.equal(rows.length,3);assert.deepEqual(rows[0].boxIds,['a','b']);
});

test('expired prices disappear even while a large catalog pass still processes later items',async()=>{
    let clock=1000;const probe=createReadOnlyGiftPriceProbe({now:()=>clock,engine:{quote:async s=>({...quote(s,clock),expiresAt:clock+10})},entries:CATALOG_SPECIFICATIONS.slice(0,5)});
    probe.getReport();await new Promise(r=>setTimeout(r,5));clock=1100;
    const report=probe.getReport();assert.equal(report.body.checks[0].available,false);assert.equal(report.body.checks[0].marketValueTon,null);assert.equal(report.body.checks[0].reason,'expired');
    await waitComplete(probe);
});

test('quote for a different gift is rejected even when reported fresh by the engine',async()=>{
    const probe=createReadOnlyGiftPriceProbe({engine:{quote:async()=>quote({name:'Wrong Gift'},Date.now())},entries:CATALOG_SPECIFICATIONS.slice(0,1)});
    const result=await waitComplete(probe);assert.equal(result.body.checks[0].available,false);assert.equal(result.body.checks[0].marketValueTon,null);
});

test('invalid batch limits cannot launch unbounded market requests',()=>{
    for(const batchSize of [0,-1,5,1.5])assert.throws(()=>createReadOnlyGiftPriceProbe({batchSize}),TypeError);
});
