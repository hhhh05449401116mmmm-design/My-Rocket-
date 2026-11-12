'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMarketplaceBackdropCatalog, BACKDROPS_URL, collectionUrl } = require('../marketplaceBackdropCatalog');
const seed = require('../marketplaceBackdropCatalog.json');
const globalRows = [
    { name: 'Black', centerColor: 3553080, edgeColor: 921359, hex: { centerColor: '#363738', edgeColor: '#0e0f0f' } },
    { name: 'Onyx Black', centerColor: 5067348, edgeColor: 3225144 },
    { name: 'Aquamarine', centerColor: 6336917, edgeColor: 4631476 }
];
const officialCatalog = [{ title: 'Plush Pepe', giftId: '5936013938331222567' }];
const tick = () => new Promise(resolve => setImmediate(resolve));

test('bundled global source has all 80 exact canonical names/colors and no invented global rarity', async () => {
    let calls = 0;
    const service = createMarketplaceBackdropCatalog({ fallback: seed, timeoutMs: 5, load: async () => { calls++; return new Promise(() => {}); } });
    const result = await service.getBackdrops();
    assert.equal(result.backdrops.length, 80); assert.equal(result.complete, true);
    assert.equal(result.source, BACKDROPS_URL); assert.equal(result.scope, 'global');
    assert.equal(result.sourceUpdatedAt, '2026-01-30T01:39:10.000Z');
    const black = result.backdrops.find(x => x.name === 'Black'), onyx = result.backdrops.find(x => x.name === 'Onyx Black');
    assert.equal(black.centerColor, '#363738'); assert.equal(black.edgeColor, '#0e0f0f');
    assert.equal(onyx.centerColor, '#4d5254'); assert.equal(onyx.edgeColor, '#313638');
    for (const name of ['Amber', 'Aquamarine', 'Azure Blue', 'Battleship Grey', 'Burgundy', 'Burnt Sienna', 'Camo Green', 'Cappuccino', 'Caramel']) {
        assert.ok(result.backdrops.some(x => x.name === name), name);
    }
    assert.ok(result.backdrops.every(x => x.rarityPermille === null && x.raritySource === null));
    await Promise.all(Array.from({ length: 4000 }, () => service.getBackdrops())); assert.equal(calls, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
});

test('selected gift loads a complete public metadata array and uses only its explicit current rarityPermille', async () => {
    const received = [];
    const service = createMarketplaceBackdropCatalog({ load: async () => globalRows, loadCollection: async args => {
        received.push(args);
        return { data: [
            { ...globalRows[2], rarityPermille: 10, originalRarityPermille: 99 },
            { ...globalRows[0], rarityPermille: 20 },
            { ...globalRows[1], originalRarityPermille: 20, price: 100, issued: 20, totalIssued: 1000 }
        ], modifiedAt: 'Sat, 10 Oct 2026 19:50:34 GMT' };
    } });
    const result = await service.getBackdrops({ collection: 'Plush Pepe', officialCatalog });
    assert.equal(result.complete, true); assert.equal(result.scope, 'collection');
    assert.equal(result.backdrops.find(x => x.name === 'Aquamarine').rarityPermille, 10);
    assert.equal(result.backdrops.find(x => x.name === 'Black').rarityPermille, 20);
    assert.equal(result.backdrops.find(x => x.name === 'Onyx Black').rarityPermille, null);
    assert.equal(result.backdrops.find(x => x.name === 'Onyx Black').raritySource, null);
    assert.equal(result.backdrops[0].raritySource, collectionUrl('Plush Pepe'));
    assert.equal(result.sourceUpdatedAt, '2026-10-10T19:50:34.000Z');
    assert.equal(received[0].giftId, officialCatalog[0].giftId);
    assert.equal(received[0].url, 'https://cdn.changes.tg/gifts/backdrops/Plush%20Pepe/backdrops.json');
});

test('global registry ignores even an accidentally supplied gift rarity; caller mutations never alter cached metadata', async () => {
    const service = createMarketplaceBackdropCatalog({ load: async () => globalRows.map(x => ({ ...x, rarityPermille: 20 })) });
    const a = await service.getBackdrops(); assert.ok(a.backdrops.every(x => x.rarityPermille === null));
    a.backdrops[0].name = 'Fake'; a.backdrops[0].centerColor = '#ffffff';
    const b = await service.getBackdrops(); assert.equal(b.backdrops[0].name, 'Aquamarine'); assert.equal(b.backdrops[0].centerColor, '#60b195');
});

test('selected collection identities bind by verified ID, never fuzzy names or ambiguous official entries', async () => {
    let calls = 0;
    const fallback = { backdrops: globalRows, collectionNamesById: { '5936013938331222567': 'Plush Pepe' } };
    const service = createMarketplaceBackdropCatalog({ fallback, load: async () => globalRows, loadCollection: async args => {
        calls++; assert.equal(args.collection, 'Plush Pepe'); return globalRows;
    } });
    const renamed = await service.getBackdrops({ collection: 'Display Pepe', officialCatalog: [{ title: 'Display Pepe', giftId: '5936013938331222567' }] });
    assert.equal(renamed.complete, true);
    for (const [collection, catalog] of [['PlushPepe', []], ['Plush Pepe', [{ title: 'Plush Pepe', giftId: '001' }]],
        ['Plush Pepe', [{ title: 'Plush Pepe', giftId: '1' }, { title: 'Plush Pepe', giftId: '2' }]]]) {
        const result = await service.getBackdrops({ collection, officialCatalog: catalog });
        assert.equal(result.complete, false); assert.equal(result.rarityStatus, 'unknown');
    }
    assert.equal(calls, 1);
});

test('4000 users share one global refresh and one selected collection fetch with six-hour caching', async () => {
    let globalCalls = 0, collectionCalls = 0, clock = 100;
    const service = createMarketplaceBackdropCatalog({ now: () => clock, load: async () => { globalCalls++; return globalRows; },
        loadCollection: async () => { collectionCalls++; await tick(); return globalRows.map(x => ({ ...x, rarityPermille: 15 })); } });
    const results = await Promise.all(Array.from({ length: 4000 }, () => service.getBackdrops({ collection: 'Plush Pepe', officialCatalog })));
    assert.ok(results.every(x => x.complete)); assert.equal(globalCalls, 1); assert.equal(collectionCalls, 1);
    clock += 6 * 60 * 60 * 1000 - 1; await service.getBackdrops({ collection: 'Plush Pepe', officialCatalog });
    assert.equal(collectionCalls, 1);
    clock++; await service.getBackdrops({ collection: 'Plush Pepe', officialCatalog }); await tick(); await tick();
    assert.equal(globalCalls, 2); assert.equal(collectionCalls, 2);
});

test('last-good cache survives errors with retry backoff and explicit stale status', async () => {
    let clock = 100, fail = false, calls = 0;
    const service = createMarketplaceBackdropCatalog({ now: () => clock, ttlMs: 50, failureTtlMs: 20, load: async () => {
        calls++; if (fail) throw new Error('Offline'); return globalRows;
    } });
    await service.getBackdrops(); clock = 150; fail = true;
    await service.getBackdrops(); await tick();
    const stale = await service.getBackdrops(); assert.equal(stale.status, 'stale'); assert.equal(stale.complete, true); assert.equal(calls, 2);
    clock = 169; await service.getBackdrops(); assert.equal(calls, 2);
    clock = 170; await service.getBackdrops(); await tick(); assert.equal(calls, 3);
});

test('malformed, conflicting, excessive and oversized metadata cannot replace last-good data', async () => {
    for (const bad of [null, {}, [], [{ name: 'Black', centerColor: 'red', edgeColor: '#000000' }],
        [{ ...globalRows[0], hex: { centerColor: '#ffffff' } }], [globalRows[0], { ...globalRows[0], edgeColor: 1 }],
        Array.from({ length: 1025 }, () => globalRows[0])]) {
        const service = createMarketplaceBackdropCatalog({ load: async () => bad });
        const result = await service.getBackdrops(); assert.equal(result.complete, false); assert.deepEqual(result.backdrops, []);
    }
    const oversized = createMarketplaceBackdropCatalog({ maxBytes: 10, load: async () => globalRows });
    assert.equal((await oversized.getBackdrops()).complete, false);
});

test('per-gift missing or invalid rarity remains null, including original rarity, counts, price, screenshot and numeric strings', async () => {
    const values = [undefined, null, '20', -1, 1001, 1.5, 0, 1000];
    const service = createMarketplaceBackdropCatalog({ load: async () => globalRows,
        loadCollection: async () => values.map((rarityPermille, i) => ({ ...globalRows[0], name: 'Variant ' + i,
            rarityPermille, originalRarityPermille: 20, price: 20, count: 20 })) });
    const result = await service.getBackdrops({ collection: 'Plush Pepe', officialCatalog });
    assert.deepEqual(result.backdrops.map(x => x.rarityPermille), [null, null, null, null, null, null, 0, 1000]);
});

test('request timeout aborts loaders; selected failure retains global swatches without claiming collection completeness', async () => {
    let signal;
    const service = createMarketplaceBackdropCatalog({ load: async () => globalRows, timeoutMs: 5,
        loadCollection: async args => { signal = args.signal; return new Promise(() => {}); } });
    const result = await service.getBackdrops({ collection: 'Plush Pepe', officialCatalog });
    assert.equal(signal.aborted, true); assert.equal(result.complete, false); assert.equal(result.scope, 'global');
    assert.equal(result.backdrops.length, 3); assert.ok(result.backdrops.every(x => x.rarityPermille === null));
});

test('selected metadata uses a global two-worker queue and finite LRU cache', async () => {
    let active = 0, peak = 0, calls = 0;
    const service = createMarketplaceBackdropCatalog({ load: async () => globalRows, maxCollections: 3,
        loadCollection: async () => { active++; peak = Math.max(peak, active); calls++; await tick(); active--; return globalRows; } });
    const catalog = Array.from({ length: 6 }, (_, i) => ({ title: 'Gift ' + i, giftId: String(i + 1) }));
    const first = await Promise.all(catalog.slice(0, 3).map(g => service.getBackdrops({ collection: g.title, officialCatalog: catalog })));
    assert.ok(first.every(x => x.complete)); assert.equal(peak, 2);
    for (const g of catalog.slice(3)) await service.getBackdrops({ collection: g.title, officialCatalog: catalog });
    await service.getBackdrops({ collection: catalog[0].title, officialCatalog: catalog }); assert.equal(calls, 7);
});

test('finite queue overflow and pinned-cache overflow fail safely instead of unbounded fan-out', async () => {
    let calls = 0;
    const service = createMarketplaceBackdropCatalog({ load: async () => globalRows, timeoutMs: 5, maxQueue: 1, maxCollections: 4,
        loadCollection: async () => { calls++; return new Promise(() => {}); } });
    const catalog = Array.from({ length: 8 }, (_, i) => ({ title: 'Gift ' + i, giftId: String(i + 1) }));
    const results = await Promise.all(catalog.map(g => service.getBackdrops({ collection: g.title, officialCatalog: catalog })));
    assert.ok(results.every(x => x.complete === false)); assert.ok(calls >= 2 && calls <= 3);
});

test('same canonical backdrop has independent explicit rarity for each selected collection', async () => {
    const catalog = [{ title: 'Gift One', giftId: '1' }, { title: 'Gift Two', giftId: '2' }];
    const service = createMarketplaceBackdropCatalog({ load: async () => globalRows,
        loadCollection: async args => [{ ...globalRows[2], rarityPermille: args.giftId === '1' ? 10 : 15 }] });
    const [one, two] = await Promise.all(catalog.map(g => service.getBackdrops({ collection: g.title, officialCatalog: catalog })));
    assert.equal(one.backdrops[0].rarityPermille, 10); assert.equal(two.backdrops[0].rarityPermille, 15);
    assert.notEqual(one.backdrops[0].raritySource, two.backdrops[0].raritySource);
    assert.equal((await service.getBackdrops()).backdrops[0].rarityPermille, null);
});
