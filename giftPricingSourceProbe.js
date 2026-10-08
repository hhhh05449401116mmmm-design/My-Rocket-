'use strict';
const {createTelegramGiftPricing,SOURCE}=require('./telegramGiftPricing');
const SPECIFICATIONS=Object.freeze([
    Object.freeze({name:'Plush Pepe'}),
    Object.freeze({name:'Plush Pepe',modelName:'Pink Latex'}),
    Object.freeze({name:'Plush Pepe',backdropName:'Black'}),
    Object.freeze({name:'Plush Pepe',backdropName:'Onyx Black'})
]);
function createReadOnlyGiftPriceProbe({getClient,engine,now=Date.now,cacheMs=90000}={}) {
    const prices=engine||createTelegramGiftPricing({getClient,timeoutMs:20000,concurrency:2,maxPending:4});
    let report=null,pending=null,lastStartedAt=0;
    function getReport() {
        if(!pending&&(!report||now()-lastStartedAt>=cacheMs)) {
            lastStartedAt=now();
            pending=Promise.all(SPECIFICATIONS.map(async specification=>{
                try {
                    const quote=await prices.quote(specification);
                    const available=quote.available===true&&quote.scanComplete===true&&quote.source===SOURCE&&quote.currency==='TON';
                    return {specification,available,reason:available?null:quote.reason||'telegram_unavailable',
                        source:SOURCE,currency:'TON',marketValueTon:available?quote.value:null,
                        priceNano:available?quote.priceNano:null,telegramGiftId:quote.baseGiftId||null,
                        resolvedSpecification:quote.resolvedSpecification||(available?specification:null),
                        resolvedAttributes:quote.resolvedAttributes||(available?{}:null),
                        observedAt:quote.observedAt||null,expiresAt:available?quote.expiresAt:null,
                        scanComplete:quote.scanComplete===true,pagesScanned:quote.pagesScanned||0};
                } catch {return {specification,available:false,reason:'telegram_unavailable',source:SOURCE,currency:'TON',marketValueTon:null};}
            })).then(checks=>{report={ok:true,phase:'complete',mode:'read-only-source-check',financialPricingChanged:false,checkedAt:now(),checks};})
                .finally(()=>{pending=null;});
        }
        if(pending)return {statusCode:202,body:{ok:true,phase:'checking',mode:'read-only-source-check',financialPricingChanged:false,startedAt:lastStartedAt}};
        return {statusCode:200,body:report};
    }
    return {getReport};
}
module.exports={createReadOnlyGiftPriceProbe,SPECIFICATIONS};
