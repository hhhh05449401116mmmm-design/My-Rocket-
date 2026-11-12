'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const serviceModule = require('../marketplaceMarketData');
const { createMarketplaceMarketData, SOURCE } = serviceModule;

const UPDATED = Date.parse('2026-11-12T10:52:34Z');
const NOW = Date.parse('2026-11-12T11:34:06Z');
const DAY = 24 * 60 * 60 * 1000;
const SHA = '14f5f60796cde709320c11cb9b8211760c37fdc4';
const LATEST = 'https://raw.githubusercontent.com/ssamy2/TelegramGiftsAssests/main/Gifts_Details.json';
const turns = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};
function gift(name, floor, extras = {}) {
    return { full_name: name, short_name: name.toLowerCase().replace(/\s+/g, '_'),
        models: 'models/test_gift/prices.json', floor_price_ton: floor, ...extras };
}
function dataset(gifts, timestamp = UPDATED) {
    return { last_updated: timestamp / 1000, upgraded: gifts };
}
function network(latest, previous, options = {}) {
    const calls = [];
    return {
        calls,
        async fetchJson(url, limits) {
            calls.push({ url, limits });
            if (url === LATEST) return typeof latest === 'function' ? latest() : latest;
            if (new URL(url).hostname === 'api.github.com') {
                if (options.commitError) throw new Error('PRIVATE_TOKEN_IN_ERROR');
                if (options.commit) return options.commit;
                return [{ sha: SHA, commit: { committer: { date: new Date(UPDATED - DAY - 16 * 60 * 1000).toISOString() } } }];
            }
            assert.equal(url, `https://raw.githubusercontent.com/ssamy2/TelegramGiftsAssests/${SHA}/Gifts_Details.json`);
            return typeof previous === 'function' ? previous() : previous;
        }
    };
}
async function withHistory(service) {
    await service.getSnapshot();
    await turns();
    return service.getSnapshot();
}

test('exports a lazy shared default and injectable read-only contract, isolated from financial engines', () => {
    assert.equal(typeof createMarketplaceMarketData, 'function');
    for (const method of ['getSnapshot', 'getMetadataSnapshot', 'enrichCatalog']) {
        assert.equal(typeof serviceModule[method], 'function');
        assert.equal(serviceModule[method], serviceModule.marketplaceMarketData[method]);
    }
    const source = fs.readFileSync(path.join(__dirname, '..', 'marketplaceMarketData.js'), 'utf8');
    for (const prohibited of ['marketPriceEngine', 'lootBoxMarketEngine', 'telegramGiftPricing', "require('./database')", 'rocketGiftCatalog', 'lootBoxGiftCatalog']) {
        assert.ok(!source.includes(prohibited), 'no financial or seed dependency: ' + prohibited);
    }
    assert.deepEqual(Object.keys(createMarketplaceMarketData()).sort(), ['enrichCatalog', 'getMetadataSnapshot', 'getSnapshot']);
});

test('positive, negative and flat comparisons use the actual same-algorithm prior floor', async () => {
    const gifts = [gift('Up Gift', 120, { regular_id: '11' }), gift('Down Gift', 75, { regular_id: '12' }), gift('Flat Gift', 8, { regular_id: '13' })];
    const past = [gift('Up Gift', 100, { regular_id: '11' }), gift('Down Gift', 100, { regular_id: '12' }), gift('Flat Gift', 8, { regular_id: '13' })];
    const net = network(dataset(gifts), dataset(past, UPDATED - DAY - 16 * 60 * 1000));
    const service = createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => NOW });
    const snapshot = await withHistory(service);
    assert.equal(snapshot.status, 'fresh'); // Genuine published source is 40+ minutes old, not stale.
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.currentUpdatedAt, '2026-11-12T10:52:34.000Z');
    assert.equal(snapshot.previousUpdatedAt, new Date(UPDATED - DAY - 16 * 60 * 1000).toISOString());
    assert.deepEqual(snapshot.entries.map(e => e.marketChange24hPct), [20, -25, 0]);
    assert.deepEqual(snapshot.floors, { upgift: 120, downgift: 75, flatgift: 8 });
    assert.equal(snapshot.source, SOURCE);
    const lookup = new URL(net.calls[1].url);
    assert.equal(lookup.searchParams.get('until'), new Date(UPDATED - DAY).toISOString());
    assert.equal(lookup.searchParams.get('path'), 'Gifts_Details.json');
    assert.equal(lookup.searchParams.get('per_page'), '1');
});

test('documented floor wins; fallback is minimum of only positive finite known providers', async () => {
    const current = dataset([
        gift('Documented', 10, { portal_price_ton: 2, getgems_price_ton: 3, tgmrkt_price_ton: 4 }),
        gift('Providers', null, { portal_price_ton: '8.25', getgems_price_ton: 7.5, tgmrkt_price_ton: -4, unknown_price_ton: 0.01 }),
        gift('Unpriced', 0, { portal_price_ton: 0, getgems_price_ton: -1, tgmrkt_price_ton: 'Infinity', price: 99, value: 999 }),
        gift('Invalid Number', true, { portal_price_ton: false, getgems_price_ton: [], tgmrkt_price_ton: 'NaN' })
    ]);
    const past = dataset([
        gift('Documented', 5, { portal_price_ton: 1 }),
        gift('Providers', -1, { portal_price_ton: 10, getgems_price_ton: '5', tgmrkt_price_ton: 6 }),
        gift('Unpriced', 1), gift('Invalid Number', 1)
    ], UPDATED - DAY);
    const net = network(current, past);
    const snapshot = await withHistory(createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => NOW }));
    assert.equal(snapshot.entries[0].marketFloorTon, 10);
    assert.equal(snapshot.entries[0].marketFloorSource, 'floor_price_ton');
    assert.equal(snapshot.entries[0].marketChange24hPct, 100);
    assert.equal(snapshot.entries[1].marketFloorTon, 7.5);
    assert.equal(snapshot.entries[1].marketFloorSource, 'provider-minimum');
    assert.equal(snapshot.entries[1].marketChange24hPct, 50);
    assert.deepEqual(snapshot.entries[1].marketProviders, { portal: 8.25, getgems: 7.5 });
    for (const entry of snapshot.entries.slice(2)) {
        assert.equal(entry.marketFloorTon, null);
        assert.equal(entry.marketChange24hPct, null);
        assert.equal(entry.marketPriceStatus, 'unavailable');
        assert.deepEqual(entry.marketProviders, {});
    }
});

test('latest requests share in-flight work and five-minute TTL; history independently throttles thirty minutes', async () => {
    let clock = NOW;
    const latest = deferred(), historical = deferred();
    let latestCalls = 0;
    const net = network(() => { latestCalls++; return latestCalls === 1 ? latest.promise : dataset([gift('Test Gift', 5)]); }, () => historical.promise);
    const service = createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => clock });
    const requests = Array.from({ length: 16 }, () => service.getSnapshot());
    await turns();
    assert.equal(latestCalls, 1);
    latest.resolve(dataset([gift('Test Gift', 5)]));
    const responses = await Promise.all(requests);
    assert.equal(responses[0].historyStatus, 'pending');
    assert.equal(responses[0].entries[0].marketChange24hPct, null);
    assert.equal(responses[0].previousUpdatedAt, null);
    await turns();
    assert.equal(net.calls.length, 3);
    clock += 5 * 60 * 1000 - 1;
    await service.getSnapshot();
    assert.equal(latestCalls, 1);
    clock++;
    await service.getSnapshot();
    assert.equal(latestCalls, 2);
    assert.equal(net.calls.filter(c => c.url.includes('api.github.com')).length, 1);
    historical.resolve(dataset([gift('Test Gift', 4)], UPDATED - DAY));
    await turns();
    assert.equal((await service.getSnapshot()).entries[0].marketChange24hPct, 25);
    clock = NOW + 30 * 60 * 1000;
    await service.getSnapshot(); await turns();
    assert.equal(net.calls.filter(c => c.url.includes('api.github.com')).length, 2);
});

test('latest errors preserve last good prices and real source time, marked stale with sixty-second backoff', async () => {
    let clock = NOW, fail = false, calls = 0;
    const net = network(() => {
        calls++;
        if (fail) throw new Error('PRIVATE_SESSION');
        return dataset([gift('Test Gift', 9)]);
    }, dataset([gift('Test Gift', 8)], UPDATED - DAY));
    const service = createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => clock });
    await withHistory(service);
    fail = true; clock += 5 * 60 * 1000;
    const stale = await service.getSnapshot();
    assert.equal(stale.status, 'stale'); assert.equal(stale.stale, true);
    assert.equal(stale.entries[0].marketFloorTon, 9);
    assert.equal(stale.entries[0].marketPriceStatus, 'stale');
    assert.equal(stale.currentUpdatedAt, new Date(UPDATED).toISOString());
    assert.ok(!JSON.stringify(stale).includes('PRIVATE_SESSION'));
    await service.getSnapshot(); assert.equal(calls, 2);
    clock += 60 * 1000 - 1; await service.getSnapshot(); assert.equal(calls, 2);
    clock++; await service.getSnapshot(); assert.equal(calls, 3);
    fail = false; clock += 60 * 1000;
    assert.equal((await service.getSnapshot()).status, 'fresh');
});

test('missing source is unavailable, never seed/zero/listing fallback, and failure is negative cached', async () => {
    let calls = 0;
    const service = createMarketplaceMarketData({ fetchJson: async () => { calls++; throw new Error('offline'); }, now: () => NOW });
    const input = [{ name: 'Plush Pepe', minPriceTon: 999, count: 8, volumeTon: 12, marketFloorTon: 777, marketChange24hPct: 44 }];
    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.status, 'unavailable'); assert.equal(snapshot.currentUpdatedAt, null);
    assert.deepEqual(snapshot.entries, []); assert.deepEqual(snapshot.floors, {});
    const enriched = await service.enrichCatalog(input);
    assert.equal(enriched[0].marketFloorTon, null); assert.equal(enriched[0].marketChange24hPct, null);
    assert.equal(enriched[0].marketPriceStatus, 'unavailable');
    assert.equal(enriched[0].minPriceTon, 999); assert.equal(enriched[0].count, 8); assert.equal(enriched[0].volumeTon, 12);
    assert.equal(input[0].marketFloorTon, 777); assert.equal(calls, 1);
});

test('source age over two hours is stale; invalid or far-future timestamps never become fetched-time updates', async () => {
    const staleNet = network(dataset([gift('Old Gift', 7)], NOW - 2 * 60 * 60 * 1000 - 1000), null, { commitError: true });
    const stale = await createMarketplaceMarketData({ fetchJson: staleNet.fetchJson, now: () => NOW }).getSnapshot();
    assert.equal(stale.status, 'stale'); assert.equal(stale.entries[0].marketFloorTon, 7);
    assert.equal(stale.currentUpdatedAt, new Date(NOW - 2 * 60 * 60 * 1000 - 1000).toISOString());
    await turns();
    for (const invalid of [undefined, null, false, '', 'not-a-timestamp', 0, -1, Infinity, NOW, (NOW + 5 * 60 * 1000 + 1000) / 1000]) {
        const service = createMarketplaceMarketData({ fetchJson: async () => ({ last_updated: invalid, upgraded: [gift('Test Gift', 99)] }), now: () => NOW });
        const snapshot = await service.getSnapshot();
        assert.equal(snapshot.status, 'unavailable', 'reject timestamp ' + invalid);
        assert.equal(snapshot.currentUpdatedAt, null); assert.deepEqual(snapshot.entries, []);
    }
    const accepted = createMarketplaceMarketData({ fetchJson: async url => {
        if (url === LATEST) return dataset([gift('Test Gift', 7)], NOW + 5 * 60 * 1000);
        return [];
    }, now: () => NOW });
    assert.equal((await accepted.getSnapshot()).status, 'fresh');
    await turns();
});

test('regressed or malformed refresh retains the last good snapshot as stale', async () => {
    let clock = NOW, response = dataset([gift('Test Gift', 7)]);
    const service = createMarketplaceMarketData({ fetchJson: async url => url === LATEST ? response : [], now: () => clock });
    await service.getSnapshot(); await turns();
    for (const invalid of [dataset([gift('Test Gift', 1)], UPDATED - 1000), { last_updated: UPDATED / 1000, upgraded: [] },
        dataset([gift('Duplicate', 3, { regular_id: '10' }), gift('Other Name', 4, { regular_id: '10' })])]) {
        response = invalid; clock += 5 * 60 * 1000;
        const result = await service.getSnapshot();
        assert.equal(result.status, 'stale'); assert.equal(result.entries[0].marketFloorTon, 7);
        assert.equal(result.currentUpdatedAt, new Date(UPDATED).toISOString());
    }
});

test('history outside the two-hour pre-cutoff window, after cutoff, absent or unpriced is null', async () => {
    for (const timestamp of [UPDATED - DAY - 2 * 60 * 60 * 1000 - 1000, UPDATED - DAY + 1000]) {
        const net = network(dataset([gift('Test Gift', 10)]), dataset([gift('Test Gift', 5)], timestamp));
        const snapshot = await withHistory(createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => NOW }));
        assert.equal(snapshot.entries[0].marketChange24hPct, null); assert.equal(snapshot.previousUpdatedAt, null);
        assert.equal(snapshot.status, 'fresh');
    }
    for (const previous of [dataset([gift('Other Gift', 5)], UPDATED - DAY), dataset([gift('Test Gift', 0)], UPDATED - DAY)]) {
        const net = network(dataset([gift('Test Gift', 10)]), previous);
        const snapshot = await withHistory(createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => NOW }));
        assert.equal(snapshot.entries[0].marketChange24hPct, null);
    }
    const boundary = network(dataset([gift('Test Gift', 10)]), dataset([gift('Test Gift', 5)], UPDATED - DAY - 2 * 60 * 60 * 1000));
    assert.equal((await withHistory(createMarketplaceMarketData({ fetchJson: boundary.fetchJson, now: () => NOW }))).entries[0].marketChange24hPct, 100);
});

test('malicious historical commit metadata cannot choose a URL; failed history is thirty-minute throttled', async () => {
    for (const commit of [[], [{ sha: 'https://private.example/token', commit: { committer: { date: '2026-11-11T10:36:16Z' } } }],
        [{ sha: SHA, commit: { committer: { date: new Date(UPDATED).toISOString() } } }]]) {
        const net = network(dataset([gift('Test Gift', 5)]), null, { commit });
        const service = createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => NOW });
        const snapshot = await withHistory(service);
        assert.equal(snapshot.previousUpdatedAt, null); assert.equal(snapshot.entries[0].marketChange24hPct, null);
        for (let i = 0; i < 4; i++) await service.getSnapshot();
        assert.equal(net.calls.length, 2);
    }
});

test('historical gift identity remains exact across source renames, never guesses similar names or different IDs', async () => {
    const net = network(dataset([gift('Renamed Gift', 10, { regular_id: '100' }), gift('Same Name', 9, { regular_id: '200' })]),
        dataset([gift('Old Title', 5, { regular_id: '100' }), gift('Same Name', 3, { regular_id: '201' })], UPDATED - DAY));
    const snapshot = await withHistory(createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => NOW }));
    assert.equal(snapshot.entries[0].marketChange24hPct, 100);
    assert.equal(snapshot.entries[1].marketChange24hPct, null);
});

test('official public gift IDs bind exact renames before name fallback without leaking official metadata', async () => {
    const net = network(dataset([
        gift('Intelligence Cup', 999, { regular_id: '6046499901846586791' }),
        gift('Algorithm Cup', 1140, { regular_id: '6050827940390765935' }),
        gift('Diamond Ring', 36, { regular_id: '5868503709637411929' }),
        gift('Signet Ring', 35, { regular_id: '5936085638515261992' })
    ]), null, { commitError: true });
    const service = createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => NOW });
    const input = [{ key: 'algorithmcup', name: 'Algorithm Cup', baseName: 'Algorithm Cup', minPriceTon: 5, count: 3, volumeTon: 8 },
        { key: 'diamondring', name: 'Diamond Ring' }, { key: 'signetring', name: 'Signet Ring' }, { name: 'Intelligent Cup' }];
    const officialCatalog = [{ title: 'Algorithm Cup', giftId: '6046499901846586791', token: 'PRIVATE_TOKEN', userId: 'PRIVATE_USER' }];
    const result = await service.enrichCatalog(input, { officialCatalog });
    assert.equal(result[0].marketFloorTon, 999); assert.equal(result[0].name, 'Algorithm Cup');
    assert.equal(result[0].minPriceTon, 5); assert.equal(result[0].count, 3); assert.equal(result[0].volumeTon, 8);
    assert.equal(result[1].marketFloorTon, 36); assert.equal(result[2].marketFloorTon, 35);
    assert.equal(result[3].marketFloorTon, null); // No fuzzy Intelligence/Intelligent match.
    assert.equal(input[0].marketFloorTon, undefined);
    for (const privateValue of ['6046499901846586791', 'PRIVATE_TOKEN', 'PRIVATE_USER', 'regular_id', 'giftId']) {
        assert.ok(!JSON.stringify(result).includes(privateValue));
    }
    const unknown = await service.enrichCatalog(input, { officialCatalog: [{ title: 'Algorithm Cup', giftId: '999' }] });
    assert.equal(unknown[0].marketFloorTon, null);
    const ambiguous = await service.enrichCatalog(input, { officialCatalog: [...officialCatalog, { title: 'Algorithm Cup', giftId: '6050827940390765935' }] });
    assert.equal(ambiguous[0].marketFloorTon, null);
    await turns();
});

test('safe catalog covers all 124 source entries independently of local catalog, strips extra fields and unsafe paths', async () => {
    const gifts = Array.from({ length: 124 }, (_, i) => gift('External Gift ' + i, i + 1, {
        regular_id: String(100 + i), token: 'PRIVATE_TOKEN', user: { id: 'PRIVATE_USER' }, session: 'PRIVATE_SESSION',
        rawTelegram: { auth: 'PRIVATE_AUTH' }, custom_emoji_id: 'PRIVATE_EMOJI', marketProviders: { rogue: 1 }
    }));
    gifts[0].models = 'https://private.example/token';
    gifts[1].models = 'models/../../private/prices.json';
    gifts[2].models = 'models/artisan_brick/prices.json';
    const net = network(dataset(gifts), null, { commitError: true });
    const service = createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => NOW });
    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.entries.length, 124); assert.equal(Object.keys(snapshot.floors).length, 124);
    assert.equal(snapshot.entries[0].modelsPath, null); assert.equal(snapshot.entries[1].modelsPath, null);
    assert.equal(snapshot.entries[2].modelsPath, 'models/artisan_brick/prices.json');
    assert.equal(snapshot.entries[2].giftId, '102'); assert.equal(snapshot.entries[2].sourceName, 'External Gift 2');
    assert.equal(snapshot.entries[2].key, 'externalgift2');
    for (const forbidden of ['PRIVATE_', 'rawTelegram', 'session', 'custom_emoji_id', 'user', 'rogue', 'private.example']) {
        assert.ok(!JSON.stringify(snapshot).includes(forbidden), 'strip ' + forbidden);
    }
    assert.equal((await service.getMetadataSnapshot()).length, 124);
    snapshot.entries[2].marketFloorTon = 999;
    snapshot.entries[2].marketProviders.portal = 999;
    snapshot.floors.externalgift2 = 999;
    const again = await service.getSnapshot();
    assert.equal(again.entries[2].marketFloorTon, 3); assert.deepEqual(again.entries[2].marketProviders, {});
    assert.equal(again.floors.externalgift2, 3);
    await turns();
});

test('public IDs reject unsafe numeric precision; canonical punctuation and compact names match exactly', async () => {
    const net = network(dataset([
        gift('Durov’s Cap', 7, { regular_id: '5915521180483191380' }),
        gift('Unsafe ID', 3, { regular_id: 5915521180483191380 }),
        gift('Bad ID', 2, { regular_id: 'PRIVATE_USER' })
    ]), null, { commitError: true });
    const service = createMarketplaceMarketData({ fetchJson: net.fetchJson, now: () => NOW });
    const result = await service.enrichCatalog([{ name: "Durov's Cap" }, { name: 'DurovsCap' }]);
    assert.deepEqual(result.map(r => r.marketFloorTon), [7, 7]);
    const entries = await service.getMetadataSnapshot();
    assert.equal(entries[1].giftId, null); assert.equal(entries[2].giftId, null);
    await turns();
});

test('cold timeout aborts transport within one request and history never delays caller', async () => {
    let signal;
    const cold = createMarketplaceMarketData({ fetchJson: async (_, options) => { signal = options.signal; return new Promise(() => {}); }, timeoutMs: 15, now: () => NOW });
    const started = Date.now();
    const unavailable = await cold.getSnapshot();
    assert.equal(unavailable.status, 'unavailable'); assert.equal(signal.aborted, true);
    assert.ok(Date.now() - started < 500);
    const net = network(dataset([gift('Test Gift', 3)]), () => new Promise(() => {}));
    const history = createMarketplaceMarketData({ fetchJson: net.fetchJson, timeoutMs: 15, now: () => NOW });
    const fresh = await history.getSnapshot();
    assert.equal(fresh.status, 'fresh'); assert.equal(fresh.previousUpdatedAt, null);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal((await history.getSnapshot()).historyStatus, 'unavailable');
});

test('limits bound custom response bytes and catalog entries; constructor refuses safety-limit overrides', async () => {
    const tooLarge = createMarketplaceMarketData({ fetchJson: async () => ({ huge: 'x'.repeat(2048) }), maxResponseBytes: 1024, now: () => NOW });
    assert.equal((await tooLarge.getSnapshot()).status, 'unavailable');
    const tooMany = createMarketplaceMarketData({ fetchJson: async () => dataset([gift('One', 1), gift('Two', 2)]), maxEntries: 1, now: () => NOW });
    assert.equal((await tooMany.getSnapshot()).status, 'unavailable');
    for (const options of [{ timeoutMs: 5001 }, { maxResponseBytes: 2 * 1024 * 1024 + 1 }, { maxEntries: 513 },
        { ttlMs: 0 }, { failureTtlMs: -1 }, { fetchJson: 1 }, { now: 1 }]) {
        assert.throws(() => createMarketplaceMarketData(options), TypeError);
    }
});

test('default HTTPS transport rejects redirects and oversized streamed responses without following URLs', async () => {
    const original = https.get;
    try {
        for (const mode of ['redirect', 'oversize', 'bad-json', 'http-error', 'valid']) {
            const urls = [], response = new EventEmitter();
            response.destroy = () => {};
            https.get = (url, options, callback) => {
                urls.push(url);
                assert.equal(options.headers.Authorization, undefined);
                assert.equal(options.headers.Cookie, undefined);
                assert.ok(options.signal);
                const request = new EventEmitter();
                request.destroy = error => queueMicrotask(() => request.emit('error', error));
                queueMicrotask(() => {
                    response.statusCode = mode === 'redirect' ? 302 : mode === 'http-error' ? 500 : 200;
                    response.headers = mode === 'redirect' ? { location: 'https://private.example/token' } : {};
                    callback(response);
                    if (response.statusCode === 200) {
                        const body = mode === 'oversize' ? 'x'.repeat(4096) : mode === 'bad-json' ? '{oops' : JSON.stringify(dataset([gift('Test Gift', 5)]));
                        response.emit('data', Buffer.from(body));
                        response.emit('end');
                    }
                });
                return request;
            };
            const service = createMarketplaceMarketData({ timeoutMs: 30, maxResponseBytes: 1024, now: () => NOW });
            const snapshot = await service.getSnapshot();
            assert.equal(snapshot.status, mode === 'valid' ? 'fresh' : 'unavailable');
            await turns();
            assert.equal(urls[0], LATEST);
            assert.ok(urls.every(url => ['raw.githubusercontent.com', 'api.github.com'].includes(new URL(url).hostname)));
            assert.equal(urls.length, mode === 'valid' ? 2 : 1);
        }
    } finally { https.get = original; }
});
