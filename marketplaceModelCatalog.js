'use strict';
// Read-only public model metadata, independent from game/financial engines.
const https=require('node:https');
const {collectionKey}=require('./marketplaceView');
const DOCUMENTS_URL='https://cdn.changes.tg/gifts/documents.json';
const SOURCE='changes-telegram-gift-model-catalog';
function label(value){return typeof value==='string'&&value.length<=160&&!/[\p{Cc}\p{Cf}]/u.test(value)?value.normalize('NFKC').trim():'';}
function giftId(value){return typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)?value:null;}
function modelImage(collection,model){return 'https://cdn.changes.tg/gifts/models/'+encodeURIComponent(collection)+'/png/'+encodeURIComponent(model)+'.png';}
function fetchDocuments({signal,maxBytes}){
    return new Promise((resolve,reject)=>{
        const req=https.get(DOCUMENTS_URL,{signal,headers:{Accept:'application/json','User-Agent':'CrazyRocket-MarketplaceModels/1.0'}},res=>{
            if(res.statusCode!==200||Number(res.headers['content-length'])>maxBytes){res.destroy();req.destroy(new Error('Model catalog response rejected'));return;}
            let bytes=0;const chunks=[];
            res.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){res.destroy();req.destroy(new Error('Model catalog too large'));}else chunks.push(chunk);});
            res.on('error',reject);res.on('aborted',()=>reject(new Error('Incomplete model catalog')));
            res.on('end',()=>{try{resolve({data:JSON.parse(Buffer.concat(chunks).toString('utf8')),modifiedAt:res.headers['last-modified']||null});}catch{reject(new Error('Invalid model catalog JSON'));}});
        });req.on('error',reject);
    });
}
function parseDocuments(raw){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>16000)throw new Error('Invalid model catalog');
    const collections=new Map(),byId=new Map();
    for(const document of Object.values(raw)){
        if(!document||typeof document!=='object'||document.current!==true)continue;
        const name=label(document.gift),model=label(document.model),id=giftId(document.giftId),key=collectionKey(name);
        if(!name||!model||!id||!key)continue;
        let entry=collections.get(key);
        if(entry&&entry.giftId!==id)throw new Error('Ambiguous collection identity');
        if(!entry){entry={key,title:name,giftId:id,models:new Map()};collections.set(key,entry);if(byId.has(id)&&byId.get(id).key!==key)throw new Error('Ambiguous collection identity');byId.set(id,entry);}
        if(!entry.models.has(model))entry.models.set(model,{name:model,imageUrl:modelImage(name,model),totalIssued:null});
    }
    if(!collections.size)throw new Error('Empty model catalog');
    return {collections,byId};
}
function createMarketplaceModelCatalog({load=fetchDocuments,now=Date.now,ttlMs=6*60*60*1000,failureTtlMs=60000,timeoutMs=5000,maxBytes=2*1024*1024,fallback=null}={}){
    let cached=null,pending=null,retryAt=0,failed=false;
    if(fallback?.documents){cached={...parseDocuments(fallback.documents),sourceUpdatedAt:fallback.sourceUpdatedAt||null};}
    async function ensure(){
        if(pending)return fallback&&cached?cached:pending;if(now()<retryAt)return cached;
        pending=(async()=>{
            const controller=new AbortController();let timer;
            try{
                const response=await Promise.race([Promise.resolve().then(()=>load({signal:controller.signal,maxBytes})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Model catalog timeout'));},timeoutMs);})]);
                const data=response?.data||response;
                if(Buffer.byteLength(JSON.stringify(data),'utf8')>maxBytes)throw new Error('Model catalog too large');
                const parsed=parseDocuments(data),modified=Date.parse(response?.modifiedAt||'');
                cached={...parsed,sourceUpdatedAt:Number.isFinite(modified)?new Date(modified).toISOString():null};failed=false;retryAt=now()+ttlMs;
            }catch{failed=true;retryAt=now()+failureTtlMs;}
            finally{clearTimeout(timer);}
            return cached;
        })().finally(()=>{pending=null;});return fallback&&cached?cached:pending;
    }
    async function getMetadataCatalog(){const cache=await ensure();return [...(cache?.collections.values()||[])].map(entry=>({title:entry.title,giftId:entry.giftId}));}
    async function getModels(collection,{officialCatalog=[]}={}){
        const cache=await ensure(),key=collectionKey(collection);
        const official=officialCatalog.filter(g=>collectionKey(g.title||g.name)===key);
        const ids=new Set(official.map(g=>giftId(g.giftId)).filter(Boolean));
        const entry=ids.size>1?null:ids.size===1?cache?.byId.get([...ids][0]):cache?.collections.get(key);
        return {models:entry?[...entry.models.values()].sort((a,b)=>a.name.localeCompare(b.name,'en')):[],complete:!!entry,source:SOURCE,status:entry?(failed?'stale':'available'):'unavailable',sourceUpdatedAt:cache?.sourceUpdatedAt||null};
    }
    return {getMetadataCatalog,getModels};
}
const marketplaceModelCatalog=createMarketplaceModelCatalog({fallback:require('./marketplaceModelCatalog.json')});
module.exports={createMarketplaceModelCatalog,marketplaceModelCatalog,DOCUMENTS_URL,SOURCE};
