'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createReadOnlyGiftPriceProbe}=require('../giftPricingSourceProbe');
const {SOURCE}=require('../telegramGiftPricing');
async function waitComplete(probe){for(let i=0;i<100;i++){const report=probe.getReport();if(report.statusCode===200)return report;await new Promise(r=>setTimeout(r,1));}throw Error('probe did not finish');}

test('read-only source probe deduplicates requests and never calls finance functions',async()=>{
    let calls=0,clock=1000;
    const engine={quote:async specification=>{calls++;await new Promise(r=>setTimeout(r,2));return {available:true,scanComplete:true,source:SOURCE,currency:'TON',specification,value:5,priceNano:'5000000000',baseGiftId:'777',observedAt:clock,expiresAt:clock+300000,pagesScanned:2};}};
    const probe=createReadOnlyGiftPriceProbe({engine,now:()=>clock});
    for(let i=0;i<10;i++)assert.equal(probe.getReport().statusCode,202);
    const result=await waitComplete(probe);assert.equal(calls,4);assert.equal(result.body.financialPricingChanged,false);
    assert.equal(result.body.checks.length,4);assert.ok(result.body.checks.every(q=>q.available&&q.telegramGiftId==='777'));
    probe.getReport();assert.equal(calls,4);
    clock+=90001;assert.equal(probe.getReport().statusCode,202);await waitComplete(probe);assert.equal(calls,8);
});

test('source or permission failure is explicit unavailable, never a zero price or estimate',async()=>{
    const probe=createReadOnlyGiftPriceProbe({engine:{quote:async()=>({available:false,reason:'telegram_user_session_required',observedAt:1000})}});
    const result=await waitComplete(probe);assert.ok(result.body.checks.every(q=>q.marketValueTon===null&&q.available===false&&q.reason==='telegram_user_session_required'));
});

test('source-check module contains no database, payment, debit, bet, or gift transfer call',()=>{
    const source=fs.readFileSync(require.resolve('../giftPricingSourceProbe'),'utf8');
    assert.doesNotMatch(source,/require\(['"]\.\/database|sendStarsForm|transferStarGift|UPDATE users|createPendingLootBoxGiftReward|placeGiftBet|joinPvpRound/);
});

test('a verified backdrop identity is reported separately from an unavailable TON floor',async()=>{
    const probe=createReadOnlyGiftPriceProbe({engine:{quote:async specification=>({available:false,reason:'no_matching_ton_listings',source:SOURCE,currency:'TON',baseGiftId:'777',specification,resolvedSpecification:specification,resolvedAttributes:specification.backdropName?{backdrop:{officialName:specification.backdropName,officialId:specification.backdropName==='Black'?'21':'22',match:'exact'}}:{},scanComplete:true,pagesScanned:1})}});
    const result=await waitComplete(probe);
    const black=result.body.checks.find(q=>q.specification.backdropName==='Black');
    const onyx=result.body.checks.find(q=>q.specification.backdropName==='Onyx Black');
    assert.equal(black.marketValueTon,null);assert.equal(black.available,false);
    assert.equal(black.resolvedAttributes.backdrop.officialName,'Black');
    assert.notEqual(black.resolvedAttributes.backdrop.officialId,onyx.resolvedAttributes.backdrop.officialId);
    assert.equal(black.scanComplete,true);
});
