'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTelegramGiftPricing,keyFor}=require('../telegramGiftPricing');
const {catalogSpecifications}=require('../giftPricingSourceProbe');
const catalog=require('../lootBoxGiftCatalog.json');

function fixture(){
    const specs=catalogSpecifications();
    const names=[...new Set(specs.map(r=>r.specification.name))];
    const ids=new Map(names.map((name,i)=>[name,String(i+1)]));
    const rows=new Map(names.map(name=>[ids.get(name),[]]));
    const wanted=new Map();let requests=0,live=0,peak=0;
    for(const [i,row] of specs.entries()){
        const s=row.specification;const attributes=[];
        if(s.modelName)attributes.push({className:'StarGiftAttributeModel',name:s.modelName,document:{id:BigInt(100000+i)}});
        if(s.backdropName)attributes.push({className:'StarGiftAttributeBackdrop',name:s.backdropName,backdropId:s.backdropName==='Black'?0:49});
        if(s.patternName)attributes.push({className:'StarGiftAttributePattern',name:s.patternName,document:{id:BigInt(200000+i)}});
        const gift={giftId:BigInt(ids.get(s.name)),attributes,slug:'Test-'+i,resellAmount:[{className:'StarsTonAmount',amount:BigInt(1000000000+i)}]};
        rows.get(ids.get(s.name)).push(gift);
    }
    // Determine expected exact floors including the general case, independently.
    for(const row of specs){const s=row.specification;const matching=rows.get(ids.get(s.name)).filter(g=>
        ['modelName','backdropName','patternName'].every(field=>!s[field]||g.attributes.some(a=>a.name===s[field])));
        wanted.set(keyFor(s),matching.reduce((min,g)=>min===null||g.resellAmount[0].amount<min?g.resellAmount[0].amount:min,null).toString());}
    const client={api:{payments:{getStarGifts:async()=>({gifts:names.map(name=>({title:name,id:BigInt(ids.get(name))}))}),
        getResaleStarGifts:async p=>{
            const gifts=rows.get(String(p.giftId));
            if(p.attributesHash===0n)return {attributes:gifts.flatMap(g=>g.attributes),gifts:[]};
            assert.equal(p.attributes,undefined);requests++;live++;peak=Math.max(peak,live);await new Promise(r=>setTimeout(r,1));live--;
            return {gifts};
        }
    }}};
    return {specs,wanted,engine:createTelegramGiftPricing({getClient:async()=>client}),status:()=>({requests,peak})};
}

test('all 306 game specifications across 111 gift types use the same exact-price engine',async()=>{
    const f=fixture();assert.equal(f.specs.length,306);
    for(let i=0;i<f.specs.length;i+=4){
        const chunk=f.specs.slice(i,i+4);
        const quotes=await Promise.all(chunk.map(row=>f.engine.quote(row.specification)));
        for(let j=0;j<quotes.length;j++){
            const q=quotes[j],s=chunk[j].specification;
            assert.equal(q.available,true,JSON.stringify({s,reason:q.reason}));
            assert.equal(q.priceNano,f.wanted.get(keyFor(s)),JSON.stringify(s));
            assert.equal(keyFor(q.specification),keyFor(s));assert.equal(q.scanComplete,true);
        }
    }
    assert.equal(f.status().requests,111,'one shared market scan per gift type');
    assert.ok(f.status().peak<=2);
});

test('any new gift type including a model and both black backdrops needs no hardcoded name case',async()=>{
    const attrs=[{className:'StarGiftAttributeModel',name:'New Model',document:{id:9n}},
        {className:'StarGiftAttributeBackdrop',name:'Black',backdropId:0},
        {className:'StarGiftAttributeBackdrop',name:'Onyx Black',backdropId:49}];
    const calls=[];
    const client={api:{payments:{getStarGifts:async()=>({gifts:[{title:'A Newly Added Gift',id:66n}]}),
        getResaleStarGifts:async p=>{calls.push(p);if(p.attributesHash===0n)return {attributes:[],gifts:[]};return {gifts:[
            {giftId:66n,attributes:[attrs[0],attrs[1]],resellAmount:[{className:'StarsTonAmount',amount:9000000000n}]},
            {giftId:66n,attributes:[attrs[0],attrs[2]],resellAmount:[{className:'StarsTonAmount',amount:4000000000n}]}
        ]};}
    }}};
    const engine=createTelegramGiftPricing({getClient:async()=>client});
    const black=await engine.quote({name:'A Newly Added Gift',modelName:'New Model',backdropName:'Black'});
    const onyx=await engine.quote({name:'A Newly Added Gift',modelName:'New Model',backdropName:'Onyx Black'});
    assert.equal(black.value,9);assert.equal(onyx.value,4);
    assert.equal(black.resolvedAttributes.backdrop.officialId,'0');assert.equal(onyx.resolvedAttributes.backdrop.officialId,'49');
    assert.equal(black.resolvedAttributes.backdrop.discoverySource,'telegram-resale-listings');
    assert.equal(calls.filter(c=>c.attributesHash===undefined).length,1);
});

test('cached market scan never creates a new timestamp or extends stale TON quotes',async()=>{
    let clock=1000,calls=0;
    const client={api:{payments:{getStarGifts:async()=>({gifts:[{title:'Gift',id:5n}]}),getResaleStarGifts:async()=>{calls++;return {gifts:[{giftId:5n,attributes:[],resellAmount:[{className:'StarsTonAmount',amount:1000000000n}]}]};}}}};
    const engine=createTelegramGiftPricing({getClient:async()=>client,now:()=>clock,ttlMs:100});
    const q=await engine.quote({name:'Gift'});clock=1090;
    const refreshed=await engine.quote({name:'Gift'},{force:true});assert.equal(refreshed.observedAt,1000);assert.equal(refreshed.expiresAt,1100);assert.equal(calls,1);
    clock=1101;assert.equal(engine.peek({name:'Gift'}).available,false);const next=await engine.quote({name:'Gift'});assert.equal(next.observedAt,1101);assert.equal(calls,2);
});

test('failed collection scans are shared across multiple batches for the bounded failure TTL',async()=>{
    for(const failure of ['error','malformed','limit']){
        let clock=1000,calls=0;
        const attrs=Array.from({length:8},(_,i)=>({className:'StarGiftAttributeModel',name:'M'+i,document:{id:BigInt(i+10)}}));
        const client={api:{payments:{getStarGifts:async()=>({gifts:[{title:'Gift A',id:5n}]}),getResaleStarGifts:async p=>{
            if(p.attributesHash===0n)return {attributes:attrs,gifts:[]};calls++;
            if(failure==='error')throw Error('temporary unavailable');
            if(failure==='malformed')return {gifts:null};
            return {gifts:[],nextOffset:'more'};
        }}}};
        const engine=createTelegramGiftPricing({getClient:async()=>client,now:()=>clock,maxPages:1,failureTtlMs:100});
        for(let i=0;i<8;i+=4){const quotes=await Promise.all(attrs.slice(i,i+4).map(a=>engine.quote({name:'Gift A',modelName:a.name})));assert.ok(quotes.every(q=>!q.available&&q.value===null));}
        assert.equal(calls,1,failure+' must be negative-cached per gift, not per model');
        clock=1101;await engine.quote({name:'Gift A',modelName:'M0'});assert.equal(calls,2);
    }
});
