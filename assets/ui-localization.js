/* UI-only localization. Never modifies inputs, game state, prices, names or artwork. */
(function(global){
    'use strict';
    const languages=['ar','en','ru'];
    const normalize=value=>String(value??'').replace(/\s+/g,' ').trim();
    const exact=new Map(),templates=[],bindings=[];
    let language='ar',observer=null,frame=null,started=false;
    const pending=new Set();
    const protectedSelectors=[
        'script','style','noscript','code','pre','textarea','[contenteditable="true"]','[data-i18n-preserve]',
        '.language-menu-item','#language-current-label','.language-current-label',
        '.market-card h3','.market-attributes','.market-collection-name','.market-collection-metrics',
        '.collectible-name','.collectible-title','.collectible-model','.collectible-symbol','.collectible-backdrop',
        '.gift-name','.gift-name-inline','.gift-card-name','.pvp-player-name','.pvp-strip-name',
        '.player-name','.spender-name','.profile-name','.user-name','#profile-name','#profile-page-name',
        '.rocket-startup-name','.app-title-bar','#rocket-reward-gift-name',
        '.ton-connect-button', '[data-tc-connect-button="true"]'
    ];
    let protectedSelectorText=protectedSelectors.join(',');
    function safeLanguage(){
        try { if(typeof currentLanguage!=='undefined'&&languages.includes(currentLanguage))return currentLanguage; } catch {}
        try { const saved=localStorage.getItem('rocketLanguage');if(languages.includes(saved))return saved; } catch {}
        return languages.includes(document.documentElement.lang)?document.documentElement.lang:'ar';
    }
    function add(triple){
        if(!triple||!languages.every(lang=>typeof triple[lang]==='string'&&triple[lang].trim()))return;
        const output={ar:triple.ar,en:triple.en,ru:triple.ru};
        [...languages.map(lang=>output[lang]),...(triple.sources||[])].forEach(value=>{
            const source=normalize(value);
            if(!source)return;
            exact.set(source,output);
            if(/\{[a-zA-Z][a-zA-Z0-9_]*\}/.test(source)){
                const names=[];let last=0,pattern='';
                const matcher=/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;let match;
                while((match=matcher.exec(source))){
                    pattern+=source.slice(last,match.index).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
                    pattern+=['amount','count','number'].includes(match[1])?'([0-9][0-9\\s.,:]*)':'(.+?)';
                    names.push(match[1]);last=matcher.lastIndex;
                }
                pattern+=source.slice(last).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
                // A template must contain meaningful fixed wording, never match arbitrary identities.
                const fixed=source.replace(/\{[^}]+\}/g,'').replace(/[^\p{L}]/gu,'');
                if(fixed.length>=4)templates.push({regex:new RegExp('^'+pattern+'$','u'),names,output});
            }
        });
    }
    function translate(value,lang=language,values={}){
        const source=normalize(value);if(!source)return String(value??'');
        let output=exact.get(source)?.[lang];
        if(output===undefined){
            for(let i=templates.length-1;i>=0;i--){
                const template=templates[i];const match=source.match(template.regex);if(!match)continue;
                const args={...values};template.names.forEach((name,index)=>args[name]=match[index+1]);
                output=template.output[lang].replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,(all,name)=>args[name]??all);break;
            }
        }
        if(output===undefined)return String(value??'');
        return output.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,(all,name)=>values[name]??all);
    }
    function skip(element){return !element||element.closest(protectedSelectorText);}
    function localizeTextNode(node){
        if(node.nodeType!==3||skip(node.parentElement))return;
        const value=node.nodeValue;if(!value||!/[\p{L}]/u.test(value))return;
        if(/^[0-9\s.,:#%+\-x×/()]+$/i.test(value))return;
        const output=translate(value);if(normalize(value)!==normalize(output)){
            const leading=value.match(/^\s*/)?.[0]||'',trailing=value.match(/\s*$/)?.[0]||'';
            node.nodeValue=leading+output+trailing;
        }
    }
    function localize(root){
        if(!root||root.nodeType===3){if(root)localizeTextNode(root);return;}
        if(root.nodeType!==1||skip(root))return;
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
        while((node=walker.nextNode()))localizeTextNode(node);
        const elements=[root,...root.querySelectorAll('[placeholder],[aria-label],[title],[data-ui-text]')];
        for(const element of elements){
            if(skip(element))continue;
            for(const attr of ['placeholder','aria-label','title']){
                if(!element.hasAttribute(attr))continue;
                const source=element.getAttribute(attr),output=translate(source);if(output!==source)element.setAttribute(attr,output);
            }
        }
    }
    function applyBindings(){
        for(const binding of bindings){
            if(!binding.selector||!binding[language])continue;
            let elements=[];try{elements=document.querySelectorAll(binding.selector);}catch{continue;}
            elements.forEach(element=>{
                if(skip(element))return;
                if(binding.attribute==='text'){
                    // Text bindings are allowed only for leaf labels; never destroy child controls/icons.
                    if(element.children.length===0&&element.textContent!==binding[language])element.textContent=binding[language];
                }else if(['placeholder','aria-label','title'].includes(binding.attribute)){
                    if(element.getAttribute(binding.attribute)!==binding[language])element.setAttribute(binding.attribute,binding[language]);
                }
            });
        }
    }
    function applyMixedLabels(){
        // Explicit UI-only containers with one variable child. Replace surrounding text nodes only.
        for(const selector of ['#plinko-gift-empty > .plinko-gift-empty-text','#earn-page .invite-banner strong','#vip-progress-text','#gift-balance-text']){
            const element=document.querySelector(selector);if(!element||!element.children.length)continue;
            const values=[...element.children].filter(child=>child.tagName.toLowerCase()!=='svg'&&normalize(child.textContent));
            if(values.length!==1)continue;
            const valueChild=values[0],raw=normalize([...element.childNodes].map(node=>node.nodeType===1&&node.tagName.toLowerCase()==='svg'?'':node.textContent).join(''));
            const value=normalize(valueChild.textContent);if(!value)continue;
            const output=translate(raw);if(output===raw)continue;
            const position=output.indexOf(value);if(position<0)continue;
            [...element.childNodes].filter(node=>node.nodeType===3).forEach(node=>node.remove());
            element.insertBefore(document.createTextNode(output.slice(0,position)),element.firstChild);
            element.appendChild(document.createTextNode(output.slice(position+value.length)));
        }
    }
    function refresh(lang){
        language=languages.includes(lang)?lang:safeLanguage();
        document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
        if(observer)observer.disconnect();
        applyMixedLabels();localize(document.body);applyBindings();
        if(observer)observe();
    }
    function observe(){observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['placeholder','aria-label','title']});}
    function flush(){
        frame=null;const roots=[...pending];pending.clear();observer.disconnect();
        applyMixedLabels();roots.forEach(root=>{if(root.isConnected)localize(root);});
        observe();
    }
    function registerLegacy(){
        try{
            if(typeof translations==='undefined')return;
            const keys=new Set(languages.flatMap(lang=>Object.keys(translations[lang]||{})));
            for(const key of keys){
                const triple={};languages.forEach(lang=>{triple[lang]=translations[lang]?.[key]||'';});
                if(languages.every(lang=>triple[lang]))add(triple);
            }
        }catch{}
    }
    function start(){
        if(started||!document.body)return;started=true;language=safeLanguage();registerLegacy();
        const data=global.GAME_UI_LANGUAGES||{};
        (data.phrases||[]).forEach(add);(data.bindings||[]).forEach(binding=>bindings.push(binding));
        (data.preserveSelectors||[]).forEach(selector=>{if(typeof selector==='string'&&selector.length<250)protectedSelectors.push(selector);});
        protectedSelectorText=[...new Set(protectedSelectors)].join(',');
        const market=global.MARKET_TEXT||{};
        Object.keys(market.ar||{}).forEach(key=>add({ar:market.ar[key],en:market.en?.[key],ru:market.ru?.[key]}));
        ['model','backdrop','symbol','maxPrice','number'].forEach(key=>add({ar:market.ar[key]+' ▾',en:market.en[key]+' ▾',ru:market.ru[key]+' ▾'}));
        add({ar:'اختر الهدية — NFT',en:'Choose gift — NFT',ru:'Выберите подарок — NFT'});
        // Correct missing/wrong-language legacy dictionary entries before future game renders.
        try{
            if(typeof translations!=='undefined'){
                const keys=new Set(languages.flatMap(lang=>Object.keys(translations[lang]||{})));
                for(const key of keys)for(const lang of languages){
                    const source=translations.en?.[key]||translations.ar?.[key]||translations[lang]?.[key];
                    if(source)translations[lang][key]=translate(source,lang);
                }
            }
        }catch{}
        refresh(language);
        observer=new MutationObserver(records=>{
            for(const record of records){
                if(skip(record.target.nodeType===3?record.target.parentElement:record.target))continue;
                if(record.type==='childList')record.addedNodes.forEach(node=>{
                    if(node.nodeType===1||node.nodeType===3&&/[\p{L}]/u.test(node.nodeValue||''))pending.add(node);
                });
                else if(record.type==='characterData'){
                    if(/[\p{L}]/u.test(record.target.nodeValue||''))pending.add(record.target);
                }else pending.add(record.target);
            }
            if(pending.size&&!frame)frame=requestAnimationFrame(flush);
        });observe();
        const nativeDialogs={alert:global.alert,confirm:global.confirm,prompt:global.prompt};
        for(const name of Object.keys(nativeDialogs))global[name]=function(message,...args){return nativeDialogs[name].call(global,translate(message,safeLanguage()),...args);};
    }
    global.GameI18n={text:(value,values)=>translate(value,safeLanguage(),values),refresh,start,add,language:safeLanguage};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})(window);
