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

const VERIFIED_BACKDROP_REFERENCES = Object.freeze({
    'plush pepe': Object.freeze({black:'PlushPepe-1056','onyx black':'PlushPepe-1'})
});

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
    const referenceAttributeCache = new Map();
    const timedOutKeys = new Set();
    let catalog = null;
    let catalogUntil = 0;
    let catalogPromise = null;
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

    async function catalogFor(client) {
        if (catalog && catalogUntil > now()) return catalog;
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

    async function referenceBackdropFor(client, spec, baseId) {
        const slug = VERIFIED_BACKDROP_REFERENCES[normalize(spec.name)]?.[normalize(spec.backdropName)];
        if (!slug || typeof client.api.payments.getUniqueStarGift !== 'function') return { reason:'backdrop_not_found' };
        const cacheKey = baseId + '|' + slug;
        const cached = referenceAttributeCache.get(cacheKey);
        if (cached && cached.until > now()) return cached.promise;
        const promise = (async () => {
            const result = await client.api.payments.getUniqueStarGift({slug});
            const gift = result?.gift;
            if (!className(gift).includes('stargiftunique') || gift.slug !== slug ||
                idString(gift.giftId ?? gift.gift_id) !== baseId) return {reason:'backdrop_reference_mismatch'};
            const resolved = resolveOfficialAttribute(Array.isArray(gift.attributes) ? gift.attributes : [],'backdrop',spec.backdropName);
            if (resolved.reason) return resolved;
            return {...resolved,discoverySource:'telegram-unique-gift',referenceSlug:slug};
        })().catch(() => ({reason:'backdrop_reference_unavailable'}));
        referenceAttributeCache.set(cacheKey,{promise,until:now()+300000});
        return promise;
    }

    async function lookup(spec, deadline) {
        if (!spec.name || spec.name.length > 120) return unavailable(spec, 'invalid_collection', now());
        if (cooldownUntil > now()) return unavailable(spec, 'telegram_rate_limited', now());
        const client = await getClient();
        // A user MTProto session is required by Telegram; the bot token is not a substitute.
        const candidates = (await catalogFor(client)).filter(g => normalize(g.title) === normalize(spec.name));
        if (candidates.length > 1) return unavailable(spec, 'ambiguous_collection', now());
        const base = candidates[0];
        const baseId = idString(base?.id);
        if (!baseId) return unavailable(spec, 'collection_not_found', now());
        const chosenIds = {};
        const filters = [];
        const resolvedSpecification = { ...spec };
        const resolvedAttributes = {};
        if (spec.modelName || spec.backdropName || spec.patternName) {
            const attrs = await attributesFor(client, baseId);
            for (const [kind, name] of [['model', spec.modelName], ['backdrop', spec.backdropName], ['pattern', spec.patternName]]) {
                if (!name) continue;
                let resolved = resolveOfficialAttribute(attrs, kind, name);
                // Some backdrops may be absent from the market attribute metadata.
                // A known public Telegram gift proves only its exact ID, not its floor.
                // Prices still require fresh matching TON listings in this collection.
                if (kind === 'backdrop' && resolved.reason === 'backdrop_not_found') {
                    resolved = await referenceBackdropFor(client,spec,baseId);
                }
                if (resolved.reason) return unavailable(spec, resolved.reason, now());
                const { attribute, id } = resolved;
                resolvedSpecification[`${kind}Name`] = String(attribute.name).trim();
                resolvedAttributes[kind] = {
                    requestedName: name,
                    officialName: String(attribute.name).trim(),
                    officialId: kind === 'backdrop' ? String(id.backdropId) : String(id.documentId),
                    match:'exact',
                    discoverySource:resolved.discoverySource || 'telegram-resale-attributes',
                    ...(resolved.referenceSlug ? {referenceSlug:resolved.referenceSlug} : {})
                };
                chosenIds[kind] = id;
                filters.push(id);
            }
        }
        let offset = '';
        let minimum = null;
        let listingSlug = null;
        let listingsMatched = 0;
        const offsets = new Set();
        const startedAt = now();
        for (let page = 0; page < maxPages; page++) {
            if (now() >= deadline) return unavailable(spec, 'scan_timeout', now());
            const result = await client.api.payments.getResaleStarGifts({
                giftId: BigInt(baseId), sortByPrice: true, starsOnly: false,
                ...(filters.length ? { attributes: filters } : {}), offset, limit: 100
            });
            if (!Array.isArray(result?.gifts)) return unavailable(spec, 'invalid_market_response', now());
            for (const gift of result.gifts) {
                if (!matches(gift, resolvedSpecification, baseId, chosenIds)) continue;
                const nano = tonNanograms(gift.resellAmount || gift.resell_amount);
                if (nano === null) continue;
                listingsMatched++;
                if (minimum === null || nano < minimum) {
                    minimum = nano;
                    listingSlug = typeof gift.slug === 'string' ? gift.slug : null;
                }
            }
            const next = String(result.nextOffset ?? result.next_offset ?? '');
            if (!next) {
                if (minimum === null) return {
                    ...unavailable(spec, 'no_matching_ton_listings', now()),
                    baseGiftId: baseId, resolvedSpecification, resolvedAttributes,
                    scanComplete: true, pagesScanned: page + 1
                };
                const observedAt = now();
                const value = Number(tonDecimal(minimum));
                return { available: true, status: 'fresh', specification: spec, currency: 'TON',
                    resolvedSpecification, resolvedAttributes,
                    source: SOURCE, value, priceNano: minimum.toString(), baseGiftId: baseId, observedAt,
                    scanStartedAt: startedAt, expiresAt: observedAt + ttlMs,
                    scanComplete: true, listingsMatched, pagesScanned: page + 1,
                    referenceSlug: listingSlug,
                    referenceUrl: listingSlug ? `https://t.me/nft/${encodeURIComponent(listingSlug)}` : null,
                    quoteId: crypto.randomUUID() };
            }
            if (offsets.has(next)) return unavailable(spec, 'pagination_loop', now());
            offsets.add(next);
            offset = next;
        }
        return unavailable(spec, 'scan_limit_exceeded', now());
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

    function status() {
        return { source: SOURCE, currency: 'TON', freshTtlMs: ttlMs, active,
            queued: queue.length, cached: cache.size, pending: inFlight.size,
            rateLimited: cooldownUntil > now() };
    }

    return { quote, requireQuote, peek, status };
}

module.exports = { createTelegramGiftPricing, specification, keyFor, normalize,
    tonNanograms, tonDecimal, SOURCE };
