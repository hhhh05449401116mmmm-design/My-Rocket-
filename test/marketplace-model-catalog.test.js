'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createMarketplaceModelCatalog}=require('../marketplaceModelCatalog');
const documents={
    a:{gift:'Plush Pepe',giftId:'5936013938331222567',model:'Red Menace',current:true},
    b:{gift:'Plush Pepe',giftId:'5936013938331222567',model:'Midas Pepe',current:true},
    c:{gift:'Plush Pepe',giftId:'5936013938331222567',model:'Midas Pepe',current:true},
    d:{gift:'Plush Pepe',giftId:'5936013938331222567',model:'Historical Model',current:false},
    e:{gift:'Ice Cream',giftId:'001',model:'Unsafe ID',current:true},
    f:{gift:'Stellar Rocket',giftId:'5956217000635139069',model:'Green Jelly',current:true}
};
test('whole public metadata catalog deduplicates current model names and preserves model-specific image identity',async()=>{
    const service=createMarketplaceModelCatalog({load:async()=>({data:documents,modifiedAt:'Tue, 03 Nov 2026 14:59:04 GMT'})});
    const catalog=await service.getMetadataCatalog();assert.equal(catalog.length,2);
    const pepe=await service.getModels('Plush Pepe');assert.equal(pepe.complete,true);assert.deepEqual(pepe.models.map(x=>x.name),['Midas Pepe','Red Menace']);
    assert.equal(pepe.models[0].imageUrl,'https://cdn.changes.tg/gifts/models/Plush%20Pepe/png/Midas%20Pepe.png');
    assert.equal(pepe.models[0].totalIssued,null);assert.equal(pepe.sourceUpdatedAt,'2026-11-03T14:59:04.000Z');
    assert.ok(!pepe.models.some(x=>x.name==='Historical Model'));
});
test('source identity binding supports exact verified collection names without fuzzy price/metadata matches',async()=>{
    const service=createMarketplaceModelCatalog({load:async()=>documents});
    const renamed=await service.getModels('Rocket Display',{officialCatalog:[{title:'Rocket Display',giftId:'5956217000635139069'}]});
    assert.equal(renamed.models[0].name,'Green Jelly');
    const unknown=await service.getModels('Plush Pepe',{officialCatalog:[{title:'Plush Pepe',giftId:'7'}]});assert.equal(unknown.complete,false);assert.deepEqual(unknown.models,[]);
});
test('single shared download serves all gifts and calls, with TTL and error backoff/last-good behavior',async()=>{
    let calls=0,clock=100,fail=false;const service=createMarketplaceModelCatalog({now:()=>clock,ttlMs:50,failureTtlMs:20,load:async()=>{calls++;if(fail)throw new Error('Offline');return documents;}});
    await Promise.all([service.getModels('Plush Pepe'),service.getModels('Stellar Rocket'),service.getMetadataCatalog()]);assert.equal(calls,1);
    clock=149;await service.getMetadataCatalog();assert.equal(calls,1);clock=150;fail=true;
    const old=await service.getModels('Plush Pepe');assert.equal(old.status,'stale');assert.equal(old.models.length,2);
    await service.getMetadataCatalog();assert.equal(calls,2);clock=171;await service.getMetadataCatalog();assert.equal(calls,3);
});
test('unavailable or malformed metadata does not invent models or supply counts',async()=>{
    for(const input of [[],{},null]){const service=createMarketplaceModelCatalog({load:async()=>input});const result=await service.getModels('Plush Pepe');assert.equal(result.complete,false);assert.deepEqual(result.models,[]);}
});
test('source waits are bounded and abort pending requests',async()=>{
    let signal;const service=createMarketplaceModelCatalog({timeoutMs:5,load:({signal:s})=>{signal=s;return new Promise(()=>{});}});
    const result=await service.getModels('Plush Pepe');assert.deepEqual(result.models,[]);assert.equal(signal.aborted,true);
});
