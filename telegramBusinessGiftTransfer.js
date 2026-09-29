const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

let client = null;
let initPromise = null;

function env(name) {
    return String(process.env[name] || '').trim();
}

async function ensureBusinessGiftClient() {
    if (client) return client;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const apiId = Number(env('BUSINESS_API_ID'));
        const apiHash = env('BUSINESS_API_HASH');
        const sessionString = env('TELEGRAM_BUSINESS_SESSION_STRING');

        if (!Number.isInteger(apiId) || apiId <= 0) throw new Error('BUSINESS_API_ID is not configured');
        if (!apiHash) throw new Error('BUSINESS_API_HASH is not configured');
        if (!sessionString) throw new Error('TELEGRAM_BUSINESS_SESSION_STRING is not configured');

        const telegramClient = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
            connectionRetries: 5,
            autoReconnect: true,
            maxConcurrentDownloads: 2
        });
        await telegramClient.connect();
        const me = await telegramClient.getMe();
        console.log('🔐 Telegram Business MTProto connected:', JSON.stringify({
            authorized: !!me,
            userId: me?.id || null
        }));
        client = telegramClient;
        return client;
    })();

    try { return await initPromise; } finally { initPromise = null; }
}

function numberValue(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
}

function savedGiftBaseId(savedGift) {
    const id = savedGift?.gift?.giftId ?? savedGift?.gift?.gift_id ?? savedGift?.gift?.id;
    if (id == null) return null;
    return String(id);
}

function savedGiftName(savedGift) {
    return String(savedGift?.gift?.name || savedGift?.gift?.title || '').trim();
}

function savedGiftUniqueId(savedGift) {
    const name = savedGiftName(savedGift);
    const number = numberValue(savedGift?.gift?.num ?? savedGift?.gift?.number);
    if (!name || number == null) return null;
    return `${name}-${number}`;
}

function savedGiftMsgId(savedGift) {
    return numberValue(savedGift?.msgId ?? savedGift?.msg_id);
}

function savedGiftTransferStars(savedGift) {
    return numberValue(savedGift?.transferStars ?? savedGift?.transfer_stars);
}

function savedGiftCanTransferAt(savedGift) {
    return numberValue(savedGift?.canTransferAt ?? savedGift?.can_transfer_at);
}

async function listBusinessCollectibles() {
    const telegramClient = await ensureBusinessGiftClient();
    const results = [];
    let offset = '';
    const seen = new Set();

    for (let page = 0; page < 200; page++) {
        const result = await telegramClient.api.payments.getSavedStarGifts({
            peer: 'me',
            excludeHosted: true,
            offset,
            limit: 100
        });
        const gifts = Array.isArray(result?.gifts) ? result.gifts : [];
        for (const gift of gifts) results.push(gift);

        const next = String(result?.nextOffset ?? result?.next_offset ?? '');
        if (!next || next === offset || seen.has(next)) break;
        seen.add(next);
        offset = next;
    }
    return results;
}

async function findBusinessGiftForType({ telegramGiftId, giftName }) {
    const wantedId = telegramGiftId == null ? null : String(telegramGiftId);
    const wantedName = String(giftName || '').trim().toLowerCase();
    const gifts = await listBusinessCollectibles();

    const candidates = gifts.filter(item => {
        const gift = item?.gift;
        const unique = savedGiftUniqueId(item);
        const transferStars = savedGiftTransferStars(item);
        const canTransferAt = savedGiftCanTransferAt(item);
        const now = Math.floor(Date.now() / 1000);

        if (!unique || !savedGiftMsgId(item)) return false;
        if (item?.gift?.className && !String(item.gift.className).toLowerCase().includes('unique')) {
            return false;
        }
        if (canTransferAt && canTransferAt > now) return false;
        if (item?.canTransfer === false || item?.can_transfer === false) return false;
        if (wantedId && savedGiftBaseId(item) === wantedId) return true;
        return !!wantedName && savedGiftName(item).toLowerCase() === wantedName;
    });

    if (!candidates.length) return null;

    // The game chooses only the gift type. Telegram's actual model/backdrop/number
    // is selected here from Account 2's currently owned transferable collectibles.
    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index];
}

function giftMetadata(savedGift) {
    const gift = savedGift?.gift || {};
    const attributes = Array.isArray(gift.attributes) ? gift.attributes : [];
    const model = attributes.find(a => String(a?.className || a?.constructor?.className || '').toLowerCase().includes('model'));
    const backdrop = attributes.find(a => String(a?.className || a?.constructor?.className || '').toLowerCase().includes('backdrop'));
    const pattern = attributes.find(a => String(a?.className || a?.constructor?.className || '').toLowerCase().includes('pattern'));
    const name = savedGiftName(savedGift);
    const number = numberValue(gift.num ?? gift.number);
    return {
        baseName: name,
        uniqueName: name,
        collectibleNumber: number,
        ownedGiftId: savedGiftUniqueId(savedGift),
        model: model ? { name: model.name || null, rarity: model.rarity || null } : null,
        backdrop: backdrop ? { name: backdrop.name || null, backdropId: model?.backdropId || backdrop.backdropId || backdrop.backdrop_id || null, rarity: backdrop.rarity || null } : null,
        symbol: pattern ? { name: pattern.name || null, rarity: pattern.rarity || null } : null,
        transferStarCount: savedGiftTransferStars(savedGift),
        canBeTransferred: true
    };
}

async function findBusinessGiftByUniqueId(uniqueCollectibleId) {
    const wanted = String(uniqueCollectibleId || '');
    if (!wanted) return null;
    const gifts = await listBusinessCollectibles();
    return gifts.find(item => savedGiftUniqueId(item) === wanted) || null;
}

async function transferSelectedGiftToUser({ savedGift, telegramUserId }) {
    const telegramClient = await ensureBusinessGiftClient();
    const msgId = savedGiftMsgId(savedGift);
    if (!Number.isSafeInteger(msgId) || msgId <= 0) throw new Error('Telegram did not return a valid saved gift message id');

    const recipientPeer = await telegramClient.getInputEntity(Number(telegramUserId));
    const stargift = new Api.InputSavedStarGiftUser({ msgId });
    const invoice = new Api.InputInvoiceStarGiftTransfer({ stargift, toId: recipientPeer });
    const transferStars = savedGiftTransferStars(savedGift);

    if (transferStars && transferStars > 0) {
        const paymentForm = await telegramClient.api.payments.getPaymentForm({ invoice });
        const formId = numberValue(paymentForm?.formId ?? paymentForm?.form_id);
        if (!Number.isSafeInteger(formId) || formId <= 0) throw new Error('Telegram did not return a valid Stars payment form');
        await telegramClient.api.payments.sendStarsForm({ formId, invoice });
    } else {
        await telegramClient.api.payments.transferStarGift({
            stargift,
            toId: recipientPeer
        });
    }

    return {
        uniqueCollectibleId: savedGiftUniqueId(savedGift),
        telegramGiftInstanceId: String(msgId),
        collectibleNumber: numberValue(savedGift?.gift?.num ?? savedGift?.gift?.number),
        msgId,
        transferStars: transferStars || 0,
        verifiedMetadata: JSON.stringify(giftMetadata(savedGift))
    };
}

module.exports = {
    ensureBusinessGiftClient,
    listBusinessCollectibles,
    findBusinessGiftForType,
    transferSelectedGiftToUser
};
