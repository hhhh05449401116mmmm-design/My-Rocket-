// =========================================================
// lootBoxMarketEngine.js
// Isolated live market pricing for the 100 TON Telegram
// Collectibles box. This module does not modify Crash, rounds,
// betting, cashout, deposits, withdrawals, or game state.
// =========================================================

const https = require('https');

const PRICE_LIST_URL = 'https://giftasset.gifts/api/v1/gifts/get_gifts_price_list';
const BACKDROP_FLOOR_URL = 'https://giftasset.gifts/api/v1/gifts/get_gifts_backdrops_floor?v2=true';

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

let marketCache = null;
let marketCacheAt = 0;
let refreshInFlight = null;

function normalize(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isSpecialBackdrop(backdrop) {
    const value = normalize(backdrop);
    return value === 'black' || value === 'onyx black';
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'CrazyRocket-100TON-Market/2.0'
            }
        }, response => {
            let body = '';
            response.setEncoding('utf8');

            response.on('data', chunk => {
                body += chunk;
                if (body.length > 5 * 1024 * 1024) {
                    request.destroy(new Error('GiftAsset response too large'));
                }
            });

            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error('GiftAsset HTTP ' + response.statusCode));
                    return;
                }

                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        });

        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error('GiftAsset request timeout'));
        });
        request.on('error', reject);
    });
}

function toPositiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function minProviderFloor(entry) {
    if (!entry || typeof entry !== 'object') return null;

    const values = Object.entries(entry)
        .filter(([key]) => key !== 'last_update')
        .map(([, value]) => toPositiveNumber(value))
        .filter(value => value != null);

    return values.length ? Math.min(...values) : null;
}

function buildCollectionIndex(payload) {
    const index = new Map();
    const collections = payload?.collection_floors;

    if (!collections || typeof collections !== 'object') return index;

    for (const [name, entry] of Object.entries(collections)) {
        const floor = minProviderFloor(entry);
        if (floor != null) {
            index.set(normalize(name), {
                value: Number(floor.toFixed(9)),
                source: 'giftasset-general-floor',
                lastUpdated: entry.last_update || null
            });
        }
    }

    return index;
}

function buildBackdropIndex(payload) {
    const index = new Map();

    if (!payload || typeof payload !== 'object') return index;

    for (const [collectionName, backdrops] of Object.entries(payload)) {
        if (!backdrops || typeof backdrops !== 'object') continue;

        const collectionKey = normalize(collectionName);
        for (const [backdropName, price] of Object.entries(backdrops)) {
            const value = toPositiveNumber(price);
            if (value == null) continue;

            index.set(collectionKey + '|' + normalize(backdropName), {
                value: Number(value.toFixed(9)),
                source: 'giftasset-backdrop-floor',
                lastUpdated: null
            });
        }
    }

    return index;
}

async function refreshMarketCache() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = Promise.all([
        fetchJson(PRICE_LIST_URL),
        fetchJson(BACKDROP_FLOOR_URL)
    ]).then(([priceList, backdropFloors]) => {
        marketCache = {
            collections: buildCollectionIndex(priceList),
            backdrops: buildBackdropIndex(backdropFloors),
            fetchedAt: Date.now()
        };
        marketCacheAt = Date.now();
        return marketCache;
    }).finally(() => {
        refreshInFlight = null;
    });

    return refreshInFlight;
}

async function ensureMarketCache() {
    if (marketCache && Date.now() - marketCacheAt < CACHE_TTL_MS) {
        return marketCache;
    }

    return refreshMarketCache();
}

async function getGeneralMarketPrice(item) {
    const name = item?.baseName || item?.name;
    if (!name) return null;

    try {
        const cache = await ensureMarketCache();
        const result = cache.collections.get(normalize(name));
        return result ? { ...result, fetchedAt: cache.fetchedAt } : null;
    } catch (error) {
        console.warn('100 TON general market lookup failed:', error.message);
        return null;
    }
}

async function getBackdropMarketPrice(item) {
    const name = item?.baseName || item?.name;
    const backdrop = item?.backdrop || null;

    if (!name || !isSpecialBackdrop(backdrop)) return null;

    try {
        const cache = await ensureMarketCache();
        const result = cache.backdrops.get(normalize(name) + '|' + normalize(backdrop));
        return result ? { ...result, fetchedAt: cache.fetchedAt } : null;
    } catch (error) {
        console.warn('100 TON backdrop market lookup failed:', name, backdrop, error.message);
        return null;
    }
}

function getCacheStatus() {
    const ageMs = marketCache ? Date.now() - marketCacheAt : null;
    return {
        loaded: Boolean(marketCache),
        ageMs,
        stale: !marketCache || ageMs >= CACHE_TTL_MS,
        collectionEntries: marketCache?.collections?.size || 0,
        backdropEntries: marketCache?.backdrops?.size || 0
    };
}

module.exports = {
    getGeneralMarketPrice,
    getBackdropMarketPrice,
    refreshMarketCache,
    getCacheStatus
};
