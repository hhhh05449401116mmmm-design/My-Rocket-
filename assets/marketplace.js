'use strict';
// Existing marketplace only: no game loops, fake listings or external purchases.
let marketplaceState = {
    tab: 'shop', catalog: [], listings: [], collectibles: [], selectedCollections:[], draftCollections:[], selectedBackdrops:[], draftBackdrops:[], backdropData:null, backdropLoading:false, backdropRequest:0, backdropError:'', collectionSort:{key:'name',direction:1},
    filters: { collection:'', model:'', backdrop:'', symbol:'', maxPrice:'', number:'', search:'' },
    options: { models:[], backdrops:[], symbols:[] }, nextOffset:0, hasMore:false,
    sheet:null, traitCollection:'', traitView:'collections', traitData:null, traitLoading:false, traitError:'', traitRequest:0, traitCache:new Map(), marketInfo:{}, catalogLoadedAt:0, imageMap:{}, loading:false, error:'', request:0, controller:null, debounce:null
};
function marketLanguage(){ try { if(typeof currentLanguage!=='undefined'&&['ar','en','ru'].includes(currentLanguage))return currentLanguage; } catch {} return localStorage.getItem('rocketLanguage')||'ar'; }
function mt(key,args={}) { const dict=window.MARKET_TEXT||{};return String(dict[marketLanguage()]?.[key]||dict.ar?.[key]||key).replace(/\{(\w+)\}/g,(all,k)=>args[k]??all); }
function marketElement(tag, className, text) {
    const element=document.createElement(tag);
    if(className) element.className=className;
    if(text!==undefined) element.textContent=text;
    return element;
}
function marketApiUrl(path) { return (typeof BACKEND_URL==='string' ? BACKEND_URL : '') + path; }
function marketAuthHeaders() {
    // The original auth variable is initialized by Telegram bootstrap; never fabricate a session.
    try { if(typeof getAuthHeaders==='function') return getAuthHeaders(); } catch { /* Outside Telegram: use an existing stored session only. */ }
    let token='';
    try { token=localStorage.getItem('authToken')||''; } catch { /* Storage unavailable. */ }
    return { 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) };
}
function marketSafeImage(value) {
    if(typeof value!=='string'||!value.trim()) return '';
    try {
        const url=new URL(value,window.location.origin);
        if(url.protocol!=='https:'&&url.origin!==window.location.origin) return '';
        if(!['https:','http:'].includes(url.protocol)) return '';
        return url.href;
    } catch { return ''; }
}
function marketImage(item) { return item.imageUrl||item.image_url||''; }
function marketArtwork(item) {
    const wrap=marketElement('div','market-art');
    const img=marketElement('img');
    img.alt=item.baseName||item.name||'Telegram gift'; img.loading='lazy'; img.decoding='async'; img.referrerPolicy='no-referrer';
    const name=item.baseName||item.name||'';
    const key=String(name).toLowerCase().replace(/[^a-z0-9]/g,'');
    const localImage=marketplaceState.imageMap[key]||'';
    const uniqueImage=!!(item.collectibleId||item.uniqueCollectibleId||item.unique_collectible_id);
    const sources=[uniqueImage?marketImage(item):localImage,uniqueImage?localImage:marketImage(item),item.imageFallbackUrl||item.fallbackImageUrl,
        name ? 'https://cdn.changes.tg/gifts/models/'+encodeURIComponent(name)+'/png/Original.png' : '',
        name ? marketApiUrl('/api/gift-media/'+encodeURIComponent(name)) : '']
        .map(marketSafeImage).filter((url,index,array)=>url&&array.indexOf(url)===index);
    let next=0;
    const advance=()=>{
        if(next<sources.length) img.src=sources[next++];
        else { img.remove(); wrap.appendChild(marketElement('span','market-picture-missing',mt('imageMissing'))); }
    };
    img.addEventListener('error',advance); wrap.appendChild(img); advance(); return wrap;
}
function selectMarketTab(tab) {
    marketplaceState.tab=tab==='mine'?'mine':'shop';
    document.querySelectorAll('#market-page .market-tab').forEach(button=>{
        const active=button.id==='market-tab-'+marketplaceState.tab;
        button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active));
    });
    const tools=document.getElementById('market-tools'); if(tools) tools.hidden=marketplaceState.tab==='mine';
    closeMarketSheet(); renderMarketplace();
}
async function loadMarketCatalog(force=false) {
    if(!force&&marketplaceState.catalog.length&&Date.now()-marketplaceState.catalogLoadedAt<60*1000) return;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try {
        const [response,images]=await Promise.all([
            fetch(marketApiUrl('/api/market/catalog'),{cache:'no-store',signal:controller.signal}),
            fetch('/assets/market-gifts/catalog-images.json?v=20261112',{signal:controller.signal}).then(r=>r.ok?r.json():{}).catch(()=>({}))
        ]);
        marketplaceState.imageMap=images||{};
        const data=await response.json();
        if(!response.ok||!data.ok) throw new Error(data.error||mt('catalogFailed'));
        marketplaceState.catalog=data.catalog||[]; marketplaceState.marketInfo=data.market||{};marketplaceState.catalogLoadedAt=Date.now();
    } catch(error) { if(!marketplaceState.catalog.length) throw error; } finally{clearTimeout(timer);}
}
async function loadMarketplace(append=false) {
    const seq=++marketplaceState.request;
    if(marketplaceState.controller) marketplaceState.controller.abort();
    const controller=new AbortController(); marketplaceState.controller=controller;
    marketplaceState.loading=true; marketplaceState.error='';
    if(!append) { marketplaceState.nextOffset=0; marketplaceState.hasMore=false; }
    renderMarketplace();
    // Catalog is a read-only, cached request; never run a Telegram verification sweep here.
    const catalogPromise=loadMarketCatalog().catch(()=>{});
    try {
        const params=new URLSearchParams({limit:'40',offset:String(append?marketplaceState.nextOffset:0)});
        Object.entries(marketplaceState.filters).forEach(([key,value])=>{if(value!=='') params.set(key,String(value));});
        const selected=marketplaceState.selectedCollections;
        if(selected.length>1&&selected.length<marketplaceState.catalog.length){params.delete('collection');params.set('collections',JSON.stringify(selected));}
        if(marketplaceState.selectedBackdrops.length>1){params.delete('backdrop');params.set('backdrops',JSON.stringify(marketplaceState.selectedBackdrops));}
        const response=await fetch(marketApiUrl('/api/market/items?'+params),{headers:marketAuthHeaders(),cache:'no-store',signal:controller.signal});
        const data=await response.json();
        if(seq!==marketplaceState.request) return;
        if(!response.ok||!data.ok) throw new Error(response.status===401?mt('login'):data.error||mt('loadFailed'));
        marketplaceState.listings=append?marketplaceState.listings.concat(data.listings||[]):(data.listings||[]);
        marketplaceState.collectibles=data.myCollectibles||data.collectibles||[];
        if(data.catalog?.length&&!marketplaceState.catalog.length) marketplaceState.catalog=data.catalog;
        marketplaceState.options=data.filters||data.options||{models:[],backdrops:[],symbols:[]};
        const pagination=data.pagination||data;
        marketplaceState.hasMore=!!pagination.hasMore;
        marketplaceState.nextOffset=pagination.nextOffset??marketplaceState.listings.length;
    } catch(error) {
        if(error.name==='AbortError'||seq!==marketplaceState.request) return;
        marketplaceState.error=error.message||mt('loadFailed');
        if(!append) marketplaceState.listings=[];
    } finally {
        await catalogPromise;
        if(seq===marketplaceState.request) { marketplaceState.loading=false; renderMarketplace(); }
    }
}
function marketFilterLabel(key) { return key==='collection'?'NFT':mt(key); }
function updateMarketFilterButtons() {
    Object.entries(marketplaceState.filters).forEach(([key,value])=>{
        const button=document.getElementById('market-filter-'+key); if(!button) return;
        button.textContent=key==='collection'&&marketplaceState.selectedCollections.length>1?'NFT · '+marketplaceState.selectedCollections.length:value!=='' ? (key==='maxPrice'?'≤ '+value+' TON':key==='number'?'#'+value:value) : marketFilterLabel(key)+' ▾';
        button.dataset.active=String(value!==''||key==='collection'&&marketplaceState.selectedCollections.length>0);
        if(key==='backdrop'&&marketplaceState.selectedBackdrops.length>1){button.textContent=mt('backdrop')+' · '+marketplaceState.selectedBackdrops.length;button.dataset.active='true';}
        button.title=marketFilterLabel(key)+(value!==''?' — '+value:'');
    });
    const summary=document.getElementById('market-selection-text');
    if(summary) summary.textContent=marketplaceState.selectedCollections.length?mt('selected',{count:marketplaceState.selectedCollections.length}):mt('hint');
}
function marketNumber(item) { return item.collectibleNumber??item.collectible_number??null; }
function marketPrice(item) { const price=Number(item.priceTon??item.price_ton??item.marketValue??item.value??0); return Number.isFinite(price)?price:0; }
function renderMarketplace() {
    const grid=document.getElementById('market-grid'),status=document.getElementById('market-status'); if(!grid||!status) return;
    updateMarketFilterButtons(); grid.replaceChildren();
    const owned=marketplaceState.collectibles.filter(item=>String(item.status||item.ownershipStatus||'').toUpperCase()==='OWNED'&&!!(item.collectibleId||item.uniqueCollectibleId||item.unique_collectible_id||(!String(item.id||'').startsWith('pending:')&&item.id)));
    const mine=marketplaceState.tab==='mine'; const items=mine?owned:marketplaceState.listings;
    status.textContent=marketplaceState.loading?mt('loading'):marketplaceState.error||
        (mine?mt('owned'):(items.length?mt('available',{count:items.length})+(marketplaceState.hasMore?' +':''):mt('none')));
    if(!items.length&&!marketplaceState.loading) {
        const empty=marketElement('div','market-empty');
        empty.appendChild(marketElement('strong','',marketplaceState.error?mt('errorTitle'):mine?mt('emptyMine'):mt('unavailable')));
        empty.appendChild(marketElement('span','',marketplaceState.error?mt('retry'):mine?mt('mineHint'):marketplaceState.selectedCollections.length
            ? mt('noMatch')
            : mt('noGift')));
        grid.appendChild(empty);
    }
    items.forEach(item=>{
        const card=marketElement('article','market-card'); card.appendChild(marketArtwork(item));
        const body=marketElement('div','market-card-body');
        body.appendChild(marketElement('h3','',item.baseName||item.name||mt('genericGift')));
        const number=marketNumber(item); body.appendChild(marketElement('p','',number!==null?'#'+number:mt('verified')));
        const traits=[item.model,item.backdrop,item.symbol].map(value=>typeof value==='object'?value?.name:value).filter(Boolean);
        body.appendChild(marketElement('p','market-attributes',traits.join(' · ')||mt('genericGift')));
        const price=marketElement('div','market-price'); const ton=marketElement('img'); ton.src='/assets/ton-icon.svg';ton.alt='TON';
        price.append(ton,marketElement('span','',marketPrice(item).toLocaleString('en-US',{maximumFractionDigits:4})+' TON')); body.appendChild(price);
        const id=item.collectibleId||item.uniqueCollectibleId||item.unique_collectible_id||item.id;
        if(mine) {
            const list=marketElement('button','market-action',mt('list')); list.type='button';list.onclick=()=>marketList(id);body.appendChild(list);
            const sell=marketElement('button','market-action secondary',mt('instant'));sell.type='button';sell.onclick=()=>marketInstantSell(id);body.appendChild(sell);
        } else {
            const buy=marketElement('button','market-action',mt('buy'));buy.type='button';buy.disabled=marketplaceState.loading||marketplaceState.error!=='';buy.onclick=()=>marketBuy(item.id,marketPrice(item));body.appendChild(buy);
        }
        card.appendChild(body);grid.appendChild(card);
    });
    const more=document.getElementById('market-more');if(more){more.hidden=mine||!marketplaceState.hasMore;more.disabled=marketplaceState.loading;}
}
function setMarketFilter(key,value) {
    if(!(key in marketplaceState.filters)) return;
    marketplaceState.filters[key]=String(value??'').trim();if(key==='collection')marketplaceState.selectedCollections=value?[String(value)]:[];closeMarketSheet();loadMarketplace();
}
function clearMarketFilters() {
    Object.keys(marketplaceState.filters).forEach(key=>marketplaceState.filters[key]='');marketplaceState.selectedCollections=[];marketplaceState.selectedBackdrops=[];
    const search=document.getElementById('market-search');if(search)search.value='';
    closeMarketSheet();loadMarketplace();
}
function marketSearchChanged(value) {
    marketplaceState.filters.search=String(value||'').trim();
    clearTimeout(marketplaceState.debounce);marketplaceState.debounce=setTimeout(()=>loadMarketplace(),300);
}
function closeMarketSheet() {
    const sheet=document.getElementById('market-sheet');if(sheet)sheet.hidden=true;
    marketplaceState.sheet=null;
    const button=document.getElementById('market-filter-'+marketplaceState.lastFilter);if(button)button.focus({preventScroll:true});
}
function ensureMarketPortal(){
    const sheet=document.getElementById('market-sheet');if(!sheet)return;
    let root=document.getElementById('market-modal-root');if(!root){root=marketElement('div');root.id='market-modal-root';document.body.appendChild(root);}
    if(sheet.parentElement!==root)root.appendChild(sheet);
}
async function openMarketFilter(key) {
    if(!['collection','model','backdrop','symbol','maxPrice','number'].includes(key)) return;
    ensureMarketPortal();
    const sheet=document.getElementById('market-sheet'),content=document.getElementById('market-sheet-content'),search=document.getElementById('market-sheet-search');
    if(!sheet||!content||!search) return;
    marketplaceState.sheet=key;marketplaceState.lastFilter=key;sheet.hidden=false;sheet.dataset.kind=key;
    if(['model','symbol'].includes(key)){const selected=marketplaceState.selectedCollections;marketplaceState.traitCollection=selected.length===1?selected[0]:selected.length===0?marketplaceState.filters.collection:'';marketplaceState.traitView=marketplaceState.traitCollection?'traits':'collections';marketplaceState.traitData=null;marketplaceState.traitError='';}
    if(key==='collection')marketplaceState.draftCollections=[...marketplaceState.selectedCollections];
    if(key==='backdrop'){marketplaceState.draftBackdrops=[...marketplaceState.selectedBackdrops];marketplaceState.backdropData=null;marketplaceState.backdropLoading=true;marketplaceState.backdropError='';}
    document.getElementById('market-sheet-title').textContent=key==='collection'?mt('collection'):marketFilterLabel(key);
    search.value='';search.hidden=['maxPrice','number'].includes(key);
    search.placeholder=key==='collection'?mt('searchCollection'):mt('searchOptions',{name:marketFilterLabel(key)});
    renderMarketPicker();
    if(key==='collection'&&!marketplaceState.catalog.length) { content.textContent=mt('catalogLoading');try {await loadMarketCatalog();if(marketplaceState.sheet===key)renderMarketPicker();}catch{content.textContent=mt('picturesFailed');} }
    if(['model','symbol'].includes(key)&&marketplaceState.traitCollection)await loadMarketTraits(marketplaceState.traitCollection,key);
    if(['model','symbol'].includes(key)&&!marketplaceState.catalog.length){try{await loadMarketCatalog();if(marketplaceState.sheet===key)renderMarketPicker();}catch{}}
    if(key==='backdrop')await loadMarketBackdrops();
    search.focus({preventScroll:true});
}
function marketPickerSearch() { renderMarketPicker(); }
function renderMarketPicker() {
    const key=marketplaceState.sheet,content=document.getElementById('market-sheet-content'),search=document.getElementById('market-sheet-search');if(!key||!content) return;
    content.replaceChildren();const query=(search?.value||'').trim().toLowerCase();
    if(key==='maxPrice'||key==='number') {
        content.appendChild(marketElement('p','market-sheet-note',key==='maxPrice'?mt('priceNote'):mt('numberNote')));
        const label=marketElement('label','market-field-label',key==='maxPrice'?mt('maxPriceLabel'):mt('number'));label.htmlFor='market-value-input';
        const input=marketElement('input','market-sheet-input');input.id='market-value-input';input.type='number';input.min=key==='number'?'1':'0';input.step=key==='number'?'1':'any';input.inputMode=key==='number'?'numeric':'decimal';input.value=marketplaceState.filters[key];input.placeholder=key==='number'?mt('exampleNumber'):mt('examplePrice');
        const apply=marketElement('button','market-sheet-apply',mt('apply'));apply.type='button';apply.onclick=()=>{
            const val=input.value.trim();const n=Number(val);
            if(val&&(!Number.isFinite(n)||n<(key==='number'?1:0)||(key==='number'&&!Number.isSafeInteger(n)))) { input.setCustomValidity(mt('validValue'));input.reportValidity();return; }
            setMarketFilter(key,val);
        };
        const reset=marketElement('button','market-option',mt('removeFilter'));reset.type='button';reset.onclick=()=>setMarketFilter(key,'');content.append(label,input,apply,reset);return;
    }
    if(key==='collection') { renderMarketCollections(content,query); return; }
    if(key==='backdrop'){renderMarketBackdrops(content,query);return;}
    renderMarketTraits(content,query);
}
async function marketList(id) {
    const price=prompt(mt('listPrice'));if(!price||!Number.isFinite(Number(price))||Number(price)<=0)return;
    await marketAction('/api/market/list',{collectibleId:id,priceTon:Number(price)},mt('listed'));
}
async function marketBuy(id,price) {
    if(!confirm(mt('buyConfirm',{amount:price})))return;
    await marketAction('/api/market/buy',{listingId:id},mt('bought'));
}
async function marketInstantSell(id) {
    if(!confirm(mt('instantConfirm')))return;
    await marketAction('/api/market/instant-sell',{collectibleId:id},mt('sold'));
}
async function marketAction(path,body,success) {
    try {
        const response=await fetch(marketApiUrl(path),{method:'POST',headers:marketAuthHeaders(),body:JSON.stringify(body)}),data=await response.json();
        if(!response.ok||!data.ok)throw new Error(data.error||mt('failed'));
        showToast(success);await loadMarketplace();if(typeof fetchBalance==='function')await fetchBalance();
    } catch(error) {showToast(error.message||mt('failed'));}
}
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&marketplaceState.sheet){event.preventDefault();closeMarketSheet();}});

function marketMetric(value,kind){
    if(value==null||!Number.isFinite(Number(value)))return '—';
    const result=marketElement('span','market-metric-value');
    const ton=marketElement('img');ton.src='/assets/ton-icon.svg';ton.alt='TON';
    result.append(ton,marketElement('span','',Number(value).toLocaleString('en-US',{maximumFractionDigits:2})));
    return result;
}
function renderMarketCollections(content,query){
    const selected=new Set(marketplaceState.draftCollections);
    const names=marketplaceState.catalog.map(item=>item.baseName||item.name);
    const controls=marketElement('div','market-collection-header');
    const allLabel=marketElement('label','market-select-all');const all=marketElement('input');all.type='checkbox';all.id='market-select-all';all.checked=names.length>0&&names.every(name=>selected.has(name));all.indeterminate=selected.size>0&&!all.checked;
    all.onchange=()=>{marketplaceState.draftCollections=all.checked?[...names]:[];renderMarketPicker();};
    allLabel.append(all,marketElement('span','',mt('all')));controls.appendChild(allLabel);
    for(const key of ['floor','volume']){
        const sort=marketElement('button','market-sort',mt(key)+' ↕');sort.type='button';sort.dataset.sort=key;
        sort.title=mt(key==='floor'?'sortFloor':'sortVolume');sort.onclick=()=>{const state=marketplaceState.collectionSort;marketplaceState.collectionSort={key,direction:state.key===key?-state.direction:1};renderMarketPicker();};controls.appendChild(sort);
    }
    content.appendChild(controls);
    const list=marketElement('div','market-collection-list');
    const items=marketplaceState.catalog.filter(item=>String(item.baseName||item.name||'').toLowerCase().includes(query));
    const sort=marketplaceState.collectionSort;
    items.sort((a,b)=>{
        if(sort.key==='name')return String(a.baseName||a.name).localeCompare(String(b.baseName||b.name),'en');
        const field=sort.key==='floor'?'marketFloorTon':'volumeTon';const av=a[field],bv=b[field];
        if(av==null&&bv!=null)return 1;if(bv==null&&av!=null)return -1;
        return ((Number(av)||0)-(Number(bv)||0))*sort.direction;
    });
    items.forEach(item=>{
        const name=item.baseName||item.name;const row=marketElement('label','market-collection-row');row.dataset.collection=name;
        const checkbox=marketElement('input','market-collection-checkbox');checkbox.type='checkbox';checkbox.checked=selected.has(name);checkbox.setAttribute('aria-label',mt('selectGift',{name}));
        checkbox.onchange=()=>{const values=new Set(marketplaceState.draftCollections);if(checkbox.checked)values.add(name);else values.delete(name);marketplaceState.draftCollections=[...values];const all=document.getElementById('market-select-all');all.checked=names.every(n=>values.has(n));all.indeterminate=values.size>0&&!all.checked;row.dataset.selected=String(checkbox.checked);};
        row.dataset.selected=String(checkbox.checked);row.append(checkbox,marketArtwork(item),marketElement('span','market-collection-name',name));
        const metrics=marketElement('div','market-collection-metrics');
        const floor=marketElement('div','market-collection-floor');floor.title=marketPriceTitle(item);const floorMetric=marketMetric(item.marketFloorTon,'floor');floor.append(floorMetric);const change=marketElement('small','market-price-change');const pct=item.marketChange24hPct;if(pct!=null&&Number.isFinite(Number(pct))){change.textContent=(Number(pct)>0?'+':'')+Number(pct).toFixed(2)+'%';change.dataset.trend=Number(pct)>0?'up':Number(pct)<0?'down':'flat';change.title=mt('change24h');}else{change.textContent='—';change.title=mt('changeMissing');}floor.appendChild(change);
        const volume=marketElement('div','market-collection-volume');volume.title=mt('volume')+' · '+mt('shop');const volumeMetric=marketMetric(item.volumeTon,'volume');volume.append(volumeMetric);
        metrics.append(floor,volume);row.appendChild(metrics);list.appendChild(row);
    });
    if(!items.length)list.appendChild(marketElement('p','market-sheet-note',mt('notFound')));
    content.appendChild(list);
    const source=marketElement('p','market-price-source',marketSummary());content.appendChild(source);
    const footer=marketElement('div','market-collection-footer');const reset=marketElement('button','market-collection-reset',mt('reset'));reset.type='button';reset.onclick=()=>{marketplaceState.draftCollections=[];marketplaceState.collectionSort={key:'name',direction:1};document.getElementById('market-sheet-search').value='';renderMarketPicker();};
    const apply=marketElement('button','market-collection-apply',mt('show'));apply.type='button';apply.onclick=()=>{
        const names=[...marketplaceState.draftCollections];marketplaceState.selectedCollections=names;
        marketplaceState.filters.collection=names.length===1?names[0]:'';
        marketplaceState.filters.model='';marketplaceState.filters.backdrop='';marketplaceState.filters.symbol='';marketplaceState.selectedBackdrops=[];
        closeMarketSheet();loadMarketplace();
    };footer.append(reset,apply);content.appendChild(footer);
}
function updateMarketLanguage(){
    const pairs={'.market-hero h2':'title','.market-hero p':'subtitle','#market-tab-shop':'shop','#market-tab-mine':'mine','#market-filter-clear':'clear','#market-more':'more','#nav-market-text':'store','#nav-home-text':'playHub'};
    Object.entries(pairs).forEach(([selector,key])=>{const element=document.querySelector(selector);if(element)element.textContent=mt(key);});
    const search=document.getElementById('market-search');if(search){search.placeholder=mt('search');search.setAttribute('aria-label',mt('search'));}
    const refresh=document.querySelector('#market-page .market-refresh');if(refresh)refresh.setAttribute('aria-label',mt('refresh'));
    const close=document.querySelector('#market-sheet .market-sheet-close');if(close)close.setAttribute('aria-label',mt('close'));
    const sheetSearch=document.getElementById('market-sheet-search');if(sheetSearch)sheetSearch.setAttribute('aria-label',mt('searchCollection'));
    const play=document.getElementById('nav-home');if(play)play.setAttribute('aria-label',mt('playHub'));
    renderMarketplace();
    if(marketplaceState.sheet){const key=marketplaceState.sheet;document.getElementById('market-sheet-title').textContent=key==='collection'?mt('collection'):marketFilterLabel(key);sheetSearch.placeholder=key==='collection'?mt('searchCollection'):mt('searchOptions',{name:marketFilterLabel(key)});renderMarketPicker();}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',updateMarketLanguage,{once:true});else updateMarketLanguage();

function marketPriceTitle(item){
    const time=item.marketUpdatedAt?new Date(item.marketUpdatedAt):null;
    const updated=time&&Number.isFinite(time.getTime())?time.toLocaleString(marketLanguage()==='ar'?'ar':marketLanguage()==='ru'?'ru-RU':'en-GB'):mt('notAvailable');
    return mt('externalFloor')+' · '+mt('updated',{time:updated})+(item.marketPriceStatus==='stale'?' · '+mt('stalePrice'):'');
}
function marketSummary(){
    const latest=marketplaceState.catalog.find(item=>item.marketUpdatedAt);
    if(!latest)return mt('marketUnavailable');
    const time=new Date(latest.marketUpdatedAt);
    const text=mt('priceSource')+' · '+mt('updated',{time:time.toLocaleTimeString(marketLanguage()==='ar'?'ar':marketLanguage()==='ru'?'ru-RU':'en-GB',{hour:'2-digit',minute:'2-digit'})})+' · '+mt('change24h');
    return text+(latest.marketPriceStatus==='stale'?' · '+mt('stalePrice'):'');
}
function refreshMarketCollectionSheet(){
    if(marketplaceState.sheet!=='collection')return;
    const scroll=document.querySelector('#market-sheet .market-collection-list')?.scrollTop||0;
    renderMarketPicker();const list=document.querySelector('#market-sheet .market-collection-list');if(list)list.scrollTop=scroll;
}
setInterval(()=>{
    if(document.hidden)return;
    const visible=marketplaceState.sheet==='collection'||document.getElementById('market-page')?.classList.contains('show');
    if(visible)loadMarketCatalog().then(refreshMarketCollectionSheet).catch(()=>{});
},60000);

async function loadMarketTraits(collection,kind,force=false){
    const seq=++marketplaceState.traitRequest,key=kind+'|'+collection;
    marketplaceState.traitCollection=collection;marketplaceState.traitView='traits';marketplaceState.traitLoading=true;marketplaceState.traitError='';
    marketplaceState.traitData=null;document.getElementById('market-sheet-search').value='';renderMarketPicker();
    try{
        const cache=marketplaceState.traitCache.get(key);
        let data=cache&&Date.now()-cache.loadedAt<60000&&!force?cache.data:null;
        if(!data){const params=new URLSearchParams({collection,kind});const response=await fetch(marketApiUrl('/api/market/traits?'+params),{cache:'no-store'});data=await response.json();if(!response.ok||!data.ok)throw new Error(mt('modelsUnavailable'));marketplaceState.traitCache.set(key,{data,loadedAt:Date.now()});}
        if(seq!==marketplaceState.traitRequest||marketplaceState.sheet!==kind)return;
        marketplaceState.traitData=data;
    }catch(error){if(seq===marketplaceState.traitRequest)marketplaceState.traitError=mt('modelsUnavailable');}
    finally{if(seq===marketplaceState.traitRequest){marketplaceState.traitLoading=false;if(marketplaceState.sheet===kind)renderMarketPicker();}}
}
function renderMarketTraits(content,query){
    const key=marketplaceState.sheet,search=document.getElementById('market-sheet-search');
    if(marketplaceState.traitView==='collections'){
        if(search)search.placeholder=mt('searchCollection');
        content.appendChild(marketElement('p','market-sheet-note',mt(key==='model'?'chooseModelCollection':'chooseTraitCollection')));
        const selected=marketplaceState.selectedCollections;
        const scope=selected.length&&selected.length<marketplaceState.catalog.length?marketplaceState.catalog.filter(item=>selected.includes(item.baseName||item.name)):marketplaceState.catalog;
        const list=marketElement('div','market-trait-collections');
        scope.filter(item=>String(item.baseName||item.name).toLowerCase().includes(query)).forEach(item=>{
            const name=item.baseName||item.name,button=marketElement('button','market-trait-collection');button.type='button';button.dataset.collection=name;button.appendChild(marketArtwork(item));
            const body=marketElement('span','market-trait-collection-body');const title=marketElement('span','market-trait-name',name);title.dataset.i18nPreserve='';body.append(title,marketElement('small','',mt('localOffers',{count:item.listingCount||0})));button.appendChild(body);
            button.onclick=()=>loadMarketTraits(name,key);list.appendChild(button);
        });
        if(!list.children.length)list.appendChild(marketElement('p','market-sheet-note',mt('notFound')));
        content.appendChild(list);return;
    }
    if(search)search.placeholder=key==='model'?mt('modelSearch'):mt('searchOptions',{name:marketFilterLabel(key)});
    const back=marketElement('button','market-trait-back',mt('backCollections'));back.type='button';back.onclick=()=>{++marketplaceState.traitRequest;marketplaceState.traitView='collections';marketplaceState.traitCollection='';marketplaceState.traitData=null;marketplaceState.traitLoading=false;search.value='';renderMarketPicker();};content.appendChild(back);
    const collection=marketElement('h4','market-trait-collection-title',marketplaceState.traitCollection);collection.dataset.i18nPreserve='';content.appendChild(collection);
    content.appendChild(marketElement('p','market-sheet-note market-counts-note',mt('countsMeaning')));
    if(marketplaceState.traitLoading){content.appendChild(marketElement('p','market-sheet-note',mt(key==='model'?'modelsLoading':'attributesLoading')));return;}
    if(marketplaceState.traitError){content.appendChild(marketElement('p','market-sheet-note',marketplaceState.traitError));const retry=marketElement('button','market-option',mt('retryModels'));retry.type='button';retry.onclick=()=>loadMarketTraits(marketplaceState.traitCollection,key,true);content.appendChild(retry);return;}
    const data=marketplaceState.traitData||{},options=data.traits||[];
    if(data.complete===false)content.appendChild(marketElement('p','market-sheet-note market-partial-warning',mt('modelsIncomplete')));
    const all=marketElement('button','market-option',mt(key==='model'?'clearModels':'clearAttributes'));all.type='button';all.onclick=()=>applyMarketTrait(key,'',marketplaceState.traitCollection);content.appendChild(all);
    const list=marketElement('div','market-trait-list');
    options.filter(item=>String(item.name||'').toLowerCase().includes(query)).forEach(item=>{
        const button=marketElement('button','market-trait-option');button.type='button';button.dataset.model=item.name;
        if(item.imageUrl){const art=marketElement('div','market-model-art'),image=marketElement('img');image.alt=item.name;image.loading='lazy';image.decoding='async';const src=marketSafeImage(item.imageUrl);if(src){image.src=src;image.onerror=()=>art.remove();art.appendChild(image);button.appendChild(art);}}
        const body=marketElement('div','market-trait-option-body');const label=marketElement('span','market-trait-name',item.name);label.dataset.i18nPreserve='';body.appendChild(label);
        body.appendChild(marketElement('small','market-trait-count',mt('modelOffers',{count:Number(item.count)||0})));
        if(item.totalIssued!=null&&Number.isSafeInteger(Number(item.totalIssued))&&Number(item.totalIssued)>=0)body.appendChild(marketElement('small','market-trait-issued',mt('issuedCount',{count:Number(item.totalIssued)})));
        button.appendChild(body);if(item.marketFloorTon!=null)button.appendChild(marketMetric(item.marketFloorTon));button.onclick=()=>applyMarketTrait(key,item.name,marketplaceState.traitCollection);list.appendChild(button);
    });
    if(!list.children.length)list.appendChild(marketElement('p','market-sheet-note',mt('notFound')));
    content.appendChild(list);
    if(query){const exact=marketElement('button','market-sheet-apply',mt('searchExact',{name:search.value.trim()}));exact.type='button';exact.onclick=()=>applyMarketTrait(key,search.value.trim(),marketplaceState.traitCollection);content.appendChild(exact);}
}
function applyMarketTrait(key,value,collection){
    const existing=marketplaceState.filters.collection;
    marketplaceState.selectedCollections=[collection];marketplaceState.filters.collection=collection;
    if(existing!==collection){marketplaceState.filters.model='';marketplaceState.filters.backdrop='';marketplaceState.filters.symbol='';marketplaceState.selectedBackdrops=[];}
    setMarketFilter(key,value);
}

async function loadMarketBackdrops(){
    const seq=++marketplaceState.backdropRequest;marketplaceState.backdropLoading=true;marketplaceState.backdropError='';renderMarketPicker();
    const selected=marketplaceState.selectedCollections;
    const collection=selected.length===1?selected[0]:selected.length===0?marketplaceState.filters.collection:'';
    const params=new URLSearchParams({kind:'backdrop'});if(collection)params.set('collection',collection);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{const response=await fetch(marketApiUrl('/api/market/traits?'+params),{cache:'no-store',signal:controller.signal});const data=await response.json();if(!response.ok||!data.ok)throw new Error(mt('backdropsUnavailable'));if(seq===marketplaceState.backdropRequest)marketplaceState.backdropData=data;}
    catch{if(seq===marketplaceState.backdropRequest)marketplaceState.backdropError=mt('backdropsUnavailable');}
    finally{clearTimeout(timer);if(seq===marketplaceState.backdropRequest){marketplaceState.backdropLoading=false;if(marketplaceState.sheet==='backdrop')renderMarketPicker();}}
}
function renderMarketBackdrops(content,query){
    if(marketplaceState.backdropLoading){content.appendChild(marketElement('p','market-sheet-note',mt('backdropsLoading')));return;}
    if(marketplaceState.backdropError){content.appendChild(marketElement('p','market-sheet-note',marketplaceState.backdropError));const retry=marketElement('button','market-option',mt('retryModels'));retry.type='button';retry.onclick=loadMarketBackdrops;content.appendChild(retry);return;}
    const data=marketplaceState.backdropData||{},options=[...(data.traits||[])].sort((a,b)=>a.name==='Black'?-1:b.name==='Black'?1:a.name.localeCompare(b.name,'en'));const selected=new Set(marketplaceState.draftBackdrops),names=options.map(item=>item.name);
    const header=marketElement('div','market-backdrop-header'),label=marketElement('label','market-select-all'),all=marketElement('input');all.type='checkbox';all.id='market-backdrop-select-all';all.checked=names.length>0&&names.every(name=>selected.has(name));all.indeterminate=selected.size>0&&!all.checked;
    all.onchange=()=>{marketplaceState.draftBackdrops=all.checked?[...names]:[];renderMarketPicker();};label.append(all,marketElement('span','',mt('all')));header.appendChild(label);content.appendChild(header);
    const list=marketElement('div','market-backdrop-list');
    options.filter(item=>String(item.name).toLowerCase().includes(query)).forEach(item=>{
        const row=marketElement('label','market-backdrop-row');row.dataset.backdrop=item.name;
        const checkbox=marketElement('input','market-collection-checkbox');checkbox.type='checkbox';checkbox.checked=selected.has(item.name);checkbox.setAttribute('aria-label',mt('selectBackdrop',{name:item.name}));
        checkbox.onchange=()=>{const values=new Set(marketplaceState.draftBackdrops);if(checkbox.checked)values.add(item.name);else values.delete(item.name);marketplaceState.draftBackdrops=[...values];all.checked=names.every(name=>values.has(name));all.indeterminate=values.size>0&&!all.checked;};
        const swatch=marketElement('span','market-backdrop-swatch');const color=value=>typeof value==='string'&&/^#[0-9a-fA-F]{6}$/.test(value)?value:null;
        const center=color(item.centerColor),edge=color(item.edgeColor);if(center&&edge)swatch.style.background='radial-gradient(ellipse at center,'+center+','+edge+')';else swatch.textContent='?';
        const body=marketElement('span','market-backdrop-name-wrap'),name=marketElement('span','market-trait-name',item.name);name.dataset.i18nPreserve='';body.appendChild(name);
        const rarity=marketElement('small','market-backdrop-rarity');const r=item.rarityPermille;
        if(r!=null&&Number.isFinite(Number(r))&&Number(r)>=0&&Number(r)<=1000){rarity.textContent=(Number(r)/10).toLocaleString('en-US',{maximumFractionDigits:2})+'%';rarity.title=mt('rarity');}else{rarity.textContent=mt('rarityUnknown');rarity.dataset.unknown='true';}
        body.appendChild(rarity);row.append(checkbox,swatch,body);list.appendChild(row);
    });
    if(!list.children.length)list.appendChild(marketElement('p','market-sheet-note',mt('notFound')));content.appendChild(list);
    if(data.rarityScope!=='collection')content.appendChild(marketElement('p','market-price-source',mt(data.collection?'rarityFetchFailed':'rarityScopeNote')));
    const footer=marketElement('div','market-collection-footer'),reset=marketElement('button','market-collection-reset',mt('reset')),apply=marketElement('button','market-collection-apply',mt('show'));
    reset.type='button';reset.onclick=()=>{marketplaceState.draftBackdrops=[];document.getElementById('market-sheet-search').value='';renderMarketPicker();};apply.type='button';apply.onclick=()=>{marketplaceState.selectedBackdrops=[...marketplaceState.draftBackdrops];marketplaceState.filters.backdrop=marketplaceState.selectedBackdrops.length===1?marketplaceState.selectedBackdrops[0]:'';closeMarketSheet();loadMarketplace();};footer.append(reset,apply);content.appendChild(footer);
}
function initializeMarketplaceShell(){
    const page=document.getElementById('market-page');if(!page)return;
    const sync=()=>document.body.classList.toggle('market-mode',page.classList.contains('show'));
    new MutationObserver(sync).observe(page,{attributes:true,attributeFilter:['class']});sync();
    if(page.classList.contains('show')&&!marketplaceState.loading)loadMarketplace();
    const button=document.getElementById('nav-home');if(button)button.setAttribute('aria-label',mt('playHub'));
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initializeMarketplaceShell,{once:true});else initializeMarketplaceShell();
