'use strict';

// Read-only Telegram resale pricing. No balance, gift transfer, or purchase calls.
// References: https://core.telegram.org/method/payments.getResaleStarGifts
//             https://core.telegram.org/constructor/starsTonAmount
const crypto = require('crypto');
const { Api } = require('teleproto');
const SOURCE = 'telegram-resale-ton-floor';
const NANO = 1000000000n;
const MAX_SAFE_NANO = BigInt(Number.MAX_SAFE_INTEGER);

function normalize(value) {
    return String(value || '').trim().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').toLowerCase();
}

function optionalTrait(value) {
    const text = String(value || '').trim();
    return ['', 'random', 'reward', 'balance'].includes(normalize(text)) ? null : text;
}

function specification(input = {}) {
    const label = optionalTrait(input.label);
    const explicitModel = optionalTrait(input.modelName || input.model_name);
    const isBackdropLabel = ['black', 'onyx black'].includes(normalize(label));
    return {
        name: String(input.baseName || input.base_name || input.name || '').trim(),
        modelName: explicitModel || (isBackdropLabel ? null : label),
        backdropName: optionalTrait(input.backdropName || input.backdrop || (isBackdropLabel ? label : null)),
        patternName: optionalTrait(input.patternName || input.pattern_name || input.pattern)
    };
}

function keyFor(input) {
    const spec = specification(input);
    return [spec.name, spec.modelName, spec.backdropName, spec.patternName].map(normalize).join('|');
}

function className(object) {
    return String(object?.className || object?._ || object?.constructor?.className || object?.constructor?.name || '').toLowerCase();
}

function idString(value) {
    try {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
        const id = BigInt(String(value));
        return id !== 0n && id >= -(1n << 63n) && id < (1n << 63n) ? id.toString() : null;
    } catch { return null; }
}

function tonNanograms(amounts) {
    let minimum = null;
    for (const amount of Array.isArray(amounts) ? amounts : []) {
        if (!className(amount).includes('starstonamount')) continue;
        const id = idString(amount.amount);
        if (!id) continue;
        const nano = BigInt(id);
        if (nano <= 0n || nano > MAX_SAFE_NANO) continue; // Never accept an imprecise monetary number.
        if (minimum === null || nano < minimum) minimum = nano;
    }
    return minimum;
}

function tonDecimal(nano) {
    return `${nano / NANO}.${(nano % NANO).toString().padStart(9, '0')}`;
}

function unavailable(spec, reason, now) {
    return { available: false, status: 'unavailable', reason, specification: spec,
        currency: 'TON', source: SOURCE, value: null, priceNano: null, observedAt: now };
}

function traitId(attribute, kind) {
    if (kind === 'backdrop') {
        const rawId = attribute?.backdropId ?? attribute?.backdrop_id;
        if (rawId === undefined || rawId === null || typeof rawId === 'boolean' ||
            !/^-?\d+$/.test(String(rawId))) return null;
        const id = Number(rawId);
        return Number.isInteger(id) && id >= -2147483648 && id <= 2147483647
            ? new Api.StarGiftAttributeIdBackdrop({ backdropId: id }) : null;
    }
    const id = idString(attribute?.document?.id);
    return id ? new (kind === 'model' ? Api.StarGiftAttributeIdModel : Api.StarGiftAttributeIdPattern)({ documentId: BigInt(id) }) : null;
}

function matches(gift, spec, baseId, chosenIds) {
    const giftId = idString(gift?.giftId ?? gift?.gift_id);
    if (!giftId || giftId !== baseId) return false;
    const attrs = Array.isArray(gift?.attributes) ? gift.attributes : [];
    for (const [kind, name] of [['model', spec.modelName], ['backdrop', spec.backdropName], ['pattern', spec.patternName]]) {
        if (!name) continue;
        const attribute = attrs.find(a => className(a).includes(kind) && normalize(a.name) === normalize(name));
        if (!attribute) return false;
        const wanted = chosenIds[kind];
        const actual = traitId(attribute, kind);
        if (!actual || (kind === 'backdrop'
            ? actual.backdropId !== wanted.backdropId
            : String(actual.documentId) !== String(wanted.documentId))) return false;
    }
    return true;
}

// Black and Onyx Black are distinct official Telegram backdrops:
// https://t.me/nft/PlushPepe-1056 (Black), https://t.me/nft/PlushPepe-1 (Onyx Black).
// Matching is exact after whitespace/case normalization, never by color or alias.
function resolveOfficialAttribute(attributes, kind, requestedName) {
    const candidates = attributes.filter(attribute => className(attribute).includes(kind) &&
        normalize(attribute.name) === normalize(requestedName));
    if (!candidates.length) return { reason: `${kind}_not_found` };
    const identities = new Map();
    for (const attribute of candidates) {
        const id = traitId(attribute, kind);
        if (!id) return { reason: `${kind}_invalid_identifier` };
        const key = kind === 'backdrop' ? String(id.backdropId) : String(id.documentId);
        identities.set(key, { attribute, id });
    }
    if (identities.size !== 1) return { reason: `${kind}_ambiguous` };
    return identities.values().next().value;
}

function compactMarketGift(gift) {
    return {
        giftId: idString(gift?.giftId ?? gift?.gift_id),
        slug: typeof gift?.slug === 'string' ? gift.slug : null,
        attributes: (Array.isArray(gift?.attributes) ? gift.attributes : []).map(attribute => ({
            className: className(attribute), name: attribute.name,
            backdropId: attribute.backdropId ?? attribute.backdrop_id,
            document: attribute.document?.id === undefined ? undefined : {id: attribute.document.id}
        })),
        resellAmount: (Array.isArray(gift?.resellAmount ?? gift?.resell_amount) ? gift.resellAmount ?? gift.resell_amount : [])
            .map(amount => ({className: className(amount), amount: amount.amount}))
    };
}

function createTelegramGiftPricing({ getClient, now = Date.now, ttlMs = 60000,
    maxPages = 100, maxEntries = 1200, concurrency = 2, timeoutMs = 20000,
    failureTtlMs = 15000, maxPending = 160 } = {}) {
    if (typeof getClient !== 'function') throw new TypeError('getClient is required');
    for (const value of [ttlMs, maxPages, maxEntries, concurrency, timeoutMs, failureTtlMs, maxPending]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid pricing resource limit');
    }
    const cache = new Map();
    const inFlight = new Map();
    const attributeCache = new Map();
    const marketScanCache = new Map();
    const marketScanInFlight = new Map();
    const marketFailureCache = new Map();
    const timedOutKeys = new Set();
    let catalog = null;
    let catalogUntil = 0;
    let catalogPromise = null;
    let lastCatalogMissRefresh = -Infinity;
    let active = 0;
    let cooldownUntil = 0;
    const queue = [];

    async function runLimited(operation) {
        if (active >= concurrency) await new Promise(resolve => queue.push(resolve));
        else active++;
        try { return await operation(); }
        finally {
            const next = queue.shift();
            if (next) next(); // Transfer the reserved slot; do not expose a transient free slot.
            else active--;
        }
    }

    async function catalogFor(client, force = false) {
        if (!force && catalog && catalogUntil > now()) return catalog;
        if (!catalogPromise) {
            catalogPromise = client.api.payments.getStarGifts({ hash: 0 }).then(result => {
                if (!Array.isArray(result?.gifts) || !result.gifts.length) throw new Error('catalog_unavailable');
                catalog = result.gifts;
                catalogUntil = now() + 30 * 60000;
                return catalog;
            }).finally(() => { catalogPromise = null; });
        }
        return catalogPromise;
    }

    async function attributesFor(client, giftId) {
        const cached = attributeCache.get(giftId);
        if (cached && cached.until > now()) return cached.promise;
        const promise = client.api.payments.getResaleStarGifts({ giftId: BigInt(giftId), offset: '', limit: 1, sortByPrice: true, starsOnly: false, attributesHash: 0n })
            .then(result => {
                if (!Array.isArray(result?.attributes)) throw new Error('attributes_unavailable');
                return result.attributes;
            }).catch(error => { attributeCache.delete(giftId); throw error; });
        attributeCache.set(giftId, { until: now() + 30 * 60000, promise });
        return promise;
    }

    // One bounded, shared, unfiltered market scan per official collection.
    // This is not a collection-price fallback: each quote below requires its
    // own exact model/backdrop/pattern names AND IDs on the returned listings.
    async function scanCollection(client, baseId, deadline) {
        const cached = marketScanCache.get(baseId);
        if (cached && cached.until > now()) return cached.result;
        const failure = marketFailureCache.get(baseId);
        if (failure && failure.until > now()) {
            if (failure.error) throw failure.error;
            return failure.result;
        }
        if (marketScanInFlight.has(baseId)) return marketScanInFlight.get(baseId);
        const promise = (async () => {
            const gifts = [];
            const offsets = new Set();
            const startedAt = now();
            let offset = '';
            for (let page = 0; page < maxPages; page++) {
                if (now() >= deadline) return {reason:'scan_timeout'};
                const result = await client.api.payments.getResaleStarGifts({
                    giftId:BigInt(baseId),sortByPrice:true,starsOnly:false,offset,limit:100
                });
                if (!Array.isArray(result?.gifts)) return {reason:'invalid_market_response'};
                if (result.gifts.length > 100) return {reason:'invalid_market_response'};
                for (const gift of result.gifts) {
                    if (idString(gift?.giftId ?? gift?.gift_id) === baseId) gifts.push(compactMarketGift(gift));
                }
                // The maximum number of entries is limited by page count and
                // Telegram's requested page size; malformed oversized replies fail.
                const next = String(result.nextOffset ?? result.next_offset ?? '');
                if (!next) {
                    const observedAt = now();
                    const snapshot = {gifts,pagesScanned:page+1,scanStartedAt:startedAt,
                        observedAt,expiresAt:observedAt+Math.min(ttlMs,60000)};
                    if (now() < deadline) {
                        marketScanCache.set(baseId,{until:snapshot.expiresAt,result:snapshot});
                        let totalRows=[...marketScanCache.values()].reduce((sum,row)=>sum+row.result.gifts.length,0);
                        while (marketScanCache.size>Math.min(maxEntries,24) || totalRows>30000) {
                            const oldest=marketScanCache.keys().next().value;
                            totalRows-=marketScanCache.get(oldest).result.gifts.length;
                            marketScanCache.delete(oldest);
                        }
                    }
                    return snapshot;
                }
                if (offsets.has(next)) return {reason:'pagination_loop'};
                offsets.add(next);offset=next;
            }
            return {reason:'scan_limit_exceeded'};
        })().then(result => {
            if (result.reason) {
                marketFailureCache.set(baseId,{until:now()+failureTtlMs,result:{reason:result.reason}});
            } else marketFailureCache.delete(baseId);
            return result;
        }).catch(error => {
            marketFailureCache.set(baseId,{until:now()+failureTtlMs,error});
            throw error;
        }).finally(() => {
            while (marketFailureCache.size>maxEntries) marketFailureCache.delete(marketFailureCache.keys().next().value);
            marketScanInFlight.delete(baseId);
        });
        marketScanInFlight.set(baseId,promise);
        return promise;
    }

    async function lookup(spec, deadline) {
        if (!spec.name || spec.name.length > 120) return unavailable(spec,'invalid_collection',now());
        if (cooldownUntil > now()) return unavailable(spec,'telegram_rate_limited',now());
        const client = await getClient();
        let candidates = (await catalogFor(client)).filter(g=>normalize(g.title)===normalize(spec.name));
        // Discover newly released Telegram types without adding a box or deploying.
        if (!candidates.length && now()-lastCatalogMissRefresh>=60000) {
            lastCatalogMissRefresh=now();
            candidates=(await catalogFor(client,true)).filter(g=>normalize(g.title)===normalize(spec.name));
        }
        if (candidates.length > 1) return unavailable(spec,'ambiguous_collection',now());
        const baseId = idString(candidates[0]?.id);
        if (!baseId) return unavailable(spec,'collection_not_found',now());
        // Attribute metadata alone may omit Black/Onyx Black. The actual market
        // rows of THIS collection provide additional official trait identifiers.
        const hasTraits = !!(spec.modelName || spec.backdropName || spec.patternName);
        const attrs = hasTraits ? await attributesFor(client,baseId) : [];
        const market = await scanCollection(client,baseId,deadline);
        if (market.reason) return unavailable(spec,market.reason,now());
        if (market.expiresAt <= now() || now() >= deadline) return unavailable(spec,'scan_timeout',now());
        const chosenIds = {}, resolvedAttributes = {}, resolvedSpecification = {...spec};
        for (const [kind,name] of [['model',spec.modelName],['backdrop',spec.backdropName],['pattern',spec.patternName]]) {
            if (!name) continue;
            let resolved = resolveOfficialAttribute(attrs,kind,name);
            let discoverySource = 'telegram-resale-attributes';
            if (resolved.reason === `${kind}_not_found`) {
                const listingAttributes = market.gifts.flatMap(g=>Array.isArray(g.attributes)?g.attributes:[]);
                resolved = resolveOfficialAttribute(listingAttributes,kind,name);
                discoverySource = 'telegram-resale-listings';
            }
            if (resolved.reason) return {
                ...unavailable(spec,resolved.reason,now()),baseGiftId:baseId,
                scanComplete:true,pagesScanned:market.pagesScanned,
                observedAt:market.observedAt
            };
            const {attribute,id}=resolved;
            chosenIds[kind]=id;
            resolvedSpecification[`${kind}Name`]=String(attribute.name).trim();
            resolvedAttributes[kind]={requestedName:name,officialName:String(attribute.name).trim(),
                officialId:kind==='backdrop'?String(id.backdropId):String(id.documentId),
                match:'exact',discoverySource};
        }
        let minimum=null,listingSlug=null,listingsMatched=0;
        for (const gift of market.gifts) {
            if (!matches(gift,resolvedSpecification,baseId,chosenIds)) continue;
            const nano=tonNanograms(gift.resellAmount||gift.resell_amount);
            if (nano===null) continue;
            listingsMatched++;
            if (minimum===null || nano<minimum) {minimum=nano;listingSlug=typeof gift.slug==='string'?gift.slug:null;}
        }
        const evidence={baseGiftId:baseId,resolvedSpecification,resolvedAttributes,
            scanComplete:true,pagesScanned:market.pagesScanned,scanStartedAt:market.scanStartedAt,
            observedAt:market.observedAt,listingsMatched};
        if (minimum===null) return {...unavailable(spec,'no_matching_ton_listings',now()),...evidence};
        return {available:true,status:'fresh',specification:spec,currency:'TON',source:SOURCE,
            value:Number(tonDecimal(minimum)),priceNano:minimum.toString(),...evidence,
            expiresAt:Math.min(market.expiresAt,market.observedAt+ttlMs),
            referenceSlug:listingSlug,referenceUrl:listingSlug?`https://t.me/nft/${encodeURIComponent(listingSlug)}`:null,
            quoteId:crypto.randomUUID()};
    }

    function peek(input) {
        const key = keyFor(input);
        const cached = cache.get(key);
        if (cached && cached.until > now()) return cached.value;
        if (timedOutKeys.has(key)) return unavailable(specification(input), 'market_timeout', now());
        return { ...unavailable(specification(input), inFlight.has(key) ? 'loading' : 'not_loaded', now()),
            status: inFlight.has(key) ? 'loading' : 'unavailable' };
    }

    async function quote(input, { force = false } = {}) {
        const spec = specification(input);
        const key = keyFor(spec);
        const cached = cache.get(key);
        if (!force && cached && cached.until > now()) return cached.value;
        if (inFlight.has(key)) return inFlight.get(key);
        if (inFlight.size >= maxPending) return unavailable(spec, 'request_queue_full', now());
        // Keep a hung MTProto RPC in the same slot until it actually finishes. A timeout
        // returns to the caller but must not release the slot or spawn unlimited retries.
        let resolveResult;
        const resultPromise = new Promise(resolve => { resolveResult = resolve; });
        inFlight.set(key, resultPromise);
        let timedOut = false;
        const deadline = now() + timeoutMs;
        const timer = setTimeout(() => {
            timedOut = true;
            timedOutKeys.add(key);
            const failed = unavailable(spec, 'market_timeout', now());
            cache.set(key, { value: failed, until: now() + failureTtlMs });
            if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
            resolveResult(failed);
        }, timeoutMs);
        runLimited(async () => {
            let value;
            try {
                if (!timedOut) value = await lookup(spec, deadline);
            }
            catch (error) {
                const message = String(error?.errorMessage || error?.message || '');
                const seconds = Number(error?.seconds || 0);
                if (/FLOOD_WAIT|FLOOD_PREMIUM_WAIT/.test(message) || seconds > 0) {
                    cooldownUntil = now() + Math.max(15, Math.min(seconds || 60, 3600)) * 1000;
                }
                value = unavailable(spec, /BOT_METHOD_INVALID/.test(message)
                    ? 'telegram_user_session_required' : cooldownUntil > now()
                        ? 'telegram_rate_limited' : 'telegram_market_unavailable', now());
            } finally { clearTimeout(timer); }
            if (!timedOut) {
                cache.set(key, { value, until: value.available ? value.expiresAt : now() + failureTtlMs });
                if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
                resolveResult(value);
            }
            timedOutKeys.delete(key);
            inFlight.delete(key);
        }).catch(() => {
            clearTimeout(timer);
            timedOutKeys.delete(key);
            inFlight.delete(key);
            resolveResult(unavailable(spec, 'telegram_market_unavailable', now()));
        });
        return resultPromise;
    }

    async function requireQuote(input, options) {
        const result = await quote(input, options);
        if (!result.available || result.expiresAt <= now()) {
            const error = new Error('A fresh matching Telegram TON price is unavailable');
            error.code = 'GIFT_PRICE_UNAVAILABLE';
            error.reason = result.reason || 'expired';
            throw error;
        }
        return result;
    }

    async function listCollections() {
        const client=await getClient();
        const gifts=await catalogFor(client);
        return gifts.filter(g=>idString(g.id)&&typeof g.title==='string'&&g.title.trim())
            .map(g=>({name:g.title.trim(),telegramGiftId:idString(g.id)}));
    }

    function status() {
        return { source: SOURCE, currency: 'TON', freshTtlMs: ttlMs, active,
            queued: queue.length, cached: cache.size, pending: inFlight.size,
            rateLimited: cooldownUntil > now() };
    }

    return { quote, requireQuote, peek, status, listCollections };
}

module.exports = { createTelegramGiftPricing, specification, keyFor, normalize,
    tonNanograms, tonDecimal, SOURCE };
