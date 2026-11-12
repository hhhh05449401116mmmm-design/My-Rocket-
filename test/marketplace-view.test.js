'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const view = require('../marketplaceView');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocket-market-view-'));
process.env.DATABASE_PATH = path.join(dir, 'market.sqlite');
process.env.MARKETPLACE_ENABLED = 'true';
for (const key of ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSION_STRING']) process.env[key] = '';
require('../test-helpers/no-network');
const database = require('../database');
const { app } = require('../server');
let listener, url, owner, viewer, pepeGift, iceGift;

function metadata(number, overrides = {}) {
    return JSON.stringify({
        baseName: 'Plush Pepe', uniqueName: 'PlushPepe', collectibleNumber: number,
        model: { name: 'Golden', rarity: 'legendary', stickerFileId: 'PRIVATE_FILE_ID' },
        backdrop: { name: 'Black', colors: { center: 123 } }, symbol: { name: 'Stars' },
        ownedGiftId: 'PRIVATE_OWNED_ID', telegramGiftId: 'PRIVATE_TELEGRAM_GIFT_ID',
        sender: { id: 'PRIVATE_TELEGRAM_ID', username: 'PRIVATE_USERNAME' },
        rawTelegram: { token: 'PRIVATE_RAW_TOKEN' }, ...overrides
    });
}
async function insertListing({ id, number, giftId = pepeGift.id, userId = owner.id, sellerId = owner.id,
    verified = 1, status = 'OWNED', listingStatus = 'ACTIVE', price = 10, meta = metadata(number), createdAt = '2026-01-01 00:00:00' }) {
    await database.run(`INSERT INTO user_gifts (user_id, gift_id, status, unique_collectible_id,
        collectible_number, ownership_verified, verified_metadata, market_value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [userId, giftId, status, id, number, verified, meta, 999]);
    await database.run(`INSERT INTO market_listings (collectible_id, seller_user_id, price_ton, status, created_at)
        VALUES (?, ?, ?, ?, ?)`, [id, sellerId, price, listingStatus, createdAt]);
}
async function request(route, authenticated = true) {
    const response = await fetch(url + route, { headers: authenticated ? { Authorization: 'Bearer ' + viewer.id } : {} });
    return { status: response.status, data: await response.json() };
}

function assertPublic(value) {
    const serialized = JSON.stringify(value);
    for (const forbidden of ['PRIVATE_', 'verifiedMetadata', 'verified_metadata', 'seller_user_id',
        'telegram_gift_id', 'telegramGiftId', 'ownedGiftId', 'stickerFileId', 'rawTelegram', 'sender']) {
        assert.ok(!serialized.includes(forbidden), 'public data must not expose ' + forbidden);
    }
}

test.before(async () => {
    await database.initDatabase();
    await database.seedDatabase();
    owner = await database.findOrCreateUser('PRIVATE_SELLER_TELEGRAM_ID');
    viewer = await database.findOrCreateUser('PRIVATE_VIEWER_TELEGRAM_ID');
    await database.run(`INSERT INTO gifts (telegram_gift_id, name, rarity, value, collection)
        VALUES (?, ?, 'common', 1, 'Telegram')`, ['PRIVATE_PEPE_MODEL_ID', 'PlushPepe']);
    pepeGift = await database.get('SELECT * FROM gifts WHERE telegram_gift_id = ?', ['PRIVATE_PEPE_MODEL_ID']);
    await database.run(`INSERT INTO gifts (telegram_gift_id, name, rarity, value, collection)
        VALUES (?, ?, 'common', 1, 'Telegram')`, ['PRIVATE_ICE_MODEL_ID', 'Ice Cream']);
    iceGift = await database.get('SELECT * FROM gifts WHERE telegram_gift_id = ?', ['PRIVATE_ICE_MODEL_ID']);
    await insertListing({ id: 'PlushPepe-17', number: 17, price: 7.25 });
    await insertListing({ id: 'PlushPepe-117', number: 117, price: 7.26,
        meta: metadata(117, { model: { name: 'Silver' }, backdrop: { name: 'Onyx Black' }, symbol: { name: 'Moon' } }) });
    // More than the page cap: exact filters must still find the oldest real listing.
    for (let i = 1000; i < 1125; i++) {
        await insertListing({ id: 'PlushPepe-' + i, number: i, createdAt: '2026-02-01 00:00:00' });
    }
    await insertListing({ id: 'unverified-1', number: 1, verified: 0 });
    await insertListing({ id: 'locked-2', number: 2, status: 'LOCKED' });
    await insertListing({ id: 'stale-owner-3', number: 3, userId: viewer.id, sellerId: owner.id });
    await insertListing({ id: 'sold-4', number: 4, listingStatus: 'SOLD' });
    await insertListing({ id: 'burned-5', number: 5, meta: metadata(5, { isBurned: true }) });
    await database.run(`INSERT INTO user_gifts (user_id, gift_id, status, unique_collectible_id,
        collectible_number, ownership_verified, verified_metadata, market_value) VALUES (?, ?, 'OWNED', ?, 9, 1, ?, 2)`,
    [viewer.id, iceGift.id, 'IceCream-9', metadata(9, { baseName: 'Ice Cream', uniqueName: 'IceCream' })]);
    await database.run(`INSERT INTO user_gifts (user_id, gift_id, status, unique_collectible_id,
        collectible_number, ownership_verified) VALUES (?, ?, 'OWNED', 'UnverifiedIce-8', 8, 0)`, [viewer.id, iceGift.id]);
    listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    url = 'http://127.0.0.1:' + listener.address().port;
});
test.after(async () => {
    if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
    await new Promise(resolve => database.db.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('catalog normalizes compact names, deduplicates by base and excludes non-Telegram local gifts', () => {
    const catalog = view.normalizeMarketplaceCatalog([
        { id: 1, name: 'PlushPepe', collection: 'Telegram', telegram_gift_id: 'PRIVATE_1' },
        { id: 2, name: '  Plush Pepe  ', collection: 'Telegram', image_url: 'javascript:alert(1)' },
        { id: 3, name: 'SPACE', collection: 'Space' },
        { id: 4, name: 'Backpack', collection: 'Gear' },
        { id: 5, name: 'Durov', collection: 'Telegram' },
        { id: 6, name: "Durov’s Cap", collection: 'Telegram' }
    ], { officialCatalog: [{ title: 'A Newly Added Gift', id: 999n, sticker: { fileId: 'PRIVATE_FILE' } }],
        stats: [{ base_name: 'PlushPepe', count: 2, min_price_ton: 7.25 }] });
    const pepe = catalog.filter(row => row.key === 'plushpepe');
    assert.equal(pepe.length, 1);
    assert.equal(pepe[0].baseName, 'Plush Pepe');
    assert.deepEqual(pepe[0].giftIds, [1, 2]);
    assert.equal(pepe[0].available, true); assert.equal(pepe[0].count, 2);
    assert.equal(pepe[0].imageUrl, 'https://cdn.changes.tg/gifts/models/Plush%20Pepe/png/Original.png');
    assert.equal(pepe[0].imageFallbackUrl, '/api/gift-media/Plush%20Pepe');
    assert.equal(catalog.filter(row => row.key === 'durovscap').length, 1);
    assert.ok(!catalog.some(row => ['space', 'backpack', 'durov', 'khabib'].includes(row.key)));
    const newGift = catalog.find(row => row.name === 'A Newly Added Gift');
    assert.equal(newGift.available, false); assert.equal(newGift.count, 0);
    assertPublic(catalog); assert.ok(!JSON.stringify(catalog).includes('javascript:'));
});

test('metadata normalization handles corrupted JSON and projects exact public collectible media', () => {
    assert.deepEqual(view.parseMetadata('not json'), {});
    assert.deepEqual(view.parseMetadata('[1,2]'), {});
    const listing = view.projectMarketplaceListing({ id: 1, collectible_id: 'PlushPepe-17', name: 'PlushPepe',
        collectible_number: 17, price_ton: '7.25', verified_metadata: metadata(999), ownership_verified: 1,
        ownership_status: 'OWNED', listing_status: 'ACTIVE', image_url: 'https://unsafe.example/token' });
    assert.equal(listing.baseName, 'Plush Pepe'); assert.equal(listing.collectibleNumber, 17);
    assert.equal(listing.model, 'Golden'); assert.equal(listing.backdrop, 'Black'); assert.equal(listing.symbol, 'Stars');
    assert.equal(listing.imageUrl, '/api/collectible-media/PlushPepe-17');
    assert.equal(listing.fallbackImageUrl, view.originalImage('Plush Pepe'));
    assert.equal(listing.priceTon, 7.25); assert.equal(listing.price_ton, 7.25);
    assertPublic(listing); assert.ok(!JSON.stringify(listing).includes('unsafe.example'));
    const legacy = view.projectMarketplaceListing({ id: 2, collectible_id: 'FinePen-8', name: 'FinePen', price_ton: 1,
        verified_metadata: JSON.stringify({ collectibleNumber: 8, model: 'Original', backdrop: 'Blue', symbol: 'Dots' }) });
    assert.equal(legacy.baseName, 'Fine Pen'); assert.equal(legacy.model, 'Original'); assert.equal(legacy.collectibleNumber, 8);
    assert.equal(view.projectMarketplaceListing({ id: 3, collectible_id: 'x', name: 'x', price_ton: -1 }), null);
});

test('query builder binds malicious text and never interpolates client values', () => {
    const malicious = "' OR 1=1; DROP TABLE gifts; --";
    const plan = view.buildMarketplaceQuery({ model: malicious, backdrop: malicious, search: malicious, maxPrice: '7.25', number: '#17' });
    assert.ok(!plan.listingsSql.includes(malicious)); assert.ok(!plan.countSql.includes(malicious));
    assert.ok(plan.params.includes(malicious)); assert.ok(plan.params.includes(7.25)); assert.ok(plan.params.includes(17));
    assert.ok(view.normalizeMarketplaceFilters({ number: '17 OR 1=1' }).invalid);
    assert.ok(view.normalizeMarketplaceFilters({ maxPrice: 'Infinity' }).invalid);
    assert.ok(view.normalizeMarketplaceFilters({ collection: { malicious } }).invalid);
});

test('database filters before pagination with exact number and inclusive maximum price', async () => {
    const page = await database.getMarketplaceListings({ collection: 'Plush Pepe', number: '17', maxPrice: '7.25', limit: 1,
        model: 'golden', backdrop: 'Black', symbol: 'Stars' });
    assert.equal(page.count, 1); assert.equal(page.listings.length, 1);
    assert.equal(page.listings[0].collectibleId, 'PlushPepe-17'); assert.equal(page.hasMore, false);
    assert.equal((await database.getMarketplaceListings({ collection: 'PlushPepe', number: 117, maxPrice: 7.25 })).count, 0);
    assert.equal((await database.getMarketplaceListings({ collection: 'Plush Pepe', number: 17, backdrop: 'Onyx Black' })).count, 0);
    assert.equal((await database.getMarketplaceListings({ collection: 'Plush Pepe', number: 117, backdrop: 'Onyx Black' })).count, 1);
    assert.equal((await database.getMarketplaceListings({ collection: 'Plush Pepe', maxPrice: 0 })).count, 0);
    assertPublic(page);
});

test('pagination caps at 100 with stable non-overlapping pages and compatible legacy array export', async () => {
    const first = await database.getMarketplaceListings({ collection: 'PlushPepe', limit: 999 });
    assert.equal(first.count, 127); assert.equal(first.listings.length, 100);
    assert.equal(first.pagination.limit, 100); assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 100);
    const second = await database.getMarketplaceListings({ collection: 'Plush Pepe', limit: 999, offset: first.nextOffset });
    assert.equal(second.listings.length, 27); assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.listings, ...second.listings].map(row => row.id)).size, 127);
    assert.ok(second.listings.some(row => row.collectibleNumber === 17));
    const legacy = await database.getMarketplaceListings(1);
    assert.ok(Array.isArray(legacy)); assert.equal(legacy.length, 1); assert.ok(legacy[0].collectible_id);
});

test('real-listing facets are collection scoped and unaffected by narrow listing filters', async () => {
    const page = await database.getMarketplaceListings({ collection: 'Plush Pepe', number: 17, limit: 1 });
    assert.deepEqual(page.filters.models, ['Golden', 'Silver']);
    assert.deepEqual(page.filters.backdrops, ['Black', 'Onyx Black']);
    assert.deepEqual(page.filters.symbols, ['Moon', 'Stars']);
    assert.ok(page.filters.numbers.includes(17)); assert.ok(page.filters.numbers.includes(117));
    const ice = await database.getMarketplaceListings({ collection: 'Ice Cream' });
    assert.equal(ice.count, 0); assert.deepEqual(ice.filters.models, []);
});

test('malicious filter values remain harmless literal values and invalid numbers match nothing', async () => {
    for (const filters of [{ collection: "' OR 1=1 --" }, { model: "' OR 1=1 --" },
        { search: '%_\' OR 1=1 --' }, { number: '17 OR 1=1' }, { maxPrice: '7.25 OR 1=1' }]) {
        const result = await database.getMarketplaceListings(filters);
        assert.equal(result.count, 0); assert.deepEqual(result.listings, []);
    }
    assert.ok((await database.get('SELECT COUNT(*) AS count FROM gifts')).count > 0);
});

test('public catalog and empty filtered API return success without inventing offers or mutating state', async () => {
    const before = await database.get('SELECT COUNT(*) AS count FROM market_listings');
    const balance = await database.getUserBalance(viewer.id);
    const result = await request('/api/market/catalog', false);
    assert.equal(result.status, 200); assert.equal(result.data.ok, true);
    assert.ok(result.data.catalog.length >= 111); assertPublic(result.data);
    assert.ok(!result.data.catalog.some(row => ['SPACE', 'Backpack', 'PUNK42'].includes(row.name)));
    const ice = result.data.catalog.find(row => row.baseName === 'Ice Cream');
    assert.equal(ice.available, false); assert.equal(ice.count, 0);
    const empty = await request('/api/market/items?collection=Ice%20Cream&maxPrice=99');
    assert.equal(empty.status, 200); assert.equal(empty.data.ok, true);
    assert.equal(empty.data.available, false); assert.equal(empty.data.count, 0);
    assert.deepEqual(empty.data.listings, []); assert.equal(empty.data.message, view.UNAVAILABLE_MESSAGE);
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM market_listings')).count, before.count);
    assert.equal(await database.getUserBalance(viewer.id), balance);
});

test('authenticated items expose only own verified owned NFTs without a verification sweep', async () => {
    const response = await request('/api/market/items?collection=Plush%20Pepe&number=17&limit=40');
    assert.equal(response.status, 200); assert.equal(response.data.count, 1);
    assert.deepEqual(response.data.myCollectibles.map(row => row.id).sort(), ['IceCream-9', 'stale-owner-3']);
    assertPublic(response.data);
    assert.equal(response.data.listings[0].isMine, false);
    assert.equal(response.data.pagination.hasMore, false);
    assert.equal((await request('/api/market/items', false)).status, 401);
});

test('catalog refresh is in-flight deduplicated, bounded and negative cached, retaining titles only', async () => {
    let calls = 0, clock = 0;
    const cache = view.createMarketplaceCatalogCache(async () => { calls++; return [{ title: 'New Gift', id: 5n, sticker: 'PRIVATE_STICKER' }]; },
        { now: () => clock, ttlMs: 100, timeoutMs: 10 });
    const [first, second] = await Promise.all([cache.get(), cache.get()]);
    assert.deepEqual(first, [{ title: 'New Gift' }]); assert.deepEqual(second, first); assert.equal(calls, 1);
    clock = 99; await cache.get(); assert.equal(calls, 1);
    clock = 100; await cache.get(); assert.equal(calls, 2);
    const failed = view.createMarketplaceCatalogCache(async () => { calls++; throw new Error('offline'); },
        { now: () => clock, failureTtlMs: 300, timeoutMs: 10 });
    await failed.get(); const failureCalls = calls; await failed.get(); assert.equal(calls, failureCalls);
    clock += 301; await failed.get(); assert.equal(calls, failureCalls + 1);
    const timed = view.createMarketplaceCatalogCache(() => new Promise(() => {}), { timeoutMs: 5 });
    assert.deepEqual(await timed.get(), []);
});


test('multiple collection filters are exact, parameterized and applied before pagination', async () => {
    const plan = view.buildMarketplaceQuery({ collections: JSON.stringify(['Plush Pepe', 'Ice Cream']), number: 17, maxPrice: 7.25 });
    assert.deepEqual(plan.filters.collections, ['plushpepe', 'icecream']);
    assert.ok(plan.listingsSql.includes(' IN (?,?)'));
    assert.ok(!plan.listingsSql.includes('Plush Pepe'));
    const page = await database.getMarketplaceListings({ collections: ['Plush Pepe', 'Ice Cream'], number: 17, maxPrice: 7.25, limit: 1 });
    assert.equal(page.count, 1); assert.equal(page.listings[0].collectibleId, 'PlushPepe-17');
    assert.ok(view.normalizeMarketplaceFilters({ collections: '[not JSON]' }).invalid);
    assert.ok(view.normalizeMarketplaceFilters({ collections: [null] }).invalid);
    assert.ok(view.normalizeMarketplaceFilters({ collections: Array(151).fill('Ice Cream') }).invalid);
    const malicious = "' OR 1=1 --";
    const invalid = await database.getMarketplaceListings({ collections: [malicious] });
    assert.equal(invalid.count, 0);
    const api = await request('/api/market/items?collections=' + encodeURIComponent(JSON.stringify(['Plush Pepe', 'Ice Cream'])) + '&number=17');
    assert.equal(api.status, 200); assert.equal(api.data.count, 1); assertPublic(api.data);
});

test('collection volume is an explicit aggregate of real in-game orders, not stock or valuation', () => {
    const catalog = view.normalizeMarketplaceCatalog([], {
        stats: [{ base_name:'Ice Cream', count:2, min_price_ton:4.2 }],
        volumes:[{ base_name:'IceCream', volume_ton:12.5, trade_count:3 }]
    });
    const ice=catalog.find(row=>row.key==='icecream');
    assert.equal(ice.minPriceTon,4.2); assert.equal(ice.volumeTon,12.5); assert.equal(ice.tradeCount,3);
    assert.equal(ice.volumeSource,'in-game-completed-orders');
    const empty=catalog.find(row=>row.key==='plushpepe');assert.equal(empty.volumeTon,0);assert.equal(empty.minPriceTon,null);
    assertPublic(catalog);
});
