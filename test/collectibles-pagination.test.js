'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

require('../test-helpers/no-network');
const serverModule = require('../server');

const { paginateCollectibleGifts } = serverModule;

function uniqueGift(ownedGiftId, number) {
    return {
        type: 'unique',
        owned_gift_id: ownedGiftId,
        number,
        sender_user: { id: 1 },
        gift: { name: `Gift-${number}`, number, base_name: `Gift-${number}` }
    };
}

test('paginateCollectibleGifts fetches every page via next_offset until an empty page', async () => {
    const calls = [];
    const pages = [
        { gifts: Array.from({ length: 100 }, (_, i) => uniqueGift(`g-${i}`, i)), nextOffset: 100 },
        { gifts: Array.from({ length: 50 }, (_, i) => uniqueGift(`g-${100 + i}`, 100 + i)), nextOffset: 150 },
        { gifts: [], nextOffset: null }
    ];
    const resolvePage = async (offset) => {
        calls.push(offset);
        return pages[calls.length - 1];
    };

    const all = await paginateCollectibleGifts(resolvePage, 'conn');

    assert.equal(calls.length, 3, 'should keep fetching until an empty page');
    assert.equal(calls[0], undefined, 'first page is fetched with no offset');
    assert.equal(calls[1], 100, 'second page uses next_offset == 100');
    assert.equal(calls[2], 150, 'third page uses next_offset == 150');
    assert.equal(all.length, 150, 'must accumulate all 150 unique gifts');
    assert.equal(new Set(all.map(g => g.owned_gift_id)).size, 150, 'no duplicate owned_gift_id');
});

test('paginateCollectibleGifts de-duplicates an owned_gift_id redelivered across pages', async () => {
    const pages = [
        { gifts: [uniqueGift('dup-1', 1), uniqueGift('dup-2', 2)], nextOffset: 2 },
        { gifts: [uniqueGift('dup-1', 1), uniqueGift('dup-3', 3)], nextOffset: 3 },
        { gifts: [], nextOffset: null }
    ];
    let call = 0;
    const resolvePage = async () => pages[call++];
    const all = await paginateCollectibleGifts(resolvePage, 'conn');

    assert.equal(all.length, 3, 'redelivered dup-1 must not be double-counted');
    assert.deepEqual(all.map(g => g.owned_gift_id).sort(), ['dup-1', 'dup-2', 'dup-3']);
});

test('paginateCollectibleGifts stops on an offset stall (next_offset stops advancing)', async () => {
    const pages = [
        { gifts: [uniqueGift('a', 1)], nextOffset: 50 },
        { gifts: [uniqueGift('b', 2), uniqueGift('c', 3)], nextOffset: 50 } // لم يتقدّم → يتوقّف
    ];
    let call = 0;
    const resolvePage = async () => { call++; return pages[call - 1]; };
    const all = await paginateCollectibleGifts(resolvePage, 'conn');

    assert.equal(call, 2, 'must not loop forever when the offset stalls');
    assert.equal(all.length, 3);
});

test('paginateCollectibleGifts is bounded by MAX_PAGES even if next_offset never stabilizes (runaway)', async () => {
    let call = 0;
    const resolvePage = async () => {
        call++;
        return { gifts: [uniqueGift(`r-${call}`, call)], nextOffset: `runaway-${call}` };
    };
    const all = await paginateCollectibleGifts(resolvePage, 'conn');

    assert.ok(call <= 100, 'must terminate instead of looping forever');
    assert.equal(all.length, call);
});

test('paginateCollectibleGifts passes the resolved connectionId through to each page call', async () => {
    let receivedConnectionId;
    const resolvePage = async (offset, connectionId) => {
        receivedConnectionId = connectionId;
        return { gifts: [], nextOffset: null };
    };
    await paginateCollectibleGifts(resolvePage, 'connection-from-env');
    assert.equal(receivedConnectionId, 'connection-from-env');
});
