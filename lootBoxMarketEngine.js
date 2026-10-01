// =========================================================
// lootBoxMarketEngine.js
// Isolated backdrop-aware pricing for the 100 TON Telegram Collectibles box.
// Normal gifts continue to use the existing general market engine.
// Black/Onyx Black variants use Telegram's current resale floor filtered
// by the exact backdrop attribute.
// =========================================================

const { getCollectibleMarketValue, refreshMarketPrices, getCacheStatus: getGeneralCacheStatus } = require('./marketPriceEngine');

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 8;
const PAGE_SIZE = 100;

const priceCache = new Map();
let giftTypeCache = null;
let giftTypeCacheAt = 0;
const GIFT_TYPE_CACHE_TTL_MS = 30 * 60 * 1000;
const backdropIdCache = new Map();
const priceInFlight = new Map();
let giftTypeInFlight = null;

function normalize(value) {
    return String(value || '').trim().toLowerCase();
}

function isSpecialBackdrop(backdrop) {
    const value = normalize(backdrop);
    return value === 'black' || value === 'onyx black';
}

function findTonAmount(amounts) {
    for (const amount of (Array.isArray(amounts) ? amounts : [])) {
        const className = String(
            amount?.className ||
            amount?.constructor?.className ||
            amount?.constructor?.name ||
            amount?._ ||
            ''
        ).toLowerCase();

        if (!className.includes('starstonamount')) continue;

        const nanograms = Number(amount?.amount);
        if (Number.isFinite(nanograms) && nanograms > 0) return nanograms / 1e9;
    }
    return null;
}

function giftTitleMatches(gift, name) {
    const target = normalize(name);
    return normalize(gift?.title) === target;
}

async function getGiftTypes(client) {
    if (giftTypeCache && Date.now() - giftTypeCacheAt < GIFT_TYPE_CACHE_TTL_MS) {
        return giftTypeCache;
    }
    if (giftTypeInFlight) return giftTypeInFlight;

    giftTypeInFlight = client.api.payments.getStarGifts({ hash: 0 })
        .then(result => {
            const gifts = Array.isArray(result?.gifts) ? result.gifts : [];
            giftTypeCache = gifts.filter(gift => gift?.id && gift?.title);
            giftTypeCacheAt = Date.now();
            return giftTypeCache;
        })
        .finally(() => {
            giftTypeInFlight = null;
        });

    return giftTypeInFlight;
}

async function resolveGiftId(client, name) {
    const gifts = await getGiftTypes(client);
    const match = gifts.find(gift => giftTitleMatches(gift, name));
    return match?.id ? String(match.id) : null;
}

async function resolveBackdropId(client, giftId, backdropName) {
    const key = String(giftId) + '|' + normalize(backdropName);
    const cached = backdropIdCache.get(key);
    if (cached) return cached;

    const result = await client.api.payments.getStarGiftUpgradeAttributes({
        giftId: BigInt(String(giftId))
    });
    const attributes = Array.isArray(result?.attributes) ? result.attributes : [];

    const backdrop = attributes.find(attribute => {
        const className = String(
            attribute?.className ||
            attribute?.constructor?.className ||
            attribute?.constructor?.name ||
            attribute?._ ||
            ''
        ).toLowerCase();

        return className.includes('backdrop') &&
            normalize(attribute?.name) === normalize(backdropName);
    });

    const backdropId = Number(backdrop?.backdropId ?? backdrop?.backdrop_id);
    if (!Number.isInteger(backdropId) || backdropId <= 0) return null;

    backdropIdCache.set(key, backdropId);
    return backdropId;
}

async function fetchTonFloor(client, giftId, backdropId = null) {
    let offset = '';
    let best = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const attributes = backdropId
            ? [{ className: 'StarGiftAttributeIdBackdrop', backdropId }]
            : undefined;

        const result = await client.api.payments.getResaleStarGifts({
            giftId: BigInt(String(giftId)),
            sortByPrice: true,
            starsOnly: false,
            ...(attributes ? { attributes } : {}),
            offset,
            limit: PAGE_SIZE
        });

        const gifts = Array.isArray(result?.gifts) ? result.gifts : [];
        for (const gift of gifts) {
            const amount = findTonAmount(gift?.resellAmount || gift?.resell_amount);
            if (amount != null && (best == null || amount < best)) best = amount;
        }

        const nextOffset = String(result?.nextOffset || result?.next_offset || '');
        if (!nextOffset || !gifts.length) break;
        offset = nextOffset;
    }

    return best;
}

async function getGeneralMarketPrice(item) {
    const name = item?.baseName || item?.name;
    if (!name) return null;
    try {
        const status = getGeneralCacheStatus();
        if (!status.loaded || status.stale) await refreshMarketPrices();
        const market = getCollectibleMarketValue({ name });
        if (market && Number(market.floorPriceTon) > 0) {
            return { value: Number(market.floorPriceTon), currency: 'TON', source: 'general-market-floor', lastUpdated: market.lastUpdated || null, fetchedAt: Date.now() };
        }
    } catch (error) {
        console.warn('100 TON general market price lookup failed:', name, error.message);
    }
    return null;
}

async function getBackdropMarketPrice(client, item) {
    const name = item?.baseName || item?.name;
    const backdrop = item?.backdrop || null;

    if (!client || !name || !isSpecialBackdrop(backdrop)) return null;

    const key = normalize(name) + '|' + normalize(backdrop);
    const cached = priceCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    if (priceInFlight.has(key)) return priceInFlight.get(key);

    const request = (async () => {
        try {
            const giftId = await resolveGiftId(client, name);
            if (!giftId) throw new Error('Telegram gift type not found');

            const backdropId = await resolveBackdropId(client, giftId, backdrop);
            if (!backdropId) throw new Error('Telegram backdrop not found');

            const floor = await fetchTonFloor(client, giftId, backdropId);
            if (!Number.isFinite(floor) || floor <= 0) {
                throw new Error('No TON listings found for this backdrop');
            }

            const value = {
                value: Number(floor.toFixed(9)),
                currency: 'TON',
                source: 'telegram-live-backdrop-floor',
                fetchedAt: Date.now()
            };
            priceCache.set(key, {
                value,
                expiresAt: Date.now() + CACHE_TTL_MS
            });
            return value;
        } catch (error) {
            console.warn('100 TON backdrop price lookup failed:', name, backdrop, error.message);
            return null;
        } finally {
            priceInFlight.delete(key);
        }
    })();

    priceInFlight.set(key, request);
    return request;
}

function getCacheStatus() {
    let fresh = 0;
    for (const entry of priceCache.values()) {
        if (entry.expiresAt > Date.now()) fresh += 1;
    }
    return { entries: priceCache.size, fresh };
}

module.exports = {
    getGeneralMarketPrice,
    getBackdropMarketPrice,
    getCacheStatus
};
