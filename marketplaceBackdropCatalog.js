'use strict';

// Read-only public trait metadata. No game imports, price data or inferred rarity.
const https = require('node:https');
const BACKDROPS_URL = 'https://cdn.changes.tg/gifts/backdrops.json';
const SOURCE = BACKDROPS_URL;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 5000;
function label(value) {
    return typeof value === 'string' && value.length <= 160 && !/[\p{Cc}\p{Cf}]/u.test(value)
        ? value.normalize('NFKC').trim() : '';
}
function key(value) { return label(value).toLowerCase(); }
function giftId(value) { return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : null; }
function collectionUrl(title) { return `https://cdn.changes.tg/gifts/backdrops/${encodeURIComponent(title)}/backdrops.json`; }
function color(value) {
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffff) return '#' + value.toString(16).padStart(6, '0');
    return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}
function sourceColor(row, field) {
    const numeric = color(row[field]), hex = color(row.hex?.[field]);
    if (numeric && hex && numeric !== hex) throw new Error('Conflicting canonical colors');
    const result = numeric || hex;
    if (!result) throw new Error('Missing canonical colors');
    return result;
}
function timestamp(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function parseBackdrops(raw, { collection = false, source = BACKDROPS_URL } = {}) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 1024) throw new Error('Invalid backdrop catalog');
    const names = new Map();
    for (const row of raw) {
        if (!row || typeof row !== 'object' || !label(row.name)) throw new Error('Invalid backdrop name');
        const rarity = collection && Number.isInteger(row.rarityPermille) && row.rarityPermille >= 0 && row.rarityPermille <= 1000
            ? row.rarityPermille : null;
        const item = { name: label(row.name), centerColor: sourceColor(row, 'centerColor'), edgeColor: sourceColor(row, 'edgeColor'),
            rarityPermille: rarity, raritySource: rarity === null ? null : source };
        const previous = names.get(item.name);
        if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('Ambiguous backdrop metadata');
        names.set(item.name, item);
    }
    return [...names.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
function fetchJson({ url = BACKDROPS_URL, signal, maxBytes }) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { signal, headers: { Accept: 'application/json', 'User-Agent': 'CrazyRocket-MarketplaceBackdrops/1.0' } }, res => {
            if (res.statusCode !== 200 || Number(res.headers['content-length']) > maxBytes) {
                res.destroy(); req.destroy(new Error('Backdrop metadata response rejected')); return;
            }
            let bytes = 0; const chunks = [];
            res.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > maxBytes) { res.destroy(); req.destroy(new Error('Backdrop metadata too large')); }
                else chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('Incomplete backdrop metadata')));
            res.on('end', () => {
                try { resolve({ data: JSON.parse(Buffer.concat(chunks).toString('utf8')), modifiedAt: res.headers['last-modified'] || null }); }
                catch { reject(new Error('Invalid backdrop metadata JSON')); }
            });
        });
        req.on('error', reject);
    });
}
/**
 * load({url, signal, maxBytes}) loads the whole global registry.
 * loadCollection({collection, giftId, url, signal, maxBytes}) loads one complete collection array.
 * Both return an array or {data: array, modifiedAt: HTTP-date/ISO-date}.
 * Global complete means the registry is complete, NOT that gift-specific rarity is known.
 * A selected collection's complete is true only after its own full metadata is obtained.
 */
function createMarketplaceBackdropCatalog({ load = fetchJson, loadCollection = fetchJson, now = Date.now,
    ttlMs = 6 * 60 * 60 * 1000, failureTtlMs = 60000, timeoutMs = MAX_TIMEOUT_MS, maxBytes = MAX_BYTES,
    maxCollections = 256, maxQueue = 256, fallback = null } = {}) {
    timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(MAX_TIMEOUT_MS, timeoutMs)) : MAX_TIMEOUT_MS;
    maxBytes = Number.isFinite(maxBytes) ? Math.max(1, Math.min(MAX_BYTES, maxBytes)) : MAX_BYTES;
    maxCollections = Number.isFinite(maxCollections) ? Math.max(1, Math.min(256, Math.floor(maxCollections))) : 256;
    maxQueue = Number.isFinite(maxQueue) ? Math.max(0, Math.min(256, Math.floor(maxQueue))) : 256;
    const global = { cached: null, pending: null, retryAt: 0, failed: false };
    const collections = new Map(), identities = new Map(), titles = new Map(), queue = [];
    let active = 0;
    for (const [id, title] of Object.entries(fallback?.collectionNamesById || {})) {
        if (giftId(id) && label(title)) { identities.set(id, label(title)); titles.set(key(title), id); }
    }
    if (fallback?.backdrops) {
        global.cached = { backdrops: parseBackdrops(fallback.backdrops), sourceUpdatedAt: timestamp(fallback.sourceUpdatedAt) };
    }
    async function bounded(loader, args, budgetMs = timeoutMs) {
        const controller = new AbortController(); let timer;
        try {
            const response = await Promise.race([
                Promise.resolve().then(() => loader({ ...args, signal: controller.signal, maxBytes })),
                new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Backdrop metadata timeout')); }, budgetMs); })
            ]);
            const data = response && Object.hasOwn(response, 'data') ? response.data : response;
            if (Buffer.byteLength(JSON.stringify(data) || '', 'utf8') > maxBytes) throw new Error('Backdrop metadata too large');
            return { backdrops: parseBackdrops(data, { collection: !!args.collection, source: args.url }),
                sourceUpdatedAt: timestamp(response?.modifiedAt) };
        } finally { clearTimeout(timer); }
    }
    function drain() {
        while (active < 2 && queue.length) {
            const job = queue.shift(); clearTimeout(job.timer);
            const remaining = job.deadline - Date.now();
            if (remaining <= 0) { job.reject(new Error('Backdrop metadata queue timeout')); continue; }
            active++;
            job.run(remaining).then(job.resolve, job.reject).finally(() => { active--; drain(); });
        }
    }
    function scheduled(run) {
        if (active >= 2 && queue.length >= maxQueue) return Promise.reject(new Error('Backdrop metadata queue full'));
        return new Promise((resolve, reject) => {
            const job = { run, resolve, reject, deadline: Date.now() + timeoutMs, timer: null };
            job.timer = setTimeout(() => {
                const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
                reject(new Error('Backdrop metadata queue timeout'));
            }, timeoutMs);
            queue.push(job); drain();
        });
    }
    async function ensure(state, loader, args, perCollection = false) {
        if (state.pending) return state.cached || state.pending;
        if (now() < state.retryAt) return state.cached;
        const refresh = async (budgetMs = timeoutMs) => {
            try { state.cached = await bounded(loader, args, budgetMs); state.failed = false; state.retryAt = now() + ttlMs; }
            catch { state.failed = true; state.retryAt = now() + failureTtlMs; }
            return state.cached;
        };
        state.pending = (perCollection ? scheduled(refresh).catch(() => {
            state.failed = true; state.retryAt = now() + failureTtlMs; return state.cached;
        }) : refresh()).finally(() => { state.pending = null; });
        return state.cached || state.pending; // Immediate seed/last-good result; refresh runs once in background.
    }
    function resolveCollection(collection, officialCatalog) {
        const name = label(collection); if (!name) return null;
        const matches = officialCatalog.filter(g => g && key(g.title || g.name) === key(name));
        const ids = new Set(matches.map(g => giftId(g.giftId)).filter(Boolean));
        if (matches.length && (ids.size !== 1 || matches.some(g => !giftId(g.giftId)))) return null;
        const id = ids.size === 1 ? [...ids][0] : titles.get(key(name)) || null;
        if (id && identities.has(id)) return { title: identities.get(id), giftId: id, cacheKey: 'id:' + id };
        // Exact names only; unknown caller names never trigger arbitrary network fan-out.
        if (matches.length) return { title: name, giftId: id, cacheKey: 'id:' + id };
        return null;
    }
    function collectionState(identity) {
        let state = collections.get(identity.cacheKey);
        if (state) { collections.delete(identity.cacheKey); collections.set(identity.cacheKey, state); return state; }
        if (collections.size >= maxCollections) {
            const evict = [...collections].find(([, value]) => !value.pending);
            if (!evict) return null;
            collections.delete(evict[0]);
        }
        state = { cached: null, pending: null, retryAt: 0, failed: false };
        collections.set(identity.cacheKey, state); return state;
    }
    async function getBackdrops({ collection = null, officialCatalog = [] } = {}) {
        const registry = await ensure(global, load, { url: BACKDROPS_URL });
        const selected = collection !== null && collection !== undefined && collection !== '';
        const identity = selected ? resolveCollection(collection, Array.isArray(officialCatalog) ? officialCatalog.slice(0, 4096) : []) : null;
        const state = identity ? collectionState(identity) : null;
        const metadata = state && typeof loadCollection === 'function'
            ? await ensure(state, loadCollection, { collection: identity.title, giftId: identity.giftId, url: collectionUrl(identity.title) }, true) : null;
        const result = selected ? metadata || registry : registry;
        const complete = selected ? !!metadata : !!registry;
        return { backdrops: (result?.backdrops || []).map(item => ({ ...item })), complete,
            source: metadata ? collectionUrl(identity.title) : BACKDROPS_URL,
            status: complete ? ((metadata ? state.failed : global.failed) ? 'stale' : 'available') : 'unavailable',
            sourceUpdatedAt: result?.sourceUpdatedAt || null,
            scope: metadata ? 'collection' : 'global', collection: identity?.title || (selected ? label(collection) || null : null),
            rarityStatus: metadata && metadata.backdrops.every(item => item.rarityPermille !== null) ? 'available' : 'unknown' };
    }
    return { getBackdrops };
}
const marketplaceBackdropCatalog = createMarketplaceBackdropCatalog({ fallback: require('./marketplaceBackdropCatalog.json') });
module.exports = { createMarketplaceBackdropCatalog, marketplaceBackdropCatalog, BACKDROPS_URL, SOURCE, collectionUrl };
