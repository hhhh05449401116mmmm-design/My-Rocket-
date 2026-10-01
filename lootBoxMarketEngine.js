// =========================================================
// lootBoxMarketEngine.js
// Isolated market pricing for the 100 TON Telegram Collectibles box.
// This module never touches Crash, rounds, betting, deposits, withdrawals,
// or the global collectible/MTProto valuation pipeline.
// =========================================================

const https = require('https');

const CALCMULA_CALC_URL = 'https://calcmula.app/calc';
const REQUEST_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT = 4;

const cache = new Map();

function fetchJson(urlString) {
    return new Promise((resolve, reject) => {
        const request = https.get(urlString, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'RocketIce-100TON-Market/1.0'
            }
        }, response => {
            let body = '';
            response.setEncoding('utf8');

            response.on('data', chunk => {
                body += chunk;
                if (body.length > 1024 * 1024) {
                    request.destroy(new Error('Calcmula response too large'));
                }
            });

            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error('Calcmula HTTP ' + response.statusCode));
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
            request.destroy(new Error('Calcmula request timeout'));
        });
        request.on('error', reject);
    });
}

function buildExpression(name, backdrop) {
    const giftName = JSON.stringify(String(name || '').trim());
    if (backdrop) {
        return 'gift(' + giftName + ', backdrop: ' + JSON.stringify(String(backdrop).trim()) + ')';
    }
    return 'gift(' + giftName + ')';
}

function extractAmount(payload) {
    const amount = Number(payload?.result?.amount);
    if (Number.isFinite(amount) && amount > 0) return amount;

    const exact = Number(payload?.result?.amountExact);
    if (Number.isFinite(exact) && exact > 0) return exact;

    return null;
}

function cacheKey(name, backdrop) {
    return String(name || '').trim().toLowerCase() + '|' + String(backdrop || '').trim().toLowerCase();
}

async function fetchPrice(name, backdrop) {
    const key = cacheKey(name, backdrop);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const expression = buildExpression(name, backdrop);
    const url = CALCMULA_CALC_URL + '?q=' + encodeURIComponent(expression);

    try {
        const payload = await fetchJson(url);
        const amount = extractAmount(payload);
        if (amount == null) throw new Error('Calcmula returned no numeric gift price');

        const result = {
            value: Number(amount.toFixed(9)),
            currency: 'TON',
            source: 'calcmula-live',
            fetchedAt: Date.now(),
            expiresAt: Date.now() + CACHE_TTL_MS
        };
        cache.set(key, result);
        return result;
    } catch (error) {
        // A pricing outage must never break the loot-box endpoint.
        console.warn('100 TON market price lookup failed:', expression, error.message);
        return null;
    }
}

async function mapWithConcurrency(items, worker, concurrency = MAX_CONCURRENT) {
    const results = new Array(items.length);
    let cursor = 0;

    async function runWorker() {
        while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            try {
                results[index] = await worker(items[index], index);
            } catch (error) {
                results[index] = null;
            }
        }
    }

    const workers = [];
    const count = Math.min(concurrency, items.length);
    for (let i = 0; i < count; i += 1) workers.push(runWorker());
    await Promise.all(workers);
    return results;
}

async function getLootBoxMarketPrice(item, fallbackGeneralPrice = null) {
    const name = item?.baseName || item?.name;
    const backdrop = item?.backdrop || null;
    if (!name) return null;

    const live = await fetchPrice(name, backdrop);
    if (live) return live;

    // For normal cards only, a generic collection floor is a safe fallback.
    // For Black/Onyx Black variants we deliberately do NOT fall back to the
    // general collection price because that would violate the requested rule.
    if (!backdrop && Number.isFinite(Number(fallbackGeneralPrice)) && Number(fallbackGeneralPrice) > 0) {
        return {
            value: Number(fallbackGeneralPrice),
            currency: 'TON',
            source: 'general-market-fallback',
            fetchedAt: Date.now()
        };
    }

    return null;
}

async function getLootBoxMarketPrices(items, fallbackGeneralResolver) {
    const list = Array.isArray(items) ? items : [];
    return mapWithConcurrency(list, async item => {
        let fallback = null;
        if (!item?.backdrop && typeof fallbackGeneralResolver === 'function') {
            try {
                fallback = await fallbackGeneralResolver(item);
            } catch {}
        }

        const price = await getLootBoxMarketPrice(item, fallback);
        return price ? Number(price.value) : 0;
    });
}

function getCacheStatus() {
    let fresh = 0;
    for (const value of cache.values()) {
        if (value.expiresAt > Date.now()) fresh += 1;
    }
    return { entries: cache.size, fresh };
}

module.exports = {
    getLootBoxMarketPrice,
    getLootBoxMarketPrices,
    getCacheStatus
};
