'use strict';

// Read-only external display data. Never import pricing engines, balances, or database state.
// Dataset: https://github.com/ssamy2/TelegramGiftsAssests/blob/main/Gifts_Details.json
// Prefer its documented floor_price_ton; otherwise use the minimum positive known provider.
// Historical comparisons use the SAME algorithm and a published snapshot at/before T - 24h.
const https = require('node:https');
const { collectionKey } = require('./marketplaceView');

const SOURCE = 'telegram-gifts-assets-multi-market';
const LATEST_URL = 'https://raw.githubusercontent.com/ssamy2/TelegramGiftsAssests/main/Gifts_Details.json';
const COMMITS_URL = 'https://api.github.com/repos/ssamy2/TelegramGiftsAssests/commits';
const RAW_PREFIX = 'https://raw.githubusercontent.com/ssamy2/TelegramGiftsAssests/';
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_TOLERANCE_MS = 2 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const PROVIDERS = Object.freeze(['portal', 'getgems', 'tgmrkt']);

function allowedSourceUrl(value) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    if (url.hostname === 'raw.githubusercontent.com') {
        return !url.search && /^\/ssamy2\/TelegramGiftsAssests\/(?:main|[a-f0-9]{40})\/Gifts_Details\.json$/.test(url.pathname);
    }
    if (url.origin + url.pathname !== COMMITS_URL) return false;
    const keys = [...url.searchParams.keys()];
    return keys.length === 3 && new Set(keys).size === 3 &&
        url.searchParams.get('path') === 'Gifts_Details.json' &&
        url.searchParams.get('per_page') === '1' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(url.searchParams.get('until') || '');
}

// No credentials, cookies, automatic redirects, or caller-supplied URLs. Count actual bytes,
// not just Content-Length. The factory also imposes an absolute timeout (including DNS).
function defaultFetchJson(url, { signal, maxResponseBytes }) {
    return new Promise((resolve, reject) => {
        if (!allowedSourceUrl(url)) { reject(new Error('Disallowed market source')); return; }
        const request = https.get(url, {
            signal,
            headers: { Accept: 'application/json', 'User-Agent': 'CrazyRocket-MarketplaceReadOnly/1.0' }
        }, response => {
            if (response.statusCode !== 200 || Number(response.headers['content-length']) > maxResponseBytes) {
                response.destroy();
                request.destroy(new Error('Market source response rejected'));
                return;
            }
            const chunks = [];
            let bytes = 0;
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > maxResponseBytes) {
                    response.destroy();
                    request.destroy(new Error('Market source response too large'));
                } else chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('aborted', () => reject(new Error('Incomplete market source response')));
            response.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch { reject(new Error('Invalid market source JSON')); }
            });
        });
        request.on('error', reject);
    });
}

function safeName(value) {
    if (typeof value !== 'string' || value.length > 160 || /[\p{Cc}\p{Cf}]/u.test(value)) return '';
    return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}
function publicGiftId(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
    if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
    const id = String(value);
    if (!/^[1-9]\d{0,19}$/.test(id) || BigInt(id) > 18446744073709551615n) return null;
    return id;
}
function positivePrice(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}
function sourceTimestamp(value, clock) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
    const seconds = Number(value);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(seconds) && seconds > 0 && Number.isSafeInteger(milliseconds) &&
        milliseconds <= clock + FUTURE_TOLERANCE_MS && milliseconds <= 8640000000000000
        ? milliseconds : null;
}
function parseDataset(data, clock, maxEntries) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid market dataset');
    const updatedMs = sourceTimestamp(data.last_updated, clock);
    if (updatedMs === null || !Array.isArray(data.upgraded) || !data.upgraded.length || data.upgraded.length > maxEntries) {
        throw new Error('Invalid market dataset timestamp or catalog');
    }
    const entries = [], byKey = new Map(), byId = new Map();
    for (const raw of data.upgraded) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const name = safeName(raw.full_name), key = collectionKey(name);
        if (!name || !key) continue;
        const giftId = publicGiftId(raw.regular_id);
        if (byKey.has(key) || (giftId && byId.has(giftId))) throw new Error('Ambiguous market collection identity');
        const providers = {};
        for (const provider of PROVIDERS) {
            const price = positivePrice(raw[provider + '_price_ton']);
            if (price !== null) providers[provider] = price;
        }
        const documentedFloor = positivePrice(raw.floor_price_ton);
        const prices = Object.values(providers);
        const floor = documentedFloor ?? (prices.length ? Math.min(...prices) : null);
        const entry = {
            key, collectionKey: key, name, baseName: name, sourceName: name, giftId,
            shortName: typeof raw.short_name === 'string' && /^[a-z0-9_]{1,80}$/.test(raw.short_name) ? raw.short_name : null,
            modelsPath: typeof raw.models === 'string' && /^models\/[a-z0-9_]{1,80}\/prices\.json$/.test(raw.models) ? raw.models : null,
            floor, providers, floorSource: floor === null ? null : documentedFloor === null ? 'provider-minimum' : 'floor_price_ton'
        };
        entries.push(entry);
        byKey.set(key, entry);
        if (giftId) byId.set(giftId, entry);
    }
    if (!entries.length) throw new Error('No safe market collections');
    return { entries, byKey, byId, updatedMs };
}

/**
 * Factory injections are trusted server-side dependencies, not request parameters.
 * fetchJson(url, {signal, timeoutMs, maxResponseBytes}) resolves parsed JSON.
 * now() returns epoch milliseconds. All callers of one instance share one latest fetch,
 * one history fetch, TTLs and error backoff. The exported default instance is process-wide.
 * officialCatalog: [{title, giftId}] binds verified collection IDs to source regular_id.
 * No automatic/fuzzy renames, local seeds, or listing-price fallbacks are used.
 */
function createMarketplaceMarketData({
    fetchJson = defaultFetchJson, now = Date.now, ttlMs = 5 * 60 * 1000,
    failureTtlMs = 60 * 1000, timeoutMs = 5000, historyTtlMs = 30 * 60 * 1000,
    staleAfterMs = 2 * 60 * 60 * 1000, maxResponseBytes = 2 * 1024 * 1024, maxEntries = 512
} = {}) {
    if (typeof fetchJson !== 'function' || typeof now !== 'function') throw new TypeError('Invalid market data dependencies');
    for (const limit of [ttlMs, failureTtlMs, timeoutMs, historyTtlMs, staleAfterMs, maxResponseBytes, maxEntries]) {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid market data resource limit');
    }
    if (timeoutMs > 5000 || maxResponseBytes > 2 * 1024 * 1024 || maxEntries > 512) {
        throw new TypeError('Market data safety limit exceeded');
    }
    let current = null, previous = null;
    let latestPending = null, historyPending = null;
    let latestRetryAt = -Infinity, historyRetryAt = -Infinity;
    let latestFailed = false, historyState = 'unavailable';

    async function requestJson(url) {
        if (!allowedSourceUrl(url)) throw new Error('Disallowed market source');
        const controller = new AbortController();
        let timer;
        try {
            const data = await Promise.race([
                Promise.resolve().then(() => fetchJson(url, { signal: controller.signal, timeoutMs, maxResponseBytes })),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new Error('Market source timeout'));
                    }, timeoutMs);
                })
            ]);
            // Also bound trusted test/custom transports: they cannot return unbounded raw data.
            const serialized = JSON.stringify(data);
            if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > maxResponseBytes) {
                throw new Error('Market source response too large');
            }
            return data;
        } finally { clearTimeout(timer); }
    }
    function validPrevious() {
        if (!current || !previous) return false;
        const distance = current.updatedMs - DAY_MS - previous.updatedMs;
        return distance >= 0 && distance <= HISTORY_TOLERANCE_MS;
    }
    function startHistory() {
        if (!current || historyPending || now() < historyRetryAt) return;
        const target = current.updatedMs - DAY_MS;
        if (target <= 0) return;
        historyRetryAt = now() + historyTtlMs;
        historyState = 'pending';
        historyPending = (async () => {
            try {
                const url = new URL(COMMITS_URL);
                url.searchParams.set('path', 'Gifts_Details.json');
                url.searchParams.set('per_page', '1');
                url.searchParams.set('until', new Date(target).toISOString());
                const commits = await requestJson(url.href);
                const commit = Array.isArray(commits) && commits.length === 1 ? commits[0] : null;
                const sha = commit?.sha;
                const commitDate = commit?.commit?.committer?.date || commit?.commit?.author?.date;
                const commitMs = typeof commitDate === 'string' ? Date.parse(commitDate) : NaN;
                if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || !Number.isFinite(commitMs) || commitMs > target) {
                    throw new Error('No safe historical snapshot');
                }
                const historical = parseDataset(await requestJson(RAW_PREFIX + sha + '/Gifts_Details.json'), now(), maxEntries);
                if (historical.updatedMs > target || target - historical.updatedMs > HISTORY_TOLERANCE_MS) {
                    throw new Error('Historical snapshot outside 24h window');
                }
                previous = historical;
                historyState = 'ready';
            } catch {
                // An older successful baseline can still be used only if its real timestamp fits.
                historyState = validPrevious() ? 'ready' : 'unavailable';
            }
        })().finally(() => { historyPending = null; });
    }
    async function ensureCurrent() {
        if (latestPending) { await latestPending; return; }
        if (now() < latestRetryAt) return;
        latestPending = (async () => {
            try {
                const candidate = parseDataset(await requestJson(LATEST_URL), now(), maxEntries);
                if (current && candidate.updatedMs < current.updatedMs) throw new Error('Regressed source timestamp');
                current = candidate;
                latestFailed = false;
                latestRetryAt = now() + ttlMs;
            } catch {
                latestFailed = true;
                latestRetryAt = now() + failureTtlMs;
            }
        })().finally(() => { latestPending = null; });
        await latestPending;
    }
    function snapshot() {
        const stale = !!current && (latestFailed || now() - current.updatedMs > staleAfterMs || current.updatedMs > now() + FUTURE_TOLERANCE_MS);
        const priced = !!current?.entries.some(entry => entry.floor !== null);
        const status = !priced ? 'unavailable' : stale ? 'stale' : 'fresh';
        const hasPrevious = validPrevious();
        const currentUpdatedAt = current ? new Date(current.updatedMs).toISOString() : null;
        const previousUpdatedAt = hasPrevious ? new Date(previous.updatedMs).toISOString() : null;
        const floors = {};
        const entries = (current?.entries || []).map(entry => {
            const before = hasPrevious ? entry.giftId ? previous.byId.get(entry.giftId) : previous.byKey.get(entry.key) : null;
            const change = entry.floor !== null && before?.floor != null
                ? ((entry.floor - before.floor) / before.floor) * 100 : null;
            floors[entry.key] = entry.floor;
            return {
                key: entry.key, collectionKey: entry.key, name: entry.name, baseName: entry.baseName,
                sourceName: entry.sourceName, shortName: entry.shortName, giftId: entry.giftId, modelsPath: entry.modelsPath,
                marketFloorTon: entry.floor,
                marketChange24hPct: Number.isFinite(change) ? (change === 0 ? 0 : change) : null,
                marketUpdatedAt: currentUpdatedAt,
                marketPreviousUpdatedAt: before ? previousUpdatedAt : null,
                marketSource: SOURCE, marketPriceStatus: entry.floor === null ? 'unavailable' : status,
                marketProviders: { ...entry.providers }, marketFloorSource: entry.floorSource
            };
        });
        return {
            source: SOURCE, currentUpdatedAt, previousUpdatedAt, stale, status,
            historyStatus: hasPrevious ? 'ready' : historyPending ? 'pending' : historyState === 'ready' ? 'unavailable' : historyState,
            entries, floors
        };
    }
    async function getSnapshot() {
        await ensureCurrent();
        startHistory(); // Deliberately NOT awaited: the cold path is at most one 5-second request.
        return snapshot();
    }
    async function getMetadataSnapshot() {
        return (await getSnapshot()).entries;
    }
    async function enrichCatalog(catalog, { officialCatalog = [] } = {}) {
        const data = await getSnapshot();
        const sourceByKey = new Map(data.entries.map(entry => [entry.key, entry]));
        const sourceById = new Map(data.entries.filter(entry => entry.giftId).map(entry => [entry.giftId, entry]));
        const bindings = new Map(), ambiguous = new Set();
        if (Array.isArray(officialCatalog)) {
            for (const gift of officialCatalog.slice(0, maxEntries)) {
                const key = collectionKey(safeName(gift?.title || gift?.name));
                const id = publicGiftId(gift?.giftId);
                if (!key || !id) continue;
                if (bindings.has(key) && bindings.get(key) !== id) ambiguous.add(key);
                bindings.set(key, id);
            }
        }
        return (Array.isArray(catalog) ? catalog : []).map(row => {
            const key = collectionKey(safeName(row.key || row.collectionKey || row.baseName || row.name));
            // A verified identity has priority. If it is unknown/ambiguous, fail closed rather
            // than substitute a different collection whose source name happens to match.
            const entry = ambiguous.has(key) ? null : bindings.has(key)
                ? sourceById.get(bindings.get(key)) : sourceByKey.get(key);
            return {
                ...row,
                marketFloorTon: entry?.marketFloorTon ?? null,
                marketChange24hPct: entry?.marketChange24hPct ?? null,
                marketUpdatedAt: entry?.marketUpdatedAt ?? null,
                marketPreviousUpdatedAt: entry?.marketPreviousUpdatedAt ?? null,
                marketSource: SOURCE,
                marketPriceStatus: entry?.marketPriceStatus || 'unavailable',
                marketProviders: entry ? { ...entry.marketProviders } : {},
                marketFloorSource: entry?.marketFloorSource ?? null
            };
        });
    }
    return { getSnapshot, getMetadataSnapshot, enrichCatalog };
}

// Lazy: constructing/requiring this module never opens the network. Parent routes may use
// this shared instance, or create one with an injected transport/clock for isolated tests.
const marketplaceMarketData = createMarketplaceMarketData();
module.exports = {
    createMarketplaceMarketData, marketplaceMarketData, SOURCE,
    getSnapshot: marketplaceMarketData.getSnapshot,
    getMetadataSnapshot: marketplaceMarketData.getMetadataSnapshot,
    enrichCatalog: marketplaceMarketData.enrichCatalog
};
