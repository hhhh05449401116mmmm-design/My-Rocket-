const https = require('https');
const { URL } = require('url');

const GIFT_DETAILS_URL = 'https://raw.githubusercontent.com/ssamy2/TelegramGiftsAssests/main/Gifts_Details.json';
const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;

let priceCache = null;
let cacheExpiry = 0;
let fetchInProgress = null;
const modelPriceCache = new Map();

function fetchJson(urlString) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const request = https.get(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'RocketIce-MarketPrice/1.0' }
        }, response => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
                reject(new Error(`Market price fetch HTTP ${response.statusCode}`));
                return;
            }
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Market price fetch timeout')));
        request.on('error', reject);
    });
}

function camelCaseToSnakeCase(str) {
    return str.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

function titleToSnakeCase(str) {
    return str.replace(/['']/g, '').toLowerCase().replace(/\s+/g, '_').replace(/-+/g, '_');
}

function buildPriceIndex(data) {
    const index = new Map();
    const addEntry = (key, price, providers) => {
        if (!index.has(key)) {
            index.set(key, { floor_price: price, providers });
        }
    };

    if (Array.isArray(data.upgraded)) {
        for (const gift of data.upgraded) {
            const full = (gift.full_name || '').toLowerCase().trim();
            const short = (gift.short_name || '').toLowerCase().trim();
            const price = gift.floor_price_ton;
            const providers = {
                floor_price_ton: gift.floor_price_ton,
                portal_price_ton: gift.portal_price_ton,
                getgems_price_ton: gift.getgems_price_ton,
                tgmrkt_price_ton: gift.tgmrkt_price_ton
            };
            if (full) addEntry(full, price, providers);
            if (short) addEntry(short, price, providers);
            addEntry(full.replace(/\s+/g, '_'), price, providers);
            if (gift.regular_id) addEntry(String(gift.regular_id).toLowerCase(), price, providers);
        }
    }

    if (Array.isArray(data.unupgraded)) {
        for (const gift of data.unupgraded) {
            const full = (gift.full_name || '').toLowerCase().trim();
            const short = (gift.short_name || '').toLowerCase().trim();
            const price = gift.price_ton || gift.floor_price_ton;
            const providers = {
                floor_price_ton: gift.price_ton,
                portal_price_ton: null,
                getgems_price_ton: null,
                tgmrkt_price_ton: gift.tgmrkt_price_ton || null
            };
            if (full) addEntry(full, price, providers);
            if (short) addEntry(short, price, providers);
            if (gift.id) addEntry(String(gift.id).toLowerCase(), price, providers);
        }
    }

    return index;
}

async function refreshCache() {
    if (fetchInProgress) return fetchInProgress;

    fetchInProgress = fetchJson(GIFT_DETAILS_URL)
        .then(data => {
            priceCache = {
                data,
                index: buildPriceIndex(data),
                lastUpdated: data.last_updated || Math.floor(Date.now() / 1000),
                fetchedAt: Date.now()
            };
            cacheExpiry = Date.now() + CACHE_TTL_MS;
            fetchInProgress = null;
            return priceCache;
        })
        .catch(error => {
            fetchInProgress = null;
            throw error;
        });

    return fetchInProgress;
}

async function ensureCache() {
    if (priceCache && Date.now() < cacheExpiry) return priceCache;
    return refreshCache();
}

function normalizeCollectibleName(name) {
    if (!name || typeof name !== 'string') return '';
    return name.toLowerCase().trim();
}

function findBestMatch(collectible, index) {
    const names = [
        normalizeCollectibleName(collectible.name),
        normalizeCollectibleName(collectible.base_name),
        normalizeCollectibleName(collectible.telegramGiftId),
        normalizeCollectibleName(collectible.model_name),
        camelCaseToSnakeCase(normalizeCollectibleName(collectible.name)),
        titleToSnakeCase(normalizeCollectibleName(collectible.name)),
    ];

    for (const key of names) {
        if (key && index.has(key)) return index.get(key);
    }

    const snakeCased = camelCaseToSnakeCase(normalizeCollectibleName(collectible.name));
    if (snakeCased && index.has(snakeCased)) return index.get(snakeCased);

    const titledSnake = titleToSnakeCase(normalizeCollectibleName(collectible.name));
    if (titledSnake && index.has(titledSnake)) return index.get(titledSnake);

    return null;
}

function getCollectibleMarketValue(collectible) {
    if (!priceCache || !priceCache.index) return null;
    const match = findBestMatch(collectible, priceCache.index);
    if (!match) return null;
    return {
        floorPriceTon: match.floor_price,
        providers: match.providers,
        lastUpdated: priceCache.lastUpdated
    };
}

async function refreshMarketPrices() {
    try {
        const cache = await ensureCache();
        return { success: true, lastUpdated: cache.lastUpdated, itemCount: cache.index.size };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function getModelPriceIndex(collectibleName) {
    const key = normalizeCollectibleName(collectibleName);
    if (!key) return null;
    const cached = modelPriceCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    await ensureCache();
    const base = priceCache?.data?.upgraded?.find(gift => {
        const full = normalizeCollectibleName(gift?.full_name);
        const short = normalizeCollectibleName(gift?.short_name);
        return full === key || short === key;
    });
    if (!base?.models) return null;
    const modelUrl = 'https://raw.githubusercontent.com/ssamy2/TelegramGiftsAssests/main/' + String(base.models).replace(/^\/+/, '');
    try {
        const value = await fetchJson(modelUrl);
        modelPriceCache.set(key, { value, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
        return value;
    } catch (error) {
        console.warn('Gift model price lookup unavailable:', error.message);
        return null;
    }
}

async function getCollectibleVariantMarketValue(collectible) {
    const name = String(collectible?.name || collectible?.base_name || '').trim();
    if (!name) return null;
    const label = String(collectible?.label || collectible?.model_name || '').trim();
    const backdrop = String(collectible?.backdrop || '').trim();

    if (label && !['random', 'reward', 'balance'].includes(label.toLowerCase())) {
        const modelPrices = await getModelPriceIndex(name);
        const modelPrice = Number(modelPrices?.models?.[label]);
        if (Number.isFinite(modelPrice) && modelPrice > 0) {
            return { floorPriceTon: modelPrice, providers: { model_floor_ton: modelPrice }, source: 'gift-details-model', model: label, backdrop: backdrop || null, lastUpdated: priceCache?.lastUpdated || null };
        }
    }

    if (backdrop) {
        const modelPrices = await getModelPriceIndex(name);
        const backdropPrice = Number(modelPrices?.backdrops?.[backdrop]);
        if (Number.isFinite(backdropPrice) && backdropPrice > 0) {
            return { floorPriceTon: backdropPrice, providers: { backdrop_floor_ton: backdropPrice }, source: 'gift-details-backdrop', model: label || null, backdrop, lastUpdated: priceCache?.lastUpdated || null };
        }
    }

    const base = getCollectibleMarketValue({ name, base_name: collectible?.base_name || name, model_name: name });
    return base ? { ...base, source: 'gift-details-collection' } : null;
}

function getCacheStatus() {
    if (!priceCache) return { loaded: false };
    return {
        loaded: true,
        lastUpdated: priceCache.lastUpdated,
        fetchedAt: priceCache.fetchedAt,
        expiresAt: cacheExpiry,
        itemCount: priceCache.index.size,
        stale: Date.now() >= cacheExpiry
    };
}

module.exports = {
    getCollectibleMarketValue,
    getCollectibleVariantMarketValue,
    refreshMarketPrices,
    ensureCache,
    getCacheStatus,
    GIFT_DETAILS_URL,
    CACHE_TTL_MS
};
