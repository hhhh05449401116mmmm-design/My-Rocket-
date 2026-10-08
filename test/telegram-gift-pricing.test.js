'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createTelegramGiftPricing, specification, keyFor, tonNanograms, tonDecimal} = require('../telegramGiftPricing');
const attributes = [
    {className:'StarGiftAttributeModel',name:'Pink Latex',document:{id:11n}},
    {className:'StarGiftAttributeModel',name:'Other Model',document:{id:12n}},
    {className:'StarGiftAttributeBackdrop',name:'Black',backdropId:21},
    {className:'StarGiftAttributeBackdrop',name:'Onyx Black',backdropId:22},
    {className:'StarGiftAttributePattern',name:'Stars',document:{id:31n}}
];
function listing(nano, {model='Pink Latex', backdrop='Black', giftId=1n, slug='PlushPepe-1', stars=false}={}) {
    return {giftId,slug,attributes:attributes.filter(a=>a.name===model||a.name===backdrop||a.name==='Stars'),
        resellAmount:[{className:stars?'StarsAmount':'StarsTonAmount',amount:BigInt(nano)}]};
}
function fixture(pages, options={}) {
    const calls=[];
    const client={api:{payments:{
        getStarGifts:async()=>({gifts:[{title:'Plush Pepe',id:1n},{title:'Other Collection',id:2n}]}),
        getStarGiftUpgradeAttributes:async()=>({attributes}),
        getResaleStarGifts:async p=>{if(p.attributesHash===0n)return {attributes,gifts:[]};calls.push(p);return typeof pages==='function'?pages(p):pages[p.offset||''];}
    }}};
    return {calls, engine:createTelegramGiftPricing({getClient:async()=>client,...options})};
}

test('Black label is a backdrop, Random is not a model, combined traits remain independent',()=>{
    assert.deepEqual(specification({name:'Plush Pepe',label:'Black'}),{name:'Plush Pepe',modelName:null,backdropName:'Black',patternName:null});
    assert.equal(specification({name:'Plush Pepe',label:'Random'}).modelName,null);
    assert.notEqual(keyFor({name:'Plush Pepe',backdrop:'Black'}),keyFor({name:'Plush Pepe',backdrop:'Onyx Black'}));
    assert.equal(specification({name:'Plush Pepe',model_name:'Pink Latex',backdrop:'Black'}).modelName,'Pink Latex');
});

test('TON nanograms are exact and Stars are not convertible pricing',()=>{
    assert.equal(tonNanograms([{className:'StarsAmount',amount:500n}]),null);
    assert.equal(tonNanograms([{className:'StarsTonAmount',amount:1234567891n}]),1234567891n);
    assert.equal(tonDecimal(1234567891n),'1.234567891');
    assert.equal(tonNanograms([{className:'StarsTonAmount',amount:-1n}]),null);
    assert.equal(tonNanograms([{className:'StarsTonAmount',amount:Number.MAX_SAFE_INTEGER+2}]),null);
});

test('general gift quote has no filters and scans all pages for TON-only minimum',async()=>{
    const {engine,calls}=fixture({'':{gifts:[listing(1000,{stars:true}),listing(9000000000n)],nextOffset:'second'},second:{gifts:[listing(4000000001n)]}});
    const quote=await engine.quote({name:'Plush Pepe',label:'Random'});
    assert.equal(quote.available,true);assert.equal(quote.value,4.000000001);
    assert.equal(quote.priceNano,'4000000001');assert.equal(quote.pagesScanned,2);
    assert.equal(calls[0].attributes,undefined);assert.equal(quote.scanComplete,true);
    assert.equal(quote.source,'telegram-resale-ton-floor');assert.ok(quote.quoteId);
});

test('model quote only accepts matching gift and model even if server returns wrong rows',async()=>{
    const {engine,calls}=fixture({'':{gifts:[listing(1000000000n,{model:'Other Model'}),listing(2000000000n,{giftId:2n}),listing(8000000000n)]}});
    const quote=await engine.quote({name:'Plush Pepe',modelName:'Pink Latex'});
    assert.equal(quote.value,8);assert.equal(quote.resolvedAttributes.model.officialId,'11');assert.equal(calls[0].attributes,undefined);
});

test('backdrop quote filters backdrop instead of calling a model Black',async()=>{
    const {engine,calls}=fixture({'':{gifts:[listing(1000000000n,{backdrop:'Onyx Black'}),listing(7000000000n)]}});
    const quote=await engine.quote({name:'Plush Pepe',label:'Black'});
    assert.equal(quote.value,7);assert.equal(quote.resolvedAttributes.backdrop.officialId,'21');assert.equal(calls[0].attributes,undefined);
});

test('combined model and backdrop require both attributes; neither individual floor substitutes',async()=>{
    const {engine,calls}=fixture({'':{gifts:[listing(1000000000n,{model:'Other Model'}),listing(2000000000n,{backdrop:'Onyx Black'}),listing(13000000000n)]}});
    const quote=await engine.quote({name:'Plush Pepe',modelName:'Pink Latex',backdropName:'Black'});
    assert.equal(quote.value,13);assert.equal(Object.keys(quote.resolvedAttributes).length,2);
});

test('unknown required trait never calls unfiltered resale and never falls back to collection',async()=>{
    const {engine,calls}=fixture({'':{gifts:[listing(1000000000n)]}});
    const quote=await engine.quote({name:'Plush Pepe',modelName:'Not a Real Model',backdropName:'Black'});
    assert.equal(quote.available,false);assert.equal(quote.value,null);assert.equal(quote.reason,'model_not_found');assert.equal(calls.length,1);
});

test('wrong collection title is not fuzzy matched',async()=>{
    const {engine,calls}=fixture({'':{gifts:[listing(1000000000n)]}});
    const quote=await engine.quote({name:'Pepe'});
    assert.equal(quote.reason,'collection_not_found');assert.equal(calls.length,0);
});

test('no matching TON listings is unavailable, not a zero or Stars valuation',async()=>{
    const {engine}=fixture({'':{gifts:[listing(1000,{stars:true})]}});
    const quote=await engine.quote({name:'Plush Pepe'});
    assert.equal(quote.value,null);assert.equal(quote.reason,'no_matching_ton_listings');
    await assert.rejects(engine.requireQuote({name:'Plush Pepe'}),{code:'GIFT_PRICE_UNAVAILABLE'});
});

test('scan limit is unavailable even if early pages contained a price',async()=>{
    const {engine}=fixture({'':{gifts:[listing(5000000000n)],nextOffset:'more'}},{maxPages:1});
    const quote=await engine.quote({name:'Plush Pepe'});
    assert.equal(quote.available,false);assert.equal(quote.reason,'scan_limit_exceeded');assert.equal(quote.value,null);
});

test('pagination loop and malformed pages never publish a partial floor',async()=>{
    const f=fixture({'':{gifts:[listing(5000000000n)],nextOffset:'x'},x:{gifts:[listing(1000000000n)],nextOffset:'x'}});
    assert.equal((await f.engine.quote({name:'Plush Pepe'})).reason,'pagination_loop');
    const g=fixture({'':{gifts:[listing(5000000000n)],nextOffset:'x'},x:{gifts:null}});
    assert.equal((await g.engine.quote({name:'Plush Pepe'})).reason,'invalid_market_response');
});

test('source errors produce no fallback and bot sessions are not silently substituted',async()=>{
    const {engine}=fixture(async()=>{const e=new Error('BOT_METHOD_INVALID');throw e;});
    const quote=await engine.quote({name:'Plush Pepe'});
    assert.equal(quote.reason,'telegram_user_session_required');assert.equal(quote.available,false);
});

test('in-flight lookup is deduplicated and only fresh cache may be used for finances',async()=>{
    let clock=1000;
    const {engine,calls}=fixture(async()=>{await new Promise(r=>setTimeout(r,10));return {gifts:[listing(3000000000n)]};},{now:()=>clock,ttlMs:100});
    const [a,b]=await Promise.all([engine.quote({name:'Plush Pepe'}),engine.quote({name:'plush pepe'})]);
    assert.equal(calls.length,1);assert.equal(a.quoteId,b.quoteId);
    await engine.quote({name:'Plush Pepe'});assert.equal(calls.length,1);
    clock=1101;assert.equal(engine.peek({name:'Plush Pepe'}).available,false);
    await engine.requireQuote({name:'Plush Pepe'});assert.equal(calls.length,2);
});

test('pattern filter is separate and uses document identity',async()=>{
    const {engine,calls}=fixture({'':{gifts:[listing(2000000000n)]}});
    const quote=await engine.quote({name:'Plush Pepe',patternName:'Stars'});
    assert.equal(quote.value,2);assert.equal(quote.resolvedAttributes.pattern.officialId,'31');assert.equal(calls[0].attributes,undefined);
});

test('a failed later page does not publish the minimum from previous pages',async()=>{
    const {engine}=fixture(async p=>{if(p.offset)throw Error('disconnected');return {gifts:[listing(1000000000n)],nextOffset:'x'};});
    const quote=await engine.quote({name:'Plush Pepe'});assert.equal(quote.available,false);assert.equal(quote.value,null);
});

test('FLOOD_WAIT causes a bounded shared cooldown rather than hammering Telegram',async()=>{
    const {engine,calls}=fixture(async()=>{const e=Error('FLOOD_WAIT_30');e.seconds=30;throw e;});
    assert.equal((await engine.quote({name:'Plush Pepe'})).reason,'telegram_rate_limited');
    assert.equal((await engine.quote({name:'Other Collection'})).reason,'telegram_rate_limited');
    assert.equal(calls.length,1);
});


test('same-name model with a different document ID is not the requested trait',async()=>{
    const wrong=listing(1000000000n);wrong.attributes=wrong.attributes.map(a=>a.name==='Pink Latex'?{...a,document:{id:99n}}:a);
    const {engine}=fixture({'':{gifts:[wrong,listing(8000000000n)]}});
    assert.equal((await engine.quote({name:'Plush Pepe',modelName:'Pink Latex'})).value,8);
});

test('resource limits reject invalid settings instead of creating a hung queue',()=>{
    assert.throws(()=>createTelegramGiftPricing({getClient:async()=>null,concurrency:0}),TypeError);
    assert.throws(()=>createTelegramGiftPricing({getClient:async()=>null,timeoutMs:-1}),TypeError);
});

test('concurrency slots are reserved across handoff and total queued lookups are bounded',async()=>{
    let live=0,peak=0;
    const {engine}=fixture(async()=>{live++;peak=Math.max(peak,live);await new Promise(r=>setTimeout(r,15));live--;return {gifts:[listing(4000000000n)]};},{concurrency:2,maxPending:4});
    await Promise.all([
        engine.quote({name:'Plush Pepe'}),engine.quote({name:'Plush Pepe',modelName:'Pink Latex'}),
        engine.quote({name:'Other Collection'}),engine.quote({name:'Other Collection',modelName:'Pink Latex'})
    ]);
    assert.ok(peak>=1 && peak<=2);assert.equal(engine.status().active,0);assert.equal(engine.status().queued,0);
    const f=fixture(async()=>{await new Promise(r=>setTimeout(r,15));return {gifts:[listing(4000000000n)]};},{maxPending:1});
    const first=f.engine.quote({name:'Plush Pepe'});
    assert.equal((await f.engine.quote({name:'Plush Pepe',modelName:'Pink Latex'})).reason,'request_queue_full');await first;
});

test('hung RPC and queued finance lookup return unavailable within a bounded timeout',async()=>{
    let release;
    const {engine,calls}=fixture(()=>new Promise(resolve=>{release=resolve;}),{concurrency:1,timeoutMs:20});
    const start=performance.now();
    const [first,second]=await Promise.all([engine.quote({name:'Plush Pepe'}),engine.quote({name:'Plush Pepe',modelName:'Pink Latex'})]);
    assert.equal(first.reason,'market_timeout');assert.equal(second.reason,'market_timeout');
    assert.ok(performance.now()-start<500);assert.equal(calls.length,1);
    assert.equal(engine.peek({name:'Plush Pepe'}).available,false);
    release({gifts:[listing(4000000000n)]});await new Promise(r=>setTimeout(r,10));
    assert.equal(engine.status().active,0);assert.equal(engine.status().pending,0);
    assert.equal(engine.peek({name:'Plush Pepe'}).available,false,'late RPC must not publish data after timeout');
});


test('exact trait filters serialize through the actual installed Telegram library',async()=>{
    const {Api}=require('teleproto');
    const {engine,calls}=fixture({'':{gifts:[listing(5000000000n)]}});
    await engine.quote({name:'Plush Pepe',modelName:'Pink Latex',backdropName:'Black',patternName:'Stars'});
    const bytes=new Api.payments.GetResaleStarGifts(calls[0]).getBytes();
    assert.ok(Buffer.isBuffer(bytes));assert.ok(bytes.length>0);
});


test('official catalog duplicate titles cannot select an arbitrary collection',async()=>{
    let calls=0;
    const client={api:{payments:{getStarGifts:async()=>({gifts:[{title:'Plush Pepe',id:1n},{title:'Plush Pepe',id:2n}]}),getResaleStarGifts:async()=>{calls++;return {gifts:[]};}}}};
    const engine=createTelegramGiftPricing({getClient:async()=>client});
    assert.equal((await engine.quote({name:'Plush Pepe'})).reason,'ambiguous_collection');assert.equal(calls,0);
});

test('fresh quote records the exact official base gift ID used for its scan',async()=>{
    const {engine}=fixture({'':{gifts:[listing(5000000000n)]}});
    assert.equal((await engine.quote({name:'Plush Pepe'})).baseGiftId,'1');
});


test('model metadata uses documented resale attributes_hash=0 and actual SDK serialization',async()=>{
    const {Api}=require('teleproto');let metadataRequest;
    const client={api:{payments:{getStarGifts:async()=>({gifts:[{title:'Plush Pepe',id:1n}]}),getResaleStarGifts:async p=>{
        if(p.attributesHash===0n){metadataRequest=p;return {attributes,gifts:[]};}return {gifts:[listing(5000000000n)]};
    }}}};
    const engine=createTelegramGiftPricing({getClient:async()=>client});
    assert.equal((await engine.quote({name:'Plush Pepe',modelName:'Pink Latex'})).available,true);
    assert.equal(metadataRequest.limit,1);assert.equal(metadataRequest.attributesHash,0n);
    assert.ok(new Api.payments.GetResaleStarGifts(metadataRequest).getBytes().length>0);
});

function officialBackdropFixture(officialAttributes, gifts) {
    const calls = [];
    const client = {api:{payments:{
        getStarGifts: async () => ({gifts:[{title:'Plush Pepe',id:1n}]}),
        getResaleStarGifts: async params => {
            if (params.attributesHash === 0n) return {attributes:officialAttributes,gifts:[]};
            calls.push(params); return {gifts};
        }
    }}};
    return {calls, engine:createTelegramGiftPricing({getClient:async()=>client})};
}


test('Black and Onyx Black produce independent IDs, filters, keys and prices',async()=>{
    const {engine,calls}=fixture({'':{gifts:[listing(7000000000n,{backdrop:'Black'}),listing(3000000000n,{backdrop:'Onyx Black'})]}});
    const black=await engine.quote({name:'Plush Pepe',backdropName:'Black'});
    const onyx=await engine.quote({name:'Plush Pepe',backdropName:'Onyx Black'});
    assert.equal(black.value,7);assert.equal(onyx.value,3);
    assert.equal(black.resolvedAttributes.backdrop.officialName,'Black');assert.equal(black.resolvedAttributes.backdrop.officialId,'21');
    assert.equal(onyx.resolvedAttributes.backdrop.officialName,'Onyx Black');assert.equal(onyx.resolvedAttributes.backdrop.officialId,'22');
    assert.notEqual(black.quoteId,onyx.quoteId);assert.equal(calls.length,1);
});

test('missing Black metadata does not alias to Onyx Black or use its floor',async()=>{
    const {engine,calls}=officialBackdropFixture(attributes.filter(a=>a.name!=='Black'),[listing(1000000000n,{backdrop:'Onyx Black'})]);
    const quote=await engine.quote({name:'Plush Pepe',backdropName:'Black'});
    assert.equal(quote.reason,'backdrop_not_found');assert.equal(quote.available,false);assert.equal(calls.length,1);
});
