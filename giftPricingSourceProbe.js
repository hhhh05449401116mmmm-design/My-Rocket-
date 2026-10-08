'use strict';
const catalog = require('./lootBoxGiftCatalog.json');
const {createTelegramGiftPricing,SOURCE,specification,keyFor} = require('./telegramGiftPricing');

function catalogSpecifications(source = catalog) {
    const unique = new Map();
    for (const box of Object.values(source.boxes || {})) {
        for (const entry of Array.isArray(box.entries) ? box.entries : []) {
            const spec = specification(entry);
            if (!spec.name) continue;
            const key = keyFor(spec);
            if (!unique.has(key)) unique.set(key,{specification:spec,boxIds:[]});
            if (!unique.get(key).boxIds.includes(box.id)) unique.get(key).boxIds.push(box.id);
        }
    }
    return [...unique.values()].sort((a,b)=>a.specification.name.localeCompare(b.specification.name));
}
const CATALOG_SPECIFICATIONS = Object.freeze(catalogSpecifications().map(row => Object.freeze(row)));
const SPECIFICATIONS = Object.freeze(CATALOG_SPECIFICATIONS.map(row => Object.freeze(row.specification)));

function createReadOnlyGiftPriceProbe({getClient,engine,now=Date.now,cacheMs=90000,batchSize=4,entries=CATALOG_SPECIFICATIONS}={}) {
    if (!Number.isSafeInteger(batchSize) || batchSize<1 || batchSize>4) throw new TypeError('Invalid source batch limit');
    if (!Number.isSafeInteger(cacheMs) || cacheMs<1) throw new TypeError('Invalid source cache duration');
    const prices=engine||createTelegramGiftPricing({getClient,timeoutMs:20000,concurrency:2,maxPending:4});
    let pending=null,startedAt=null,completedAt=null,cursor=0,checks=[];

    async function checkEntry(row) {
        const spec=row.specification;
        try {
            const quote=await prices.quote(spec);
            const available=quote.available===true && quote.scanComplete===true && quote.source===SOURCE &&
                quote.currency==='TON' && quote.expiresAt>now() && keyFor(quote.specification)===keyFor(spec);
            return {specification:spec,boxIds:row.boxIds,available,
                reason:available?null:quote.reason||'telegram_unavailable',source:SOURCE,currency:'TON',
                marketValueTon:available?quote.value:null,priceNano:available?quote.priceNano:null,
                telegramGiftId:quote.baseGiftId||null,resolvedSpecification:quote.resolvedSpecification||(available?spec:null),
                resolvedAttributes:quote.resolvedAttributes||(available?{}:null),observedAt:quote.observedAt||null,
                expiresAt:available?quote.expiresAt:null,scanComplete:quote.scanComplete===true,pagesScanned:quote.pagesScanned||0};
        } catch {
            return {specification:spec,boxIds:row.boxIds,available:false,reason:'telegram_unavailable',source:SOURCE,currency:'TON',marketValueTon:null,priceNano:null};
        }
    }

    function getReport() {
        if (!pending && (startedAt===null || (completedAt!==null && now()-completedAt>=cacheMs))) {
            startedAt=now();completedAt=null;cursor=0;checks=[];
        }
        if (!pending && cursor<entries.length) {
            const batch=entries.slice(cursor,cursor+batchSize);
            pending=Promise.all(batch.map(checkEntry)).then(rows=>{
                checks.push(...rows);cursor+=rows.length;
                if(cursor===entries.length)completedAt=now();
            }).finally(()=>{pending=null;});
        }
        if (!entries.length && completedAt===null)completedAt=now();
        const visible=checks.map(row=>row.available && row.expiresAt<=now()
            ? {...row,available:false,reason:'expired',marketValueTon:null,priceNano:null} : row);
        const phase=cursor===entries.length && !pending?'complete':'checking';
        const reasons={};
        for(const row of visible)if(!row.available)reasons[row.reason||'unknown']=(reasons[row.reason||'unknown']||0)+1;
        return {statusCode:phase==='complete'?200:202,body:{ok:true,phase,mode:'read-only-source-check',
            scope:'all-game-catalog',financialPricingChanged:false,startedAt,checkedAt:completedAt,
            coverage:{totalSpecifications:entries.length,totalGiftTypes:new Set(entries.map(row=>row.specification.name)).size,
                totalBoxes:new Set(entries.flatMap(row=>row.boxIds)).size,processed:cursor,
                available:visible.filter(row=>row.available).length,unavailable:visible.filter(row=>!row.available).length,
                remaining:entries.length-cursor,inFlight:pending?Math.min(batchSize,entries.length-cursor):0,reasons},
            checks:visible}};
    }
    return {getReport};
}
module.exports={createReadOnlyGiftPriceProbe,SPECIFICATIONS,CATALOG_SPECIFICATIONS,catalogSpecifications};
