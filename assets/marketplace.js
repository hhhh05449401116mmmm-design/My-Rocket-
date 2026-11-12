'use strict';
// Existing marketplace only: no game loops, fake listings or external purchases.
let marketplaceState = {
    tab: 'shop', catalog: [], listings: [], collectibles: [], selectedCollections:[], draftCollections:[], collectionSort:{key:'name',direction:1},
    filters: { collection:'', model:'', backdrop:'', symbol:'', maxPrice:'', number:'', search:'' },
    options: { models:[], backdrops:[], symbols:[] }, nextOffset:0, hasMore:false,
    sheet:null, catalogLoadedAt:0, imageMap:{}, loading:false, error:'', request:0, controller:null, debounce:null
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
async function loadMarketCatalog() {
    if(marketplaceState.catalog.length&&Date.now()-marketplaceState.catalogLoadedAt<15*60*1000) return;
    try {
        const [response,images]=await Promise.all([
            fetch(marketApiUrl('/api/market/catalog'),{cache:'no-store'}),
            fetch('/assets/market-gifts/catalog-images.json?v=20261112').then(r=>r.ok?r.json():{}).catch(()=>({}))
        ]);
        marketplaceState.imageMap=images||{};
        const data=await response.json();
        if(!response.ok||!data.ok) throw new Error(data.error||mt('catalogFailed'));
        marketplaceState.catalog=data.catalog||[]; marketplaceState.catalogLoadedAt=Date.now();
    } catch(error) { if(!marketplaceState.catalog.length) throw error; }
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
    Object.keys(marketplaceState.filters).forEach(key=>marketplaceState.filters[key]='');marketplaceState.selectedCollections=[];
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
async function openMarketFilter(key) {
    if(!['collection','model','backdrop','symbol','maxPrice','number'].includes(key)) return;
    const sheet=document.getElementById('market-sheet'),content=document.getElementById('market-sheet-content'),search=document.getElementById('market-sheet-search');
    if(!sheet||!content||!search) return;
    marketplaceState.sheet=key;marketplaceState.lastFilter=key;sheet.hidden=false;sheet.dataset.kind=key;
    if(key==='collection')marketplaceState.draftCollections=[...marketplaceState.selectedCollections];
    document.getElementById('market-sheet-title').textContent=key==='collection'?mt('collection'):marketFilterLabel(key);
    search.value='';search.hidden=['maxPrice','number'].includes(key);
    search.placeholder=key==='collection'?mt('searchCollection'):mt('searchOptions',{name:marketFilterLabel(key)});
    renderMarketPicker();
    if(key==='collection'&&!marketplaceState.catalog.length) { content.textContent=mt('catalogLoading');try {await loadMarketCatalog();if(marketplaceState.sheet===key)renderMarketPicker();}catch{content.textContent=mt('picturesFailed');} }
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
    const optionKey={model:'models',backdrop:'backdrops',symbol:'symbols'}[key];
    const options=(marketplaceState.options[optionKey]||[]).map(value=>typeof value==='object'?value.name:value).filter(Boolean);
    content.appendChild(marketElement('p','market-sheet-note',mt('traitsNote')));
    const all=marketElement('button','market-option',mt('allOptions'));all.type='button';all.onclick=()=>setMarketFilter(key,'');content.appendChild(all);
    options.filter(value=>String(value).toLowerCase().includes(query)).forEach(value=>{const button=marketElement('button','market-option',value);button.type='button';button.onclick=()=>setMarketFilter(key,value);content.appendChild(button);});
    if(query) {const exact=marketElement('button','market-sheet-apply',mt('searchExact',{name:search.value.trim()}));exact.type='button';exact.onclick=()=>setMarketFilter(key,search.value);content.appendChild(exact);}
    if(!options.length) content.appendChild(marketElement('p','market-sheet-note',mt('noTraits')));
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
        const field=sort.key==='floor'?'minPriceTon':'volumeTon';const av=a[field],bv=b[field];
        if(av==null&&bv!=null)return 1;if(bv==null&&av!=null)return -1;
        return ((Number(av)||0)-(Number(bv)||0))*sort.direction;
    });
    items.forEach(item=>{
        const name=item.baseName||item.name;const row=marketElement('label','market-collection-row');row.dataset.collection=name;
        const checkbox=marketElement('input','market-collection-checkbox');checkbox.type='checkbox';checkbox.checked=selected.has(name);checkbox.setAttribute('aria-label',mt('selectGift',{name}));
        checkbox.onchange=()=>{const values=new Set(marketplaceState.draftCollections);if(checkbox.checked)values.add(name);else values.delete(name);marketplaceState.draftCollections=[...values];const all=document.getElementById('market-select-all');all.checked=names.every(n=>values.has(n));all.indeterminate=values.size>0&&!all.checked;row.dataset.selected=String(checkbox.checked);};
        row.dataset.selected=String(checkbox.checked);row.append(checkbox,marketArtwork(item),marketElement('span','market-collection-name',name));
        const metrics=marketElement('div','market-collection-metrics');
        const floor=marketElement('div','market-collection-floor');floor.title=mt('floor')+' · '+mt('shop');const floorMetric=marketMetric(item.minPriceTon,'floor');floor.append(floorMetric);
        const volume=marketElement('div','market-collection-volume');volume.title=mt('volume')+' · '+mt('shop');const volumeMetric=marketMetric(item.volumeTon,'volume');volume.append(volumeMetric);
        metrics.append(floor,volume);row.appendChild(metrics);list.appendChild(row);
    });
    if(!items.length)list.appendChild(marketElement('p','market-sheet-note',mt('notFound')));
    content.appendChild(list);
    const footer=marketElement('div','market-collection-footer');const reset=marketElement('button','market-collection-reset',mt('reset'));reset.type='button';reset.onclick=()=>{marketplaceState.draftCollections=[];marketplaceState.collectionSort={key:'name',direction:1};document.getElementById('market-sheet-search').value='';renderMarketPicker();};
    const apply=marketElement('button','market-collection-apply',mt('show'));apply.type='button';apply.onclick=()=>{
        const names=[...marketplaceState.draftCollections];marketplaceState.selectedCollections=names;
        marketplaceState.filters.collection=names.length===1?names[0]:'';
        marketplaceState.filters.model='';marketplaceState.filters.backdrop='';marketplaceState.filters.symbol='';
        closeMarketSheet();loadMarketplace();
    };footer.append(reset,apply);content.appendChild(footer);
}
function updateMarketLanguage(){
    const pairs={'.market-hero h2':'title','.market-hero p':'subtitle','#market-tab-shop':'shop','#market-tab-mine':'mine','#market-filter-clear':'clear','#market-more':'more','#nav-market-text':'store'};
    Object.entries(pairs).forEach(([selector,key])=>{const element=document.querySelector(selector);if(element)element.textContent=mt(key);});
    const search=document.getElementById('market-search');if(search){search.placeholder=mt('search');search.setAttribute('aria-label',mt('search'));}
    const refresh=document.querySelector('#market-page .market-refresh');if(refresh)refresh.setAttribute('aria-label',mt('refresh'));
    const close=document.querySelector('#market-page .market-sheet-close');if(close)close.setAttribute('aria-label',mt('close'));
    const sheetSearch=document.getElementById('market-sheet-search');if(sheetSearch)sheetSearch.setAttribute('aria-label',mt('searchCollection'));
    renderMarketplace();
    if(marketplaceState.sheet){const key=marketplaceState.sheet;document.getElementById('market-sheet-title').textContent=key==='collection'?mt('collection'):marketFilterLabel(key);sheetSearch.placeholder=key==='collection'?mt('searchCollection'):mt('searchOptions',{name:marketFilterLabel(key)});renderMarketPicker();}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',updateMarketLanguage,{once:true});else updateMarketLanguage();
