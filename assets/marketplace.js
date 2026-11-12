'use strict';
// Existing marketplace only: no game loops, fake listings or external purchases.
let marketplaceState = {
    tab: 'shop', catalog: [], listings: [], collectibles: [],
    filters: { collection:'', model:'', backdrop:'', symbol:'', maxPrice:'', number:'', search:'' },
    options: { models:[], backdrops:[], symbols:[] }, nextOffset:0, hasMore:false,
    sheet:null, catalogLoadedAt:0, imageMap:{}, loading:false, error:'', request:0, controller:null, debounce:null
};
function marketElement(tag, className, text) {
    const element=document.createElement(tag);
    if(className) element.className=className;
    if(text!==undefined) element.textContent=text;
    return element;
}
function marketApiUrl(path) { return (typeof BACKEND_URL==='string' ? BACKEND_URL : '') + path; }
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
        else { img.remove(); wrap.appendChild(marketElement('span','market-picture-missing','الصورة غير متاحة')); }
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
        if(!response.ok||!data.ok) throw new Error(data.error||'تعذر تحميل قائمة الهدايا');
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
        const response=await fetch(marketApiUrl('/api/market/items?'+params),{headers:getAuthHeaders(),cache:'no-store',signal:controller.signal});
        const data=await response.json();
        if(seq!==marketplaceState.request) return;
        if(!response.ok||!data.ok) throw new Error(response.status===401?'افتح اللعبة من Telegram لعرض المقتنيات والشراء.':data.error||'تعذر تحميل المتجر');
        marketplaceState.listings=append?marketplaceState.listings.concat(data.listings||[]):(data.listings||[]);
        marketplaceState.collectibles=data.myCollectibles||data.collectibles||[];
        if(data.catalog?.length&&!marketplaceState.catalog.length) marketplaceState.catalog=data.catalog;
        marketplaceState.options=data.filters||data.options||{models:[],backdrops:[],symbols:[]};
        const pagination=data.pagination||data;
        marketplaceState.hasMore=!!pagination.hasMore;
        marketplaceState.nextOffset=pagination.nextOffset??marketplaceState.listings.length;
    } catch(error) {
        if(error.name==='AbortError'||seq!==marketplaceState.request) return;
        marketplaceState.error=error.message||'تعذر تحميل المتجر';
        if(!append) marketplaceState.listings=[];
    } finally {
        await catalogPromise;
        if(seq===marketplaceState.request) { marketplaceState.loading=false; renderMarketplace(); }
    }
}
function marketFilterLabel(key) {
    return {collection:'NFT',model:'النموذج',backdrop:'الخلفية',symbol:'الرمز',maxPrice:'أقصى سعر',number:'رقم الهدية'}[key];
}
function updateMarketFilterButtons() {
    Object.entries(marketplaceState.filters).forEach(([key,value])=>{
        const button=document.getElementById('market-filter-'+key); if(!button) return;
        button.textContent=value!=='' ? (key==='maxPrice'?'≤ '+value+' TON':key==='number'?'#'+value:value) : marketFilterLabel(key)+' ▾';
        button.dataset.active=String(value!=='');
        button.title=marketFilterLabel(key)+(value!==''?' — '+value:'');
    });
    const summary=document.getElementById('market-selection-text');
    if(summary) summary.textContent=marketplaceState.filters.collection
        ? 'الهدايا المختارة: '+marketplaceState.filters.collection : 'اختر نوع الهدية من NFT، أو تصفّح جميع العروض.';
}
function marketNumber(item) { return item.collectibleNumber??item.collectible_number??null; }
function marketPrice(item) { const price=Number(item.priceTon??item.price_ton??item.marketValue??item.value??0); return Number.isFinite(price)?price:0; }
function renderMarketplace() {
    const grid=document.getElementById('market-grid'),status=document.getElementById('market-status'); if(!grid||!status) return;
    updateMarketFilterButtons(); grid.replaceChildren();
    const owned=marketplaceState.collectibles.filter(item=>String(item.status||item.ownershipStatus||'').toUpperCase()==='OWNED'&&!!(item.collectibleId||item.uniqueCollectibleId||item.unique_collectible_id||(!String(item.id||'').startsWith('pending:')&&item.id)));
    const mine=marketplaceState.tab==='mine'; const items=mine?owned:marketplaceState.listings;
    status.textContent=marketplaceState.loading?'جارٍ تحميل الهدايا...':marketplaceState.error||
        (mine?'مقتنياتك الموثّقة داخل اللعبة':(items.length?'العروض المتاحة: '+items.length+(marketplaceState.hasMore?' +':''):'لا توجد عروض مطابقة'));
    if(!items.length&&!marketplaceState.loading) {
        const empty=marketElement('div','market-empty');
        empty.appendChild(marketElement('strong','',marketplaceState.error?'تعذر تحميل العروض':mine?'لا توجد مقتنيات متاحة للبيع':'هذه الهدية غير متوفرة حاليًا'));
        empty.appendChild(marketElement('span','',marketplaceState.error?'يمكنك إعادة المحاولة بزر التحديث.':mine?'ستظهر مقتنياتك الموثّقة هنا عندما تكون متاحة.':marketplaceState.filters.collection
            ? 'لا توجد عروض لـ '+marketplaceState.filters.collection+' بهذه الخيارات. جرّب هدية أخرى أو امسح الفلاتر.'
            : 'يمكنك اختيار هدية من زر NFT أو العودة لاحقًا.'));
        grid.appendChild(empty);
    }
    items.forEach(item=>{
        const card=marketElement('article','market-card'); card.appendChild(marketArtwork(item));
        const body=marketElement('div','market-card-body');
        body.appendChild(marketElement('h3','',item.baseName||item.name||'Telegram collectible'));
        const number=marketNumber(item); body.appendChild(marketElement('p','',number!==null?'#'+number:'مقتنى موثّق'));
        const traits=[item.model,item.backdrop,item.symbol].map(value=>typeof value==='object'?value?.name:value).filter(Boolean);
        body.appendChild(marketElement('p','market-attributes',traits.join(' · ')||'Telegram collectible'));
        const price=marketElement('div','market-price'); const ton=marketElement('img'); ton.src='/assets/ton-icon.svg';ton.alt='TON';
        price.append(ton,marketElement('span','',marketPrice(item).toLocaleString('en-US',{maximumFractionDigits:4})+' TON')); body.appendChild(price);
        const id=item.collectibleId||item.uniqueCollectibleId||item.unique_collectible_id||item.id;
        if(mine) {
            const list=marketElement('button','market-action','عرض للبيع'); list.type='button';list.onclick=()=>marketList(id);body.appendChild(list);
            const sell=marketElement('button','market-action secondary','بيع فوري بالتقييم');sell.type='button';sell.onclick=()=>marketInstantSell(id);body.appendChild(sell);
        } else {
            const buy=marketElement('button','market-action','شراء');buy.type='button';buy.disabled=marketplaceState.loading||marketplaceState.error!=='';buy.onclick=()=>marketBuy(item.id,marketPrice(item));body.appendChild(buy);
        }
        card.appendChild(body);grid.appendChild(card);
    });
    const more=document.getElementById('market-more');if(more){more.hidden=mine||!marketplaceState.hasMore;more.disabled=marketplaceState.loading;}
}
function setMarketFilter(key,value) {
    if(!(key in marketplaceState.filters)) return;
    marketplaceState.filters[key]=String(value??'').trim();closeMarketSheet();loadMarketplace();
}
function clearMarketFilters() {
    Object.keys(marketplaceState.filters).forEach(key=>marketplaceState.filters[key]='');
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
    marketplaceState.sheet=key;marketplaceState.lastFilter=key;sheet.hidden=false;
    document.getElementById('market-sheet-title').textContent=key==='collection'?'اختر الهدية — NFT':marketFilterLabel(key);
    search.value='';search.hidden=['maxPrice','number'].includes(key);
    search.placeholder=key==='collection'?'ابحث عن الهدية':'ابحث عن '+marketFilterLabel(key);
    renderMarketPicker();
    if(key==='collection'&&!marketplaceState.catalog.length) { content.textContent='جارٍ تحميل قائمة الهدايا...';try {await loadMarketCatalog();if(marketplaceState.sheet===key)renderMarketPicker();}catch{content.textContent='تعذر تحميل صور الهدايا. أغلق النافذة وأعد المحاولة.';} }
    search.focus({preventScroll:true});
}
function marketPickerSearch() { renderMarketPicker(); }
function renderMarketPicker() {
    const key=marketplaceState.sheet,content=document.getElementById('market-sheet-content'),search=document.getElementById('market-sheet-search');if(!key||!content) return;
    content.replaceChildren();const query=(search?.value||'').trim().toLowerCase();
    if(key==='maxPrice'||key==='number') {
        content.appendChild(marketElement('p','market-sheet-note',key==='maxPrice'?'اعرض الهدايا التي لا تتجاوز هذا السعر بـ TON.':'ابحث عن الرقم المحدد للمقتنى، وليس رقم نوع الهدية.'));
        const label=marketElement('label','market-field-label',key==='maxPrice'?'الحد الأقصى للسعر (TON)':'رقم الهدية');label.htmlFor='market-value-input';
        const input=marketElement('input','market-sheet-input');input.id='market-value-input';input.type='number';input.min=key==='number'?'1':'0';input.step=key==='number'?'1':'any';input.inputMode=key==='number'?'numeric':'decimal';input.value=marketplaceState.filters[key];input.placeholder=key==='number'?'مثال: 312628':'مثال: 5';
        const apply=marketElement('button','market-sheet-apply','تطبيق');apply.type='button';apply.onclick=()=>{
            const val=input.value.trim();const n=Number(val);
            if(val&&(!Number.isFinite(n)||n<(key==='number'?1:0)||(key==='number'&&!Number.isSafeInteger(n)))) { input.setCustomValidity('أدخل قيمة صحيحة');input.reportValidity();return; }
            setMarketFilter(key,val);
        };
        const reset=marketElement('button','market-option','إلغاء هذا الفلتر');reset.type='button';reset.onclick=()=>setMarketFilter(key,'');content.append(label,input,apply,reset);return;
    }
    if(key==='collection') {
        const grid=marketElement('div','market-picker-grid');const all=marketElement('button','market-picker market-picker-all','كل الهدايا');all.type='button';all.onclick=()=>setMarketFilter('collection','');grid.appendChild(all);
        const items=marketplaceState.catalog.filter(item=>String(item.baseName||item.name||'').toLowerCase().includes(query));
        items.forEach(item=>{const button=marketElement('button','market-picker');button.type='button';const name=item.baseName||item.name;button.append(marketArtwork(item),marketElement('span','',name));button.onclick=()=>{
            marketplaceState.filters.model='';marketplaceState.filters.backdrop='';marketplaceState.filters.symbol='';
            setMarketFilter('collection',name);
        };grid.appendChild(button);});
        if(!items.length) grid.appendChild(marketElement('p','market-sheet-note','لم يتم العثور على هدية بهذا الاسم.'));content.appendChild(grid);
        return;
    }
    const optionKey={model:'models',backdrop:'backdrops',symbol:'symbols'}[key];
    const options=(marketplaceState.options[optionKey]||[]).map(value=>typeof value==='object'?value.name:value).filter(Boolean);
    content.appendChild(marketElement('p','market-sheet-note','الخيارات أدناه مأخوذة من العروض الحقيقية. يمكنك أيضًا البحث عن اسم محدد.'));
    const all=marketElement('button','market-option','الكل');all.type='button';all.onclick=()=>setMarketFilter(key,'');content.appendChild(all);
    options.filter(value=>String(value).toLowerCase().includes(query)).forEach(value=>{const button=marketElement('button','market-option',value);button.type='button';button.onclick=()=>setMarketFilter(key,value);content.appendChild(button);});
    if(query) {const exact=marketElement('button','market-sheet-apply','البحث عن: '+search.value.trim());exact.type='button';exact.onclick=()=>setMarketFilter(key,search.value);content.appendChild(exact);}
    if(!options.length) content.appendChild(marketElement('p','market-sheet-note','لا توجد خصائص متاحة في العروض الحالية. اكتب اسم الخيار للبحث عنه.'));
}
async function marketList(id) {
    const price=prompt('أدخل سعر العرض بـ TON:');if(!price||!Number.isFinite(Number(price))||Number(price)<=0)return;
    await marketAction('/api/market/list',{collectibleId:id,priceTon:Number(price)},'تم عرض المقتنى للبيع');
}
async function marketBuy(id,price) {
    if(!confirm('تأكيد شراء المقتنى مقابل '+price+' TON؟'))return;
    await marketAction('/api/market/buy',{listingId:id},'تم الشراء وإضافة المقتنى إلى حقيبتك');
}
async function marketInstantSell(id) {
    if(!confirm('سيتم بيع الهدية وإضافة قيمتها حسب تقييم اللعبة إلى رصيدك. متابعة؟'))return;
    await marketAction('/api/market/instant-sell',{collectibleId:id},'تم البيع الفوري وإضافة TON إلى رصيدك');
}
async function marketAction(path,body,success) {
    try {
        const response=await fetch(marketApiUrl(path),{method:'POST',headers:getAuthHeaders(),body:JSON.stringify(body)}),data=await response.json();
        if(!response.ok||!data.ok)throw new Error(data.error||'فشلت العملية');
        showToast(success);await loadMarketplace();if(typeof fetchBalance==='function')await fetchBalance();
    } catch(error) {showToast(error.message||'فشلت العملية');}
}
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&marketplaceState.sheet){event.preventDefault();closeMarketSheet();}});
