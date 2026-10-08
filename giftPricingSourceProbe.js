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
    const seedEntries=entries;
    const discoversTelegram=typeof prices.listCollections==='function';
    let discovery=null,discoveryPending=null,discoveredAt=null,officialTypes=0;
    let pending=null,startedAt=null,completedAt=null,cursor=0,checks=[];

    function discover() {
        if (!discoversTelegram || discoveryPending) return;
        discovery='loading';
        let timer;
        // Shared catalog promise remains owned by the engine. A hung request cannot
        // block the report forever; failed discovery is never called complete coverage.
        discoveryPending=Promise.race([
            Promise.resolve().then(()=>prices.listCollections()),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('catalog_timeout')),20000);})
        ]).then(rows=>{
            if (!Array.isArray(rows)) throw Error('invalid_catalog');
            const merged=new Map(seedEntries.map(row=>[keyFor(row.specification),row]));
            const names=new Set();
            for(const row of rows){
                if(typeof row.name!=='string'||!row.name.trim()) continue;
                const spec=specification({name:row.name});names.add(keyFor(spec));
                if(!merged.has(keyFor(spec))) merged.set(keyFor(spec),{specification:spec,boxIds:[],telegramGiftId:row.telegramGiftId||null});
            }
            entries=[...merged.values()].sort((a,b)=>a.specification.name.localeCompare(b.specification.name));
            officialTypes=names.size;discovery='complete';discoveredAt=now();
        }).catch(()=>{discovery='unavailable';discoveredAt=now();})
            .finally(()=>{clearTimeout(timer);discoveryPending=null;});
    }

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
        if(discoversTelegram && discovery===null) discover();
        const discovering=discoversTelegram && discovery==='loading';
        if (!discovering && !pending && (startedAt===null || (completedAt!==null && now()-completedAt>=cacheMs))) {
            startedAt=now();completedAt=null;cursor=0;checks=[];
            if(discoversTelegram && discoveredAt!==null && now()-discoveredAt>=30*60000){discovery=null;discover();}
        }
        if (!discoveryPending && !pending && cursor<entries.length) {
            const batch=entries.slice(cursor,cursor+batchSize);
            pending=Promise.all(batch.map(checkEntry)).then(rows=>{
                checks.push(...rows);cursor+=rows.length;
                if(cursor===entries.length)completedAt=now();
            }).finally(()=>{pending=null;});
        }
        if (!entries.length && completedAt===null && !discoveryPending)completedAt=now();
        const visible=checks.map(row=>row.available && row.expiresAt<=now()
            ? {...row,available:false,reason:'expired',marketValueTon:null,priceNano:null} : row);
        const phase=discoveryPending?'discovering-catalog':cursor===entries.length && !pending?'complete':'checking';
        const reasons={};
        for(const row of visible)if(!row.available)reasons[row.reason||'unknown']=(reasons[row.reason||'unknown']||0)+1;
        return {statusCode:phase==='complete'?200:202,body:{ok:true,phase,mode:'read-only-source-check',
            scope:discoversTelegram?'all-official-telegram-types-and-game-specifications':'all-game-catalog',
            financialPricingChanged:false,incomingGiftPricingChanged:false,startedAt,checkedAt:completedAt,
            officialCatalog:{status:discovery||'not-requested',giftTypes:officialTypes,observedAt:discoveredAt},
            coverage:{totalSpecifications:entries.length,totalGiftTypes:new Set(entries.map(row=>row.specification.name)).size,
                totalBoxes:new Set(entries.flatMap(row=>row.boxIds)).size,processed:cursor,
                available:visible.filter(row=>row.available).length,unavailable:visible.filter(row=>!row.available).length,
                remaining:entries.length-cursor,inFlight:pending?Math.min(batchSize,entries.length-cursor):0,reasons},
            checks:visible}};
    }
    return {getReport};
}
module.exports={createReadOnlyGiftPriceProbe,SPECIFICATIONS,CATALOG_SPECIFICATIONS,catalogSpecifications};
