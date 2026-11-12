'use strict';

// Marketplace read models only. No prices, ownership records or offers are created here.
const rocketCatalog = require('./rocketGiftCatalog.json');
const lootCatalog = require('./lootBoxGiftCatalog.json');
const UNAVAILABLE_MESSAGE = 'هذه الهدية غير متوفرة حاليًا';
const LOCAL_GIFTS = [
    ...Object.values(lootCatalog.boxes || {}).flatMap(box => box.entries || []),
    ...(rocketCatalog.gifts || [])
];

const BASE_ALIASES = new Map([['durov', "Durov's Cap"], ['khabib', "Khabib's Papakha"]]);
function text(value) {
    return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
}
function collectionKey(value) {
    return text(value).toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]/gu, '');
}
const localNames = new Map();
for (const gift of LOCAL_GIFTS) {
    const rawName = text(gift.baseName || gift.name);
    const name = BASE_ALIASES.get(collectionKey(rawName)) || rawName;
    if (name && !localNames.has(collectionKey(name))) localNames.set(collectionKey(name), name);
}
function canonicalBaseName(value) {
    const name = text(value).replace(/(?:\s*#\s*|-)\d+$/, '').trim();
    return BASE_ALIASES.get(collectionKey(name)) || localNames.get(collectionKey(name)) || name;
}
function parseMetadata(value) {
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return {}; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function traitName(value) {
    return text(typeof value === 'object' && value ? value.name : value) || null;
}
function collectibleNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function originalImage(baseName) {
    return baseName ? `https://cdn.changes.tg/gifts/models/${encodeURIComponent(baseName)}/png/Original.png` : null;
}
function giftImageFallback(baseName) {
    return baseName ? `/api/gift-media/${encodeURIComponent(baseName)}` : null;
}
function collectibleDetails(row) {
    const metadata = parseMetadata(row.verified_metadata ?? row.verifiedMetadata);
    const baseName = canonicalBaseName(metadata.baseName || row.base_name || row.baseName || row.name || metadata.uniqueName);
    const id = text(row.collectible_id || row.unique_collectible_id || row.collectibleId || row.id);
    return {
        collectibleId: id,
        key: collectionKey(baseName),
        collectionKey: collectionKey(baseName),
        baseName,
        name: baseName,
        uniqueName: text(metadata.uniqueName || row.uniqueName) || id || baseName,
        collectibleNumber: collectibleNumber(row.collectible_number ?? row.collectibleNumber ?? metadata.collectibleNumber),
        model: traitName(metadata.model ?? row.model),
        backdrop: traitName(metadata.backdrop ?? row.backdrop),
        symbol: traitName(metadata.symbol ?? row.symbol),
        imageUrl: id ? `/api/collectible-media/${encodeURIComponent(id)}` : originalImage(baseName),
        fallbackImageUrl: originalImage(baseName),
        imageFallbackUrl: originalImage(baseName),
        rarity: text(row.rarity) || traitName(metadata.model?.rarity) || 'common'
    };
}
function projectMarketplaceListing(row) {
    const details = collectibleDetails(row);
    const priceTon = Number(row.price_ton ?? row.priceTon);
    if (!row.id || !details.collectibleId || !details.baseName || !Number.isFinite(priceTon) || priceTon <= 0) return null;
    if (row.ownership_verified != null && Number(row.ownership_verified) !== 1) return null;
    if (row.ownership_status != null && row.ownership_status !== 'OWNED') return null;
    if (row.listing_status != null && row.listing_status !== 'ACTIVE') return null;
    const value = Number(row.market_value ?? row.marketValue ?? 0);
    return {
        ...details,
        id: row.id,
        priceTon,
        createdAt: row.created_at ?? row.createdAt ?? null,
        collection: details.baseName,
        marketValue: Number.isFinite(value) ? value : 0,
        isMine: !!Number(row.is_mine ?? row.isMine ?? 0),
        // Legacy item fields remain available, but seller identity and raw metadata do not.
        collectible_id: details.collectibleId,
        collectible_number: details.collectibleNumber,
        price_ton: priceTon,
        image_url: details.imageUrl,
        created_at: row.created_at ?? row.createdAt ?? null,
        market_value: Number.isFinite(value) ? value : 0
    };
}
function projectOwnedMarketplaceCollectible(row, apiRow = {}) {
    if (Number(row.ownership_verified) !== 1 || row.ownership_status !== 'OWNED' || !row.unique_collectible_id) return null;
    if (parseMetadata(row.verified_metadata).isBurned) return null;
    const details = collectibleDetails(row);
    return {
        ...details,
        id: details.collectibleId,
        userGiftId: row.user_gift_id,
        status: 'OWNED',
        value: Number(apiRow.value ?? row.value ?? 0),
        sellValue: Number(apiRow.sellValue ?? 0),
        canBeTransferred: !!apiRow.canBeTransferred,
        collectible_id: details.collectibleId,
        collectible_number: details.collectibleNumber,
        image_url: details.imageUrl
    };
}

function normalizeMarketplaceCatalog(rows = [], { officialCatalog = [], stats = [], volumes = [] } = {}) {
    const names = new Map(localNames);
    // Official titles can improve spelling without ever exposing Telegram IDs/documents.
    for (const gift of officialCatalog) {
        const name = canonicalBaseName(gift.title || gift.name);
        if (name) names.set(collectionKey(name), name);
    }
    const catalog = new Map();
    function add(row, trusted = false) {
        const rawName = row.base_name || row.baseName || row.title || row.name;
        const key = collectionKey(canonicalBaseName(rawName));
        if (!key) return;
        const telegram = trusted || names.has(key) || text(row.collection).toLowerCase() === 'telegram' || Number(row.has_verified_collectible) === 1;
        if (!telegram) return; // Do not turn game-only local gifts into Telegram collections.
        const name = names.get(key) || canonicalBaseName(rawName);
        let entry = catalog.get(key);
        if (!entry) {
            entry = {
                id: key, key, name, baseName: name, collection: name,
                imageUrl: originalImage(name), image_url: originalImage(name),
                imageFallbackUrl: giftImageFallback(name), fallbackImageUrl: giftImageFallback(name),
                giftIds: [], rarity: text(row.rarity) || 'common',
                value: Number.isFinite(Number(row.value)) ? Number(row.value) : 0,
                total_supply: Math.max(0, Number(row.total_supply) || 0),
                available: false, count: 0, listingCount: 0, minPriceTon: null,
                volumeTon: 0, tradeCount: 0, volumeSource: 'in-game-completed-orders'
            };
            catalog.set(key, entry);
        }
        // giftIds are local gifts.id keys, NOT telegram_gift_id or owned-gift IDs.
        if (Number.isSafeInteger(row.id) && row.id > 0 && !entry.giftIds.includes(row.id)) entry.giftIds.push(row.id);
    }
    for (const row of rows) add(row);
    for (const gift of LOCAL_GIFTS) add({ name: gift.baseName || gift.name }, true);
    for (const gift of officialCatalog) add({ title: gift.title || gift.name }, true);
    for (const row of stats) {
        add({ baseName: row.base_name || row.name }, true);
        const entry = catalog.get(collectionKey(canonicalBaseName(row.base_name || row.name)));
        if (!entry) continue;
        const count = Math.max(0, Number(row.count) || 0);
        const min = Number(row.min_price_ton);
        entry.count += count;
        entry.listingCount = entry.count;
        entry.available = entry.count > 0;
        if (count && Number.isFinite(min) && min > 0) entry.minPriceTon = entry.minPriceTon == null ? min : Math.min(entry.minPriceTon, min);
    }
    for (const row of volumes) {
        const entry = catalog.get(collectionKey(canonicalBaseName(row.base_name || row.name)));
        if (!entry) continue;
        const volume = Number(row.volume_ton), trades = Number(row.trade_count);
        if (Number.isFinite(volume) && volume >= 0) entry.volumeTon += volume;
        if (Number.isSafeInteger(trades) && trades >= 0) entry.tradeCount += trades;
    }
    return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function normalizeMarketplaceFilters(input = {}) {
    const result = { collection: '', collections: [], model: '', backdrop: '', symbol: '', search: '', maxPrice: null, number: null, invalid: false };
    for (const field of ['collection', 'model', 'backdrop', 'symbol', 'search']) {
        const value = input[field];
        if (value == null || value === '') continue;
        if (typeof value !== 'string' || value.length > 160) { result.invalid = true; continue; }
        result[field] = field === 'collection' ? collectionKey(canonicalBaseName(value)) : text(value);
        if (!result[field]) result.invalid = true;
    }
    if (input.collections != null && input.collections !== '') {
        let values = input.collections;
        if (typeof values === 'string' && values.length <= 24000) {
            try { values = JSON.parse(values); } catch { values = null; }
        }
        if (!Array.isArray(values) || values.length > 150 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 160)) result.invalid = true;
        else result.collections = [...new Set(values.map(value => collectionKey(canonicalBaseName(value))))];
    }
    if (input.maxPrice != null && input.maxPrice !== '') {
        const value = typeof input.maxPrice === 'number' ? String(input.maxPrice) : input.maxPrice;
        if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) result.invalid = true;
        else result.maxPrice = Number(value);
    }
    if (input.number != null && input.number !== '') {
        const value = typeof input.number === 'number' ? String(input.number) : input.number;
        if (typeof value !== 'string' || !/^#?\d+$/.test(value) || !collectibleNumber(value.replace(/^#/, ''))) result.invalid = true;
        else result.number = Number(value.replace(/^#/, ''));
    }
    return result;
}
function paginationOptions(input = {}) {
    const requestedLimit = Number(input.limit);
    const requestedOffset = Number(input.offset);
    const page = Number(input.page);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 60;
    const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
        ? requestedOffset : (Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger((page - 1) * limit) ? (page - 1) * limit : 0);
    return { limit, offset };
}

// All interpolated expressions below are fixed code; user input is exclusively bound parameters.
const METADATA_SQL = "CASE WHEN json_valid(ug.verified_metadata) THEN ug.verified_metadata ELSE '{}' END";
const BASE_SQL = `COALESCE(NULLIF(json_extract(${METADATA_SQL}, '$.baseName'), ''), g.name)`;
function traitSql(field) {
    return `COALESCE(NULLIF(json_extract(${METADATA_SQL}, '$.${field}.name'), ''), CASE WHEN json_type(${METADATA_SQL}, '$.${field}') = 'text' THEN json_extract(${METADATA_SQL}, '$.${field}') END)`;
}
const NUMBER_SQL = `COALESCE(ug.collectible_number, json_extract(${METADATA_SQL}, '$.collectibleNumber'))`;
function collectionSql(value) {
    let sql = `lower(trim(${value}))`;
    sql = `replace(${sql}, '&', 'and')`;
    for (const char of [' ', '-', '_', "'", '’', '‘', '`', '.', '#']) sql = `replace(${sql}, '${char.replace(/'/g, "''")}', '')`;
    return sql;
}
const MARKETPLACE_FROM_SQL = `FROM market_listings ml
    JOIN user_gifts ug ON ug.unique_collectible_id = ml.collectible_id AND ug.user_id = ml.seller_user_id
    JOIN gifts g ON g.id = ug.gift_id`;
const MARKETPLACE_ACTIVE_SQL = `ml.status = 'ACTIVE' AND ug.status = 'OWNED' AND ug.ownership_verified = 1
    AND length(trim(ml.collectible_id)) > 0 AND ml.price_ton > 0 AND ml.price_ton <= 1.7976931348623157e308
    AND COALESCE(json_extract(${METADATA_SQL}, '$.isBurned'), 0) != 1`;
function buildMarketplaceQuery(input = {}) {
    const filters = normalizeMarketplaceFilters(input);
    const pagination = paginationOptions(input);
    const scope = [MARKETPLACE_ACTIVE_SQL];
    const scopeParams = [];
    const baseKeySql = collectionSql(BASE_SQL);
    const canonicalKeySql = `CASE ${baseKeySql} WHEN 'durov' THEN 'durovscap' WHEN 'khabib' THEN 'khabibspapakha' ELSE ${baseKeySql} END`;
    if (filters.collections.length) {
        scope.push(`${canonicalKeySql} IN (${filters.collections.map(() => '?').join(',')})`);
        scopeParams.push(...filters.collections);
    } else if (filters.collection) { scope.push(`${canonicalKeySql} = ?`); scopeParams.push(filters.collection); }
    const where = [...scope], params = [...scopeParams];
    if (filters.invalid) where.push('0 = 1');
    for (const field of ['model', 'backdrop', 'symbol']) {
        if (filters[field]) { where.push(`lower(trim(${traitSql(field)})) = lower(?)`); params.push(filters[field]); }
    }
    if (filters.maxPrice != null) { where.push('ml.price_ton <= ?'); params.push(filters.maxPrice); }
    if (filters.number != null) { where.push(`CAST(${NUMBER_SQL} AS NUMERIC) = ?`); params.push(filters.number); }
    if (filters.search) {
        where.push(`instr(lower(COALESCE(${BASE_SQL}, '') || ' ' || g.name || ' ' || ml.collectible_id || ' ' || COALESCE(${traitSql('model')}, '') || ' ' || COALESCE(${traitSql('backdrop')}, '') || ' ' || COALESCE(${traitSql('symbol')}, '')), lower(?)) > 0`);
        params.push(filters.search);
    }
    const fromWhere = `${MARKETPLACE_FROM_SQL} WHERE ${where.join(' AND ')}`;
    const facetFromWhere = `${MARKETPLACE_FROM_SQL} WHERE ${scope.join(' AND ')}`;
    const viewerId = Number.isSafeInteger(Number(input.viewerUserId)) ? Number(input.viewerUserId) : -1;
    return {
        filters, pagination, params, scopeParams,
        countSql: `SELECT COUNT(*) AS count ${fromWhere}`,
        listingsSql: `SELECT ml.id, ml.collectible_id, ml.price_ton, ml.created_at,
            ug.collectible_number, ug.verified_metadata, ug.ownership_verified, ug.status AS ownership_status,
            ml.status AS listing_status, g.name, g.rarity, COALESCE(ug.market_value, g.value) AS market_value,
            CASE WHEN ug.user_id = ? THEN 1 ELSE 0 END AS is_mine
            ${fromWhere} ORDER BY ml.created_at DESC, ml.id DESC LIMIT ? OFFSET ?`,
        listingParams: [viewerId, ...params, pagination.limit + 1, pagination.offset],
        traitsSql: `SELECT DISTINCT ${traitSql('model')} AS model, ${traitSql('backdrop')} AS backdrop, ${traitSql('symbol')} AS symbol ${facetFromWhere}`,
        numbersSql: `SELECT DISTINCT ${NUMBER_SQL} AS number ${facetFromWhere} AND ${NUMBER_SQL} > 0 ORDER BY number ASC LIMIT 1001`,
        priceRangeSql: `SELECT MIN(ml.price_ton) AS min_price, MAX(ml.price_ton) AS max_price ${facetFromWhere}`
    };
}
function buildMarketplacePage(plan, rows, count, traitRows = [], numberRows = [], priceRange = {}) {
    const listings = rows.slice(0, plan.pagination.limit).map(projectMarketplaceListing).filter(Boolean);
    const hasMore = rows.length > plan.pagination.limit;
    const facets = field => [...new Set(traitRows.map(row => traitName(row[field])).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
    return {
        listings,
        count: Math.max(0, Number(count) || 0),
        available: Number(count) > 0,
        message: Number(count) > 0 ? null : UNAVAILABLE_MESSAGE,
        filters: {
            models: facets('model'), backdrops: facets('backdrop'), symbols: facets('symbol'),
            numbers: numberRows.slice(0, 1000).map(row => collectibleNumber(row.number)).filter(Boolean),
            numbersHasMore: numberRows.length > 1000,
            minPrice: priceRange.min_price ?? null, maxPrice: priceRange.max_price ?? null
        },
        hasMore,
        nextOffset: hasMore ? plan.pagination.offset + listings.length : null,
        pagination: { ...plan.pagination, hasMore, nextOffset: hasMore ? plan.pagination.offset + listings.length : null }
    };
}

function createMarketplaceCatalogCache(load, { now = Date.now, timeoutMs = 4000, ttlMs = 15 * 60 * 1000, failureTtlMs = 5 * 60 * 1000 } = {}) {
    let cached = [], retryAt = 0, pending = null;
    return {
        peek: () => cached,
        get() {
            if (now() < retryAt) return Promise.resolve(cached);
            if (pending) return pending;
            pending = (async () => {
                let timer;
                try {
                    const gifts = await Promise.race([
                        Promise.resolve().then(load),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Marketplace catalog timeout')), timeoutMs); })
                    ]);
                    if (!Array.isArray(gifts) || !gifts.length) throw new Error('Empty marketplace catalog');
                    cached = gifts.map(gift => ({ title: text(gift.title || gift.name) })).filter(gift => gift.title);
                    if (!cached.length) throw new Error('No marketplace gift titles');
                    retryAt = now() + ttlMs;
                } catch {
                    retryAt = now() + failureTtlMs;
                } finally { clearTimeout(timer); }
                return cached;
            })().finally(() => { pending = null; });
            return pending;
        }
    };
}

module.exports = {
    UNAVAILABLE_MESSAGE, collectionKey, canonicalBaseName, parseMetadata, originalImage,
    normalizeMarketplaceCatalog, normalizeMarketplaceFilters, projectMarketplaceListing,
    projectOwnedMarketplaceCollectible, buildMarketplaceQuery, buildMarketplacePage,
    createMarketplaceCatalogCache, MARKETPLACE_FROM_SQL, MARKETPLACE_ACTIVE_SQL, BASE_SQL
};
