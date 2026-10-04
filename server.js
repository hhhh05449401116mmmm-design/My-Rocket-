// =========================================================
// server.js - السيرفر الرئيسي المتكامل
// متوافق مع database.js ومع الـ Frontend القادم
// =========================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const path = require('path');

// Collectible-only renderer. Lazy loading keeps renderer failures isolated from the game loop.
let sharpRenderer = undefined;
function getSharpRenderer() {
    if (sharpRenderer !== undefined) return sharpRenderer;
    try { sharpRenderer = require('sharp'); }
    catch (error) { sharpRenderer = null; console.error('Collectible renderer unavailable:', error.message); }
    return sharpRenderer;
}

const { TonClient, WalletContractV5R1, internal, Address, Cell, contractAddress, loadStateInit, toNano } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { URL } = require('url');
require('dotenv').config();
const {
    DEFAULT_CLIENT_SEED,
    createFairRound,
    shouldAutoCashout,
    MAX_CRASH_MULTIPLIER
} = require('./crashFair');
const { getCollectibleMarketValue, getCollectibleVariantMarketValue, refreshMarketPrices, ensureCache: ensureGiftMarketCache } = require('./marketPriceEngine');
const {
    getModelMarketPrice,
    getGeneralMarketPrice,
    getBackdropMarketPrice,
    refreshMarketCache: refresh100TonMarketCache,
    getCacheStatus: get100TonMarketCacheStatus
} = require('./lootBoxMarketEngine');

async function get100TonBackdropPriceSafe(item) {
    try {
        return await getBackdropMarketPrice(item);
    } catch (error) {
        console.warn('100 TON backdrop pricing unavailable:', error.message);
        return null;
    }
}

async function get100TonGeneralMarketPriceSafe(item) {
    try {
        return await getGeneralMarketPrice(item);
    } catch (error) {
        console.warn('100 TON general pricing unavailable:', error.message);
        return null;
    }
}

function get100TonCatalogSlug(item) {
    // Only use an explicitly verified Telegram collectible slug.
    // Image paths such as gift-art/plushpepe are collection asset slugs,
    // not valid unique Star Gift slugs for payments.getUniqueStarGift.
    return item?.slug ? String(item.slug) : null;
}

async function get100TonTelegramMarketPriceSafe(item) {
    try {
        let giftId = item?.telegramGiftId || null;
        let slug = get100TonCatalogSlug(item);

        if (!giftId) {
            const baseName = item?.baseName || item?.name;
            const gift = baseName
                ? await get('SELECT telegram_gift_id, slug FROM gifts WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1', [baseName])
                : null;
            giftId = giftId || gift?.telegram_gift_id || null;
            slug = slug || gift?.slug || null;
        }

        if (!giftId && !slug) return null;

        return await getLiveTelegramCollectiblePrice({
            slug,
            giftId,
            backdropName: item?.backdrop || null
        });
    } catch (error) {
        console.warn('100 TON Telegram market fallback unavailable:', error.message);
        return null;
    }
}
// =========================================================
// Isolated 100 TON loot-box catalog.
// This path is intentionally independent from the Crash/round engine.
// =========================================================
const LOOT_BOX_100_CATALOG = [
    { name: 'Plush Pepe', image: 'https://tg.me/api/media/gift-art/plushpepe/thumb.webp' },
    { name: "Durov's Cap", backdrop: 'Black', image: 'https://tg.me/api/media/gift-art/durovscap/thumb.webp', baseName: "Durov's Cap" },
    { name: 'Heart Locket', image: 'https://tg.me/api/media/gift-art/heartlocket/thumb.webp' },
    { name: 'Rare Bird', telegramGiftId: '5999116401002939514', slug: 'rarebird', image: 'https://tg.me/api/media/gift-art/rarebird/thumb.webp', baseName: 'Rare Bird' },
    { name: 'Precious Peach', backdrop: 'Black', image: 'https://tg.me/api/media/gift-art/preciouspeach/thumb.webp', baseName: 'Precious Peach' },
    { name: 'Scared Cat', image: 'https://tg.me/api/media/gift-art/scaredcat/thumb.webp' },
    { name: 'Nail Bracelet', backdrop: 'Black', image: 'https://tg.me/api/media/gift-art/nailbracelet/thumb.webp', baseName: 'Nail Bracelet' },
    { name: 'Heroic Helmet', image: 'https://tg.me/api/media/gift-art/mightyarm/thumb.webp' },
    { name: 'Swiss Watch', backdrop: 'Black', image: 'https://tg.me/api/media/gift-art/swisswatch/thumb.webp', baseName: 'Swiss Watch' },
    { name: 'Westside Sign', telegramGiftId: '6014697240977737490', slug: 'westsidesign', image: 'https://tg.me/api/media/gift-art/westsidesign/thumb.webp', baseName: 'Westside Sign' },
    { name: 'Loot Bag', image: 'https://tg.me/api/media/gift-art/lootbag/thumb.webp' },
    { name: 'Bonded Ring', backdrop: 'Black', image: 'https://tg.me/api/media/gift-art/bondedring/thumb.webp', baseName: 'Bonded Ring' },
    { name: 'Astral Shard', telegramGiftId: '5933629604416717361', slug: 'astralshard', image: 'https://tg.me/api/media/gift-art/astralshard/thumb.webp', baseName: 'Astral Shard' },
    { name: 'Artisan Brick', backdrop: 'Black', image: 'https://tg.me/api/media/gift-art/artisanbrick/thumb.webp', baseName: 'Artisan Brick' },
    { name: 'Durov\'s Cap', image: 'https://tg.me/api/media/gift-art/durovscap/thumb.webp' },
    { name: 'Low Rider', backdrop: 'Black', image: 'https://tg.me/api/media/gift-art/lowrider/thumb.webp', baseName: 'Low Rider' },
    { name: 'Diamond Ring', backdrop: 'Black', image: 'https://tg.me/api/media/gift-art/diamondring/thumb.webp', baseName: 'Diamond Ring' },
    { name: 'Toy Bear', backdrop: 'Black', image: 'https://tg.me/api/media/gift-art/toybear/thumb.webp', baseName: 'Toy Bear' },
    { name: 'Plush Pepe', backdrop: 'Onyx Black', image: 'https://tg.me/api/media/gift-art/plushpepe/thumb.webp', baseName: 'Plush Pepe' },
    { name: 'Scared Cat', backdrop: 'Black', image: 'https://tg.me/api/media/gift-art/scaredcat/thumb.webp', baseName: 'Scared Cat' },
    { name: 'Scared Cat', backdrop: 'Onyx Black', image: 'https://tg.me/api/media/gift-art/scaredcat/thumb.webp', baseName: 'Scared Cat' },
    { name: 'Toy Bear', image: 'https://tg.me/api/media/gift-art/toybear/thumb.webp' }
];
const LOOT_BOX_100_PRICE = 100;
    
// Live Telegram collectible pricing.
// Normal collectibles use the current Telegram resale floor for the base gift type.
// Black/Onyx Black backdrops use the exact live resale price when listed; otherwise
// the current floor filtered to that backdrop. This only changes valuation data.
const LIVE_COLLECTIBLE_PRICE_TTL_MS = 60 * 1000;
const liveCollectiblePriceCache = new Map();

function isBlackBackdropName(name) {
    const normalized = String(name || '').trim().toLowerCase().replace(/[-_]+/g, ' ');
    return normalized === 'black' || normalized === 'onyx black';
}

function findTonAmount(amounts) {
    for (const amount of (Array.isArray(amounts) ? amounts : [])) {
        const className = String(amount?.className || amount?.constructor?.className || amount?.constructor?.name || amount?._ || '').toLowerCase();
        if (className.includes('starstonamount')) {
            const nanograms = Number(amount?.amount);
            if (Number.isFinite(nanograms) && nanograms > 0) return nanograms / 1e9;
        }
    }
    return null;
}

function findBackdropAttributeId(uniqueGift) {
    for (const attribute of (Array.isArray(uniqueGift?.attributes) ? uniqueGift.attributes : [])) {
        const className = String(attribute?.className || attribute?.constructor?.className || attribute?.constructor?.name || attribute?._ || '').toLowerCase();
        if (className.includes('backdrop')) {
            const id = Number(attribute?.backdropId ?? attribute?.backdrop_id);
            if (Number.isInteger(id) && id > 0) return id;
        }
    }
    return null;
}

async function getLiveTelegramCollectiblePrice({ slug, giftId, backdropName }) {
    const key = [String(slug || ''), String(giftId || ''), String(backdropName || '')].join('|');
    const cached = liveCollectiblePriceCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const client = await ensureTelegramMtprotoClient();
    let uniqueGift = null;
    try {
        if (slug) {
            const result = await client.api.payments.getUniqueStarGift({ slug: String(slug) });
            uniqueGift = result?.gift || result || null;
        }
    } catch (error) {
        console.warn('Live collectible lookup failed:', error.message);
    }

    const specialBackdrop = isBlackBackdropName(backdropName);
    let value = null;
    let source = null;

    if (specialBackdrop && uniqueGift) {
        const listedPrice = findTonAmount(uniqueGift.resellAmount || uniqueGift.resell_amount);
        if (listedPrice != null) {
            value = listedPrice;
            source = 'telegram-live-resale';
        }
    }

    if (value == null && giftId) {
        let attributes = null;
        if (specialBackdrop && uniqueGift) {
            const backdropId = findBackdropAttributeId(uniqueGift);
            if (backdropId) attributes = [{ className: 'StarGiftAttributeIdBackdrop', backdropId }];
        }
        try {
            const result = await client.api.payments.getResaleStarGifts({
                giftId: BigInt(String(giftId)),
                sortByPrice: true,
                starsOnly: false,
                ...(attributes ? { attributes } : {}),
                offset: '',
                limit: 100
            });
            const resaleGifts = Array.isArray(result?.gifts) ? result.gifts : [];
            const tonPrices = resaleGifts
                .map(gift => findTonAmount(gift?.resellAmount || gift?.resell_amount))
                .filter(price => Number.isFinite(price) && price > 0);
            const floor = tonPrices.length ? Math.min(...tonPrices) : null;
            if (floor != null) {
                value = floor;
                source = attributes ? 'telegram-live-backdrop-floor' : 'telegram-live-floor';
            }
        } catch (error) {
            console.warn('Live Telegram resale floor lookup failed:', error.message);
        }
    }

    if (value == null || !Number.isFinite(value) || value <= 0) return null;
    const result = { value: Number(value.toFixed(9)), currency: 'TON', source, fetchedAt: Date.now() };
    liveCollectiblePriceCache.set(key, { value: result, expiresAt: Date.now() + LIVE_COLLECTIBLE_PRICE_TTL_MS });
    return result;
}

async function refreshVerifiedCollectibleMarketValue(identity, userGiftId = null) {
    const telegramGiftModel = identity?.telegramGiftModel || {};
    let metadata = {};
    try {
        metadata = identity?.verifiedMetadata
            ? (typeof identity.verifiedMetadata === 'string' ? JSON.parse(identity.verifiedMetadata) : identity.verifiedMetadata)
            : {};
    } catch {}
    const live = await getLiveTelegramCollectiblePrice({
        slug: telegramGiftModel.slug || identity?.uniqueCollectibleId,
        giftId: telegramGiftModel.telegramGiftId || metadata?.telegramGiftId || metadata?.baseName || null,
        backdropName: metadata?.backdrop?.name || identity?.backdropName || null
    });
    if (!live) return null;

    const liveMetadata = {
        ...metadata,
        marketValue: live.value,
        marketValueCurrency: live.currency,
        marketValueSource: live.source,
        marketValueUpdatedAt: new Date(live.fetchedAt).toISOString()
    };
    if (identity?.uniqueCollectibleId) {
        await updateUserCollectibleMarketValue(identity.uniqueCollectibleId, live.value, JSON.stringify(liveMetadata));
    } else if (userGiftId) {
        await run('UPDATE user_gifts SET market_value = ?, verified_metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ownership_verified = 1',
            [live.value, JSON.stringify(liveMetadata), userGiftId]);
    }
    return live;
}


// =========================================================
// استيراد قاعدة البيانات
// =========================================================
const {
    db,
    initDatabase,
    seedDatabase,
    query,
    get,
    run,
    transaction,
    findOrCreateUser,
     attachReferralToUser,
     getReferralOverview,
     getUserBalance,
     updateUserBalance,
     getUserTestBalance,
     setTestBalance,
     resetTestBalance,
     getUserTestBalanceRaw,
    getUserGifts,
    getGiftById,
    addGiftToUser,
    addLootBoxGiftToUser,
    sellLootBoxGiftForBalance,
    markGiftAsLootBoxReward,
    isLootBoxGiftLocked,
    updateGiftStatus,
    getUserCollectibles,
    getActiveCollectibleUniqueIds,
    createOrGetImportIntent,
    getLatestImportIntentForUser,
    getPendingIntentByTelegramSenderId,
    isCollectibleAlreadyCredited,
    creditVerifiedCollectible,
    updateCollectibleMarketValue,
    updateUserCollectibleMarketValue,
    savePersistedBusinessConnection,
    getPersistedBusinessConnection,
    hasProcessedWebhookUpdate,
    markWebhookUpdateProcessed,
    getCollectibleByUniqueId,
    sellCollectibleForBalance,
    placeGiftBet,
    placeTonBet,
    cashoutTonBet,
    placeTestBet,
    cashoutTestBet,
    settleTestBetLoss,
    openLootbox,
    createDeposit,
    createWithdrawalRequest,
    markWithdrawalProcessing,
    completeWithdrawal,
    getUserWithdrawals,
    refundFailedWithdrawal,
    saveDepositBoc,
    creditVerifiedDeposit,
    updateDepositStatus,
    updateUserStats,
    getSpenderLeaderboard,
    createNotification,
    getNotifications,
    createRoundRecord,
    getRoundByNumber,
    updateRoundState,
    getActiveBetsForRound,
    getRoundPlayers,
    getQueuedTonBetsForRound,
    queueTonBet,
    cancelQueuedTonBet,
    promoteQueuedTonBets,
    queueGiftBet,
    cancelQueuedGiftBet,
    promoteQueuedGiftBets,
    getQueuedGiftBetsForRound,
    cashoutBet,
    crashRound,
    selectRewardFromInventory,
    getInventoryCollectibles,
    reserveCollectibleForWithdrawal,
    reservePendingGiftForWithdrawal,
    attachPendingGiftCollectible,
    rollbackPendingGiftWithdrawal,
    confirmGiftWithdrawal,
    rollbackGiftWithdrawal,
    getGiftTransactions,
    getPendingPayouts,
    createMinesGame,
    revealMinesTile,
    cashoutMinesGame,
    createPlinkoGame,
    dropPlinkoChip,
    createDiceGame,
    getMiniGame,
    createLotteryGame,
    getPvpActiveRound,
    createPvpRound,
    startPvpCountdown,
    getPvpRoundWithParticipants,
    getLastPvpRoundNumber,
    crashPvpRound,
    joinPvpRound,
    cashoutPvpBet,
    MAX_PVP_PLAYERS
} = require('./database');

const {
    initializeLeaderboard,
    getWeeklyLeaderboard,
    startLeaderboardCycleWorker,
    stopLeaderboardCycleWorker
} = require('./leaderboard');

const {
    ensureBusinessGiftClient,
    findBusinessGiftForType,
    findBusinessGiftByUniqueId,
    transferSelectedGiftToUser
} = require('./telegramBusinessGiftTransfer');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================
// Middleware
// =========================================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Telegram WebView can retain the HTML entry point across deployments. Never cache the
// entry document, otherwise an old frontend can keep calling a retired Railway origin.
app.use((req, res, next) => {
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});
app.use('/vendor/tlottie', express.static(path.join(__dirname, 'node_modules/tlottie/dist'), {
    immutable: true,
    maxAge: '1y'
}));
app.use(express.static('.'));

// =========================================================
// 1. المصادقة والتحقق من Telegram
// =========================================================
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TON_DEPOSIT_RECEIVER = process.env.TON_DEPOSIT_RECEIVER || '';
const TONCENTER_API_URL = process.env.TONCENTER_API_URL || 'https://toncenter.com/api/v2';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';
const TON_TREASURY_MNEMONIC = process.env.TON_TREASURY_MNEMONIC || '';
const TON_WITHDRAWAL_RESERVE = Number(process.env.TON_WITHDRAWAL_RESERVE || '0.05');
// Phase 3B: server-only config for the managed Telegram business account that receives collectibles.
// Never exposed to the frontend. Real verification only runs once this is configured on the Telegram side.
const TELEGRAM_BUSINESS_CONNECTION_ID = process.env.TELEGRAM_BUSINESS_CONNECTION_ID || '';
// Optional but recommended: Telegram's official secret_token mechanism for webhook authenticity.
// Never logged. When unset, the webhook still works but cannot verify the caller is really Telegram.
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || null;

// TEST BALANCE: opt-in fake balance for QA only. Disabled by default.
// When disabled, the test_balance field is never read or written for gameplay.
const ENABLE_TEST_BALANCE = process.env.ENABLE_TEST_BALANCE === 'true';

const TON_CONNECT_PROOF_DOMAIN = process.env.TON_CONNECT_PROOF_DOMAIN || 'my-rocket.vercel.app';
const TON_CONNECT_PROOF_NETWORK = process.env.TON_CONNECT_PROOF_NETWORK || '-239';
const TON_CONNECT_PROOF_MAX_AGE_SEC = 15 * 60;
const pendingTonProofs = new Map();
const verifiedTonWallets = new Map();

function issueTonProofPayload(userId) {
    const payload = crypto.randomBytes(32).toString('hex');
    pendingTonProofs.set(String(userId), { payload, expiresAt: Date.now() + TON_CONNECT_PROOF_MAX_AGE_SEC * 1000 });
    return payload;
}
function consumeTonProofPayload(userId, payload) {
    const entry = pendingTonProofs.get(String(userId));
    if (!entry || entry.expiresAt < Date.now() || entry.payload !== payload) return false;
    pendingTonProofs.delete(String(userId));
    return true;
}
function buildTonProofDigest(address, proof) {
    const domainBytes = Buffer.from(proof.domain.value, 'utf8');
    if (!Number.isInteger(proof.domain.lengthBytes) || proof.domain.lengthBytes !== domainBytes.length) throw new Error('Invalid TON proof domain length');
    const workchain = Buffer.alloc(4); workchain.writeInt32BE(address.workChain, 0);
    const domainLength = Buffer.alloc(4); domainLength.writeUInt32LE(domainBytes.length, 0);
    const timestamp = Buffer.alloc(8); timestamp.writeBigUInt64LE(BigInt(proof.timestamp), 0);
    const message = Buffer.concat([Buffer.from('ton-proof-item-v2/', 'utf8'), workchain, Buffer.from(address.hash), domainLength, domainBytes, timestamp, Buffer.from(String(proof.payload), 'utf8')]);
    const innerHash = crypto.createHash('sha256').update(message).digest();
    return crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect', 'utf8'), innerHash])).digest();
}
function publicKeyFromBigInt(value) {
    const hex = BigInt(value).toString(16).padStart(64, '0');
    if (hex.length > 64) throw new Error('Invalid wallet public key');
    return Buffer.from(hex, 'hex');
}
async function getWalletPublicKeyFromChain(addressString) {
    const endpoint = TONCENTER_API_URL.endsWith('/api/v2') ? TONCENTER_API_URL + '/jsonRPC' : TONCENTER_API_URL + '/api/v2/jsonRPC';
    const client = new TonClient({ endpoint, ...(TONCENTER_API_KEY ? { apiKey: TONCENTER_API_KEY } : {}) });
    const result = await client.runMethod(Address.parse(addressString), 'get_public_key');
    return publicKeyFromBigInt(result.stack.readBigNumber());
}
function verifyEd25519Digest(digest, signature, publicKey) {
    if (!Buffer.isBuffer(signature) || signature.length !== 64 || !Buffer.isBuffer(publicKey) || publicKey.length !== 32) return false;
    const keyObject = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]), format: 'der', type: 'spki' });
    return crypto.verify(null, digest, keyObject, signature);
}
async function verifyTonConnectProof(input) {
    const { address: addressString, network, walletStateInit, proof } = input || {};
    if (!addressString || !walletStateInit || !proof) throw new Error('TON proof is required');
    if (String(network) !== TON_CONNECT_PROOF_NETWORK) throw new Error('Wrong TON network');
    if (proof.domain?.value !== TON_CONNECT_PROOF_DOMAIN) throw new Error('Wrong TON proof domain');
    if (!proof.payload || !consumeTonProofPayload(input.userId, String(proof.payload))) throw new Error('Invalid or expired TON proof payload');
    const timestamp = Number(proof.timestamp);
    if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TON_CONNECT_PROOF_MAX_AGE_SEC) throw new Error('TON proof expired');
    const wantedAddress = Address.parse(addressString);
    const stateInit = loadStateInit(Cell.fromBase64(walletStateInit).beginParse());
    const derivedAddress = contractAddress(wantedAddress.workChain, stateInit);
    if (!derivedAddress.equals(wantedAddress)) throw new Error('Wallet state does not match wallet address');
    const publicKey = await getWalletPublicKeyFromChain(addressString);
    const digest = buildTonProofDigest(wantedAddress, proof);
    const signature = Buffer.from(String(proof.signature || ''), 'base64');
    if (!verifyEd25519Digest(digest, signature, publicKey)) throw new Error('Invalid TON proof signature');
    const rawAddress = wantedAddress.toRawString();
    verifiedTonWallets.set(String(input.userId), { address: rawAddress, expiresAt: Date.now() + TON_CONNECT_PROOF_MAX_AGE_SEC * 1000 });
    return rawAddress;
}
function getVerifiedTonWallet(userId) {
    const entry = verifiedTonWallets.get(String(userId));
    if (!entry || entry.expiresAt < Date.now()) { verifiedTonWallets.delete(String(userId)); return null; }
    return entry.address;
}

// In-memory only (does not survive a restart): populated by /telegram-webhook once a real
// business_connection update arrives. No database migration performed for this yet.
let runtimeBusinessConnection = {
    id: null,
    businessUserId: null,
    canViewGiftsAndStars: false,
    canTransferAndUpgradeGifts: false,
    isEnabled: false,
    updatedAt: null
};

// Webhook sweep protection: prevent overlapping/expansive collectible sweeps.
let collectibleSweepInProgress = false;
let lastCollectibleSweepTime = 0;
const COLLECTIBLE_SWEEP_COOLDOWN_MS = 2 * 60 * 1000; // 2-minute minimum between sweeps

function requestJson(urlString) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
            reject(new Error('TONCENTER_API_URL must use HTTPS in production'));
            return;
        }
        const client = url.protocol === 'http:' ? http : https;
        const request = client.get(url, {
            headers: {
                Accept: 'application/json',
                ...(TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {})
            }
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`TON indexer HTTP ${response.statusCode}`));
                    return;
                }
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.setTimeout(10000, () => request.destroy(new Error('TON indexer timeout')));
        request.on('error', reject);
    });
}

async function findRealTonWithdrawalTransactionHash(withdrawal, treasuryAddress, sentAfterMs) {
    const expectedDestination = canonicalTonAddress(withdrawal.wallet_address);
    const expectedComment = 'rocket-withdrawal:' + withdrawal.id;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const apiUrl = new URL(`${TONCENTER_API_URL.replace(/\/$/, '')}/getTransactions`);
        apiUrl.searchParams.set('address', treasuryAddress);
        apiUrl.searchParams.set('limit', '50');
        const result = await requestJson(apiUrl.toString());
        const transactions = Array.isArray(result.result) ? result.result : [];
        for (const transaction of transactions) {
            const txHash = transaction.transaction_id?.hash;
            const utime = Number(transaction.utime || 0) * 1000;
            if (!txHash || (utime && utime + 10000 < sentAfterMs)) continue;
            for (const message of (transaction.out_msgs || [])) {
                if (canonicalTonAddress(message.destination) !== expectedDestination) continue;
                if (extractComment(message).includes(expectedComment)) return txHash;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('TON withdrawal transaction hash was not found');
}

async function sendRealTonWithdrawal(withdrawal) {
    // Read production secrets at request time so a long-lived Node process cannot
    // retain an empty value from an earlier environment snapshot.
    const treasuryMnemonic = String(process.env.TON_TREASURY_MNEMONIC || '').trim();
    const toncenterApiUrl = String(process.env.TONCENTER_API_URL || TONCENTER_API_URL || 'https://toncenter.com/api/v2').trim();
    const toncenterApiKey = String(process.env.TONCENTER_API_KEY || TONCENTER_API_KEY || '').trim();
    const depositReceiver = String(process.env.TON_DEPOSIT_RECEIVER || TON_DEPOSIT_RECEIVER || '').trim();
    if (!treasuryMnemonic) throw new Error('Real withdrawals are not configured on the server');
    const endpoint = toncenterApiUrl.endsWith('/api/v2') ? toncenterApiUrl + '/jsonRPC' : toncenterApiUrl + '/api/v2/jsonRPC';
    const client = new TonClient({ endpoint, ...(toncenterApiKey ? { apiKey: toncenterApiKey } : {}) });
    const keyPair = await mnemonicToPrivateKey(treasuryMnemonic.split(/\s+/));
    const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey, walletId: { networkGlobalId: -239 } });
    const treasuryAddress = canonicalTonAddress(wallet.address.toString());
    const configuredTreasury = canonicalTonAddress(depositReceiver);
    if (!configuredTreasury || treasuryAddress !== configuredTreasury) throw new Error('Treasury wallet configuration does not match TON_DEPOSIT_RECEIVER');
    const contract = client.open(wallet);
    const balance = await contract.getBalance();
    const amountNano = toNano(String(Number(withdrawal.amount).toFixed(9)));
    const reserveNano = toNano(String(Math.max(0.02, TON_WITHDRAWAL_RESERVE)));
    if (balance < amountNano + reserveNano) throw new Error('Treasury wallet has insufficient TON for this withdrawal');
    const seqno = await contract.getSeqno();
    const sentAfterMs = Date.now();
    await contract.sendTransfer({ seqno, secretKey: keyPair.secretKey, timeout: Math.floor(Date.now() / 1000) + 60, sendMode: 3, messages: [internal({ to: Address.parse(withdrawal.wallet_address), value: amountNano, body: 'rocket-withdrawal:' + withdrawal.id })] });
    const deadline = sentAfterMs + 30000;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if ((await contract.getSeqno()) > seqno) return await findRealTonWithdrawalTransactionHash(withdrawal, wallet.address.toString(), sentAfterMs);
    }
    throw new Error('TON withdrawal was not confirmed by the treasury wallet');
}
function canonicalTonAddress(address) {
    if (typeof address !== 'string') return null;
    const value = address.trim();
    const rawMatch = value.match(/^(-?\d+):([a-fA-F0-9]{64})$/);
    if (rawMatch) return `${Number(rawMatch[1])}:${rawMatch[2].toLowerCase()}`;
    try {
        const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4), 'base64');
        if (bytes.length !== 36) return null;
        return `${bytes.readInt8(1)}:${bytes.subarray(2, 34).toString('hex')}`;
    } catch (error) {
        return null;
    }
}

function extractComment(value) {
    if (!value) return '';
    if (typeof value === 'string') {
        if (value.includes('rocket-deposit:')) return value;
        try {
            const decoded = Buffer.from(value, 'base64').toString('utf8');
            if (decoded.includes('rocket-deposit:')) return decoded;
        } catch (error) {}
        return '';
    }
    if (Array.isArray(value)) return value.map(extractComment).find(Boolean) || '';
    if (typeof value === 'object') {
        for (const key of ['text', 'comment', 'message', 'body', 'msg_data']) {
            const comment = extractComment(value[key]);
            if (comment) return comment;
        }
    }
    return '';
}

async function findVerifiedDepositTransaction(deposit) {
    if (!TON_DEPOSIT_RECEIVER) throw new Error('TON_DEPOSIT_RECEIVER is not configured');
    const expectedRecipient = canonicalTonAddress(TON_DEPOSIT_RECEIVER);
    const expectedSender = canonicalTonAddress(deposit.wallet_address);
    const expectedAmount = BigInt(Math.ceil(Number(deposit.amount) * 1000000000));
    const expectedComment = `rocket-deposit:${deposit.id}`;
    const createdAtSeconds = Math.floor(new Date(deposit.created_at).getTime() / 1000);
    const pageSize = 100;
    const maxPages = 20;
    let toLt = null;
    let toHash = null;

    for (let page = 0; page < maxPages; page++) {
        const apiUrl = new URL(`${TONCENTER_API_URL.replace(/\/$/, '')}/getTransactions`);
        apiUrl.searchParams.set('address', TON_DEPOSIT_RECEIVER);
        apiUrl.searchParams.set('limit', String(pageSize));
        if (toLt && toHash) {
            apiUrl.searchParams.set('lt', toLt);
            apiUrl.searchParams.set('hash', toHash);
        }
        const result = await requestJson(apiUrl.toString());
        const transactions = Array.isArray(result.result) ? result.result : [];
        if (transactions.length === 0) break;

        for (const transaction of transactions) {
            const message = transaction.in_msg || {};
            let value;
            try { value = BigInt(String(message.value || '0')); } catch (error) { continue; }
            const transactionHash = transaction.transaction_id?.hash || transaction.hash;
            const transactionId = transactionHash && transaction.transaction_id?.lt
                ? `${transaction.transaction_id.lt}:${transactionHash}`
                : transactionHash;
            const comment = extractComment(message);
            if (!transactionId || !message.source || !message.destination) continue;
            if (canonicalTonAddress(message.destination) !== expectedRecipient) continue;
            if (canonicalTonAddress(message.source) !== expectedSender) continue;
            if (value < expectedAmount || !comment.includes(expectedComment)) continue;
            return { transactionHash: transactionId };
        }

        const oldest = transactions[transactions.length - 1];
        const oldestUtime = Number(oldest.utime || oldest.now || 0);
        if (createdAtSeconds && oldestUtime && oldestUtime < createdAtSeconds) break;
        const oldestId = oldest.transaction_id || {};
        if (!oldestId.lt || !oldestId.hash || transactions.length < pageSize) break;
        toLt = String(oldestId.lt);
        toHash = String(oldestId.hash);
    }
    return null;
}

function verifyTelegramData(initData) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');

        const dataCheckString = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData')
            .update(BOT_TOKEN)
            .digest();

        const computedHash = crypto.createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        return computedHash === hash;
    } catch (error) {
        console.error('Verification error:', error);
        return false;
    }
}

// =========================================================
// 1.1 Phase 3B: Telegram Business Account collectible verification (server-only)
// Official mechanism: Bot API business-connection gifts (getBusinessAccountGifts),
// requires the business bot to have the "can_view_gifts_and_stars" right.
// Never invents endpoints; never trusts client-provided gift data.
// =========================================================
function callTelegramBotApi(method, payload = {}) {
    return new Promise((resolve, reject) => {
        if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
            reject(new Error('BOT_TOKEN is not configured'));
            return;
        }
        const body = JSON.stringify(payload);
        const request = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, response => {
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { raw += chunk; });
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(raw);
                    if (!parsed.ok) {
                        reject(new Error(`Telegram API error: ${parsed.description || 'unknown error'}`));
                        return;
                    }
                    resolve(parsed.result);
                } catch (error) { reject(error); }
            });
        });
        request.setTimeout(10000, () => request.destroy(new Error('Telegram API timeout')));
        request.on('error', reject);
        request.write(body);
        request.end();
    });
}

// يجلب كل صفحات getBusinessAccountGifts عبر next_offset حتى تنتهي النتائج.
// منعطف محايد وقابل للاختبار بدون شبكة — يمنع التكرار وحلقة لا نهائية.
// يعتمد على next_offset الرسمي من Telegram فقط ولا ينطلق بأي افتراضات.
async function paginateCollectibleGifts(resolvePage, connectionId) {
    const allGifts = [];
    const seen = new Set(); // يمنع duplicate عندما يعيد Telegram صفحة تم قراءتها
    const MAX_PAGES = 100; // حد أمان: 100 صفحة × 100 هدية = 10,000 هدية كحد أعلى
    let offset;
    let page = 0;

    while (page < MAX_PAGES) {
        const { gifts = [], nextOffset } = await resolvePage(offset, connectionId);
        for (const gift of gifts) {
            const key = gift && gift.owned_gift_id ? String(gift.owned_gift_id) : null;
            if (!key) { allGifts.push(gift); continue; }
            if (seen.has(key)) continue;
            seen.add(key);
            allGifts.push(gift);
        }
        page++;
        // توقّف عندما لا يعاد هناك صفحات: لا next_offset، ولم يتقدّم الـ offset،
        // أو صفحة فارغة تمامًا. هذه منعطفات وقف حقيقية ولا تسبب حلقة لا نهائية.
        if (!nextOffset || nextOffset === offset || gifts.length === 0) break;
        offset = nextOffset;
    }
    return allGifts;
}

// يجلب الهدايا المملوكة لحساب اللعبة التجاري على Telegram عبر الـ Business API الرسمي فقط.
async function fetchBusinessAccountGifts() {
    const connectionId = TELEGRAM_BUSINESS_CONNECTION_ID || runtimeBusinessConnection.id;
    if (!connectionId) {
        throw new Error('TELEGRAM_BUSINESS_CONNECTION_ID is not configured');
    }
    return paginateCollectibleGifts(async (offset) => {
        const payload = { business_connection_id: connectionId };
        // Telegram يدعم offset الرسمي للترقيم الصفحي — لا نستخدمه إلا إن وُجد.
        if (offset) payload.offset = offset;
        const result = await callTelegramBotApi('getBusinessAccountGifts', payload);
        const gifts = Array.isArray(result?.gifts) ? result.gifts : [];
        const nextOffset = (result && typeof result.next_offset !== 'undefined') ? result.next_offset : null;
        return { gifts, nextOffset };
    }, connectionId);
}

// Every business-scoped update officially carries business_connection_id, so these act as a
// recovery source when the one-off business_connection update was never delivered.
function extractBusinessConnectionIdFromUpdate(update) {
    return update?.business_message?.business_connection_id
        || update?.edited_business_message?.business_connection_id
        || update?.deleted_business_messages?.business_connection_id
        || null;
}

// يستعيد بيانات الاتصال الرسمية من Telegram عبر getBusinessConnection ثم يحفظها.
// كل الحقول تأتي من Telegram نفسه — لا اختراع ولا افتراضات محلية.
async function recoverBusinessConnectionById(connectionId) {
    const connection = await callTelegramBotApi('getBusinessConnection', {
        business_connection_id: connectionId
    });
    if (!connection || !connection.id) throw new Error('getBusinessConnection returned no connection');

    runtimeBusinessConnection = {
        id: connection.id,
        businessUserId: connection.user?.id || null,
        canViewGiftsAndStars: !!connection.rights?.can_view_gifts_and_stars,
        canTransferAndUpgradeGifts: !!connection.rights?.can_transfer_and_upgrade_gifts,
        isEnabled: !!connection.is_enabled,
        updatedAt: new Date().toISOString()
    };
    await savePersistedBusinessConnection({
        connectionId: runtimeBusinessConnection.id,
        businessUserId: runtimeBusinessConnection.businessUserId,
        canViewGiftsAndStars: runtimeBusinessConnection.canViewGiftsAndStars,
        canTransferAndUpgradeGifts: runtimeBusinessConnection.canTransferAndUpgradeGifts,
        isEnabled: runtimeBusinessConnection.isEnabled
    });
    return runtimeBusinessConnection;
}

async function ensureRuntimeBusinessConnection() {
    let connectionId = TELEGRAM_BUSINESS_CONNECTION_ID || runtimeBusinessConnection.id;
    if (!connectionId) {
        const persisted = await getPersistedBusinessConnection();
        connectionId = persisted?.connection_id || null;
        if (connectionId && !runtimeBusinessConnection.id) {
            runtimeBusinessConnection = {
                id: persisted.connection_id,
                businessUserId: persisted.business_user_id,
                canViewGiftsAndStars: !!persisted.can_view_gifts_and_stars,
                canTransferAndUpgradeGifts: !!persisted.can_transfer_and_upgrade_gifts,
                isEnabled: !!persisted.is_enabled,
                updatedAt: persisted.updated_at
            };
        }
    }
    if (!connectionId) return runtimeBusinessConnection;

    // Always re-read Telegram's live rights here. The business owner can change
    // permissions after the previous connection snapshot was persisted, especially
    // can_transfer_and_upgrade_gifts. Never keep a stale "false" value that blocks
    // a withdrawal after the permission has been enabled in Telegram.
    try {
        return await recoverBusinessConnectionById(connectionId);
    } catch (error) {
        console.error('🔗 Business connection refresh failed:', error.message);
    }
    return runtimeBusinessConnection;
}

// يستخرج الهوية الفريدة الرسمية لهدية Telegram Collectible فقط (يتجاهل النجوم/الهدايا العادية).
function canonicalCollectibleSlug(name, number) {
    const rawName = String(name || '').trim();
    const numericNumber = Number(number);
    if (!rawName || !Number.isSafeInteger(numericNumber) || numericNumber <= 0) return null;
    const suffix = `-${numericNumber}`;
    return rawName.endsWith(suffix) ? rawName : `${rawName}${suffix}`;
}

function extractUniqueCollectibleIdentity(ownedGift) {
    const uniqueGift = ownedGift?.gift;
    if (!ownedGift || ownedGift.type !== 'unique' || !uniqueGift) return null;
    if (!uniqueGift.name || !Number.isFinite(uniqueGift.number)) return null;

    // Telegram's static thumbnail is preferred because it is a browser-renderable image.
    // The full sticker may be TGS/WEBM and is therefore kept as metadata/fallback only.
    const stickerThumbnailFileId = uniqueGift.model?.sticker?.thumbnail?.file_id || null;
    const stickerFileId = uniqueGift.model?.sticker?.file_id || null;
    const displayFileId = stickerThumbnailFileId || stickerFileId || null;

    const collectibleForPricing = {
        name: uniqueGift.base_name || uniqueGift.name,
        model_name: uniqueGift.model?.name || uniqueGift.base_name || uniqueGift.name
    };
    const marketValue = getCollectibleMarketValue(collectibleForPricing);
    const giftValue = marketValue ? marketValue.floorPriceTon : 0;

    const verifiedMetadata = {
        source: 'telegram.business.getBusinessAccountGifts',
        ownedGiftId: ownedGift.owned_gift_id || null,
        uniqueCollectibleId: canonicalCollectibleSlug(uniqueGift.name, uniqueGift.number),
        telegramGiftId: uniqueGift.gift_id || uniqueGift.base_name || uniqueGift.name,
        baseName: uniqueGift.base_name || null,
        uniqueName: uniqueGift.name,
        collectibleNumber: Number.isFinite(uniqueGift.number) ? uniqueGift.number : null,
        isPremium: !!uniqueGift.is_premium,
        isBurned: !!uniqueGift.is_burned,
        isFromBlockchain: !!uniqueGift.is_from_blockchain,
        sendDate: Number.isFinite(ownedGift.send_date) ? ownedGift.send_date : null,
        sendDateIso: Number.isFinite(ownedGift.send_date)
            ? new Date(ownedGift.send_date * 1000).toISOString()
            : null,
        isSaved: !!ownedGift.is_saved,
        canBeTransferred: !!ownedGift.can_be_transferred,
        transferStarCount: Number.isFinite(ownedGift.transfer_star_count) ? ownedGift.transfer_star_count : null,
        nextTransferDate: Number.isFinite(ownedGift.next_transfer_date) ? ownedGift.next_transfer_date : null,
        nextTransferDateIso: Number.isFinite(ownedGift.next_transfer_date)
            ? new Date(ownedGift.next_transfer_date * 1000).toISOString()
            : null,
        sender: ownedGift.sender_user ? {
            id: ownedGift.sender_user.id || null,
            username: ownedGift.sender_user.username || null,
            firstName: ownedGift.sender_user.first_name || null,
            lastName: ownedGift.sender_user.last_name || null
        } : null,
        model: {
            name: uniqueGift.model?.name || null,
            rarity: uniqueGift.model?.rarity || null,
            rarityPerMille: Number.isFinite(uniqueGift.model?.rarity_per_mille) ? uniqueGift.model.rarity_per_mille : null,
            stickerFileId,
            stickerThumbnailFileId,
            stickerFileUniqueId: uniqueGift.model?.sticker?.file_unique_id || null,
            stickerThumbnailFileUniqueId: uniqueGift.model?.sticker?.thumbnail?.file_unique_id || null,
            stickerIsAnimated: !!uniqueGift.model?.sticker?.is_animated,
            stickerIsVideo: !!uniqueGift.model?.sticker?.is_video
        },
        symbol: uniqueGift.symbol ? {
            name: uniqueGift.symbol.name || null,
            rarityPerMille: Number.isFinite(uniqueGift.symbol.rarity_per_mille) ? uniqueGift.symbol.rarity_per_mille : null,
            stickerFileId: uniqueGift.symbol.sticker?.file_id || null,
            stickerThumbnailFileId: uniqueGift.symbol.sticker?.thumbnail?.file_id || null
        } : null,
        backdrop: uniqueGift.backdrop ? {
            name: uniqueGift.backdrop.name || null,
            rarityPerMille: Number.isFinite(uniqueGift.backdrop.rarity_per_mille) ? uniqueGift.backdrop.rarity_per_mille : null,
            colors: uniqueGift.backdrop.colors || null
        } : null,
        marketValue: giftValue,
        displayMediaFileId: displayFileId,
        rawTelegram: ownedGift
    };

    return {
        uniqueCollectibleId: canonicalCollectibleSlug(uniqueGift.name, uniqueGift.number),
        telegramGiftInstanceId: String(ownedGift.owned_gift_id || ''),
        collectibleNumber: uniqueGift.number,
        senderTelegramId: ownedGift.sender_user?.id || null,
        senderUsername: ownedGift.sender_user?.username || null,
        telegramGiftModel: {
            telegramGiftId: uniqueGift.gift_id || uniqueGift.base_name || uniqueGift.name,
            name: uniqueGift.name || uniqueGift.base_name || 'Telegram Collectible',
            slug: canonicalCollectibleSlug(uniqueGift.name, uniqueGift.number),
            imageUrl: null,
            collection: uniqueGift.base_name || uniqueGift.backdrop?.name || null,
            rarity: uniqueGift.model?.rarity || 'common',
            value: giftValue,
            totalSupply: 0
        },
        verifiedMetadata: JSON.stringify(verifiedMetadata),
        stickerFileId: displayFileId
    };
}

// ===== Backpack حية: تسجيل عملاء SSE وإرسال إشعارات collectible-credited =====
// خريطة userId -> مجموعة من استجابات الـ SSE المتصلة. لا تُخزّن أي أسرار أو file_id.
const collectibleClients = new Map();

function registerCollectibleClient(userId, res) {
    if (!collectibleClients.has(userId)) collectibleClients.set(userId, new Set());
    collectibleClients.get(userId).add(res);
}

function unregisterCollectibleClient(userId, res) {
    const clients = collectibleClients.get(userId);
    if (clients) {
        clients.delete(res);
        if (clients.size === 0) collectibleClients.delete(userId);
    }
}

// يبثّ حدث collectible-credited لعميل Backpack المناسب فقط.
// يُرسل هوية القطعة العلنية + الرقم فقط — لا BOT_TOKEN، لا file_id، لا بيانات مرسل خام.
// يُستدعى من داخل المسح بعد creditVerifiedCollectible بنجاح.
function notifyCollectibleClients(userId, payload) {
    const clients = collectibleClients.get(userId);
    if (!clients) return 0;
    const data = `event: collectible-credited\ndata: ${JSON.stringify(payload)}\n\n`;
    let sent = 0;
    for (const res of clients) {
        if (res.writableEnded) continue;
        try { res.write(data); sent++; } catch { /* العميل انقطع، سيُزاله في استقبال close */ }
    }
    return sent;
}

// مسح دوري للهدايا المملوكة لحساب Telegram Business.
// الملكية داخل اللعبة تُسند إلى sender_user.id: هذا هو مُرسل الهدية، وليس مالك حساب Business.
// لا نطلب من مالك حساب Business تسجيل الدخول للعبة، ولا نُسند المقتنى إليه.
// fetchGiftsFn قابل للحقن للاختبارات فقط (افتراضيًا يستخدم استدعاء Telegram الحقيقي).
async function runCollectibleVerificationSweep(fetchGiftsFn = fetchBusinessAccountGifts) {
    await ensureRuntimeBusinessConnection();
    const connectionId = TELEGRAM_BUSINESS_CONNECTION_ID || runtimeBusinessConnection.id;
    if (!connectionId) {
        console.warn('🔍 Collectible sweep skipped: no business connection available', JSON.stringify({
            envConfigured: !!TELEGRAM_BUSINESS_CONNECTION_ID,
            runtimeDiscovered: !!runtimeBusinessConnection.id,
            canViewGiftsAndStars: runtimeBusinessConnection.canViewGiftsAndStars,
            isEnabled: runtimeBusinessConnection.isEnabled
        }));
        return { configured: false, credited: 0, unmatched: 0 };
    }

    if (!runtimeBusinessConnection.canViewGiftsAndStars) {
        console.warn('🔍 Collectible sweep skipped: Business connection cannot view gifts and stars');
        return { configured: true, credited: 0, unmatched: 0, reason: 'missing_view_gifts_right' };
    }

    try {
        await refreshMarketPrices();
    } catch (priceError) {
        console.error('🔍 Collectible sweep: market price refresh failed:', priceError.message);
    }

    let ownedGifts;
    try {
        ownedGifts = await fetchGiftsFn();
    } catch (error) {
        console.error('🔍 Collectible sweep: getBusinessAccountGifts failed:', error.message);
        throw error;
    }

    let credited = 0;
    let unmatched = 0;
    let uniqueDetected = 0;
    const reasons = {
        alreadyCredited: 0,
        creditFailed: 0,
        senderUnknown: 0,
        playerNotRegistered: 0
    };

    for (const ownedGift of ownedGifts) {
        const identity = extractUniqueCollectibleIdentity(ownedGift);
        if (!identity) continue;
        uniqueDetected++;

        const alreadyCredited = await isCollectibleAlreadyCredited(identity.uniqueCollectibleId, identity.telegramGiftInstanceId, identity.senderTelegramId);
        if (alreadyCredited) {
            // Repair legacy IDs created as "Name-N-N" when Telegram's name already
            // contained the collectible number. The canonical identity is "Name-N".
            const legacyIdMatch = String(alreadyCredited.unique_collectible_id || '').match(/^(.*)-(\d+)-(\d+)$/);
            const currentNumber = Number(identity.collectibleNumber);
            if (
                legacyIdMatch
                && Number(legacyIdMatch[2]) === currentNumber
                && Number(legacyIdMatch[3]) === currentNumber
                && legacyIdMatch[1]
                && identity.uniqueCollectibleId
                && identity.uniqueCollectibleId !== alreadyCredited.unique_collectible_id
            ) {
                const canonicalOwner = await get(
                    `SELECT id FROM user_gifts
                     WHERE unique_collectible_id = ?
                       AND id != ?
                       AND status IN ('OWNED', 'IN_BET', 'LOCKED')
                     LIMIT 1`,
                    [identity.uniqueCollectibleId, alreadyCredited.id]
                );
                if (!canonicalOwner) {
                    await run(
                        'UPDATE user_gifts SET unique_collectible_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [identity.uniqueCollectibleId, alreadyCredited.id]
                    );
                    alreadyCredited.unique_collectible_id = identity.uniqueCollectibleId;
                    console.log('🧾 Collectible identity repaired:', JSON.stringify({
                        from: legacyIdMatch[0],
                        to: identity.uniqueCollectibleId,
                        userGiftId: alreadyCredited.id
                    }));
                }
            }

            // Revalue existing verified collectibles from Telegram's live market.
            try {
                await refreshVerifiedCollectibleMarketValue({
                    uniqueCollectibleId: identity.uniqueCollectibleId,
                    verifiedMetadata: identity.verifiedMetadata,
                    telegramGiftModel: identity.telegramGiftModel
                }, alreadyCredited.id);
            } catch (marketError) {
                console.warn('Collectible live market revaluation failed:', marketError.message);
            }
            // Existing collectibles may have been imported before Telegram sticker media was
            // persisted. Reconcile the current official Telegram sticker file id on every sweep
            // so the Backpack can recover the real image instead of falling back to 🎁.
            try {
                let existingMetadata = {};
                try {
                    existingMetadata = alreadyCredited.verified_metadata ? JSON.parse(alreadyCredited.verified_metadata) : {};
                } catch {}
                const metadataChanged = JSON.stringify(existingMetadata) !== identity.verifiedMetadata;
                const mediaChanged = (alreadyCredited.telegram_thumbnail_file_id || null) !== (identity.stickerFileId || null);
                if (metadataChanged || mediaChanged) {
                    await run(
                        `UPDATE user_gifts
                         SET telegram_thumbnail_file_id = ?, verified_metadata = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [identity.stickerFileId || alreadyCredited.telegram_thumbnail_file_id || null, identity.verifiedMetadata, alreadyCredited.id]
                    );
                    console.log('🧾 Collectible metadata synchronized:', JSON.stringify({
                        uniqueCollectibleId: identity.uniqueCollectibleId,
                        userGiftId: alreadyCredited.id,
                        mediaChanged
                    }));
                }
            } catch (mediaRepairError) {
                console.error('🧾 Collectible metadata synchronization failed:', mediaRepairError.message);
            }
            reasons.alreadyCredited++;
            continue;
        }

        const senderTelegramId = identity.senderTelegramId;
        if (!senderTelegramId) {
            unmatched++;
            reasons.senderUnknown++;
            console.warn('🔍 Collectible not credited: Telegram did not expose a known sender');
            continue;
        }

        // Primary identity is Telegram's immutable numeric user id. If an existing
        // registered player was created before Telegram exposed that id in the gift,
        // reconcile by the sender's exact current username, then persist the real id.
        // This still requires a pre-existing Rocket account; we never auto-register here.
        let player = await get('SELECT * FROM users WHERE telegram_id = ?', [String(senderTelegramId)]);
        let matchedByUsername = false;
        const senderUsername = identity.senderUsername ? String(identity.senderUsername).replace(/^@/, '').trim().toLowerCase() : '';
        if (!player && senderUsername) {
            player = await get(
                'SELECT * FROM users WHERE lower(ltrim(username, \'@\')) = ? LIMIT 1',
                [senderUsername]
            );
            if (player) {
                matchedByUsername = true;
                await run('UPDATE users SET telegram_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [String(senderTelegramId), player.id]);
                player = await get('SELECT * FROM users WHERE id = ?', [player.id]);
            }
        }
        if (!player) {
            unmatched++;
            reasons.playerNotRegistered++;
            console.warn('🔍 Collectible not credited: sender is not a registered Rocket player', JSON.stringify({
                senderTelegramId: String(senderTelegramId),
                senderUsername: identity.senderUsername || null
            }));
            continue;
        }
        if (matchedByUsername) {
            console.log('🔗 Collectible sender identity reconciled by username:', JSON.stringify({
                userId: player.id,
                senderUsername: identity.senderUsername
            }));
        }

        try {
            const creditResult = await creditVerifiedCollectible({
                intentId: null,
                userId: player.id,
                telegramGiftModel: identity.telegramGiftModel,
                uniqueCollectibleId: identity.uniqueCollectibleId,
                telegramGiftInstanceId: identity.telegramGiftInstanceId,
                collectibleNumber: identity.collectibleNumber,
                verifiedMetadata: identity.verifiedMetadata,
                stickerFileId: identity.stickerFileId
            });

            if (creditResult.alreadyCredited) {
                reasons.alreadyCredited++;
                continue;
            }

            try {
                await refreshVerifiedCollectibleMarketValue(identity, creditResult.userGift?.id || null);
            } catch (marketError) {
                console.warn('Collectible live market revaluation after credit failed:', marketError.message);
            }

            credited++;
            console.log('✅ Collectible credited:', JSON.stringify({
                uniqueCollectibleId: identity.uniqueCollectibleId,
                collectibleNumber: identity.collectibleNumber,
                userId: player.id
            }));

            notifyCollectibleClients(player.id, {
                type: 'collectible-credited',
                uniqueCollectibleId: identity.uniqueCollectibleId,
                collectibleNumber: identity.collectibleNumber,
                receivedAt: new Date().toISOString()
            });

            // Confirmation goes to the real sender/player. Failure here must never undo
            // the already-committed collectible ownership in the Backpack.
            try {
                await callTelegramBotApi('sendMessage', {
                    chat_id: String(senderTelegramId),
                    text: `🎁 ${identity.telegramGiftModel.name} #${identity.collectibleNumber} just arrived.
It’s in your Backpack: upgrade it, use it in a contract, or quick-sell it.`
                });
            } catch (notifyError) {
                console.error('🔍 Collectible confirmation message failed:', notifyError.message);
            }
        } catch (error) {
            unmatched++;
            reasons.creditFailed++;
            console.error('🔍 Collectible credit failed:', JSON.stringify({
                uniqueCollectibleId: identity.uniqueCollectibleId,
                reason: error.message
            }));
        }
    }

    console.log('🔍 Collectible sweep summary:', JSON.stringify({
        giftsReturned: ownedGifts.length,
        uniqueDetected,
        credited,
        unmatched,
        reasons
    }));

    return { configured: true, credited, unmatched, giftsReturned: ownedGifts.length, uniqueDetected, reasons };
}

// ===== Phase 3B: Real Telegram collectible media resolution (server-only, no BOT_TOKEN leakage) =====
// In-memory cache only (file_path is not a secret, no token stored): fileId -> { filePath, expiresAt }.
const telegramFileCache = new Map();
const TELEGRAM_FILE_CACHE_TTL_MS = 60 * 60 * 1000;

async function resolveTelegramFilePath(fileId) {
    const cached = telegramFileCache.get(fileId);
    if (cached && cached.expiresAt > Date.now()) return cached.filePath;

    const result = await callTelegramBotApi('getFile', { file_id: fileId });
    if (!result || !result.file_path) throw new Error('Telegram getFile returned no file_path');

    telegramFileCache.set(fileId, { filePath: result.file_path, expiresAt: Date.now() + TELEGRAM_FILE_CACHE_TTL_MS });
    return result.file_path;
}

// يبث بايتات ملف Telegram الحقيقي دون كشف BOT_TOKEN للعميل أبداً (الطلب يبقى سيرفر-إلى-سيرفر فقط).
function streamTelegramFile(filePath, res) {
    return new Promise((resolve, reject) => {
        const request = https.request({
            hostname: 'api.telegram.org',
            path: `/file/bot${BOT_TOKEN}/${filePath}`,
            method: 'GET'
        }, telegramRes => {
            if (telegramRes.statusCode < 200 || telegramRes.statusCode >= 300) {
                telegramRes.resume();
                reject(new Error(`Telegram file HTTP ${telegramRes.statusCode}`));
                return;
            }
            res.setHeader('Content-Type', telegramRes.headers['content-type'] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            telegramRes.pipe(res);
            telegramRes.on('end', resolve);
        });
        request.setTimeout(10000, () => request.destroy(new Error('Telegram file timeout')));
        request.on('error', reject);
        request.end();
    });
}

// ===== Rocket game: official Telegram Stellar Rocket model catalog =====
// Isolated from the crash/round engine. This uses MTProto only to read the public
// collectible attributes for the Stellar Rocket gift type and to serve the exact
// Telegram model Document bytes to the existing <video> element.
//
// Required server-only variables:
//   TELEGRAM_API_ID
//   TELEGRAM_API_HASH
//   TELEGRAM_SESSION_STRING
//
// The session string is a Telegram user login credential. Never log or expose it.
let telegramMtprotoClient = null;
let telegramRocketCatalog = [];
let telegramRocketCatalogLoadedAt = 0;
let telegramMtprotoInitPromise = null;

const TELEGRAM_ROCKET_CATALOG_TTL_MS = 30 * 60 * 1000;
const telegramRocketMediaCache = new Map();
const MAX_TELEGRAM_ROCKET_MEDIA_CACHE = 8;
const MAX_TELEGRAM_ROCKET_MEDIA_BYTES = 12 * 1024 * 1024;

function rocketAttributeRarity(attribute) {
    const rarity = attribute?.rarity;
    if (!rarity) return null;
    if (Number.isFinite(rarity.permille)) return Number(rarity.permille);
    const name = String(rarity.className || rarity.constructor?.name || '').toLowerCase();
    if (name.includes('legendary')) return 'legendary';
    if (name.includes('epic')) return 'epic';
    if (name.includes('rare')) return 'rare';
    if (name.includes('uncommon')) return 'uncommon';
    return null;
}

function isTelegramRocketModel(attribute) {
    return !!attribute && (
        attribute.className === 'StarGiftAttributeModel'
        || attribute.constructor?.className === 'StarGiftAttributeModel'
        || attribute.constructor?.name === 'StarGiftAttributeModel'
    );
}

function telegramDocumentKey(document) {
    return document?.id != null ? String(document.id) : null;
}

function telegramDocumentMimeType(document) {
    return String(document?.mimeType || document?.mime_type || 'video/webm').toLowerCase();
}

function detectTelegramRocketFormat(buffer, mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (mime.includes('tgsticker') || mime === 'application/x-tgsticker' || isGzip) return 'tgs';
    if (mime === 'video/webm' || mime.includes('webm')) return 'webm';
    return 'unknown';
}

function decodeTelegramTgs(buffer) {
    const inflated = zlib.gunzipSync(buffer);
    const animation = JSON.parse(inflated.toString('utf8'));
    if (!animation || typeof animation !== 'object' || !Array.isArray(animation.layers)) {
        throw new Error('Telegram TGS payload is not valid Lottie JSON');
    }
    return animation;
}

function buildTelegramRocketModel(model, index) {
    const document = model.document || null;
    const documentId = telegramDocumentKey(document);
    return {
        id: documentId || `model-${index + 1}`,
        name: String(model.name || `Stellar Rocket #${index + 1}`),
        rarity: rocketAttributeRarity(model),
        crafted: !!model.crafted,
        documentId,
        mimeType: telegramDocumentMimeType(document),
        size: Number.isFinite(Number(document?.size)) ? Number(document.size) : null,
        mediaUrl: documentId ? `/api/rocket-media/${encodeURIComponent(documentId)}` : null
    };
}

async function ensureTelegramMtprotoClient() {
    if (telegramMtprotoClient) return telegramMtprotoClient;
    if (telegramMtprotoInitPromise) return telegramMtprotoInitPromise;

    telegramMtprotoInitPromise = (async () => {
        let TelegramClient;
        let StringSession;
        try {
            ({ TelegramClient } = require('teleproto'));
            ({ StringSession } = require('teleproto/sessions'));
        } catch (error) {
            throw new Error('teleproto is unavailable: ' + error.message);
        }

        const apiId = Number(String(process.env.TELEGRAM_API_ID || '').trim());
        const apiHash = String(process.env.TELEGRAM_API_HASH || '').trim();
        const sessionString = String(process.env.TELEGRAM_SESSION_STRING || '').trim();

        if (!Number.isInteger(apiId) || apiId <= 0) throw new Error('TELEGRAM_API_ID is not configured');
        if (!apiHash) throw new Error('TELEGRAM_API_HASH is not configured');
        if (!sessionString) throw new Error('TELEGRAM_SESSION_STRING is not configured');

        const session = new StringSession(sessionString);
        const client = new TelegramClient(session, apiId, apiHash, {
            connectionRetries: 5,
            autoReconnect: true,
            maxConcurrentDownloads: 4
        });
        await client.connect();
        const me = await client.getMe();
        console.log('🔐 Telegram MTProto connected for Stellar Rocket catalog:', JSON.stringify({
            authorized: !!me,
            accountType: me?.className || null
        }));
        telegramMtprotoClient = client;
        return client;
    })();

    try {
        return await telegramMtprotoInitPromise;
    } finally {
        telegramMtprotoInitPromise = null;
    }
}

async function refreshTelegramRocketCatalog(force = false) {
    if (!force && telegramRocketCatalog.length && Date.now() - telegramRocketCatalogLoadedAt < TELEGRAM_ROCKET_CATALOG_TTL_MS) {
        return telegramRocketCatalog;
    }

    const client = await ensureTelegramMtprotoClient();

    // Telegram's official MTProto flow:
    // 1) payments.getStarGifts gives the base gift type and id.
    // 2) payments.getStarGiftUpgradeAttributes gives every possible model/pattern/backdrop.
    const available = await client.api.payments.getStarGifts({ hash: 0 });
    const gifts = Array.isArray(available?.gifts) ? available.gifts : [];
    const stellarRocket = gifts.find(gift => String(gift?.title || '').trim().toLowerCase() === 'stellar rocket')
        || gifts.find(gift => String(gift?.title || '').trim().toLowerCase().includes('stellar rocket'));

    if (!stellarRocket?.id) {
        throw new Error('Telegram did not return the Stellar Rocket base gift');
    }

    const attributesResult = await client.api.payments.getStarGiftUpgradeAttributes({
        giftId: stellarRocket.id
    });
    const attributes = Array.isArray(attributesResult?.attributes) ? attributesResult.attributes : [];
    const models = attributes
        .filter(attribute => isTelegramRocketModel(attribute) && !attribute.crafted && attribute.document)
        .map((attribute, index) => buildTelegramRocketModel(attribute, index))
        .filter(model => model.documentId);

    if (!models.length) {
        throw new Error('Telegram returned no Stellar Rocket model documents');
    }

    const deduped = [];
    const seen = new Set();
    for (const model of models) {
        if (seen.has(model.documentId)) continue;
        seen.add(model.documentId);
        deduped.push(model);
    }

    telegramRocketCatalog = deduped;
    telegramRocketCatalogLoadedAt = Date.now();

    console.log('🚀 Stellar Rocket catalog refreshed from Telegram:', JSON.stringify({
        baseGiftId: String(stellarRocket.id),
        variantsReported: Number(stellarRocket.upgradeVariants || 0) || null,
        modelsReturned: telegramRocketCatalog.length
    }));

    return telegramRocketCatalog;
}

async function getTelegramRocketMedia(documentId) {
    const key = String(documentId || '').trim();
    if (!key) throw new Error('Rocket document id is required');

    const cached = telegramRocketMediaCache.get(key);
    if (cached) {
        cached.lastUsedAt = Date.now();
        return cached;
    }

    const catalogEntry = telegramRocketCatalog.find(item => item.documentId === key);
    if (!catalogEntry) throw new Error('Rocket model is not in the Telegram catalog');

    const client = await ensureTelegramMtprotoClient();
    const document = {
        _: 'document',
        id: BigInt(key),
        accessHash: undefined
    };

    // Prefer the exact Document object returned by getStarGiftUpgradeAttributes.
    // It contains the file reference needed by Telegram's MTProto media endpoint.
    const available = await client.api.payments.getStarGifts({ hash: 0 });
    const gifts = Array.isArray(available?.gifts) ? available.gifts : [];
    const stellarRocket = gifts.find(gift => String(gift?.title || '').trim().toLowerCase().includes('stellar rocket'));
    if (!stellarRocket?.id) throw new Error('Stellar Rocket base gift unavailable');

    const attributesResult = await client.api.payments.getStarGiftUpgradeAttributes({ giftId: stellarRocket.id });
    const attribute = (Array.isArray(attributesResult?.attributes) ? attributesResult.attributes : [])
        .find(item => isTelegramRocketModel(item) && !item.crafted && telegramDocumentKey(item.document) === key);
    if (!attribute?.document) throw new Error('Rocket model document reference unavailable');

    const buffer = await client.downloadMedia(attribute.document);
    if (!buffer || !Buffer.isBuffer(buffer)) throw new Error('Telegram returned no rocket media');
    if (buffer.length > MAX_TELEGRAM_ROCKET_MEDIA_BYTES) throw new Error('Rocket media exceeds safe cache limit');

    const mimeType = telegramDocumentMimeType(attribute.document);
    const format = detectTelegramRocketFormat(buffer, mimeType);
    console.log('🚀 Telegram Stellar Rocket media:', JSON.stringify({
        documentId: key, mimeType, format, size: buffer.length,
        magic: buffer.subarray(0, 8).toString('hex')
    }));
    const entry = { buffer, mimeType, format, size: buffer.length, lastUsedAt: Date.now() };
    telegramRocketMediaCache.set(key, entry);

    while (telegramRocketMediaCache.size > MAX_TELEGRAM_ROCKET_MEDIA_CACHE) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [candidateKey, candidate] of telegramRocketMediaCache) {
            if (candidate.lastUsedAt < oldestTime) {
                oldestTime = candidate.lastUsedAt;
                oldestKey = candidateKey;
            }
        }
        if (oldestKey == null) break;
        telegramRocketMediaCache.delete(oldestKey);
    }

    return entry;
}

// Public, privacy-safe recent loot-box wins for the live HOT card.
// Only reward data is exposed; user identity is never returned.
app.get('/api/loot-box/recent-wins', async (req, res) => {
    try {
        const requestedBox = String(req.query?.boxName || '').trim();
        const rows = await query(`
            SELECT n.type, n.message, n.data, n.created_at,
                   g.name AS gift_name, g.image_url AS gift_image, g.value AS gift_value
            FROM notifications n
            LEFT JOIN gifts g
              ON g.id = CASE
                    WHEN n.type = 'GIFT_WON'
                    THEN CAST(json_extract(n.data, '$.giftId') AS INTEGER)
                    ELSE NULL
                 END
            WHERE n.type IN ('GIFT_WON', 'BALANCE_WON')
            ORDER BY n.created_at DESC
            LIMIT 100
        `);

        const wins = [];
        for (const row of rows) {
            let data = {};
            try { data = row.data ? JSON.parse(row.data) : {}; } catch {}

            const source = String(data.source || '');
            if (source !== 'paid-loot-box' && source !== 'free-box') continue;

            const boxName = String(data.boxName || '').trim();
            if (requestedBox && boxName !== requestedBox) continue;

            const isTon = row.type === 'BALANCE_WON' || Number(data.tonReward) > 0;

            // HOT is reserved for collectible gift wins only.
            // TON wins remain in the normal reward system but never appear in this feed.
            if (isTon || !row.gift_name || !row.gift_image) continue;

            const value = Number(row.gift_value || 0);
            wins.push({
                type: 'gift',
                name: row.gift_name,
                image: row.gift_image,
                value: Number.isFinite(value) ? value : 0,
                boxName,
                createdAt: row.created_at
            });

            if (wins.length >= 12) break;
        }

        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, wins });
    } catch (error) {
        console.error('Recent loot-box wins failed:', error.message);
        res.status(200).json({ ok: true, wins: [] });
    }
});

app.get('/api/rocket-gifts', async (req, res) => {
    try {
        const catalog = await refreshTelegramRocketCatalog();
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            ok: true,
            source: 'telegram-mtproto-payments.getStarGiftUpgradeAttributes',
            collection: 'Stellar Rocket',
            rockets: catalog.map(item => ({
                id: item.id,
                name: item.name,
                model: item.name,
                rarity: item.rarity,
                number: null,
                mediaUrl: item.mediaUrl,
                mimeType: item.mimeType,
                isVideo: item.mimeType.startsWith('video/'),
                isAnimated: true
            }))
        });
    } catch (error) {
        console.error('Rocket catalog fetch failed:', error.message);
        res.status(503).json({
            ok: false,
            rockets: [],
            error: 'Stellar Rocket catalog unavailable'
        });
    }
});


// Generic Telegram Star Gift media proxy.
const telegramGiftMediaCache = new Map();
const telegramGiftMediaInFlight = new Map();
const TELEGRAM_GIFT_MEDIA_CACHE_LIMIT = 120;
const TELEGRAM_GIFT_MEDIA_TTL_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_GIFT_CATALOG_TTL_MS = 15 * 60 * 1000;
const TELEGRAM_GIFT_MEDIA_MAX_CONCURRENT = 6;
let telegramGiftCatalogCache = null;
let telegramGiftCatalogInFlight = null;
let telegramGiftMediaActive = 0;
const telegramGiftMediaWaiters = [];

function normalizeTelegramGiftName(value) {
    return String(value || '').trim().toLowerCase()
        .replace(/[’‘`]/g, "'")
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '');
}

function detectImageMime(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return 'application/octet-stream';
    if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
    if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
    return 'application/octet-stream';
}

async function getTelegramStarGiftCatalog() {
    if (telegramGiftCatalogCache && Date.now() - telegramGiftCatalogCache.loadedAt < TELEGRAM_GIFT_CATALOG_TTL_MS) {
        return telegramGiftCatalogCache.gifts;
    }
    if (telegramGiftCatalogInFlight) return telegramGiftCatalogInFlight;

    telegramGiftCatalogInFlight = (async () => {
        const client = await ensureTelegramMtprotoClient();
        const available = await client.api.payments.getStarGifts({ hash: 0 });
        const gifts = Array.isArray(available?.gifts) ? available.gifts : [];
        if (!gifts.length) throw new Error('Telegram returned an empty Star Gift catalog');
        telegramGiftCatalogCache = { gifts, loadedAt: Date.now() };
        return gifts;
    })().finally(() => {
        telegramGiftCatalogInFlight = null;
    });

    return telegramGiftCatalogInFlight;
}

function chooseTelegramGiftThumbnail(document) {
    const thumbs = Array.isArray(document?.thumbs) ? document.thumbs : [];
    const usable = thumbs.filter(thumb => {
        return thumb && typeof thumb.type === 'string' && thumb.type !== 'j' &&
            (Number(thumb.w || 0) > 0 || Number(thumb.size || 0) > 0);
    });
    usable.sort((a, b) => {
        const areaA = Number(a.w || 0) * Number(a.h || 0);
        const areaB = Number(b.w || 0) * Number(b.h || 0);
        return (areaB - areaA) || (Number(b.size || 0) - Number(a.size || 0));
    });
    return usable[0] || null;
}

async function withTelegramGiftMediaSlot(task) {
    if (telegramGiftMediaActive >= TELEGRAM_GIFT_MEDIA_MAX_CONCURRENT) {
        await new Promise(resolve => telegramGiftMediaWaiters.push(resolve));
    }
    telegramGiftMediaActive += 1;
    try {
        return await task();
    } finally {
        telegramGiftMediaActive -= 1;
        const next = telegramGiftMediaWaiters.shift();
        if (next) next();
    }
}

async function getTelegramGiftMedia(slug) {
    const key = normalizeTelegramGiftName(slug);
    if (!key) throw new Error('Gift name is required');

    const cached = telegramGiftMediaCache.get(key);
    if (cached && Date.now() - cached.loadedAt < TELEGRAM_GIFT_MEDIA_TTL_MS) return cached;

    const pending = telegramGiftMediaInFlight.get(key);
    if (pending) return pending;

    const work = withTelegramGiftMediaSlot(async () => {
        const secondCheck = telegramGiftMediaCache.get(key);
        if (secondCheck && Date.now() - secondCheck.loadedAt < TELEGRAM_GIFT_MEDIA_TTL_MS) return secondCheck;

        const gifts = await getTelegramStarGiftCatalog();
        const gift = gifts.find(item => normalizeTelegramGiftName(item?.title) === key);
        if (!gift?.sticker) throw new Error('Telegram Star Gift not found');

        const thumbnail = chooseTelegramGiftThumbnail(gift.sticker);
        if (!thumbnail) throw new Error('Telegram gift thumbnail unavailable');

        const client = await ensureTelegramMtprotoClient();
        const buffer = await client.downloadMedia(gift.sticker, { thumb: String(thumbnail.type) });
        if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Telegram returned no gift thumbnail');
        if (buffer.length > 1024 * 1024) throw new Error('Gift thumbnail exceeds safe cache limit');

        const mimeType = detectImageMime(buffer);
        if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp' && mimeType !== 'image/gif') {
            throw new Error('Telegram gift thumbnail is not a browser image');
        }

        const entry = { buffer, mimeType, loadedAt: Date.now() };
        telegramGiftMediaCache.set(key, entry);
        while (telegramGiftMediaCache.size > TELEGRAM_GIFT_MEDIA_CACHE_LIMIT) {
            const oldestKey = telegramGiftMediaCache.keys().next().value;
            if (oldestKey === undefined) break;
            telegramGiftMediaCache.delete(oldestKey);
        }
        return entry;
    });

    telegramGiftMediaInFlight.set(key, work);
    try {
        return await work;
    } finally {
        telegramGiftMediaInFlight.delete(key);
    }
}

app.get('/api/gift-media/:slug', async (req, res) => {
    try {
        const entry = await getTelegramGiftMedia(decodeURIComponent(String(req.params.slug || '')));
        res.setHeader('Cache-Control', 'public, max-age=21600, stale-while-revalidate=86400');
        res.setHeader('X-Telegram-Media', 'stargift-thumbnail');
        res.setHeader('Content-Type', entry.mimeType);
        res.setHeader('Content-Length', String(entry.buffer.length));
        res.end(entry.buffer);
    } catch (error) {
        console.error('Telegram Star Gift thumbnail proxy failed:', error.message);
        if (!res.headersSent) res.status(404).end();
    }
});

app.get('/api/rocket-media/:documentId', async (req, res) => {
    try {
        const entry = await getTelegramRocketMedia(decodeURIComponent(String(req.params.documentId || '')));
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Telegram-Media', 'mtproto');
        res.setHeader('X-Telegram-Original-Mime-Type', entry.mimeType || 'application/octet-stream');
        res.setHeader('X-Telegram-Render-Type', entry.format || 'unknown');
        if (entry.format === 'tgs') {
            res.setHeader('Content-Type', 'application/x-tgsticker');
            res.setHeader('Content-Encoding', 'identity');
            res.setHeader('Content-Length', String(entry.size));
            res.end(entry.buffer);
            return;
        }
        res.setHeader('Content-Type', entry.mimeType || 'video/webm');
        res.setHeader('Content-Length', String(entry.size));
        res.end(entry.buffer);
    } catch (error) {
        console.error('Rocket MTProto media proxy failed:', error.message);
        if (!res.headersSent) res.status(404).end();
    }
});

// ===== Telegram Business Connection webhook (Phase 3B) =====
// Receives ONLY the official business_connection update; ignores every other Telegram update type.
// Never invents/hardcodes a connection id — it only stores whatever Telegram itself sends.
app.post('/telegram-webhook', async (req, res) => {
    // Diagnostic log before secret validation — booleans only (never secret values, tokens, or personal data).
    console.log('🔎 Webhook diagnostic: Telegram webhook request received', JSON.stringify({
        hasSecretHeader: !!req.headers['x-telegram-bot-api-secret-token'],
        secretConfiguredOnServer: !!TELEGRAM_WEBHOOK_SECRET
    }));

    // Official Telegram secret_token check (set via setWebhook secret_token). If configured on our
    // side but the header is missing/wrong, reject before doing anything else — never processed.
    if (TELEGRAM_WEBHOOK_SECRET) {
        const providedSecret = req.headers['x-telegram-bot-api-secret-token'] || '';
        const expected = Buffer.from(TELEGRAM_WEBHOOK_SECRET);
        const provided = Buffer.from(String(providedSecret));
        const isValid = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
        if (!isValid) {
            console.warn('🔎 Webhook diagnostic: secret token mismatch or missing header - rejected 401');
            res.status(401).end();
            return;
        }
    }

    try {
        const update = req.body || {};
        const updateId = Number.isFinite(update.update_id) ? update.update_id : null;
        const updateType = Object.keys(update).find(key => key !== 'update_id') || 'unknown';
        const hasBusinessConnection = !!update.business_connection;

        // Diagnostic only — safe fields exclusively (no BOT_TOKEN, secret, connection_id, user IDs, file_id).
        console.log('🔎 Webhook diagnostic: update received', JSON.stringify({ updateId, updateType, hasBusinessConnection }));

        // Idempotency: Telegram may redeliver the same update_id on timeout/retry.
        if (Number.isFinite(update.update_id)) {
            const alreadyProcessed = await hasProcessedWebhookUpdate(update.update_id);
            if (alreadyProcessed) {
                res.status(200).json({ ok: true });
                return;
            }
        }

        const connection = update.business_connection;
        if (!connection) {
            // Normal bot messages are also delivered to this webhook. Use /start (or /open)
            // as the canonical launcher so every player opens the game as a real Telegram
            // Mini App and receives signed WebApp initData for authentication.
            const incomingMessage = update.message;
            const messageText = typeof incomingMessage?.text === 'string' ? incomingMessage.text.trim() : '';
            const chatId = incomingMessage?.chat?.id;
                        if (chatId && /^\/(start|open)(?:@[^\s]+)?(?:\s|$)/i.test(messageText)) {
                try {
                    await sendTelegramMiniAppLaunchMessage(chatId);
                    console.log('🚀 Telegram Mini App launch message sent', JSON.stringify({ hasChatId: true }));
                } catch (launchError) {
                    console.error('Telegram Mini App launch message failed:', launchError.message);
                }
            }

            // Business-scoped updates carry business_connection_id. Recover the connection when
            // needed, then trigger ingestion for messages/service messages that may represent a gift.
            const recoverableId = extractBusinessConnectionIdFromUpdate(update);
            if (recoverableId && (
                !runtimeBusinessConnection.id
                || !runtimeBusinessConnection.canViewGiftsAndStars
                || !runtimeBusinessConnection.isEnabled
            )) {
                try {
                    const recovered = await recoverBusinessConnectionById(recoverableId);
                    console.log('🔗 Recovered business connection from business update:', JSON.stringify({
                        updateType,
                        hasConnectionId: !!recovered.id,
                        canViewGiftsAndStars: recovered.canViewGiftsAndStars,
                        isEnabled: recovered.isEnabled
                    }));
                } catch (recoveryError) {
                    console.error('🔎 Webhook diagnostic: business connection recovery failed', JSON.stringify({ updateId, reason: recoveryError.message }));
                }
            }

            if (['business_message', 'edited_business_message', 'deleted_business_messages'].includes(updateType)) {
                if (collectibleSweepInProgress) {
                    console.log('ℹ️ Telegram webhook: business update received but sweep already in progress — skipping');
                } else {
                    const now = Date.now();
                    if (now - lastCollectibleSweepTime < COLLECTIBLE_SWEEP_COOLDOWN_MS) {
                        console.log('ℹ️ Telegram webhook: business update received but sweep on cooldown — skipping');
                    } else {
                        collectibleSweepInProgress = true;
                        lastCollectibleSweepTime = now;
                        console.log('ℹ️ Telegram webhook: business-scoped update received, triggering collectible sweep');
                        runCollectibleVerificationSweep().catch(err =>
                            console.error('Sweep triggered from webhook failed:', err.message)
                        ).finally(() => { collectibleSweepInProgress = false; });
                    }
                }
            } else {
                console.log(`ℹ️ Telegram webhook: ignored unrelated update type "${updateType}"`);
            }

            await markWebhookUpdateProcessed(update.update_id);
            res.status(200).json({ ok: true });
            return;
        }

        const canViewGiftsAndStars = !!connection.rights?.can_view_gifts_and_stars;
        const canTransferAndUpgradeGifts = !!connection.rights?.can_transfer_and_upgrade_gifts;
        runtimeBusinessConnection = {
            id: connection.id || null,
            businessUserId: connection.user?.id || null,
            canViewGiftsAndStars,
            canTransferAndUpgradeGifts,
            isEnabled: !!connection.is_enabled,
            updatedAt: new Date().toISOString()
        };

        // Persist across restarts — public connection metadata only, never a secret.
        console.log('🔎 Webhook diagnostic: calling savePersistedBusinessConnection', JSON.stringify({ updateId }));
        try {
            await savePersistedBusinessConnection({
                connectionId: runtimeBusinessConnection.id,
                businessUserId: runtimeBusinessConnection.businessUserId,
                canViewGiftsAndStars: runtimeBusinessConnection.canViewGiftsAndStars,
                canTransferAndUpgradeGifts: runtimeBusinessConnection.canTransferAndUpgradeGifts,
                isEnabled: runtimeBusinessConnection.isEnabled
            });
            console.log('🔎 Webhook diagnostic: savePersistedBusinessConnection succeeded', JSON.stringify({ updateId }));
        } catch (persistError) {
            console.error('🔎 Webhook diagnostic: savePersistedBusinessConnection FAILED', JSON.stringify({ updateId, reason: persistError.message }));
            throw persistError;
        }
        await markWebhookUpdateProcessed(update.update_id);

        // Never log BOT_TOKEN, secrets, connection_id, or Telegram user IDs — presence/flags only.
        console.log('🔗 Telegram business_connection update:', JSON.stringify({
            updateType: 'business_connection',
            hasConnectionId: !!runtimeBusinessConnection.id,
            canViewGiftsAndStars: runtimeBusinessConnection.canViewGiftsAndStars,
            canTransferAndUpgradeGifts: runtimeBusinessConnection.canTransferAndUpgradeGifts,
            isEnabled: runtimeBusinessConnection.isEnabled
        }));

        if (!canViewGiftsAndStars) {
            console.warn('⚠️ Business connection is missing can_view_gifts_and_stars — collectible verification cannot use it yet.');
        }
        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Telegram webhook handling error:', error.message);
        if (!res.headersSent) res.status(500).json({ ok: false });
    }
});

async function authenticate(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
        const user = await get('SELECT * FROM users WHERE id = ?', [token]);
        if (!user) {
            return res.status(401).json({ ok: false, error: 'User not found' });
        }
        req.user = user;
        next();
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
}

// =========================================================
// 3. دوال حالة اللعبة (Game State)
// =========================================================
let currentGameState = {
    roundId: 0,
    phase: 'COUNTDOWN', // COUNTDOWN, FLIGHT, CRASH
    multiplier: 1.00,
    seconds: 5,
    flightStartedAt: null,
    history: [],
    serverSeedHash: null,
    serverSeed: null,
    clientSeed: DEFAULT_CLIENT_SEED,
    nonce: 0,
    crashAt: null,
    players: []
};

const MULTIPLIER_INCREASE_PER_SECOND = 1 / 2.7;
let roundSettlementInProgress = false;
let gameLoopBusy = false;
let gameLoopTimer = null;
let roundTransitionTimer = null;

function getGameStateSnapshot() {
    return {
        roundId: currentGameState.roundId,
        phase: currentGameState.phase,
        multiplier: currentGameState.multiplier,
        seconds: currentGameState.seconds,
        flightStartedAt: currentGameState.flightStartedAt,
        serverTime: Date.now(),
        history: currentGameState.history,
        serverSeedHash: currentGameState.serverSeedHash,
        clientSeed: currentGameState.clientSeed,
        nonce: currentGameState.nonce,
        serverSeed: currentGameState.phase === 'CRASH' ? currentGameState.serverSeed : null,
        crashAt: currentGameState.phase === 'CRASH' ? currentGameState.crashAt : null,
        players: currentGameState.players
    };
}

// جلب الحالة الحالية
function getCurrentRoundId() {
    return currentGameState.roundId;
}

function getCurrentMultiplier() {
    return currentGameState.multiplier;
}

function getGamePhase() {
    return currentGameState.phase;
}

// تحديث الحالة (يتم استدعاؤها من حلقة اللعبة)
function updateGameState(newState) {
    currentGameState = { ...currentGameState, ...newState };
}

// اسم Telegram الظاهر فقط (لا username، لا telegram_id)
function buildPlayerDisplayName(firstName, lastName) {
    const name = [firstName, lastName].filter(Boolean).join(' ').trim();
    return name || null;
}

async function refreshRoundPlayers() {
    const rows = await getRoundPlayers(currentGameState.roundId);
    const queuedRows = currentGameState.phase === 'FLIGHT'
        ? (await getQueuedTonBetsForRound(currentGameState.roundId + 1)).concat(await getQueuedGiftBetsForRound(currentGameState.roundId + 1))
        : [];
    currentGameState.players = rows.concat(queuedRows).map(row => ({
        id: `${row.bet_type}:${row.bet_id}`,
        name: buildPlayerDisplayName(row.first_name, row.last_name),
        avatar: row.avatar_url || null,
        amount: row.amount,
        status: row.status === 'QUEUED' ? 'QUEUED' : row.status,
        multiplier: row.multiplier,
        betType: row.bet_type,
        giftName: row.gift_name || null,
        giftImageUrl: row.unique_collectible_id
            ? `/api/collectible-media/${encodeURIComponent(row.unique_collectible_id)}`
            : (row.gift_image_url || null)
    }));
}

async function startRound(roundNumber) {
    if (roundTransitionTimer) clearTimeout(roundTransitionTimer);
    roundTransitionTimer = null;
    const fairRound = createFairRound(roundNumber, DEFAULT_CLIENT_SEED);
    await createRoundRecord(fairRound);
    // Queued bets remain cancellable during FLIGHT and are promoted only
    // when the 5-second countdown finishes and FLIGHT is about to start.

    updateGameState({
        roundId: roundNumber,
        phase: 'COUNTDOWN',
        multiplier: 1.00,
        seconds: 5,
        flightStartedAt: null,
        serverSeedHash: fairRound.serverSeedHash,
        serverSeed: fairRound.serverSeed,
        clientSeed: fairRound.clientSeed,
        nonce: fairRound.nonce,
        crashAt: fairRound.crashAt,
        players: []
    });
    await refreshRoundPlayers();
    console.log(`🔐 Round ${roundNumber} committed: ${fairRound.serverSeedHash}`);
}

async function launchRound() {
    if (currentGameState.phase !== 'COUNTDOWN') return;
    await promoteQueuedTonBets(currentGameState.roundId);
    await promoteQueuedGiftBets(currentGameState.roundId);
    await updateRoundState(currentGameState.roundId, 'FLIGHT', 1.00);
    updateGameState({
        phase: 'FLIGHT',
        multiplier: 1.00,
        flightStartedAt: Date.now()
    });
    console.log(`🚀 Round ${currentGameState.roundId} launched!`);
    if (currentGameState.crashAt <= 1.00) await crashCurrentRound();
}

async function processAutoCashouts(multiplier) {
    const bets = await getActiveBetsForRound(currentGameState.roundId);
    let anyCashed = false;
    for (const bet of bets) {
        const target = Number(bet.target);
        if (shouldAutoCashout(target, multiplier, currentGameState.crashAt)) {
            try {
                await cashoutBet(bet.bet_type, bet.id, bet.user_id, currentGameState.roundId, target);
                anyCashed = true;
            } catch (error) {
                if (!error.message.includes('already settled') && !error.message.includes('not found')) {
                    console.error(`Auto cashout failed for ${bet.bet_type} ${bet.id}:`, error.message);
                }
            }
        }
    }
    if (anyCashed) await refreshRoundPlayers();
}

async function crashCurrentRound() {
    if (currentGameState.phase !== 'FLIGHT' || roundSettlementInProgress) return;
    roundSettlementInProgress = true;
    const roundId = currentGameState.roundId;
    const crashAt = currentGameState.crashAt;
    try {
        const result = await crashRound(roundId, crashAt);
        if (!result.settled) return;
        updateGameState({
            phase: 'CRASH',
            multiplier: crashAt,
            flightStartedAt: null,
            history: [crashAt, ...currentGameState.history].slice(0, 10)
        });
        await refreshRoundPlayers();
        console.log(`💥 Round ${roundId} crashed at ${crashAt}x`);
        roundTransitionTimer = setTimeout(async () => {
            try {
                await startRound(roundId + 1);
            } catch (error) {
                console.error('Failed to start next round:', error);
            }
        }, 3000);
    } finally {
        roundSettlementInProgress = false;
    }
}

// =========================================================
// 4. حلقة اللعبة (Game Loop)
// =========================================================
function startGameLoop() {
    if (gameLoopTimer) return gameLoopTimer;
    gameLoopTimer = setInterval(async () => {
        if (gameLoopBusy) return;
        gameLoopBusy = true;
        try {
            if (currentGameState.phase === 'FLIGHT') {
                const flightElapsedSeconds = currentGameState.flightStartedAt
                    ? (Date.now() - currentGameState.flightStartedAt) / 1000
                    : 0;
                const nextMultiplier = Math.round((1 + flightElapsedSeconds * MULTIPLIER_INCREASE_PER_SECOND) * 100) / 100;

                if (nextMultiplier >= currentGameState.crashAt) {
                    await processAutoCashouts(currentGameState.crashAt);
                    await crashCurrentRound();
                } else {
                    currentGameState.multiplier = nextMultiplier;
                    await processAutoCashouts(nextMultiplier);
                }
            } else if (currentGameState.phase === 'COUNTDOWN') {
                currentGameState.seconds--;
                if (currentGameState.seconds <= 0) await launchRound();
            }
        } catch (error) {
            console.error('Game loop error:', error);
        } finally {
            gameLoopBusy = false;
        }
    }, 1000);
    return gameLoopTimer;
}

function stopGameLoop() {
    if (gameLoopTimer) clearInterval(gameLoopTimer);
    if (roundTransitionTimer) clearTimeout(roundTransitionTimer);
    gameLoopTimer = null;
    roundTransitionTimer = null;
    stopCollectibleReconciliationWorker();
}

// مسح دوري خلفي (لا يعتمد على فتح المستخدم لصفحة الحقيبة) لاعتماد المقتنيات الواردة تلقائيًا.
let collectibleReconciliationTimer = null;
let collectibleReconciliationBusy = false;
const COLLECTIBLE_RECONCILIATION_INTERVAL_MS = 45000;

function startCollectibleReconciliationWorker() {
    if (collectibleReconciliationTimer) return;
    collectibleReconciliationTimer = setInterval(async () => {
        if (collectibleReconciliationBusy) return; // never allow overlapping sweeps
        collectibleReconciliationBusy = true;
        try {
            await runCollectibleVerificationSweep();
        } catch (error) {
            console.error('Background collectible reconciliation failed:', error.message);
        } finally {
            collectibleReconciliationBusy = false;
        }
    }, COLLECTIBLE_RECONCILIATION_INTERVAL_MS);
}

function stopCollectibleReconciliationWorker() {
    if (collectibleReconciliationTimer) clearInterval(collectibleReconciliationTimer);
    collectibleReconciliationTimer = null;
}

// =========================================================
// 4.2 PvP Battle System State & Loop
// =========================================================
let pvpState = {
    roundId: null,
    roundNumber: 0,
    phase: 'WAITING',
    seconds: 0,
    serverSeedHash: null,
    serverSeed: null,
    crashAt: null,
    poolTon: 0,
    poolGift: 0,
    participants: [],
    lastWinnerUserId: null
};

let pvpGameLoopTimer = null;
let pvpRoundTransitionTimer = null;
let pvpBusy = false;
const PVP_COUNTDOWN_SECONDS = 10;

function getPvpStateSnapshot() {
    return {
        roundId: pvpState.roundId,
        phase: pvpState.phase,
        seconds: pvpState.seconds,
        poolTon: pvpState.poolTon,
        poolGift: pvpState.poolGift,
        participants: pvpState.participants.map(p => ({
            id: p.id,
            name: p.name,
            avatar: p.avatar,
            betCurrency: p.bet_currency,
            betAmount: p.bet_amount,
            participationPercent: p.participation_percent,
            status: p.status,
            multiplier: p.cashout_multiplier
        })),
        serverTime: Date.now(),
        maxPlayers: MAX_PVP_PLAYERS
    };
}

function buildPlayerName(user) {
    return (user.first_name + ' ' + (user.last_name || '')).trim() || 'Unknown';
}

async function refreshPvpParticipants() {
    if (!pvpState.roundId) return;
    const data = await getPvpRoundWithParticipants(pvpState.roundId);
    if (!data) return;
    pvpState.participants = data.participants.map(p => ({
        ...p,
        name: buildPlayerName(p),
        avatar: p.telegram_id ? `https://t.me/i/userpic/${p.telegram_id}.jpg` : '',
        participation_percent: calculatePercent(p.bet_amount, data.participants.reduce((s, x) => s + x.bet_amount, 0))
    }));
    pvpState.poolTon = data.participants
        .filter(p => p.bet_currency === 'TON')
        .reduce((s, p) => s + parseFloat(p.bet_amount), 0);
    pvpState.poolGift = data.participants
        .filter(p => p.bet_currency === 'GIFT')
        .reduce((s, p) => s + parseFloat(p.bet_amount), 0);
}

function calculatePercent(contrib, total) {
    return total > 0 ? parseFloat((contrib / total * 100).toFixed(2)) : 0;
}

async function startPvpRound() {
    if (pvpRoundTransitionTimer) clearTimeout(pvpRoundTransitionTimer);
    pvpRoundTransitionTimer = null;

    const nextRound = await getLastPvpRoundNumber() + 1;
    const round = await createPvpRound(nextRound);

    pvpState = {
        roundId: round.id,
        roundNumber: round.round_number,
        phase: 'WAITING',
        seconds: PVP_COUNTDOWN_SECONDS,
        serverSeedHash: round.server_seed_hash,
        serverSeed: round.server_seed,
        crashAt: round.crash_at,
        poolTon: 0,
        poolGift: 0,
        participants: [],
        lastWinnerUserId: null
    };
    console.log(`🎮 PvP Round ${round.round_number} created (WAITING)`);
}

async function triggerPvpCountdown() {
    if (!pvpState.roundId) return;
    const round = await startPvpCountdown(pvpState.roundId);
    pvpState.phase = 'COUNTDOWN';
    pvpState.seconds = PVP_COUNTDOWN_SECONDS;
    console.log(`⏰ PvP Round ${pvpState.roundNumber} COUNTDOWN started (${PVP_COUNTDOWN_SECONDS}s)`);
}

async function launchPvpRound() {
    if (pvpState.phase !== 'COUNTDOWN') return;
    const data = await getPvpRoundWithParticipants(pvpState.roundId);
    if (!data || data.participants.length === 0) {
        console.log(`🎮 PvP Round ${pvpState.roundNumber} cancelled (no players)`);
        await startPvpRound();
        await triggerPvpCountdown();
        return;
    }
    await refreshPvpParticipants();
    pvpState.phase = 'LIVE';
    console.log(`🔥 PvP Round ${pvpState.roundNumber} LIVE with ${pvpState.participants.length} players`);
}

async function settlePvpRound() {
    if (pvpState.phase !== 'LIVE' || !pvpState.roundId) return;
    try {
        const result = await crashPvpRound(pvpState.roundId);
        pvpState.phase = 'RESULT';
        pvpState.lastWinnerUserId = result.winnerUserId;
        pvpState.crashAt = result.crashAt;
        console.log(`💥 PvP Round ${pvpState.roundNumber} crashed at ${result.crashAt}x`);
        await startPvpRound();
        await triggerPvpCountdown();
    } catch (error) {
        console.error('PvP round settlement error:', error.message);
    }
}

async function startPvpGameLoop() {
    if (pvpGameLoopTimer) return pvpGameLoopTimer;
    pvpGameLoopTimer = setInterval(async () => {
        if (pvpBusy) return;
        pvpBusy = true;
        try {
            if (pvpState.phase === 'WAITING') {
                const participants = await getPvpRoundWithParticipants(pvpState.roundId);
                if (participants && participants.participants.length >= 1) {
                    await triggerPvpCountdown();
                }
            } else if (pvpState.phase === 'COUNTDOWN') {
                pvpState.seconds--;
                if (pvpState.seconds <= 0) {
                    await launchPvpRound();
                }
            } else if (pvpState.phase === 'LIVE') {
                pvpState.seconds--;
                if (pvpState.seconds <= -15) {
                    await settlePvpRound();
                }
            }
        } catch (error) {
            console.error('PvP game loop error:', error);
        } finally {
            pvpBusy = false;
        }
    }, 1000);
    await startPvpRound();
    await triggerPvpCountdown();
    return pvpGameLoopTimer;
}

function stopPvpGameLoop() {
    if (pvpGameLoopTimer) clearInterval(pvpGameLoopTimer);
    if (pvpRoundTransitionTimer) clearTimeout(pvpRoundTransitionTimer);
    pvpGameLoopTimer = null;
    pvpRoundTransitionTimer = null;
}

// =========================================================
// 5. API Routes
// =========================================================

// ===== 5.1 المصادقة =====
app.post('/api/auth', async (req, res) => {
    try {
        const { initData } = req.body;
        
        if (!initData) {
            console.error('🔐 Auth rejected: missing Telegram initData');
            return res.status(400).json({ ok: false, error: 'initData required' });
        }

        if (!verifyTelegramData(initData)) {
            const p = new URLSearchParams(initData);
            let debugUserId = null;
            try { debugUserId = JSON.parse(p.get('user') || '{}').id || null; } catch {}
            console.error('🔐 Auth rejected: invalid Telegram signature', {
                hasHash: Boolean(p.get('hash')),
                hasUser: Boolean(p.get('user')),
                userId: debugUserId
            });
            return res.status(401).json({ ok: false, error: 'Invalid Telegram data' });
        }

        const params = new URLSearchParams(initData);
        const userData = JSON.parse(params.get('user'));
        const startParam = params.get('start_param') || params.get('startapp') || '';
        console.log('🔐 Telegram player authenticated', {
            telegramId: String(userData.id),
            username: userData.username || null,
            hasReferralStartParam: /^ref_r\d+$/.test(startParam)
        });
        
        const user = await findOrCreateUser(userData.id, {
            username: userData.username,
            first_name: userData.first_name,
            last_name: userData.last_name,
            avatar_url: userData.photo_url
        });

        if (/^ref_r\d+$/.test(startParam)) {
            try { await attachReferralToUser(user.id, startParam.slice(4)); }
            catch (referralError) { console.error('Referral attach failed:', referralError.message); }
        }

        // Keep the Telegram identity metadata current for identity reconciliation.
        await run(
            'UPDATE users SET init_data = ?, username = ?, first_name = ?, last_name = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [initData, userData.username || null, userData.first_name || null, userData.last_name || null, userData.photo_url || null, user.id]
        );

        res.json({ 
            ok: true, 
            user: {
                id: user.id,
                telegram_id: user.telegram_id,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                avatar_url: user.avatar_url,
                balance: user.balance,
                total_turnover: Number(user.total_turnover || 0)
            },
            token: user.id 
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.2 جلب حالة اللعبة =====
app.get('/api/game/state', authenticate, async (req, res) => {
    try {
        res.json({ ok: true, state: getGameStateSnapshot() });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.2.1 بث حالة اللعبة عبر SSE =====
app.get('/api/game-stream', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).end();

    try {
        const user = await get('SELECT id FROM users WHERE id = ?', [token]);
        if (!user) return res.status(401).end();
    } catch (error) {
        return res.status(500).end();
    }

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    const sendState = () => {
        res.write(`event: game-state\ndata: ${JSON.stringify(getGameStateSnapshot())}\n\n`);
    };
    sendState();
    const streamTimer = setInterval(sendState, 250);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

    req.on('close', () => {
        clearInterval(streamTimer);
        clearInterval(heartbeat);
    });
});

// =========================================================
// 5.2.2 PvP Game State SSE
// =========================================================

app.get('/api/pvp-stream', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).end();
    try {
        const user = await get('SELECT id FROM users WHERE id = ?', [token]);
        if (!user) return res.status(401).end();
    } catch (error) {
        return res.status(500).end();
    }

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    const sendState = () => {
        res.write(`event: pvp-state\ndata: ${JSON.stringify(getPvpStateSnapshot())}\n\n`);
    };
    sendState();
    const streamTimer = setInterval(sendState, 500);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

    req.on('close', () => {
        clearInterval(streamTimer);
        clearInterval(heartbeat);
    });
});

// ===== 5.3 PvP API =====
app.get('/api/pvp/state', authenticate, async (req, res) => {
    try {
        res.json({ ok: true, state: getPvpStateSnapshot() });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/pvp/join', authenticate, async (req, res) => {
    try {
        const { betCurrency, betAmount, giftUniqueId } = req.body;
        const result = await joinPvpRound(req.user.id, betCurrency || 'TON', betAmount, giftUniqueId || null);
        if (result.betCurrency === 'TON') {
            await refreshPvpParticipants();
        }
        res.json({ ok: true, ...result });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/pvp/cashout', authenticate, async (req, res) => {
    try {
        const { participantId } = req.body;
        const result = await cashoutPvpBet(participantId, req.user.id);
        res.json({ ok: true, ...result });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.3 جلب هدايا المستخدم =====
app.get('/api/gifts', authenticate, async (req, res) => {
    try {
        const gifts = await getUserGifts(req.user.id);
        res.json({ ok: true, gifts });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

function parseCollectibleMetadata(row) {
    try {
        return row?.verified_metadata ? JSON.parse(row.verified_metadata) : {};
    } catch {
        return {};
    }
}

function buildCollectibleApiRow(row, req) {
    const metadata = parseCollectibleMetadata(row);
    const isPendingGiftReward = !row.unique_collectible_id &&
        row.loot_box_reward === 1 &&
        (row.ownership_status === 'WON' || row.ownership_status === 'OWNED');
    const model = isPendingGiftReward ? {} : (metadata.model || {});
    const symbol = isPendingGiftReward ? null : (metadata.symbol || null);
    const backdrop = isPendingGiftReward ? null : (metadata.backdrop || null);
    const mediaFileId = isPendingGiftReward
        ? null
        : (metadata.stickerThumbnailFileId || metadata.stickerFileId || row.telegram_thumbnail_file_id || null);
    const hasMedia = !!(mediaFileId || metadata.model?.stickerFileId || metadata.symbol?.stickerFileId || (isPendingGiftReward && row.image_url));
    const genericGiftImage = row.name
        ? 'https://cdn.changes.tg/gifts/models/' + encodeURIComponent(String(row.name)) + '/png/Original.png'
        : null;
    const imageUrl = isPendingGiftReward
        ? (genericGiftImage || row.image_url || null)
        : (row.unique_collectible_id && hasMedia
            ? `/api/collectible-media/${encodeURIComponent(row.unique_collectible_id)}`
            : null);
    return {
        id: row.unique_collectible_id || `pending:${row.user_gift_id}`,
        userGiftId: row.user_gift_id,
        pendingWithdrawal: isPendingGiftReward,
        lootBoxReward: isPendingGiftReward,
        lootBoxLocked: isLootBoxGiftLocked(row),
        lootBoxLockedUntil: row.loot_box_locked_until || null,
        name: row.name || metadata.uniqueName || metadata.baseName || 'Telegram Gift',
        baseName: isPendingGiftReward ? (row.name || null) : (metadata.baseName || row.name || null),
        uniqueName: isPendingGiftReward ? null : (metadata.uniqueName || row.name || null),
        collectibleNumber: isPendingGiftReward ? null : (row.collectible_number ?? metadata.collectibleNumber ?? null),
        model: isPendingGiftReward ? null : (model.name || null),
        modelRarity: isPendingGiftReward ? null : (model.rarity || null),
        modelRarityPerMille: isPendingGiftReward ? null : (model.rarityPerMille ?? null),
        symbol: isPendingGiftReward ? null : (symbol?.name || null),
        symbolRarityPerMille: isPendingGiftReward ? null : (symbol?.rarityPerMille ?? null),
        backdrop: isPendingGiftReward ? null : (backdrop?.name || null),
        backdropRarityPerMille: isPendingGiftReward ? null : (backdrop?.rarityPerMille ?? null),
        backdropColors: isPendingGiftReward ? null : (backdrop?.colors || null),
        sender: isPendingGiftReward ? null : (metadata.sender || null),
        sendDate: isPendingGiftReward ? null : (metadata.sendDate || null),
        sendDateIso: isPendingGiftReward ? null : (metadata.sendDateIso || null),
        ownedGiftId: isPendingGiftReward ? null : (metadata.ownedGiftId || row.telegram_gift_instance_id || null),
        isPremium: isPendingGiftReward ? false : !!metadata.isPremium,
        isFromBlockchain: isPendingGiftReward ? false : !!metadata.isFromBlockchain,
        canBeTransferred: isPendingGiftReward ? true : !!metadata.canBeTransferred,
        transferStarCount: isPendingGiftReward ? null : (metadata.transferStarCount ?? null),
        nextTransferDate: isPendingGiftReward ? null : (metadata.nextTransferDate ?? null),
        nextTransferDateIso: isPendingGiftReward ? null : (metadata.nextTransferDateIso || null),
        stickerIsAnimated: isPendingGiftReward ? false : !!model.stickerIsAnimated,
        stickerIsVideo: isPendingGiftReward ? false : !!model.stickerIsVideo,
        imageUrl,
        rarity: row.rarity || model.rarity || 'common',
        value: Number(row.collectible_market_value ?? row.market_value ?? row.value ?? 0),
        sellValue: Number((Number(row.collectible_market_value ?? row.market_value ?? row.value ?? 0) * Number(process.env.COLLECTIBLE_SELL_RATE || '0.89')).toFixed(2)),
        status: row.ownership_status,
        verifiedMetadata: isPendingGiftReward ? null : row.verified_metadata,
        receivedAt: row.received_at
    };
}

// ===== 5.3.1 جلب مقتنيات Telegram الحقيقية الموثّقة فقط (Phase 3A/3B) =====
app.get('/api/collectibles', authenticate, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    try {
        try {
            await runCollectibleVerificationSweep();
        } catch (sweepErr) {
            // Sweep failure logged silently so user can still view already verified collectibles
            console.error('Sweep error on GET /api/collectibles:', sweepErr.message);
        }

        const rows = await getUserCollectibles(req.user.id);
        const collectibles = rows
            .filter(row =>
                (row.ownership_verified === 1 && row.unique_collectible_id) ||
                ((row.loot_box_reward === 1) && (row.ownership_status === 'WON' || row.ownership_status === 'OWNED') && !row.unique_collectible_id)
            )
            .map(row => buildCollectibleApiRow(row, req));
        res.json({ ok: true, collectibles });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Alias for frontend compatibility — identical to GET /api/collectibles, authenticated and user-isolated.
app.get('/api/collectibles/portfolio', authenticate, async (req, res) => {
    try {
        try {
            await runCollectibleVerificationSweep();
        } catch (sweepErr) {
            console.error('Sweep error on GET /api/collectibles/portfolio:', sweepErr.message);
        }

        const rows = await getUserCollectibles(req.user.id);
        const collectibles = rows
            .filter(row => row.ownership_verified === 1 && row.unique_collectible_id)
            .map(row => buildCollectibleApiRow(row, req));
        res.json({ ok: true, collectibles });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});
// المُدخل الوحيد المقبول هو unique_collectible_id (نفس المعرّف العلني المستخدم في الرهان)،
// ويُتحقق أنه ينتمي فعلًا لقطعة verified في قاعدتنا قبل أي اتصال بـ Telegram. لا يُكشف BOT_TOKEN أبداً.
// Fragment exposes a public WebP for minted Telegram collectibles using the same
// UniqueGift name/number slug. Prefer this exact rendered collectible image when available;
// keep Telegram Bot API media as a fallback. This is isolated to collectible media only.
const fragmentCollectibleCache = new Map();
const MAX_FRAGMENT_CACHE = 48;

function fragmentGiftSlug(metadata) {
    const name = metadata?.uniqueName;
    const number = metadata?.collectibleNumber;
    if (!name || !Number.isFinite(Number(number))) return null;
    return `${String(name).toLowerCase()}-${Number(number)}`;
}

async function fetchFragmentCollectibleImage(metadata) {
    const slug = fragmentGiftSlug(metadata);
    if (!slug) return null;
    const cached = fragmentCollectibleCache.get(slug);
    if (cached) return cached;
    return new Promise(resolve => {
        const req = https.request({
            hostname: 'nft.fragment.com',
            path: `/gift/${encodeURIComponent(slug)}.webp`,
            method: 'GET',
            headers: { 'User-Agent': 'CrazyRocketBot/2.0 collectible-media' }
        }, response => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
                response.resume();
                resolve(null);
                return;
            }
            const contentType = String(response.headers['content-type'] || '').toLowerCase();
            if (!contentType.includes('image/')) {
                response.resume();
                resolve(null);
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size <= 8 * 1024 * 1024) chunks.push(chunk);
            });
            response.on('end', () => {
                if (size > 8 * 1024 * 1024) return resolve(null);
                const buffer = Buffer.concat(chunks);
                cacheSet(fragmentCollectibleCache, slug, buffer, MAX_FRAGMENT_CACHE);
                resolve(buffer);
            });
            response.on('error', () => resolve(null));
        });
        req.setTimeout(12000, () => req.destroy());
        req.on('error', () => resolve(null));
        req.end();
    });
}

const collectibleRenderCache = new Map();
const stickerBufferCache = new Map();
const MAX_RENDER_CACHE = 48;
const MAX_STICKER_CACHE = 64;

function cacheSet(map, key, value, max) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
}

function colorHex(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 0xFFFFFF ? '#' + Math.round(n).toString(16).padStart(6, '0') : fallback;
}

function backdropSvg(colors) {
    const center = colorHex(colors?.center_color, '#6b55e8');
    const edge = colorHex(colors?.edge_color, '#20183f');
    const symbol = colorHex(colors?.symbol_color, '#ffffff');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><radialGradient id="g"><stop offset="0" stop-color="${center}"/><stop offset="1" stop-color="${edge}"/></radialGradient></defs><rect width="640" height="640" rx="64" fill="url(#g)"/><circle cx="320" cy="270" r="250" fill="${symbol}" opacity=".08"/></svg>`;
}

async function downloadTelegramMedia(filePath) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname: 'api.telegram.org', path: `/file/bot${BOT_TOKEN}/${filePath}`, method: 'GET' }, response => {
            if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); reject(new Error(`Telegram media HTTP ${response.statusCode}`)); return; }
            const chunks = []; let size = 0;
            response.on('data', chunk => { size += chunk.length; if (size <= 20 * 1024 * 1024) chunks.push(chunk); });
            response.on('end', () => size <= 20 * 1024 * 1024 ? resolve(Buffer.concat(chunks)) : reject(new Error('Telegram media exceeds renderer limit')));
        });
        req.setTimeout(15000, () => req.destroy(new Error('Telegram media timeout')));
        req.on('error', reject); req.end();
    });
}

async function getStickerPng(sticker) {
    const sharp = getSharpRenderer();
    if (!sharp || !sticker) return null;
    const ids = [sticker.thumbnailFileId, sticker.fileId].filter(Boolean);
    for (const fileId of [...new Set(ids)]) {
        try {
            let buffer = stickerBufferCache.get(fileId);
            if (!buffer) { buffer = await downloadTelegramMedia(await resolveTelegramFilePath(fileId)); cacheSet(stickerBufferCache, fileId, buffer, MAX_STICKER_CACHE); }
            return await sharp(buffer).ensureAlpha().png().toBuffer();
        } catch (error) { console.warn('Collectible sticker render fallback:', error.message); }
    }
    return null;
}

async function renderCollectibleImage(id, metadata) {
    const cached = collectibleRenderCache.get(id);
    if (cached) return cached;

    // Exact rendered collectible image first. This matches the visual Telegram/Fragment card
    // rather than attempting to reconstruct the artwork from separate model/symbol stickers.
    const fragmentImage = await fetchFragmentCollectibleImage(metadata);
    if (fragmentImage) {
        cacheSet(collectibleRenderCache, id, fragmentImage, MAX_RENDER_CACHE);
        return fragmentImage;
    }

    const sharp = getSharpRenderer();
    if (!sharp) throw new Error('sharp unavailable');
    const model = metadata?.model || {};
    const symbol = metadata?.symbol || {};
    const [modelPng, symbolPng] = await Promise.all([
        getStickerPng({ fileId: model.stickerFileId, thumbnailFileId: model.stickerThumbnailFileId }),
        getStickerPng({ fileId: symbol.stickerFileId, thumbnailFileId: symbol.stickerThumbnailFileId })
    ]);
    if (!modelPng && !symbolPng) throw new Error('No renderable Telegram collectible media');
    const layers = [];
    if (modelPng) layers.push({ input: await sharp(modelPng).resize(500, 500, { fit: 'contain' }).png().toBuffer(), left: 70, top: 55 });
    if (symbolPng) layers.push({ input: await sharp(symbolPng).resize(210, 210, { fit: 'contain' }).png().toBuffer(), left: 215, top: 215 });
    const output = await sharp(Buffer.from(backdropSvg(metadata?.backdrop?.colors || {}))).composite(layers).webp({ quality: 92 }).toBuffer();
    cacheSet(collectibleRenderCache, id, output, MAX_RENDER_CACHE);
    return output;
}

app.get('/api/collectible-media/:uniqueCollectibleId', async (req, res) => {
    try {
        const collectible = await getCollectibleByUniqueId(req.params.uniqueCollectibleId);
        if (!collectible || collectible.ownership_verified !== 1) return res.status(404).end();
        let metadata = null;
        try { metadata = collectible.verified_metadata ? JSON.parse(collectible.verified_metadata) : null; } catch {}
        if (!metadata) return res.status(404).end();
        const output = await renderCollectibleImage(req.params.uniqueCollectibleId, metadata);
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
        res.setHeader('X-Collectible-Media', 'rendered');
        res.end(output);
    } catch (error) {
        console.error('collectible-media render failed:', error.message);
        if (!res.headersSent) res.status(502).end();
    }
});

// ===== 5.3.2 إنشاء intent استيراد قصير العمر (لا يمنح ملكية) =====
app.post('/api/collectibles/import-intent', authenticate, async (req, res) => {
    try {
        const intent = await createOrGetImportIntent(req.user.id);
        res.json({
            ok: true,
            intentId: intent.intent_token,
            expiresAt: intent.expires_at
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.3.3 حالة التحقق الحقيقي من Telegram (Phase 3B) — لا تمنح ملكية أبداً من هنا =====
app.get('/api/collectibles/verification-status', authenticate, async (req, res) => {
    try {
        if (!TELEGRAM_BUSINESS_CONNECTION_ID && !runtimeBusinessConnection.id) {
            res.json({ ok: true, configured: false, status: 'not_configured' });
            return;
        }

        try {
            await runCollectibleVerificationSweep();
        } catch (sweepError) {
            console.error('Collectible verification sweep failed:', sweepError.message);
            res.json({ ok: true, configured: true, status: 'error' });
            return;
        }

        const intent = await getLatestImportIntentForUser(req.user.id);
        if (!intent) { res.json({ ok: true, configured: true, status: 'none' }); return; }
        if (intent.status === 'CONSUMED') { res.json({ ok: true, configured: true, status: 'verified' }); return; }
        if (intent.status === 'PENDING' && new Date(intent.expires_at) > new Date()) {
            res.json({ ok: true, configured: true, status: 'pending' });
            return;
        }
        res.json({ ok: true, configured: true, status: 'expired' });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.3.x بثّ Backpack الحي عبر SSE (collectible-credited فقط — لا يكشف أسرار/ملفات/ـpayload) =====
app.get('/api/collectibles-stream', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).end();
    try {
        const user = await get('SELECT id FROM users WHERE id = ?', [token]);
        if (!user) return res.status(401).end();
        const userId = Number(user.id);

        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        registerCollectibleClient(userId, res);

        res.write(': connected\n\n'); // comment يحافظ الاتصال دافئاً وينشئ إشارة فتح
        const heartbeat = setInterval(() => {
            if (!res.writableEnded) res.write(': heartbeat\n\n');
        }, 15000);

        req.on('close', () => {
            clearInterval(heartbeat);
            unregisterCollectibleClient(userId, res);
            if (!res.writableEnded) res.end();
        });
        req.on('error', () => {
            clearInterval(heartbeat);
            unregisterCollectibleClient(userId, res);
            if (!res.writableEnded) res.end();
        });
    } catch (error) {
        if (!res.headersSent) res.status(500).end();
    }
});

// ===== 5.3.4 حالة اتصال Business (محمي/إداري فقط) — لا يكشف قيمة business_connection_id أبداً =====
app.get('/api/admin/business-connection-status', authenticate, async (req, res) => {
    if (!ADMIN_TELEGRAM_ID || req.user.telegram_id !== ADMIN_TELEGRAM_ID) {
         res.status(403).json({ ok: false, error: 'Forbidden' });
         return;
    }
    res.json({
        ok: true,
        envConfigured: !!TELEGRAM_BUSINESS_CONNECTION_ID,
        runtimeDiscovered: !!runtimeBusinessConnection.id,
        businessUserId: runtimeBusinessConnection.businessUserId,
        canViewGiftsAndStars: runtimeBusinessConnection.canViewGiftsAndStars,
        canTransferAndUpgradeGifts: runtimeBusinessConnection.canTransferAndUpgradeGifts,
        isEnabled: runtimeBusinessConnection.isEnabled,
        updatedAt: runtimeBusinessConnection.updatedAt
    });
});

// ===== 5.3.4.1 إعادة جلب صلاحيات الاتصال من Telegram (محمي/إداري) — لا يكشف أي معرّف =====
// يُستخدم عند تغيير الصلاحيات (مثل تفعيل View Gifts and Stars) دون الحاجة لفصل/إعادة ربط البوت.
app.post('/api/admin/refresh-business-connection', authenticate, async (req, res) => {
    if (!ADMIN_TELEGRAM_ID || req.user.telegram_id !== ADMIN_TELEGRAM_ID) {
         res.status(403).json({ ok: false, error: 'Forbidden' });
         return;
    }
    try {
        const persisted = await getPersistedBusinessConnection();
        const connectionId = TELEGRAM_BUSINESS_CONNECTION_ID
            || runtimeBusinessConnection.id
            || (persisted ? persisted.connection_id : null);
        if (!connectionId) {
            res.status(409).json({ ok: false, error: 'No known business connection to refresh' });
            return;
        }

        const refreshed = await recoverBusinessConnectionById(connectionId);
        res.json({
            ok: true,
            runtimeDiscovered: !!refreshed.id,
            canViewGiftsAndStars: refreshed.canViewGiftsAndStars,
            isEnabled: refreshed.isEnabled,
            updatedAt: refreshed.updatedAt
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.3.5 إعداد Telegram webhook (محمي/إداري فقط) — لا يكشف BOT_TOKEN أبداً =====
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || 'https://my-rocket-production-150d.up.railway.app/telegram-webhook';
// business_connection is NOT delivered by Telegram's default allowed_updates, so it must be
// requested explicitly or the webhook never receives the connection at all.
// Empty allowed_updates means Telegram delivers all supported update types.
// This is intentional for Business mode so a connection update cannot be lost because of a stale subscription.
const TELEGRAM_ALLOWED_UPDATES = [];

async function ensureTelegramWebhookConfigured() {
    if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') return false;
    const info = await callTelegramBotApi('getWebhookInfo', {});
    const currentAllowed = Array.isArray(info.allowed_updates) ? info.allowed_updates : [];
    const allowedUpdatesMatch = TELEGRAM_ALLOWED_UPDATES.length === 0
        ? currentAllowed.length === 0
        : TELEGRAM_ALLOWED_UPDATES.every(type => currentAllowed.includes(type))
            && currentAllowed.length === TELEGRAM_ALLOWED_UPDATES.length;
    const urlMatches = info.url === TELEGRAM_WEBHOOK_URL;
    if (!urlMatches || !allowedUpdatesMatch || TELEGRAM_WEBHOOK_SECRET) {
        const payload = { url: TELEGRAM_WEBHOOK_URL, allowed_updates: TELEGRAM_ALLOWED_UPDATES };
        if (TELEGRAM_WEBHOOK_SECRET) payload.secret_token = TELEGRAM_WEBHOOK_SECRET;
        await callTelegramBotApi('setWebhook', payload);
        console.log('🔗 Telegram webhook configuration ensured:', JSON.stringify({
            urlMatches: true, allUpdatesEnabled: TELEGRAM_ALLOWED_UPDATES.length === 0,
            businessConnectionAllowed: true, secretConfigured: !!TELEGRAM_WEBHOOK_SECRET
        }));
        return true;
    }
    console.log('🔗 Telegram webhook configuration already correct:', JSON.stringify({
        urlMatches, businessConnectionAllowed: true, secretConfigured: !!TELEGRAM_WEBHOOK_SECRET
    }));
    return true;
}

app.post('/api/admin/setup-telegram-webhook', authenticate, async (req, res) => {
    if (!ADMIN_TELEGRAM_ID || req.user.telegram_id !== ADMIN_TELEGRAM_ID) {
         res.status(403).json({ ok: false, error: 'Forbidden' });
         return;
    }
    try {
        const payload = { url: TELEGRAM_WEBHOOK_URL, allowed_updates: TELEGRAM_ALLOWED_UPDATES };
        if (TELEGRAM_WEBHOOK_SECRET) payload.secret_token = TELEGRAM_WEBHOOK_SECRET;
        await callTelegramBotApi('setWebhook', payload);
        res.json({
            ok: true,
            success: true,
            url: TELEGRAM_WEBHOOK_URL,
            allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
            secretConfigured: !!TELEGRAM_WEBHOOK_SECRET
        });
    } catch (error) {
        // callTelegramBotApi never includes BOT_TOKEN in its error messages.
        res.status(400).json({ ok: false, success: false, error: error.message });
    }
});

app.get('/api/admin/telegram-webhook-status', authenticate, async (req, res) => {
    if (!ADMIN_TELEGRAM_ID || req.user.telegram_id !== ADMIN_TELEGRAM_ID) {
         res.status(403).json({ ok: false, error: 'Forbidden' });
         return;
    }
    try {
        const info = await callTelegramBotApi('getWebhookInfo', {});
        res.json({
            ok: true,
            hasUrl: !!info.url,
            expectedUrl: TELEGRAM_WEBHOOK_URL,
            urlMatches: info.url === TELEGRAM_WEBHOOK_URL,
            allowedUpdates: info.allowed_updates || [],
            businessConnectionAllowed: Array.isArray(info.allowed_updates)
                ? info.allowed_updates.includes('business_connection')
                : false,
            pendingUpdateCount: info.pending_update_count,
            lastErrorMessage: info.last_error_message || null,
            hasCustomCertificate: !!info.has_custom_certificate
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.4 جلب رصيد المستخدم =====
app.get('/api/balance', authenticate, async (req, res) => {
    try {
        // The real TON balance is the single spendable balance used by every
        // paid loot box and game action. Never allow a cached browser response
        // to make the client believe it has an older balance.
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        const balance = await getUserBalance(req.user.id);
        const response = { ok: true, balance };
        if (ENABLE_TEST_BALANCE) {
            response.test_balance = await getUserTestBalance(req.user.id);
            response.testBalanceEnabled = true;
        } else {
            response.test_balance = 0;
            response.testBalanceEnabled = false;
        }
        res.json(response);
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.4b إدارة رصيد الاختبار (TEST BALANCE) — ADMIN ONLY =====
// This endpoint is server-authoritative and never exposed to non-admins.
// Test balance is completely isolated from real TON balance and collectibles.
app.post('/api/admin/test-balance', authenticate, async (req, res) => {
    if (!ADMIN_TELEGRAM_ID || req.user.telegram_id !== ADMIN_TELEGRAM_ID) {
        return res.status(403).json({ ok: false, error: 'Admin access required' });
    }

    if (!ENABLE_TEST_BALANCE) {
        return res.status(503).json({ ok: false, error: 'Test balance is not enabled. Set ENABLE_TEST_BALANCE=true to use this feature.' });
    }

    try {
        const { action, amount, targetUserId } = req.body;

        if (action === 'add') {
            const targetId = targetUserId || req.user.id;
            const testAmount = Number(amount) || 0;
            if (testAmount <= 0 || testAmount > 1000000) {
                return res.status(400).json({ ok: false, error: 'Invalid test amount. Must be between 1 and 1000000 TEST.' });
            }
            const testBalance = await setTestBalance(targetId, testAmount);
            const realBalance = await getUserBalance(targetId);
            res.json({
                ok: true,
                action: 'add',
                test_balance: testBalance,
                real_balance: realBalance,
                message: 'TEST balance added — not withdrawable, not convertible to TON'
            });
        } else if (action === 'reset') {
            const targetId = targetUserId || req.user.id;
            const testBalance = await resetTestBalance(targetId);
            const realBalance = await getUserBalance(targetId);
            res.json({
                ok: true,
                action: 'reset',
                test_balance: testBalance,
                real_balance: realBalance,
                message: 'TEST balance reset to 0 — real balance unaffected'
            });
        } else if (action === 'set') {
            const targetId = targetUserId || req.user.id;
            const testAmount = Number(amount) || 0;
            const testBalance = await setTestBalance(targetId, testAmount);
            const realBalance = await getUserBalance(targetId);
            res.json({
                ok: true,
                action: 'set',
                test_balance: testBalance,
                real_balance: realBalance
            });
        } else {
            return res.status(400).json({ ok: false, error: 'Action must be "add", "reset", or "set"' });
        }
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// GET endpoint for frontend to check test balance status (admin-only read).
app.get('/api/admin/test-balance/:userId?', authenticate, async (req, res) => {
    if (!ADMIN_TELEGRAM_ID || req.user.telegram_id !== ADMIN_TELEGRAM_ID) {
        return res.status(403).json({ ok: false, error: 'Admin access required' });
    }

    if (!ENABLE_TEST_BALANCE) {
        return res.status(503).json({ ok: false, error: 'Test balance is not enabled' });
    }

    try {
        const targetId = req.params.userId ? Number(req.params.userId) : req.user.id;
        const realBalance = await getUserBalance(targetId);
        const testBalance = await getUserTestBalance(targetId);
        res.json({
            ok: true,
            real_balance: realBalance,
            test_balance: testBalance,
            enabled: true
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.4c Get test balance for current user (read-only, test mode only) =====
app.get('/api/test/balance', authenticate, async (req, res) => {
    if (!ENABLE_TEST_BALANCE) {
        return res.status(503).json({ ok: false, error: 'Test balance is not enabled' });
    }
    try {
        const testBalance = await getUserTestBalance(req.user.id);
        res.json({ ok: true, test_balance: testBalance, isTest: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.5 الرهان بالهدية =====
app.post('/api/bet/gift', authenticate, async (req, res) => {
    try {
        const { giftId, autoCashoutTarget } = req.body;
        if (!giftId) return res.status(400).json({ ok: false, error: 'giftId required' });
        const roundId = currentGameState.phase === 'FLIGHT' ? currentGameState.roundId + 1 : currentGameState.roundId;
        if (currentGameState.phase !== 'COUNTDOWN' && currentGameState.phase !== 'FLIGHT') {
            return res.status(400).json({ ok: false, error: 'Betting only allowed during COUNTDOWN or FLIGHT' });
        }
        const rewardGift = await get('SELECT ug.* FROM user_gifts ug WHERE ug.user_id = ? AND (ug.id = ? OR ug.unique_collectible_id = ?) AND ug.status IN (\'OWNED\', \'WON\') ORDER BY ug.id DESC LIMIT 1', [req.user.id, giftId, giftId]);
        if (rewardGift && isLootBoxGiftLocked(rewardGift)) return res.status(423).json({ ok: false, error: 'This loot-box gift is locked for 7 days', lockedUntil: rewardGift.loot_box_locked_until });
        const queued = currentGameState.phase === 'FLIGHT';
        const result = queued ? await queueGiftBet(req.user.id, giftId, roundId, autoCashoutTarget) : await placeGiftBet(req.user.id, giftId, roundId, autoCashoutTarget);
        await refreshRoundPlayers();
        res.json({ ok: true, queued, bet: result, roundId });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.6 سحب الهدية (Cash Out) =====
app.post('/api/cashout/gift', authenticate, async (req, res) => {
    try {
        const { betId } = req.body;
        
        if (!betId) {
            return res.status(400).json({ ok: false, error: 'betId required' });
        }

        // التحقق من أن الجولة في مرحلة FLIGHT
        if (currentGameState.phase !== 'FLIGHT') {
            return res.status(400).json({ ok: false, error: 'Cashout only allowed during FLIGHT' });
        }

        const multiplier = currentGameState.multiplier;
        const result = await cashoutBet('GIFT', betId, req.user.id, currentGameState.roundId, multiplier);
        const balance = await getUserBalance(req.user.id);
        await refreshRoundPlayers();
        
        if (result.collectibleConsumed) {
            await createNotification(
                req.user.id,
                'BET_WON',
                `Collectible bet paid ${Number(result.payout || 0).toFixed(2)} TON at ${Number(result.multiplier || 0).toFixed(2)}x`,
                { betId, multiplier: result.multiplier, payout: result.payout, collectibleId: result.originalCollectibleId }
            );
            return res.json({
                ok: true,
                payout: result.payout,
                multiplier: result.multiplier,
                giftValue: result.giftValue,
                collectibleConsumed: true,
                collectibleId: result.originalCollectibleId,
                message: result.message,
                balance
            });
        }

        if (result.collectibleReturned) {
            await createNotification(
                req.user.id,
                'BET_WON',
                'Collectible returned at low multiplier',
                { betId, multiplier: result.multiplier, collectibleId: result.originalCollectibleId }
            );
            return res.json({ 
                ok: true,
                payout: result.payout,
                multiplier: result.multiplier,
                giftValue: result.giftValue,
                collectibleReturned: true,
                collectibleId: result.originalCollectibleId,
                message: result.message,
                balance: balance
            });
        }

        if (result.rewardGranted) {
            await createNotification(
                req.user.id,
                'BET_WON',
                'Collectible prize granted!',
                { betId, multiplier: result.multiplier, rewardGiftType: result.rewardGiftType, rewardUserGiftId: result.rewardUserGiftId }
            );
            return res.json({ 
                ok: true,
                payout: result.payout,
                multiplier: result.multiplier,
                giftValue: result.giftValue,
                rewardGranted: true,
                rewardGiftType: result.rewardGiftType,
                rewardCollectibleId: result.rewardUserGiftId ? `pending:${result.rewardUserGiftId}` : null,
                message: result.message,
                balance: balance
            });
        }

        if (result.payoutPending) {
            await createNotification(
                req.user.id,
                'BET_WON',
                'Prize pending - admin review needed',
                { betId, multiplier: result.multiplier, collectibleId: result.originalCollectibleId }
            );
            return res.json({ 
                ok: true,
                payout: result.payout,
                multiplier: result.multiplier,
                giftValue: result.giftValue,
                payoutPending: true,
                collectibleId: result.originalCollectibleId,
                message: result.message,
                balance: balance
            });
        }

        // إنشاء إشعار
        await createNotification(
            req.user.id,
            'BET_WON',
            `You cashed out at ${result.multiplier.toFixed(2)}x`,
            { betId, payout: result.payout, multiplier: result.multiplier }
        );
        
        res.json({ 
            ok: true, 
            payout: result.payout, 
            multiplier: result.multiplier,
            giftValue: result.giftValue,
            balance: balance
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.6.1 قيمة السوق =====
app.get('/api/collectibles/market-value', authenticate, async (req, res) => {
    try {
        const { collectibleId } = req.query;
        if (!collectibleId) {
            return res.status(400).json({ ok: false, error: 'collectibleId required' });
        }
        const collectible = await getCollectibleByUniqueId(collectibleId);
        if (!collectible) {
            return res.status(404).json({ ok: false, error: 'Collectible not found' });
        }
        const metadata = parseCollectibleMetadata(collectible);
        const live = await refreshVerifiedCollectibleMarketValue({
            uniqueCollectibleId: collectible.unique_collectible_id,
            verifiedMetadata: collectible.verified_metadata,
            telegramGiftModel: {
                telegramGiftId: collectible.telegram_gift_id || metadata.telegramGiftId || metadata.baseName || collectible.name,
                slug: collectible.unique_collectible_id
            }
        }, collectible.user_gift_id);
        if (live) {
            return res.json({ ok: true, available: true, marketValue: { floorPriceTon: live.value, source: live.source, currency: live.currency, lastUpdated: live.fetchedAt } });
        }
        const gift = await get('SELECT * FROM gifts WHERE id = ?', [collectible.gift_id]);
        const marketValue = getCollectibleMarketValue({
            name: gift ? gift.name : null,
            base_name: gift ? gift.telegram_gift_id : null,
            model_name: gift ? gift.name : null
        });
        if (!marketValue) return res.json({ ok: true, available: false, reason: 'No market data available' });
        res.json({ ok: true, available: true, marketValue });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.6.2 مخزون المتجر =====
app.get('/api/inventory', authenticate, async (req, res) => {
    try {
        const invent = await getInventoryCollectibles('AVAILABLE');
        res.json({ ok: true, items: invent.map(item => ({
            uniqueCollectibleId: item.unique_collectible_id,
            marketValue: item.market_value,
            modelName: item.model_name,
            collectionName: item.collection_name,
            rarity: item.rarity,
            ownershipStatus: item.ownership_status
        })) });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.6.2.1 بيع المقتنى مقابل رصيد TON داخل اللعبة =====
app.post('/api/collectibles/sell', authenticate, async (req, res) => {
    try {
        const { collectibleId } = req.body || {};
        if (!collectibleId) {
            return res.status(400).json({ ok: false, error: 'collectibleId required' });
        }

        const collectible = await getCollectibleByUniqueId(collectibleId);
        if (!collectible || collectible.user_id !== req.user.id || collectible.ownership_verified !== 1) {
            return res.status(404).json({ ok: false, error: 'Collectible not found or not owned' });
        }
        if (collectible.ownership_status !== 'OWNED') {
            return res.status(409).json({ ok: false, error: 'Collectible is not available for sale' });
        }

        // Sale value is calculated from Telegram's latest server-side market value.
        // The client never supplies the amount, preventing price manipulation.
        const metadata = parseCollectibleMetadata(collectible);
        const live = await refreshVerifiedCollectibleMarketValue({
            uniqueCollectibleId: collectible.unique_collectible_id,
            verifiedMetadata: collectible.verified_metadata,
            telegramGiftModel: {
                telegramGiftId: collectible.telegram_gift_id || metadata.telegramGiftId || metadata.baseName || collectible.name,
                slug: collectible.unique_collectible_id
            }
        }, collectible.user_gift_id);
        const market = live
            ? { floorPriceTon: live.value, source: live.source }
            : getCollectibleMarketValue({
                name: collectible.name,
                base_name: collectible.telegram_gift_id,
                model_name: collectible.name
            });
        const marketValue = Number(market?.floorPriceTon ?? collectible.collectible_market_value ?? collectible.value ?? 0);
        const sellRate = Number(process.env.COLLECTIBLE_SELL_RATE || '0.89');
        if (!Number.isFinite(marketValue) || marketValue <= 0) {
            return res.status(409).json({ ok: false, error: 'No valid market value is available for this collectible' });
        }
        if (!Number.isFinite(sellRate) || sellRate <= 0 || sellRate > 1) {
            return res.status(503).json({ ok: false, error: 'Invalid collectible sale configuration' });
        }

        const saleValue = Number((marketValue * sellRate).toFixed(9));
        const result = await sellCollectibleForBalance(req.user.id, collectibleId, saleValue);

        await createNotification(
            req.user.id,
            'GIFT_SOLD',
            `Collectible sold for ${saleValue.toFixed(2)} TON`,
            { collectibleId, marketValue, saleValue }
        );

        res.json({
            ok: true,
            collectibleId,
            marketValue,
            sellRate,
            saleValue,
            balance: result.balance
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== Loot-box keep pending gift =====
app.post('/api/loot-box/gift/keep', authenticate, async (req, res) => {
    try {
        const userGiftId = Number(req.body?.userGiftId);
        if (!Number.isSafeInteger(userGiftId) || userGiftId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid loot-box gift' });
        }

        const reward = await get(
            `SELECT * FROM user_gifts WHERE id = ? AND user_id = ? AND status = 'WON' LIMIT 1`,
            [userGiftId, req.user.id]
        );
        if (!reward) {
            return res.status(404).json({ ok: false, error: 'Loot-box gift not found or already used' });
        }
        if (isLootBoxGiftLocked(reward)) {
            return res.status(423).json({ ok: false, error: 'This loot-box gift is locked for 7 days', lockedUntil: reward.loot_box_locked_until });
        }

        const gift = await get(
            `SELECT ug.id AS user_gift_id, g.name, COALESCE(ug.market_value, g.value) AS market_value
             FROM user_gifts ug
             JOIN gifts g ON ug.gift_id = g.id
             WHERE ug.id = ? AND ug.user_id = ?
             LIMIT 1`,
            [userGiftId, req.user.id]
        );

        res.json({
            ok: true,
            userGiftId,
            gift: gift || null
        });
    } catch (error) {
        console.error('Loot-box gift keep failed:', { userId: req.user?.id, userGiftId: req.body?.userGiftId, error: error.message });
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== Loot-box pending gift sale =====
app.post('/api/loot-box/gift/sell', authenticate, async (req, res) => {
    try {
        const userGiftId = Number(req.body?.userGiftId);
        if (!Number.isSafeInteger(userGiftId) || userGiftId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid loot-box gift' });
        }

        const reward = await get("SELECT ug.*, g.name, COALESCE(ug.market_value, g.value) AS value FROM user_gifts ug JOIN gifts g ON ug.gift_id = g.id WHERE ug.id = ? AND ug.user_id = ? AND ug.status = 'WON' LIMIT 1", [userGiftId, req.user.id]);
        if (!reward) return res.status(404).json({ ok: false, error: 'Loot-box gift not found or already used' });
        if (isLootBoxGiftLocked(reward)) return res.status(423).json({ ok: false, error: 'This loot-box gift is locked for 7 days', lockedUntil: reward.loot_box_locked_until });

        const baseValue = Number(reward.value || 0);
        const sellRate = Number(process.env.COLLECTIBLE_SELL_RATE || '0.89');
        if (!Number.isFinite(baseValue) || baseValue <= 0 || !Number.isFinite(sellRate) || sellRate <= 0 || sellRate > 1) {
            return res.status(409).json({ ok: false, error: 'No valid market value is available for this gift' });
        }

        const saleValue = Number((baseValue * sellRate).toFixed(9));
        const result = await sellLootBoxGiftForBalance(req.user.id, userGiftId, saleValue);
        await createNotification(
            req.user.id,
            'GIFT_SOLD',
            `Gift sold for ${saleValue.toFixed(2)} TON`,
            { userGiftId, giftName: reward.name, saleValue, source: 'paid-loot-box' }
        );

        res.json({ ok: true, userGiftId, giftName: reward.name, saleValue, balance: result.balance });
    } catch (error) {
        console.error('Loot-box gift sale failed:', { userId: req.user?.id, userGiftId: req.body?.userGiftId, error: error.message });
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.6.3 سحب هدية =====
app.post('/api/collectibles/withdraw', authenticate, async (req, res) => {
    try {
        const { collectibleId } = req.body || {};
        if (!collectibleId) return res.status(400).json({ ok: false, error: 'collectibleId required' });

        const userTelegramId = Number(req.user.telegram_id);
        if (!Number.isSafeInteger(userTelegramId) || userTelegramId <= 0) {
            return res.status(400).json({ ok: false, error: 'Your Telegram account ID could not be verified', reason: 'invalid_telegram_user' });
        }

        if (String(collectibleId).startsWith('pending:')) {
            const userGiftId = Number(String(collectibleId).slice('pending:'.length));
            if (!Number.isSafeInteger(userGiftId) || userGiftId <= 0) {
                return res.status(400).json({ ok: false, error: 'Invalid pending gift reward' });
            }

            const pendingReward = await get('SELECT * FROM user_gifts WHERE id = ? AND user_id = ? LIMIT 1', [userGiftId, req.user.id]);
            if (!pendingReward) return res.status(404).json({ ok: false, error: 'Gift reward not found' });
            if (isLootBoxGiftLocked(pendingReward)) return res.status(423).json({ ok: false, error: 'This loot-box gift is locked for 7 days', lockedUntil: pendingReward.loot_box_locked_until });

            const reserved = await reservePendingGiftForWithdrawal(req.user.id, userGiftId);
            let selectedUniqueId = null;
            try {
                const activeCollectibleIds = await getActiveCollectibleUniqueIds();
                const selected = await findBusinessGiftForType({
                    telegramGiftId: reserved.telegram_gift_id,
                    giftName: reserved.name,
                    excludedUniqueIds: activeCollectibleIds
                });
                if (!selected) {
                    await rollbackPendingGiftWithdrawal(req.user.id, userGiftId, 'No transferable collectible of this gift type is currently available in Account 2');
                    return res.status(409).json({
                        ok: false,
                        error: 'This gift is temporarily unavailable for withdrawal',
                        reason: 'gift_type_unavailable',
                        collectibleReturned: true
                    });
                }

                // Persist the selected concrete collectible BEFORE the external transfer.
                // This makes rollback safe if Telegram rejects the transfer.
                selectedUniqueId = String(selected?.gift?.name || selected?.gift?.title || '').trim() +
                    '-' + String(selected?.gift?.num ?? selected?.gift?.number ?? '');
                if (!selectedUniqueId || selectedUniqueId.endsWith('-')) {
                    throw new Error('Telegram did not return a valid unique collectible identity');
                }

                // transferSelectedGiftToUser performs the real transfer; attach first using
                // the same identity, then Telegram is the final authority on success/failure.
                const msgId = Number(selected?.msgId ?? selected?.msg_id);
                if (!Number.isSafeInteger(msgId) || msgId <= 0) throw new Error('Telegram did not return a valid saved gift message id');
                const transferStars = Number(selected?.transferStars ?? selected?.transfer_stars ?? 0);
                const metadata = JSON.stringify({
                    baseName: reserved.name,
                    uniqueName: String(selected?.gift?.name || selected?.gift?.title || reserved.name),
                    collectibleNumber: Number(selected?.gift?.num ?? selected?.gift?.number ?? 0) || null,
                    ownedGiftId: selectedUniqueId,
                    transferStarCount: Number.isSafeInteger(transferStars) ? transferStars : null,
                    canBeTransferred: true
                });

                await attachPendingGiftCollectible(req.user.id, userGiftId, {
                    uniqueCollectibleId: selectedUniqueId,
                    telegramGiftInstanceId: String(msgId),
                    collectibleNumber: Number(selected?.gift?.num ?? selected?.gift?.number ?? 0) || null,
                    verifiedMetadata: metadata,
                    marketValue: reserved.market_value || reserved.value || 0
                });

                const sent = await transferSelectedGiftToUser({
                    savedGift: selected,
                    uniqueCollectibleId: selectedUniqueId,
                    telegramUserId: userTelegramId
                });

                // Telegram's successful payment/transfer response is authoritative. Do not immediately re-read


                // Account 2 inventory because getSavedStarGifts can briefly lag after a successful transfer.


                await confirmGiftWithdrawal(


                    req.user.id,


                    selectedUniqueId,


                    'telegram-business-account2-transfer-complete:msg-' + sent.msgId


                );
                await createNotification(
                    req.user.id,
                    'GIFT_WON',
                    'Gift withdrawn to your Telegram account!',
                    { collectibleId: selectedUniqueId, giftType: reserved.name }
                );
                return res.json({
                    ok: true,
                    status: 'SENT',
                    collectibleId: selectedUniqueId,
                    giftType: reserved.name
                });
            } catch (error) {
                const telegramDetail = String(
                    error?.errorMessage
                    || error?.error_message
                    || error?.message
                    || 'Unknown Telegram transfer error'
                );
                const telegramCode = Number.isFinite(Number(error?.code)) ? Number(error.code) : null;
                console.error('ACCOUNT2 COLLECTIBLE TRANSFER FAILED:', JSON.stringify({
                    stage: 'telegram-transfer',
                    errorName: error?.constructor?.name || null,
                    telegramCode,
                    telegramDetail
                }));
                try {
                    await rollbackPendingGiftWithdrawal(req.user.id, userGiftId, telegramDetail);
                } catch (rollbackError) {
                    console.error('ACCOUNT2 WITHDRAW ROLLBACK ERROR:', rollbackError.message);
                }
                return res.status(502).json({
                    ok: false,
                    error: 'Telegram gift transfer failed',
                    reason: 'transfer_failed',
                    detail: telegramDetail,
                    telegramCode,
                    collectibleReturned: true
                });
            }
        }

        const collectible = await getCollectibleByUniqueId(collectibleId);
        if (!collectible || collectible.user_id !== req.user.id) {
            return res.status(404).json({ ok: false, error: 'Collectible not found or not owned' });
        }
        if (!collectible.unique_collectible_id) {
            return res.status(400).json({ ok: false, error: 'Not a unique collectible' });
        }

        await reserveCollectibleForWithdrawal(req.user.id, collectibleId);
        try {
            const selected = await findBusinessGiftByUniqueId(collectible.unique_collectible_id);
            if (!selected) throw new Error('This exact collectible is not currently owned by Account 2');

            const sent = await transferSelectedGiftToUser({
                savedGift: selected,
                uniqueCollectibleId: collectible.unique_collectible_id,
                telegramUserId: userTelegramId
            });

            // Telegram's successful transfer response is authoritative. Do not use an immediate Account 2 inventory read as a failure condition because inventory propagation can lag.
            await confirmGiftWithdrawal(req.user.id, collectibleId, 'telegram-business-account2-transfer-complete:msg-' + sent.msgId);
            await createNotification(req.user.id, 'GIFT_WON', 'Gift withdrawn to your Telegram account!', { collectibleId });
            return res.json({ ok: true, status: 'SENT', collectibleId });
        } catch (error) {
            const telegramDetail = String(
                error?.errorMessage
                || error?.error_message
                || error?.message
                || 'Unknown Telegram transfer error'
            );
            const telegramCode = Number.isFinite(Number(error?.code)) ? Number(error.code) : null;
            console.error('ACCOUNT2 COLLECTIBLE TRANSFER FAILED:', JSON.stringify({
                stage: 'telegram-transfer',
                errorName: error?.constructor?.name || null,
                telegramCode,
                telegramDetail
            }));
            await rollbackGiftWithdrawal(req.user.id, collectibleId, telegramDetail);
            return res.status(502).json({
                ok: false,
                error: 'Telegram gift transfer failed',
                reason: 'transfer_failed',
                detail: telegramDetail,
                telegramCode,
                collectibleReturned: true
            });
        }
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});
// ===== 5.6.4 معاملات الهدايا =====
app.get('/api/collectibles/transactions', authenticate, async (req, res) => {
    try {
        const transactions = await getGiftTransactions(req.user.id);
        res.json({ ok: true, transactions });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.6.5 المعاملات المعلقة =====
app.get('/api/collectibles/pending-payouts', authenticate, async (req, res) => {
    try {
        const pending = await getPendingPayouts(req.user.id);
        res.json({ ok: true, pending });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
    });

// ===== 5.6.6 MINI GAMES API =====

// --- MINES ---
app.post('/api/mines/bet', authenticate, async (req, res) => {
    try {
        const { amount, currency, giftId } = req.body;
        const betAmount = Number(String(amount ?? '').trim().replace(',', '.'));
        if (currency === 'TEST' && !ENABLE_TEST_BALANCE) {
            return res.status(403).json({ ok: false, error: 'Test balance is not enabled' });
        }
        const betCurrency = currency === 'GIFT' ? 'GIFT' : currency === 'TEST' ? 'TEST' : 'TON';

        const result = await createMinesGame(req.user.id, betAmount, betCurrency, giftId);
        res.json({
            ok: true,
            gameId: result.gameId,
            serverSeedHash: result.serverSeedHash,
            clientSeed: result.clientSeed,
            betAmount: result.betAmount || betAmount,
            currency: betCurrency
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/mines/reveal', authenticate, async (req, res) => {
    try {
        const { gameId, tileIndex } = req.body;
        if (typeof tileIndex !== 'number' || tileIndex < 0 || tileIndex > 24) {
            return res.status(400).json({ ok: false, error: 'Invalid tile index' });
        }
        const result = await revealMinesTile(gameId, req.user.id, tileIndex);
        res.json({ ok: true, ...result });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/mines/cashout', authenticate, async (req, res) => {
    try {
        const { gameId } = req.body;
        const result = await cashoutMinesGame(gameId, req.user.id);
        await createNotification(req.user.id, 'BET_WON', `Mines cashout: ${result.payout.toFixed(2)} TON`, { gameId, payout: result.payout });
        res.json({ ok: true, ...result });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.get('/api/mines/state/:gameId', authenticate, async (req, res) => {
    try {
        const result = await getMiniGame(req.params.gameId, req.user.id);
        if (!result) return res.status(404).json({ ok: false, error: 'Game not found' });
        res.json({ ok: true, ...result });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// --- PLINKO ---
app.post('/api/plinko/bet', authenticate, async (req, res) => {
    try {
        const { amount, currency, giftId } = req.body;
        const betAmount = Number(String(amount ?? '').trim().replace(',', '.'));
        if (currency === 'TEST' && !ENABLE_TEST_BALANCE) {
            return res.status(403).json({ ok: false, error: 'Test balance is not enabled' });
        }
        const betCurrency = currency === 'GIFT' ? 'GIFT' : currency === 'TEST' ? 'TEST' : 'TON';

        const result = await createPlinkoGame(req.user.id, betAmount, betCurrency, giftId);
        res.json({
            ok: true,
            gameId: result.gameId,
            serverSeedHash: result.serverSeedHash,
            clientSeed: result.clientSeed
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/plinko/drop', authenticate, async (req, res) => {
    try {
        const { gameId } = req.body;
        const result = await dropPlinkoChip(gameId, req.user.id);
        await createNotification(req.user.id, 'BET_WON', `Plinko result: ${result.multiplier}x`, { gameId, multiplier: result.multiplier });
        res.json({ ok: true, ...result });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// --- DICE ---
app.post('/api/dice/bet', authenticate, async (req, res) => {
    try {
        const { amount, currency, giftId, target } = req.body;
        const betAmount = Number(String(amount ?? '').trim().replace(',', '.'));
        if (currency === 'TEST' && !ENABLE_TEST_BALANCE) {
            return res.status(403).json({ ok: false, error: 'Test balance is not enabled' });
        }
        const betCurrency = currency === 'GIFT' ? 'GIFT' : currency === 'TEST' ? 'TEST' : 'TON';
        const targetNum = Number(target);

        const result = await createDiceGame(req.user.id, betAmount, betCurrency, giftId, targetNum);
        res.json({
            ok: true,
            gameId: result.gameId,
            serverSeedHash: result.serverSeedHash,
            clientSeed: result.clientSeed,
            roll: result.roll,
            won: result.won,
            payout: result.payout,
            target: result.target
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// --- LOTTERY ---
app.post('/api/lottery/bet', authenticate, async (req, res) => {
    try {
        const { amount, currency, playerNumbers } = req.body;
        const betAmount = Number(String(amount ?? '').trim().replace(',', '.'));
        if (currency === 'TEST' && !ENABLE_TEST_BALANCE) {
            return res.status(403).json({ ok: false, error: 'Test balance is not enabled' });
        }
        const betCurrency = currency === 'TEST' ? 'TEST' : 'TON';

        if (!Array.isArray(playerNumbers) || playerNumbers.length !== 5) {
            return res.status(400).json({ ok: false, error: 'You must select exactly 5 numbers' });
        }

        const result = await createLotteryGame(req.user.id, betAmount, betCurrency, null, playerNumbers);
        res.json({
            ok: true,
            gameId: result.gameId,
            serverSeedHash: result.serverSeedHash,
            clientSeed: result.clientSeed,
            drawnNumbers: result.drawnNumbers,
            matches: result.matches,
            matchCount: result.matchCount,
            payout: result.payout,
            won: result.won
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// --- 5.7 الرهان بـ TON ---
app.post('/api/bet/ton', authenticate, async (req, res) => {
    try {
        const { amount, autoCashoutTarget } = req.body;
        const normalizedAmount = Number(String(amount ?? '').trim().replace(',', '.'));
        
        if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0.1) {
            return res.status(400).json({ ok: false, error: 'Invalid amount' });
        }

        const roundId = currentGameState.phase === 'FLIGHT'
            ? currentGameState.roundId + 1
            : currentGameState.roundId;

        if (currentGameState.phase === 'FLIGHT') {
            const result = await queueTonBet(req.user.id, normalizedAmount, roundId, autoCashoutTarget);
            await refreshRoundPlayers();
            const balance = await getUserBalance(req.user.id);
            res.json({
                ok: true,
                queued: true,
                bet: result,
                roundId,
                balance
            });
            return;
        }

        if (currentGameState.phase !== 'COUNTDOWN') {
            return res.status(400).json({ ok: false, error: 'Betting only allowed during COUNTDOWN or FLIGHT' });
        }

        const result = await placeTonBet(req.user.id, normalizedAmount, roundId, autoCashoutTarget);
        await refreshRoundPlayers();
        
        res.json({ 
            ok: true, 
            bet: result,
            roundId: roundId
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.8b Gift queued bet status/cancel =====
app.get('/api/bet/gift/current', authenticate, async (req, res) => {
    try {
        const active = await get('SELECT id, round_id, gift_value_at_bet, auto_cashout_target FROM gift_bets WHERE user_id = ? AND round_id = ? AND status = \'ACTIVE\' ORDER BY id DESC LIMIT 1', [req.user.id, currentGameState.roundId]);
        if (active) return res.json({ ok: true, state: 'active', betId: active.id, roundId: active.round_id, amount: Number(active.gift_value_at_bet), autoCashoutTarget: active.auto_cashout_target });
        const queuedRoundId = currentGameState.phase === 'FLIGHT'
            ? currentGameState.roundId + 1
            : currentGameState.roundId;
        const queued = await get('SELECT id, round_id, user_gift_id, gift_value_at_bet, auto_cashout_target FROM queued_gift_bets WHERE user_id = ? AND round_id = ? AND status = \'QUEUED\' ORDER BY id DESC LIMIT 1', [req.user.id, queuedRoundId]);
        if (queued) return res.json({ ok: true, state: 'queued', betId: queued.id, userGiftId: queued.user_gift_id, roundId: queued.round_id, amount: Number(queued.gift_value_at_bet), autoCashoutTarget: queued.auto_cashout_target });
        return res.json({ ok: true, state: 'none' });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/bet/gift/cancel-queued', authenticate, async (req, res) => {
    try {
        const { betId } = req.body;
        if (!betId) return res.status(400).json({ ok: false, error: 'betId required' });
        if (currentGameState.phase !== 'FLIGHT') return res.status(400).json({ ok: false, error: 'Queued bet is locked' });
        const result = await cancelQueuedGiftBet(betId, req.user.id, currentGameState.roundId + 1);
        await refreshRoundPlayers();
        res.json({ ok: true, cancelled: true, ...result });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.8 TON queued bet status/cancel =====
app.get('/api/bet/ton/current', authenticate, async (req, res) => {
    try {
        const active = await get(
            'SELECT id, round_id, amount, auto_cashout_target FROM ton_bets WHERE user_id = ? AND round_id = ? AND status = \'ACTIVE\' AND bet_currency = \'TON\' ORDER BY id DESC LIMIT 1',
            [req.user.id, currentGameState.roundId]
        );
        if (active) {
            return res.json({
                ok: true,
                state: 'active',
                betId: active.id,
                roundId: active.round_id,
                amount: Number(active.amount),
                autoCashoutTarget: active.auto_cashout_target
            });
        }

        const queuedRoundId = currentGameState.phase === 'FLIGHT'
            ? currentGameState.roundId + 1
            : currentGameState.roundId;
        const queued = await get(
            'SELECT id, round_id, amount, auto_cashout_target FROM queued_ton_bets WHERE user_id = ? AND round_id = ? AND status = \'QUEUED\' ORDER BY id DESC LIMIT 1',
            [req.user.id, queuedRoundId]
        );
        if (queued) {
            return res.json({
                ok: true,
                state: 'queued',
                betId: queued.id,
                roundId: queued.round_id,
                amount: Number(queued.amount),
                autoCashoutTarget: queued.auto_cashout_target
            });
        }

        return res.json({ ok: true, state: 'none' });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.8 TON queued bet status/cancel =====
app.post('/api/bet/ton/cancel-queued', authenticate, async (req, res) => {
    try {
        const { betId } = req.body;
        if (!betId) {
            return res.status(400).json({ ok: false, error: 'betId required' });
        }
        if (currentGameState.phase !== 'FLIGHT') {
            return res.status(400).json({ ok: false, error: 'Queued bet is locked' });
        }

        const result = await cancelQueuedTonBet(
            betId,
            req.user.id,
            currentGameState.roundId + 1
        );
        await refreshRoundPlayers();
        res.json({
            ok: true,
            cancelled: true,
            ...result
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/cashout/ton', authenticate, async (req, res) => {
    try {
        const { betId } = req.body;
        
        if (!betId) {
            return res.status(400).json({ ok: false, error: 'betId required' });
        }

        // التحقق من أن الجولة في مرحلة FLIGHT
        if (currentGameState.phase !== 'FLIGHT') {
            return res.status(400).json({ ok: false, error: 'Cashout only allowed during FLIGHT' });
        }

        const multiplier = currentGameState.multiplier;
        const result = await cashoutBet('TON', betId, req.user.id, currentGameState.roundId, multiplier);
        const balance = await getUserBalance(req.user.id);
        await refreshRoundPlayers();
        
        // إنشاء إشعار
        await createNotification(
            req.user.id,
            'BET_WON',
            `💰 You cashed out! ${result.payout.toFixed(2)} TON`,
            { betId, payout: result.payout, multiplier: result.multiplier }
        );
        
        res.json({ 
            ok: true, 
            payout: result.payout, 
            multiplier: result.multiplier,
            amount: result.amount,
            balance: balance
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.7b صرف الاختبار (TEST BET) — Rocket game using TEST balance ONLY =====
// Test balance is completely isolated from real TON. Cannot be withdrawn,
// converted to TON, or affect collectible ownership.
app.post('/api/bet/test', authenticate, async (req, res) => {
    if (!ENABLE_TEST_BALANCE) {
        return res.status(403).json({ ok: false, error: 'Test balance is not enabled' });
    }

    try {
        const { amount, autoCashoutTarget } = req.body;
        const normalizedAmount = Number(String(amount ?? '').trim().replace(',', '.'));

        if (!Number.isFinite(normalizedAmount) || normalizedAmount < 1) {
            return res.status(400).json({ ok: false, error: 'Invalid test amount (minimum 1 TEST)' });
        }

        if (currentGameState.phase !== 'COUNTDOWN') {
            return res.status(400).json({ ok: false, error: 'Betting only allowed during COUNTDOWN' });
        }

        const roundId = currentGameState.roundId;
        const result = await placeTestBet(req.user.id, normalizedAmount, roundId, autoCashoutTarget);
        await refreshRoundPlayers();

        res.json({
            ok: true,
            bet: result,
            roundId: roundId,
            isTest: true
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/cashout/test', authenticate, async (req, res) => {
    if (!ENABLE_TEST_BALANCE) {
        return res.status(403).json({ ok: false, error: 'Test balance is not enabled' });
    }

    try {
        const { betId } = req.body;

        if (!betId) {
            return res.status(400).json({ ok: false, error: 'betId required' });
        }

        if (currentGameState.phase !== 'FLIGHT') {
            return res.status(400).json({ ok: false, error: 'Cashout only allowed during FLIGHT' });
        }

        const multiplier = currentGameState.multiplier;
        const result = await cashoutTestBet(betId, req.user.id, multiplier);
        const testBalance = await getUserTestBalance(req.user.id);
        await refreshRoundPlayers();

        await createNotification(
            req.user.id,
            'BET_WON',
            `TEST cashout: ${result.payout.toFixed(2)} TEST`,
            { betId, payout: result.payout, multiplier: result.multiplier }
        );

        res.json({
            ok: true,
            payout: result.payout,
            multiplier: result.multiplier,
            amount: result.amount,
            test_balance: testBalance,
            isTest: true
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== Isolated 100 TON Telegram Collectibles box =====
app.get('/api/loot-box/100/market-items', authenticate, async (req, res) => {
    try {
        const forceRefresh = String(req.query?.refresh || '') === '1';
        if (forceRefresh) {
            // A refresh is requested only when the player starts another opening.
            // It never runs during the spinner/result view and remains read-only.
            try { await refreshMarketPrices(); } catch (marketError) {
                console.warn('100 TON general market forced refresh unavailable:', marketError.message);
            }
            try { await refresh100TonMarketCache(); } catch (marketError) {
                console.warn('100 TON market forced refresh unavailable:', marketError.message);
            }
        }

        // Warm the same read-only gift market cache already used by the 0.1 TON box.
        // This is only a pricing fallback and is completely isolated from Crash/game state.
        try {
            await ensureGiftMarketCache();
        } catch (marketError) {
            console.warn('100 TON gift market fallback unavailable:', marketError.message);
        }

        let cacheStatus = get100TonMarketCacheStatus();
        const items = await Promise.all(LOOT_BOX_100_CATALOG.map(async (item, catalogIndex) => {
            // Prefer the exact 100 TON market source. If it has no mapping for a gift,
            // fall back to the same collection-floor source used by the other paid boxes,
            // then use Telegram live lookup only as the last fallback.
            let marketValueTon = 0;
            let lastUpdated = null;
            let source = null;

            const baseName = item.baseName || item.name;
            const fallbackMarket = function() {
                const match = getCollectibleMarketValue({
                    name: baseName,
                    base_name: baseName,
                    model_name: baseName
                });
                return match && Number(match.floorPriceTon) > 0
                    ? {
                        value: Number(match.floorPriceTon),
                        lastUpdated: match.lastUpdated || null,
                        source: 'gift-details-floor'
                    }
                    : null;
            };

            if (item.backdrop) {
                let special = await get100TonBackdropPriceSafe(item);
                if (!special?.value) special = fallbackMarket();
                if (!special?.value) special = await get100TonTelegramMarketPriceSafe(item);
                marketValueTon = Number(special?.value || 0);
                lastUpdated = special?.lastUpdated || (special?.fetchedAt ? new Date(special.fetchedAt).toISOString() : null);
                source = special?.source || null;
            } else {
                let market = await get100TonGeneralMarketPriceSafe(item);
                if (!market?.value) market = fallbackMarket();
                if (!market?.value) market = await get100TonTelegramMarketPriceSafe(item);
                marketValueTon = Number(market?.value || 0);
                lastUpdated = market?.lastUpdated || (market?.fetchedAt ? new Date(market.fetchedAt).toISOString() : null);
                source = market?.source || 'general-market-floor';
            }

            return {
                catalogIndex,
                name: item.name,
                backdrop: item.backdrop || null,
                image: item.image,
                marketValueTon,
                lastUpdated,
                source
            };
        }));

        const hasAnyPrice = items.some(item => item.marketValueTon > 0);
        const refreshing = !cacheStatus.loaded || cacheStatus.stale;
        if (refreshing) {
            refresh100TonMarketCache().catch(error => console.warn('100 TON market refresh failed:', error.message));
        }
        cacheStatus = get100TonMarketCacheStatus();

        res.json({
            ok: true,
            items,
            refreshing,
            stale: !!cacheStatus.stale,
            available: hasAnyPrice
        });
    } catch (error) {
        // Pricing is read-only and isolated; a market failure must never affect the game.
        res.status(200).json({ ok: true, items: [], refreshing: false, stale: false, available: false });
    }
});

// ===== Read-only market values for the isolated 0.1 TON box =====
app.get('/api/loot-box/0_1/market-items', authenticate, async (req, res) => {
    try {
        try {
            await ensureGiftMarketCache();
        } catch (marketError) {
            console.warn('0.1 TON market cache unavailable:', marketError.message);
        }

        const names = PAID_BOX_GIFT_NAMES.box_0_1 || [];
        const items = names.map(name => {
            const market = getCollectibleMarketValue({
                name,
                base_name: name,
                model_name: name
            });
            return {
                name,
                image: paidBoxGiftImage(name),
                marketValueTon: Number(market?.floorPriceTon || 0),
                lastUpdated: market?.lastUpdated || null
            };
        });

        res.json({ ok: true, items });
    } catch (error) {
        // This endpoint is read-only and isolated; a market failure must never
        // affect the paid draw or the Crash/game loop.
        res.status(200).json({ ok: true, items: [] });
    }
});

// ===== Read-only exact Telegram resale prices for paid loot boxes =====
// Prices are fetched from Telegram's own resale marketplace using the exact
// gift type + model/backdrop/pattern attributes. Third-party market floors are
// only used as a fallback when Telegram has no matching TON listing.
const TELEGRAM_VARIANT_PRICE_TTL_MS = 60 * 1000;
const telegramVariantPriceCache = new Map();
let telegramExactGiftCatalogCache = null;
let telegramExactGiftCatalogExpiresAt = 0;
const telegramGiftAttributesCache = new Map();

function telegramAttributeClass(attribute) {
    return String(
        attribute?.className ||
        attribute?.constructor?.className ||
        attribute?.constructor?.name ||
        attribute?._ ||
        ''
    ).toLowerCase();
}

function telegramAttributeDocumentId(attribute) {
    const document = attribute?.document;
    return document?.id != null ? String(document.id) : null;
}

function telegramAttributeId(attribute) {
    const cls = telegramAttributeClass(attribute);
    if (cls.includes('model')) {
        const documentId = telegramAttributeDocumentId(attribute);
        return documentId ? { className: 'StarGiftAttributeIdModel', documentId: BigInt(documentId) } : null;
    }
    if (cls.includes('pattern')) {
        const documentId = telegramAttributeDocumentId(attribute);
        return documentId ? { className: 'StarGiftAttributeIdPattern', documentId: BigInt(documentId) } : null;
    }
    if (cls.includes('backdrop')) {
        const backdropId = Number(attribute?.backdropId ?? attribute?.backdrop_id);
        return Number.isInteger(backdropId) && backdropId > 0
            ? { className: 'StarGiftAttributeIdBackdrop', backdropId }
            : null;
    }
    return null;
}

function findTelegramAttribute(attributes, kind, name) {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return null;
    return (Array.isArray(attributes) ? attributes : []).find(attribute => {
        const cls = telegramAttributeClass(attribute);
        if (!cls.includes(kind)) return false;
        return String(attribute?.name || '').trim().toLowerCase() === wanted;
    }) || null;
}

async function getTelegramGiftCatalog() {
    if (telegramExactGiftCatalogCache && telegramExactGiftCatalogExpiresAt > Date.now()) {
        return telegramExactGiftCatalogCache;
    }
    const client = await ensureTelegramMtprotoClient();
    const result = await client.api.payments.getStarGifts({ hash: 0 });
    const gifts = Array.isArray(result?.gifts) ? result.gifts : [];
    telegramExactGiftCatalogCache = gifts;
    telegramExactGiftCatalogExpiresAt = Date.now() + 30 * 60 * 1000;
    return gifts;
}

async function getTelegramGiftAttributes(giftId) {
    const key = String(giftId);
    const cached = telegramGiftAttributesCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.attributes;
    const client = await ensureTelegramMtprotoClient();
    const result = await client.api.payments.getStarGiftUpgradeAttributes({
        giftId: BigInt(key)
    });
    const attributes = Array.isArray(result?.attributes) ? result.attributes : [];
    telegramGiftAttributesCache.set(key, {
        attributes,
        expiresAt: Date.now() + 30 * 60 * 1000
    });
    return attributes;
}

async function getExactTelegramVariantPrice({ name, modelName, backdropName, patternName }) {
    const cacheKey = [
        String(name || '').trim().toLowerCase(),
        String(modelName || '').trim().toLowerCase(),
        String(backdropName || '').trim().toLowerCase(),
        String(patternName || '').trim().toLowerCase()
    ].join('|');
    const cached = telegramVariantPriceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const client = await ensureTelegramMtprotoClient();
    const gifts = await getTelegramGiftCatalog();
    const wantedName = String(name || '').trim().toLowerCase();
    const baseGift = gifts.find(gift => String(gift?.title || '').trim().toLowerCase() === wantedName)
        || gifts.find(gift => String(gift?.title || '').trim().toLowerCase().includes(wantedName));
    if (!baseGift?.id) return null;

    const attributes = await getTelegramGiftAttributes(baseGift.id);
    const attributeIds = [];

    if (modelName && String(modelName).trim().toLowerCase() !== 'random') {
        const model = findTelegramAttribute(attributes, 'model', modelName);
        const modelId = telegramAttributeId(model);
        if (!modelId) return null;
        attributeIds.push(modelId);
    }

    if (patternName) {
        const pattern = findTelegramAttribute(attributes, 'pattern', patternName);
        const patternId = telegramAttributeId(pattern);
        if (!patternId) return null;
        attributeIds.push(patternId);
    }

    if (backdropName) {
        const backdrop = findTelegramAttribute(attributes, 'backdrop', backdropName);
        const backdropId = telegramAttributeId(backdrop);
        if (!backdropId) return null;
        attributeIds.push(backdropId);
    }

    const result = await client.api.payments.getResaleStarGifts({
        giftId: BigInt(String(baseGift.id)),
        sortByPrice: true,
        starsOnly: false,
        ...(attributeIds.length ? { attributes: attributeIds } : {}),
        offset: '',
        limit: 100
    });

    const resaleGifts = Array.isArray(result?.gifts) ? result.gifts : [];
    const tonPrices = resaleGifts
        .map(gift => findTonAmount(gift?.resellAmount || gift?.resell_amount))
        .filter(price => Number.isFinite(price) && price > 0);

    if (!tonPrices.length) return null;

    const value = {
        value: Number(Math.min(...tonPrices).toFixed(9)),
        currency: 'TON',
        source: 'telegram-live-exact-variant-floor',
        fetchedAt: Date.now()
    };
    telegramVariantPriceCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + TELEGRAM_VARIANT_PRICE_TTL_MS
    });
    return value;
}

app.get('/api/loot-box/market-items', authenticate, async (req, res) => {
    try {
        let variants = [];
        try {
            variants = JSON.parse(String(req.query?.variants || '[]'));
        } catch {}
        if (!Array.isArray(variants)) variants = [];

        const items = [];
        for (const variant of variants.slice(0, 250)) {
            const name = String(variant?.name || '').trim();
            if (!name) continue;

            let market = null;
            try {
                market = await getExactTelegramVariantPrice({
                    name,
                    modelName: variant?.model_name || variant?.label || null,
                    backdropName: variant?.backdrop || null,
                    patternName: variant?.pattern || variant?.pattern_name || null
                });
            } catch (error) {
                console.warn('Telegram exact variant price lookup failed:', name, error.message);
            }

            if (!market) {
                market = await getModelMarketPrice({
                    name,
                    label: variant?.label || null,
                    model_name: variant?.model_name || null,
                    backdrop: variant?.backdrop || null,
                    baseName: name
                }) || await getCollectibleVariantMarketValue({
                    name,
                    label: variant?.label || null,
                    model_name: variant?.model_name || null,
                    backdrop: variant?.backdrop || null
                });
            }

            items.push({
                key: String(variant?.key || ''),
                name,
                label: variant?.label || null,
                backdrop: variant?.backdrop || null,
                pattern: variant?.pattern || variant?.pattern_name || null,
                marketValueTon: Number(market?.value ?? market?.floorPriceTon ?? 0),
                source: market?.source || null,
                lastUpdated: market?.fetchedAt || market?.lastUpdated || null
            });
        }

        res.setHeader('Cache-Control', 'no-store');
        res.json({
            ok: true,
            items,
            available: items.some(item => item.marketValueTon > 0)
        });
    } catch (error) {
        console.error('Telegram exact loot-box market pricing failed:', error.message);
        res.status(200).json({ ok: true, items: [], available: false });
    }
});

// ===== Server-authoritative paid loot-box roulette =====
const PAID_LOOT_BOX_CONFIG = {
    box_0_1: { name: 'Farm', price: 0.1, rarity: 'common', tonRewards: [], nothingChance: 9999, giftChance: 1 },
    box_2:   { name: 'Arm',   price: 2,   rarity: 'rare',   tonRewards: [0.05] },
    box_heart: { name: 'Heart', price: 2, rarity: 'rare', tonRewards: [0.05] },
    box_2_5: { name: 'Movie', price: 4.5, rarity: 'rare',   tonRewards: [0.50, 0.40, 1.00, 0.20] },
    box_5:   { name: 'Autumn', price: 5,   rarity: 'rare',   tonRewards: [0.25, 0.40, 0.60, 0.80] },
    box_8:   { name: 'space',   price: 8,   rarity: 'epic',   tonRewards: [0.40, 0.60, 0.80, 1.20] },
    box_12:  { name: 'Pepe',  price: 12,  rarity: 'epic',   tonRewards: [0.60, 0.90, 1.00, 1.20, 1.80] },
    box_15:  { name: 'Ring',  price: 15, rarity: 'epic',   tonRewards: [] },
    box_20:  { name: 'Black',  price: 20, rarity: 'epic',   tonRewards: [1.00, 1.50, 2.00, 3.00] },
    box_25:  { name: 'Cap',  price: 25, rarity: 'epic',   tonRewards: [1.25, 2.00, 3.00, 4.00] },
    box_50:  { name: 'Crazy',  price: 50, rarity: 'legendary', tonRewards: [2.50, 4.00, 6.00, 8.00] },
    box_100: { name: 'VIP', price: 100, rarity: 'legendary', tonRewards: [5.00, 8.00, 10.00, 15.00] }
};

const PAID_BOX_GIFT_NAMES = {
    box_heart: ["Heart Locket","Cupid Charm","Love Candle","Eternal Rose","Trapped Heart","Diamond Ring"],
    box_0_1: ["Plush Pepe","Heart Locket","Durov's Cap","Precious Peach","Scared Cat","Heroic Helmet","Loot Bag","Mighty Arm","Astral Shard","Nail Bracelet","Westside Sign","Durov's Glasses","Perfume Bottle","Ion Gem","Mini Oscar","Artisan Brick","Gem Signet","Low Rider","Swiss Watch","Magic Potion","Sharp Tongue","Kissed Frog","Bonded Ring","Vintage Cigar","Voodoo Doll","Neko Helmet","Toy Bear","Genie Lamp","Signet Ring","Diamond Ring","Rare Bird","Bling Binky","Electric Skull","Khabib's Papakha","Eternal Rose","Cupid Charm","Sky Stilettos","Trapped Heart","Ionic Dryer","UFC Strike","Snoop Cigar","Love Potion","Mad Pumpkin","Crystal Ball","Flying Broom","Record Player","Skull Flower","Valentine Box","Sakura Flower","Top Hat","Love Candle","Jingle Bells","Hanging Star","Fine Pen","Chill Flame","Instant Ramen","Pool Float","Vice Cream","Candy Cane","Lush Bouquet","Desk Calendar","Money Pot","Jester Hat","Cookie Heart","Restless Jar","Lol Pop","Winter Wreath","Mousse Cake","Snake Box","Liberty Figure","Santa Hat","Pet Snake","Snow Globe","B-Day Candle","Bunny Muffin","Party Sparkler","Spring Basket","Star Notepad","Bow Tie","Homemade Cake","Snow Mittens","Holiday Drink","Sleigh Bell","Light Sword","Input Key","Spiced Wine","Jack-in-the-Box","Stellar Rocket","Mood Pack"],
    box_5: ["Durov's Cap","Precious Peach","Loot Bag","Mini Oscar","Crystal Ball","Candy Cane","Vice Cream","Chill Flame","Lush Bouquet","Desk Calendar","Money Pot","Jester Hat","Cookie Heart","Restless Jar","Lol Pop","Winter Wreath","Mousse Cake","Snake Box","Liberty Figure","Santa Hat","Pet Snake","Snow Globe","B-Day Candle","Mad Pumpkin","Bunny Muffin","Party Sparkler","Magic Potion","Jingle Bells","Sakura Flower","Voodoo Doll","Khabib's Papakha","Electric Skull","Love Candle","Spring Basket","Flying Broom"],
    box_8: ["Genie Lamp","Nail Bracelet","Bonded Ring","Mighty Arm","Swiss Watch","Vintage Cigar","Top Hat","Signet Ring","Mini Oscar","Neko Helmet","Voodoo Doll","Bling Binky","Star Notepad","Bow Tie","Snoop Cigar","Homemade Cake","Mad Pumpkin","Snow Mittens","Snoop Cigar","Holiday Drink","Sleigh Bell","Light Sword","Input Key","Spiced Wine","Jack-in-the-Box","Stellar Rocket","Mood Pack"],
    box_2: ["Sleigh Bell","Light Sword","Toy Bear","Rare Bird","Bow Tie","Liberty Figure","Valentine Box","Timeless Book","Jolly Chimp","Joyful Bundle","Cupid Charm","Flying Broom","Stellar Rocket","Tama Gadget","Hanging Star","Chill Flame","Snow Globe","Snake Box","Big Year","Happy Brownie","Lunar Snake","Candy Cane","Whip Cupcake"],
    box_2_5: ["Mighty Arm","Loot Bag","Durov's Glasses","Signet Ring","Scared Cat","Kissed Frog","Low Rider","Mini Oscar","Electric Skull","Astral Shard","Light Sword","Bling Binky","Toy Bear","Gem Signet","Artisan Brick","Swiss Watch","Desk Calendar"],
    box_12: ["Plush Pepe","Kissed Frog","Loot Bag","Spring Basket","Durov's Glasses","Nail Bracelet","Neko Helmet","Heroic Helmet","Scared Cat","Surge Board","Cupid Charm","Ice Cream","Sharp Tongue","Mood Pack","Bunny Muffin","Toy Bear","Star Notepad","Snow Globe","Tama Gadget","Restless Jar","Pool Float","Timeless Book","Winter Wreath","Jester Hat","Desk Calendar","Joyful Bundle","Spy Agaric","Jack-in-the-Box","Ginger Cookie","Valentine Box","B-Day Candle","Fresh Socks","Easter Egg","Hypno Lollipop","Party Sparkler","Stellar Rocket","Pet Snake"],
    box_15: ["Heroic Helmet","Nail Bracelet","Gem Signet","Swiss Watch","Bonded Ring","Voodoo Doll","Toy Bear","Signet Ring","Diamond Ring","Eternal Rose","Cupid Charm","Mad Pumpkin","Skull Flower","Valentine Box","Sakura Flower","Hanging Star","Restless Jar","Bow Tie","Victory Medal","Ice Cream"],
    box_20: ["Scared Cat","Durov's Cap","Mighty Arm","Nail Bracelet","Ion Gem","Genie Lamp","Swiss Watch","Bonded Ring","Perfume Bottle","Magic Potion","Mini Oscar","Artisan Brick","Low Rider","Kissed Frog","Bling Binky","Neko Helmet","Khabib's Papakha","Cupid Charm","Snoop Cigar","UFC Strike","Hanging Star","Sakura Flower","Sky Stilettos","Crystal Ball","Record Player","Mad Pumpkin","Love Potion","Flying Broom","Evil Eye","Valentine Box","Sleigh Bell","Berry Box","Lunar Snake","Instant Ramen","B-Day Candle","Precious Peach","Astral Shard","Heroic Helmet","Heart Locket","Gem Signet","Westside Sign","Sharp Tongue","Loot Bag","Voodoo Doll","Vintage Cigar","Signet Ring","Electric Skull","Rare Bird","Toy Bear","Eternal Rose","Diamond Ring","Top Hat","Ionic Dryer","Trapped Heart","Skull Flower","Jingle Bells","Jolly Chimp","Snake Box","Xmas Stocking"],
    box_25: ["Heart Locket","Durov's Cap","Precious Peach","Scared Cat","Mighty Arm","Heroic Helmet","Loot Bag","Astral Shard","Perfume Bottle","Ion Gem","Artisan Brick","Magic Potion","Swiss Watch","Sharp Tongue","Kissed Frog","Vintage Cigar","Signet Ring","Genie Lamp","Rare Bird","Electric Skull","Snoop Cigar","UFC Strike","Crystal Ball","Record Player","Skull Flower","Top Hat","Jolly Chimp","Light Sword"],
    box_50: ["Plush Pepe","Heart Locket","Durov's Cap","Precious Peach","Mighty Arm","Heroic Helmet","Loot Bag","Astral Shard","Nail Bracelet","Mini Oscar","Perfume Bottle","Ion Gem","Artisan Brick","Gem Signet","Bonded Ring","Vintage Cigar","Neko Helmet","Toy Bear","Signet Ring","Rare Bird","Bling Binky","Khabib's Papakha","Cupid Charm","UFC Strike","Love Potion","Top Hat"],
    box_100: ["Plush Pepe","Durov's Cap","Heart Locket","Precious Peach","Scared Cat","Nail Bracelet","Heroic Helmet","Swiss Watch","Loot Bag","Bonded Ring","Rare Bird","Astral Shard","Westside Sign","Artisan Brick","Low Rider","Diamond Ring","Toy Bear"]
};

function paidBoxGiftImage(name) {
    return '/api/gift-media/' + encodeURIComponent(String(name || ''));
}

async function getPaidBoxGiftPool(boxId, rarity) {
    const names = PAID_BOX_GIFT_NAMES[boxId] || [];
    if (names.length) {
        for (const name of [...new Set(names)]) {
            const slug = 'paid-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            await run(
                'INSERT OR IGNORE INTO gifts (telegram_gift_id, name, slug, emoji, image_url, collection, rarity, value, total_supply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [slug, name, slug, '🎁', paidBoxGiftImage(name), 'Paid Loot Box', rarity, 0, 0]
            );
        }
        const placeholders = names.map(() => '?').join(',');
        const rows = await query(
            'SELECT * FROM gifts WHERE name IN (' + placeholders + ') ORDER BY RANDOM()',
            names
        );
        if (rows.length) return rows;
    }

    // Boxes that do not currently expose a gift catalog keep their existing frontend
    // catalog untouched. If the server awards a gift, it is selected from already
    // registered Telegram gifts of the box rarity.
    return await query(
        "SELECT * FROM gifts WHERE rarity = ? OR rarity = 'common' ORDER BY RANDOM() LIMIT 30",
        [rarity]
    );
}

app.post('/api/loot-box/draw', authenticate, async (req, res) => {
    try {
        const boxId = String(req.body?.boxId || '').trim();
        const config = PAID_LOOT_BOX_CONFIG[boxId];
        if (!config) return res.status(400).json({ ok: false, error: 'Paid loot box not found' });

        const result = await transaction(async () => {
            const balance = Number(await getUserBalance(req.user.id) || 0);
            if (!Number.isFinite(balance) || balance < 0) {
                throw new Error('Invalid TON balance');
            }

            // Debit the real in-game TON balance atomically. Every paid box uses
            // this same path, so deposited TON and earned TON are equally spendable.
            // The balance can never go negative, and a stale frontend balance cannot
            // cause a valid purchase to be rejected.
            const debit = await run(
                'UPDATE users SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance >= ?',
                [Number(config.price), req.user.id, Number(config.price)]
            );
            if (debit.changes !== 1) throw new Error('Insufficient balance');

            // Prize odds are server-authoritative:
            // 70% TON, 23% gift below 7 TON, 7% gift above 7 TON.
            // The spinner is only a visual presentation of the already-selected
            // server result; it never decides the reward.
            let giftPool = await getPaidBoxGiftPool(boxId, config.rarity);
            if (!giftPool.length) throw new Error('No gifts available for this box');

            try {
                await ensureGiftMarketCache();
            } catch (marketError) {
                console.warn('Paid loot-box market cache unavailable:', marketError.message);
            }

            const enrichedGiftPool = giftPool.map(item => {
                const market = getCollectibleMarketValue({
                    name: item.name,
                    base_name: item.telegram_gift_id,
                    model_name: item.name
                });
                const marketValue = Number(market?.floorPriceTon ?? item.value ?? 0);
                return { ...item, marketValue };
            });

            const highValueGifts = enrichedGiftPool.filter(item => item.marketValue > 7);
            const lowValueGifts = enrichedGiftPool.filter(item => item.marketValue <= 7);

            const roll = crypto.randomInt(0, 10000);
            const allowedTonRewards = Array.isArray(config.tonRewards)
                ? [...new Set(config.tonRewards.map(Number).filter(value => Number.isFinite(value) && value > 0))]
                : [];
            let gift = null;
            let tonReward = null;
            let nothing = false;

            if (boxId === 'box_0_1') {
                // Farm is gift-or-Nothing only: 0.01% gift, 99.99% Nothing.
                if (roll < Number(config.nothingChance || 0)) {
                    nothing = true;
                } else if (roll < Number(config.nothingChance || 0) + Number(config.giftChance || 0)) {
                    gift = enrichedGiftPool[crypto.randomInt(0, enrichedGiftPool.length)];
                }
            } else if (boxId === 'box_15') {
                // Ring is gift-only: no TON balance reward is allowed for this box.
                gift = enrichedGiftPool[crypto.randomInt(0, enrichedGiftPool.length)];
            } else if (roll < 7000) {
                // TON can only come from the rewards explicitly configured for this box.
                if (!allowedTonRewards.length) {
                    throw new Error('No configured TON rewards for this box');
                }
                tonReward = allowedTonRewards[crypto.randomInt(0, allowedTonRewards.length)];
            } else if (roll < 9300) {
                const pool = lowValueGifts.length ? lowValueGifts : enrichedGiftPool;
                gift = pool[crypto.randomInt(0, pool.length)];
            } else {
                const pool = highValueGifts.length ? highValueGifts : lowValueGifts;
                if (!pool.length) throw new Error('No gifts available for this box');
                gift = pool[crypto.randomInt(0, pool.length)];
            }

            // Build the visual reel from this box's actual reward types.
            // Movie (4.5 TON) is gift-only, so its reel contains gifts only.
            const reelGiftPool = enrichedGiftPool
                .slice()
                .sort(() => Math.random() - 0.5)
                .slice(0, Math.min(8, enrichedGiftPool.length));

            const reelGiftItems = reelGiftPool.map(item => ({
                name: item.name,
                image: paidBoxGiftImage(item.name),
                rewardType: 'gift',
                marketValue: item.marketValue
            }));

            const reelNothingItem = {
                name: 'Nothing',
                image: null,
                rewardType: 'nothing'
            };

            const spinItems = boxId === 'box_0_1'
                ? [...reelGiftItems, reelNothingItem]
                : [...reelGiftItems, ...allowedTonRewards.map(value => ({
                    name: Number(value).toFixed(2) + ' TON Balance',
                    image: '/assets/ton-icon.svg',
                    value: Number(value),
                    rewardType: 'ton'
                }))];
            if (nothing) {
                spinItems[0] = {
                    name: 'Nothing',
                    image: null,
                    rewardType: 'nothing'
                };
            } else if (gift && !spinItems.some(item => item.rewardType === 'gift' && item.name === gift.name)) {
                spinItems[0] = {
                    name: gift.name,
                    image: paidBoxGiftImage(gift.name),
                    rewardType: 'gift',
                    marketValue: gift.marketValue
                };
            }
            if (tonReward !== null) {
                const isConfiguredTonReward = allowedTonRewards.some(value =>
                    Math.abs(Number(value) - Number(tonReward)) < 0.000001
                );
                if (!isConfiguredTonReward) {
                    throw new Error('Selected TON reward is not configured for this box');
                }
                if (!spinItems.some(item =>
                    item.rewardType === 'ton' && Math.abs(Number(item.value) - Number(tonReward)) < 0.000001
                )) {
                    throw new Error('Selected TON reward is not present in this box reel');
                }
            }
            // The box price was already debited atomically above.

            // Ensure every paid box is registered even if the historical seed predates it.
            await run(
                'INSERT OR IGNORE INTO lootboxes (name, emoji, price, rarity) VALUES (?, ?, ?, ?)',
                [config.name, '💎', config.price, config.rarity]
            );
            const boxRow = await get('SELECT * FROM lootboxes WHERE name = ? LIMIT 1', [config.name]);
            if (!boxRow) throw new Error('Lootbox is not registered');

            let userGift = null;
            let giftMarketValue = 0;
            if (gift) {
                giftMarketValue = Number(gift.marketValue || 0);
                userGift = await addLootBoxGiftToUser(req.user.id, gift.id);
                if (giftMarketValue > 0) {
                    await run(
                        'UPDATE user_gifts SET market_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [giftMarketValue, userGift.id]
                    );
                    userGift.market_value = giftMarketValue;
                }
            }

            await run(
                'INSERT INTO lootbox_history (user_id, lootbox_id, gift_id, status) VALUES (?, ?, ?, ?)',
                [req.user.id, boxRow.id, userGift?.gift_id || gift?.id || null, 'OPENED']
            );

            if (gift) {
                await createNotification(
                    req.user.id,
                    'GIFT_WON',
                    '🎁 You won ' + gift.name + ' from the ' + config.name + ' box!',
                    { giftId: gift.id, boxName: config.name, source: 'paid-loot-box', probability: boxId === 'box_0_1' ? 0.25 : 0.07 }
                );
            } else if (!nothing) {
                await updateUserBalance(req.user.id, tonReward, 'add');
                await createNotification(
                    req.user.id,
                    'BALANCE_WON',
                    '💎 You won ' + Number(tonReward).toFixed(2) + ' TON from the ' + config.name + ' box!',
                    { tonReward, boxName: config.name, source: 'paid-loot-box', probability: boxId === 'box_0_1' ? 0.70 : 0.93 }
                );
            }

            return {
                boxId,
                boxName: config.name,
                price: config.price,
                winnerType: nothing ? 'nothing' : (gift ? 'gift' : 'ton'),
                gift: gift ? {
                    ...gift,
                    image_url: paidBoxGiftImage(gift.name),
                    userGiftId: userGift?.id || null,
                    pending: true,
                    lootBoxLockedUntil: userGift?.loot_box_locked_until || null,
                    marketValue: giftMarketValue,
                    sellValue: Number((giftMarketValue * Number(process.env.COLLECTIBLE_SELL_RATE || '0.89')).toFixed(2))
                } : null,
                tonReward,
                spinItems,
                balance: Number(await getUserBalance(req.user.id) || 0)
            };
        });

        res.json({ ok: true, ...result });
    } catch (error) {
        console.error('Paid loot-box draw failed:', {
            userId: req.user?.id,
            boxId: req.body?.boxId,
            error: error.message,
            stack: error.stack
        });
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== Isolated FREE / FREE24 reward claim =====
// This path is independent from Crash, rounds, betting, cashout, deposits,
// withdrawals, MTProto, and the paid 100 TON loot-box path.
const FREE_BOX_REWARDS = [
    { name: 'Nail Bracelet', image: 'https://tg.me/api/media/gift-art/nailbracelet/thumb.webp', value: 0 },
    { name: 'Bonded Ring', image: 'https://tg.me/api/media/gift-art/bondedring/thumb.webp', value: 0 },
    { name: 'Signet Ring', image: 'https://tg.me/api/media/gift-art/signetring/thumb.webp', value: 0 },
    { name: 'Diamond Ring', image: 'https://tg.me/api/media/gift-art/diamondring/thumb.webp', value: 0 },
    { name: 'Cupid Charm', image: 'https://tg.me/api/media/gift-art/cupidcharm/thumb.webp', value: 0 },
    { name: 'Crystal Ball', image: 'https://tg.me/api/media/gift-art/crystalball/thumb.webp', value: 0 },
    { name: 'Love Candle', image: 'https://tg.me/api/media/gift-art/lovecandle/thumb.webp', value: 0 },
    { name: 'Fine Pen', image: 'https://tg.me/api/media/gift-art/finepen/thumb.webp', value: 0 },
    { name: 'Jolly Chimp', image: 'https://tg.me/api/media/gift-art/jollychimp/thumb.webp', value: 0 },
    { name: 'Light Sword', image: 'https://tg.me/api/media/gift-art/lightsword/thumb.webp', value: 0 },
    { name: 'Input Key', image: 'https://tg.me/api/media/gift-art/inputkey/thumb.webp', value: 0 },
    { name: 'Lush Bouquet', image: 'https://tg.me/api/media/gift-art/lushbouquet/thumb.webp', value: 0 },
    { name: 'Spring Basket', image: 'https://tg.me/api/media/gift-art/springbasket/thumb.webp', value: 0 },
    { name: 'Money Pot', image: 'https://tg.me/api/media/gift-art/moneypot/thumb.webp', value: 0 },
    { name: 'Stellar Rocket', image: 'https://tg.me/api/media/gift-art/stellarrocket/thumb.webp', value: 0 },
    { name: 'Snoop Dogg', image: 'https://tg.me/api/media/gift-art/snoopdogg/thumb.webp', value: 0 },
    { name: 'Pretty Posy', image: 'https://tg.me/api/media/gift-art/prettyposey/thumb.webp', value: 0 },
    { name: 'Jack-in-the-Box', image: 'https://tg.me/api/media/gift-art/jackinthebox/thumb.webp', value: 0 },
    { name: 'Mousse Cake', image: 'https://tg.me/api/media/gift-art/moussecake/thumb.webp', value: 0 },
    { name: 'Victory Medal', image: 'https://tg.me/api/media/gift-art/victorymedal/thumb.webp', value: 0 },
    { name: 'Fresh Socks', image: 'https://tg.me/api/media/gift-art/freshsocks/thumb.webp', value: 0 },
    { name: 'Mood Pack', image: 'https://tg.me/api/media/gift-art/moodpack/thumb.webp', value: 0 },
    { name: 'Happy Brownie', image: 'https://tg.me/api/media/gift-art/happybrownie/thumb.webp', value: 0 },
    { name: 'Whip Cupcake', image: 'https://tg.me/api/media/gift-art/whipcupcake/thumb.webp', value: 0 },
    { name: 'Chill Flame', image: 'https://tg.me/api/media/gift-art/chillflame/thumb.webp', value: 0 },
    { name: 'Instant Ramen', image: 'https://tg.me/api/media/gift-art/instantramen/thumb.webp', value: 0 },
    { name: 'Vice Cream', image: 'https://tg.me/api/media/gift-art/vicecream/thumb.webp', value: 0 },
    { name: 'Ice Cream', image: 'https://tg.me/api/media/gift-art/icecream/thumb.webp', value: 0 },
    { name: '0.01 TON Balance', image: '/assets/ton-icon.svg', value: 0.01, rewardType: 'ton' },
    { name: '0.02 TON Balance', image: '/assets/ton-icon.svg', value: 0.02, rewardType: 'ton' },
    { name: '0.03 TON Balance', image: '/assets/ton-icon.svg', value: 0.03, rewardType: 'ton' },
    { name: '0.05 TON Balance', image: '/assets/ton-icon.svg', value: 0.05, rewardType: 'ton' }
];

function freeBoxRewardKey(name) {
    return 'free-box-' + String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

app.get('/api/loot-box/free/status', authenticate, async (req, res) => {
    try {
        const row = await get(
            `SELECT lh.created_at
             FROM lootbox_history lh
             JOIN lootboxes lb ON lb.id = lh.lootbox_id
             WHERE lh.user_id = ? AND lh.status = 'OPENED' AND lb.name = 'FREE'
             ORDER BY lh.id DESC LIMIT 1`,
            [req.user.id]
        );
        if (!row) return res.json({ ok: true, available: true, nextAvailableAt: null });

        const openedAt = new Date(String(row.created_at).replace(' ', 'T') + 'Z').getTime();
        const nextAvailableAt = openedAt + 24 * 60 * 60 * 1000;
        if (!Number.isFinite(openedAt) || Date.now() >= nextAvailableAt) {
            return res.json({ ok: true, available: true, nextAvailableAt: null });
        }
        return res.json({ ok: true, available: false, nextAvailableAt: new Date(nextAvailableAt).toISOString() });
    } catch (error) {
        console.error('Free loot-box status failed:', error.message);
        res.status(500).json({ ok: false, error: 'Unable to check free box status' });
    }
});

app.post('/api/loot-box/free/claim', authenticate, async (req, res) => {
    try {
        const boxId = req.body?.boxId === 'free24' ? 'free24' : 'free';
        const result = await transaction(async () => {
            const latestOpen = await get(
                `SELECT lh.created_at
                 FROM lootbox_history lh
                 JOIN lootboxes lb ON lb.id = lh.lootbox_id
                 WHERE lh.user_id = ? AND lh.status = 'OPENED' AND lb.name = 'FREE'
                 ORDER BY lh.id DESC LIMIT 1`,
                [req.user.id]
            );
            if (latestOpen) {
                const openedAt = new Date(String(latestOpen.created_at).replace(' ', 'T') + 'Z').getTime();
                const nextAvailableAt = openedAt + 24 * 60 * 60 * 1000;
                if (Number.isFinite(openedAt) && Date.now() < nextAvailableAt) {
                    const cooldownError = new Error('Free box is available once every 24 hours');
                    cooldownError.statusCode = 429;
                    cooldownError.nextAvailableAt = new Date(nextAvailableAt).toISOString();
                    throw cooldownError;
                }
            }

            // Provision the isolated FREE catalog lazily on first claim so the 28
            // collectible rewards are all real inventory records without touching global seeds.
            for (const catalogReward of FREE_BOX_REWARDS) {
                if (catalogReward.rewardType === 'ton') continue;
                const rewardKey = freeBoxRewardKey(catalogReward.name);
                const existing = await get('SELECT id FROM gifts WHERE telegram_gift_id = ? LIMIT 1', [rewardKey]);
                if (!existing) {
                    await run(
                        'INSERT OR IGNORE INTO gifts (telegram_gift_id, name, slug, emoji, image_url, collection, rarity, value, total_supply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [rewardKey, catalogReward.name, rewardKey, '🎁', catalogReward.image, 'FREE', 'common', 0, 0]
                    );
                }
            }

            const reward = FREE_BOX_REWARDS[Math.floor(Math.random() * FREE_BOX_REWARDS.length)];
            let gift = null;
            let userGift = null;

            if (reward.rewardType === 'ton') {
                await updateUserBalance(req.user.id, reward.value, 'add');
            } else {
                const rewardKey = freeBoxRewardKey(reward.name);
                gift = await get(
                    'SELECT * FROM gifts WHERE telegram_gift_id = ? LIMIT 1',
                    [rewardKey]
                );
                if (!gift) {
                    await run(
                        'INSERT OR IGNORE INTO gifts (telegram_gift_id, name, slug, emoji, image_url, collection, rarity, value, total_supply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [rewardKey, reward.name, rewardKey, '🎁', reward.image, 'FREE', 'common', 0, 0]
                    );
                    gift = await get('SELECT * FROM gifts WHERE telegram_gift_id = ? LIMIT 1', [rewardKey]);
                }
                if (!gift) throw new Error('Free reward catalog is not ready');

                // Avoid the legacy one-per-gift-per-user constraint by selecting another
                // collectible when this user already owns this catalog item.
                const owned = await get(
                    "SELECT id FROM user_gifts WHERE user_id = ? AND gift_id = ? AND status IN ('OWNED','LOCKED','IN_BET','WON') LIMIT 1",
                    [req.user.id, gift.id]
                );
                if (owned) {
                    const available = [];
                    for (const candidate of FREE_BOX_REWARDS.filter(item => !item.rewardType)) {
                        const key = freeBoxRewardKey(candidate.name);
                        const candidateGift = await get('SELECT id FROM gifts WHERE telegram_gift_id = ? LIMIT 1', [key]);
                        if (!candidateGift) continue;
                        const candidateOwned = await get(
                            "SELECT id FROM user_gifts WHERE user_id = ? AND gift_id = ? AND status IN ('OWNED','LOCKED','IN_BET','WON') LIMIT 1",
                            [req.user.id, candidateGift.id]
                        );
                        if (!candidateOwned) available.push({ candidate, candidateGift });
                    }
                    if (available.length) {
                        const picked = available[Math.floor(Math.random() * available.length)];
                        gift = picked.candidateGift;
                    } else {
                        await updateUserBalance(req.user.id, 0.01, 'add');
                        return {
                            rewardType: 'ton',
                            name: '0.01 TON Balance',
                            value: 0.01,
                            image: '/assets/ton-icon.svg',
                            balance: Number(await getUserBalance(req.user.id) || 0)
                        };
                    }
                }

                userGift = await addLootBoxGiftToUser(req.user.id, gift.id, Number(gift.value || 0));
            }

            const lootbox = await get('SELECT id FROM lootboxes WHERE name = ? LIMIT 1', [boxId === 'free24' ? 'FREE24' : 'FREE']);
            let lootboxId = lootbox?.id || null;
            if (!lootboxId) {
                const inserted = await run(
                    'INSERT INTO lootboxes (name, emoji, price, rarity) VALUES (?, ?, 0, ?)',
                    [boxId === 'free24' ? 'FREE24' : 'FREE', '🎁', 'common']
                );
                lootboxId = inserted.lastID;
            }

            await run(
                'INSERT INTO lootbox_history (user_id, lootbox_id, gift_id, status) VALUES (?, ?, ?, ?)',
                [req.user.id, lootboxId, userGift?.gift_id || gift?.id || null, 'OPENED']
            );

            return {
                rewardType: reward.rewardType || 'collectible',
                name: reward.rewardType === 'ton' ? reward.name : gift.name,
                value: reward.rewardType === 'ton' ? reward.value : Number(gift.value || 0),
                image: reward.rewardType === 'ton' ? reward.image : (gift.image_url || reward.image),
                userGiftId: userGift?.id || null,
                lootBoxLockedUntil: userGift?.loot_box_locked_until || null,
                balance: Number(await getUserBalance(req.user.id) || 0)
            };
        });

        await createNotification(
            req.user.id,
            'GIFT_WON',
            `🎁 You won ${result.name} from ${boxId === 'free24' ? 'FREE24' : 'FREE'}!`,
            { boxName: boxId === 'free24' ? 'FREE24' : 'FREE', rewardType: result.rewardType, value: result.value, userGiftId: result.userGiftId || null }
        );

        res.json({ ok: true, boxId, gift: result });
    } catch (error) {
        console.error('Free loot-box claim failed:', error.message);
        res.status(Number(error.statusCode) || 400).json({
            ok: false,
            error: error.message,
            nextAvailableAt: error.nextAvailableAt || null
        });
    }
});

app.post('/api/loot-box/100/draw', authenticate, async (req, res) => {
    try {
        const result = await transaction(async () => {
            const gifts = [];
            for (const catalogItem of LOOT_BOX_100_CATALOG) {
                const baseName = catalogItem.baseName || catalogItem.name;
                let gift = catalogItem.telegramGiftId
                    ? await get('SELECT * FROM gifts WHERE telegram_gift_id = ? LIMIT 1', [catalogItem.telegramGiftId])
                    : null;

                if (!gift) {
                    gift = await get(
                        'SELECT * FROM gifts WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1',
                        [baseName]
                    );
                }

                // Only the isolated 100 TON path may create a missing catalog row.
                // This avoids global seed changes and keeps the Crash/round system untouched.
                if (!gift && catalogItem.telegramGiftId) {
                    await run(
                        'INSERT OR IGNORE INTO gifts (telegram_gift_id, name, slug, emoji, image_url, collection, rarity, value, total_supply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            catalogItem.telegramGiftId,
                            catalogItem.name,
                            catalogItem.slug || null,
                            '🎁',
                            catalogItem.image || null,
                            catalogItem.name,
                            'common',
                            LOOT_BOX_100_PRICE,
                            catalogItem.name === 'Rare Bird' ? 15000 : catalogItem.name === 'Westside Sign' ? 12000 : 10000
                        ]
                    );
                    gift = await get(
                        'SELECT * FROM gifts WHERE telegram_gift_id = ? LIMIT 1',
                        [catalogItem.telegramGiftId]
                    );
                }

                if (!gift) {
                    throw new Error('100 TON catalog is not ready: ' + baseName);
                }

                gifts.push({ ...gift, image_url: gift.image_url || catalogItem.image });
            }

            const balance = Number(await getUserBalance(req.user.id) || 0);
            if (balance < LOOT_BOX_100_PRICE) throw new Error('Insufficient balance');

            // Select one catalog entry at draw time. Black/Onyx Black entries
            // are visual variants of the same underlying gift record.
            const selectedIndex = Math.floor(Math.random() * LOOT_BOX_100_CATALOG.length);
            const selectedCatalogItem = LOOT_BOX_100_CATALOG[selectedIndex];
            const selectedGift = gifts[selectedIndex];

            // Capture the market value once for this opening. The same snapshot
            // is persisted on the pending gift and returned to the UI; it does not
            // change while the player is watching the result.
            let marketValueTon = 0;
            if (selectedCatalogItem.backdrop) {
                let special = await get100TonBackdropPriceSafe(selectedCatalogItem);
                if (!special?.value) special = await get100TonGeneralMarketPriceSafe(selectedCatalogItem);
                if (!special?.value) special = await get100TonTelegramMarketPriceSafe(selectedCatalogItem);
                marketValueTon = Number(special?.value || 0);
            } else {
                let market = await get100TonGeneralMarketPriceSafe(selectedCatalogItem);
                if (!market?.value) market = await get100TonTelegramMarketPriceSafe(selectedCatalogItem);
                marketValueTon = Number(market?.value || 0);
            }

            await updateUserBalance(req.user.id, LOOT_BOX_100_PRICE, 'subtract');

            const userGift = await addLootBoxGiftToUser(req.user.id, selectedGift.id, marketValueTon);
            const sellRate = Number(process.env.COLLECTIBLE_SELL_RATE || '0.89');
            const sellValue = marketValueTon > 0 && Number.isFinite(sellRate) && sellRate > 0 && sellRate <= 1
                ? Number((marketValueTon * sellRate).toFixed(9))
                : 0;

            await createNotification(
                req.user.id,
                'GIFT_WON',
                '🎁 You won ' + selectedGift.name +
                    (selectedCatalogItem.backdrop ? ' (' + selectedCatalogItem.backdrop + ')' : '') +
                    ' from the 100 TON box!',
                {
                    giftId: selectedGift.id,
                    box: '100 TON',
                    random: true,
                    backdrop: selectedCatalogItem.backdrop || null,
                    marketValueTon
                }
            );

            return {
                gift: {
                    ...selectedGift,
                    userGiftId: userGift.id,
                    lootBoxLockedUntil: userGift.loot_box_locked_until || null,
                    image_url: selectedCatalogItem.image || selectedGift.image_url,
                    backdrop: selectedCatalogItem.backdrop || null,
                    marketValue: marketValueTon,
                    value: marketValueTon,
                    sellValue
                },
                balance: Number((balance - LOOT_BOX_100_PRICE).toFixed(9)),
                marketValueTon
            };
        });

        res.json({ ok: true, ...result });
    } catch (error) {
        res.status(error.message === 'Insufficient balance' ? 400 : 503).json({ ok: false, error: error.message });
    }
});

// ===== 5.9 فتح صندوق الحظ =====
app.post('/api/lootbox/open', authenticate, async (req, res) => {
    try {
        const { boxId } = req.body;
        
        if (!boxId) {
            return res.status(400).json({ ok: false, error: 'boxId required' });
        }

        const result = await openLootbox(req.user.id, boxId);
        if (result?.userGiftId) await markGiftAsLootBoxReward(result.userGiftId);
        
        // إنشاء إشعار
        await createNotification(
            req.user.id,
            'GIFT_WON',
            `🎁 You won ${result.gift.name} from ${result.boxName}!`,
            { giftId: result.gift.id, boxName: result.boxName }
        );
        
        res.json({ 
            ok: true, 
            gift: result.gift,
            userGiftId: result.userGiftId,
            boxName: result.boxName
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.10 إنشاء إيداع =====
app.post('/api/deposit/create', authenticate, async (req, res) => {
    try {
        const { walletAddress, amount, payload } = req.body;
        const normalizedAmount = Number(String(amount ?? '').trim().replace(',', '.'));
        
        if (!walletAddress || !Number.isFinite(normalizedAmount) || normalizedAmount <= 0 || normalizedAmount > 100000) {
            return res.status(400).json({ ok: false, error: 'Invalid deposit data' });
        }
        if (!TON_DEPOSIT_RECEIVER) {
            return res.status(503).json({ ok: false, error: 'TON_DEPOSIT_RECEIVER is not configured' });
        }

        const deposit = await createDeposit(req.user.id, walletAddress, Number(normalizedAmount.toFixed(9)), payload);
        const amountNano = Math.round(Number(deposit.amount) * 1000000000).toString();
        const comment = `rocket-deposit:${deposit.id}`;
        res.json({ 
            ok: true, 
            receiver: TON_DEPOSIT_RECEIVER,
            amountNano,
            comment,
            deposit: {
                id: deposit.id,
                amount: deposit.amount,
                walletAddress: deposit.wallet_address,
                status: deposit.status,
                createdAt: deposit.created_at
            }
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/deposit/submit', authenticate, async (req, res) => {
    try {
        const { depositId, boc } = req.body;
        if (!depositId || !boc) return res.status(400).json({ ok: false, error: 'depositId and boc required' });
        const deposit = await saveDepositBoc(depositId, req.user.id, boc);
        res.json({ ok: true, depositId: deposit.id, status: deposit.status });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

// ===== 5.11 التحقق من حالة الإيداع =====
app.get('/api/deposit/status', authenticate, async (req, res) => {
    try {
        const { depositId } = req.query;
        
        if (!depositId) {
            return res.status(400).json({ ok: false, error: 'depositId required' });
        }

        const deposit = await get(
            'SELECT * FROM deposits WHERE id = ? AND user_id = ?', 
            [depositId, req.user.id]
        );
        
        if (!deposit) {
            return res.status(404).json({ ok: false, error: 'Deposit not found' });
        }

        if (deposit.status === 'PENDING') {
            try {
                const verified = await findVerifiedDepositTransaction(deposit);
                if (verified) {
                    await creditVerifiedDeposit(deposit.id, req.user.id, verified.transactionHash);
                }
            } catch (verificationError) {
                console.error('TON deposit verification error:', verificationError.message);
            }
            const refreshed = await get(
                'SELECT * FROM deposits WHERE id = ? AND user_id = ?',
                [depositId, req.user.id]
            );
            return res.json({
                ok: true,
                deposit: {
                    id: refreshed.id,
                    amount: refreshed.amount,
                    status: refreshed.status,
                    failureReason: refreshed.failure_reason,
                    createdAt: refreshed.created_at,
                    updatedAt: refreshed.updated_at
                }
            });
        }
        
        res.json({ 
            ok: true, 
            deposit: {
                id: deposit.id,
                amount: deposit.amount,
                status: deposit.status,
                failureReason: deposit.failure_reason,
                createdAt: deposit.created_at,
                updatedAt: deposit.updated_at
            }
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.11 TON Connect Proof =====
app.get('/api/ton-proof/payload', authenticate, async (req, res) => {
    try { res.json({ ok: true, payload: issueTonProofPayload(req.user.id), domain: TON_CONNECT_PROOF_DOMAIN, network: TON_CONNECT_PROOF_NETWORK }); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});
app.post('/api/ton-proof/verify', authenticate, async (req, res) => {
    try { const address = await verifyTonConnectProof({ ...req.body, userId: req.user.id }); res.json({ ok: true, address, verified: true }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
});

// ===== 5.12 طلب سحب الأرباح =====
app.post('/api/withdrawal/request', authenticate, async (req, res) => {
    let withdrawal = null;
    try {
        const normalizedAddress = getVerifiedTonWallet(req.user.id);
        const normalizedAmount = Number(String(req.body?.amount ?? '').trim().replace(',', '.'));
        if (!normalizedAddress) return res.status(428).json({ ok: false, error: 'TON wallet ownership proof is required. Reconnect your wallet to verify ownership.' });
        if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0.1 || normalizedAmount > 100000) return res.status(400).json({ ok: false, error: 'Invalid withdrawal data' });
        withdrawal = await createWithdrawalRequest(req.user.id, normalizedAddress, Number(normalizedAmount.toFixed(9)));
        await markWithdrawalProcessing(withdrawal.id);
        const processing = await get('SELECT * FROM withdrawals WHERE id = ?', [withdrawal.id]);
        const txRef = await sendRealTonWithdrawal(processing);
        const paid = await completeWithdrawal(withdrawal.id, txRef);
        res.json({ ok: true, withdrawal: { id: paid.id, amount: paid.amount, walletAddress: paid.wallet_address, status: paid.status, transactionHash: paid.transaction_hash, createdAt: paid.created_at }, balance: await getUserBalance(req.user.id), message: 'Withdrawal sent successfully.' });
    } catch (error) {
        if (withdrawal?.id) { try { await refundFailedWithdrawal(withdrawal.id, error.message); } catch (refundError) { console.error('WITHDRAWAL REFUND ERROR:', refundError); } }
        const message = error.message || 'Withdrawal failed';
        const status = /not configured|configuration does not match|insufficient|not confirmed/i.test(message) ? 503 : 400;
        res.status(status).json({ ok: false, error: message });
    }
});
app.get('/api/withdrawal/history', authenticate, async (req, res) => {
    try {
        const withdrawals = await getUserWithdrawals(req.user.id);
        res.json({
            ok: true,
            withdrawals: withdrawals.map(item => ({
                id: item.id,
                amount: item.amount,
                walletAddress: item.wallet_address,
                status: item.status,
                transactionHash: item.transaction_hash,
                failureReason: item.failure_reason,
                createdAt: item.created_at,
                updatedAt: item.updated_at
            }))
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.12 جلب إشعارات المستخدم =====
app.get('/api/notifications', authenticate, async (req, res) => {
    try {
        const notifications = await getNotifications(req.user.id);
        res.json({ ok: true, notifications });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.13 جلب إحصائيات المستخدم =====
app.get('/api/referral', authenticate, async (req, res) => {
    try {
        const overview = await getReferralOverview(req.user.id);
        const info = await getTelegramBotLaunchInfo();
        const link = info.username ? `https://t.me/${info.username}?startapp=ref_${overview.referralCode}` : null;
        res.json({ ok: true, ...overview, inviteLink: link, commissionPercent: 10 });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/stats', authenticate, async (req, res) => {
    try {
        const stats = await get('SELECT * FROM user_stats WHERE user_id = ?', [req.user.id]);
        res.json({ ok: true, stats: stats || { total_rounds: 0, total_wins: 0, total_losses: 0 } });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.13A Weekly activity leaderboard =====
// Isolated from Crash, core game settlement, reward probabilities, and FREE/FREE24.
app.get('/api/spender-leaderboard', authenticate, async (req, res) => {
    try {
        const leaderboard = await getWeeklyLeaderboard(req.user.id);
        res.json({ ok: true, ...leaderboard });
    } catch (error) {
        console.error('Weekly leaderboard error:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get('/api/weekly-leaderboard', authenticate, async (req, res) => {
    try {
        const leaderboard = await getWeeklyLeaderboard(req.user.id);
        res.json({ ok: true, ...leaderboard });
    } catch (error) {
        console.error('Weekly leaderboard error:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.14 جلب جميع الهدايا المتاحة (للعرض) =====
app.get('/api/gifts/all', authenticate, async (req, res) => {
    try {
        const gifts = await query('SELECT * FROM gifts ORDER BY value DESC');
        res.json({ ok: true, gifts });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.15 جلب جميع الصناديق =====
app.get('/api/lootboxes', authenticate, async (req, res) => {
    try {
        const boxes = await query('SELECT * FROM lootboxes ORDER BY price ASC');
        res.json({ ok: true, boxes });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// =========================================================
// 6. بدء تشغيل السيرفر
// =========================================================
async function initializeTelegramRocketCatalog() {
    if (!String(process.env.TELEGRAM_SESSION_STRING || '').trim()) {
        console.warn('🚀 Stellar Rocket MTProto: TELEGRAM_SESSION_STRING is not configured; rocket catalog remains unavailable');
        return;
    }
    try {
        await refreshTelegramRocketCatalog(true);
    } catch (error) {
        console.error('🚀 Stellar Rocket catalog warm-up failed:', error.message);
    }
}

async function verifyTonTreasuryConfiguration() {
    if (!TON_TREASURY_MNEMONIC || !TON_DEPOSIT_RECEIVER) {
        console.log('💰 TON treasury configuration check: SKIPPED (missing treasury variables)');
        return { configured: false, match: false };
    }

    try {
        const words = TON_TREASURY_MNEMONIC.trim().split(/\s+/);
        const keyPair = await mnemonicToPrivateKey(words);
        const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey, walletId: { networkGlobalId: -239 } });
        const derivedAddress = canonicalTonAddress(wallet.address.toString());
        const configuredAddress = canonicalTonAddress(TON_DEPOSIT_RECEIVER);
        const match = !!derivedAddress && !!configuredAddress && derivedAddress === configuredAddress;

        console.log('💰 TON treasury wallet check:', JSON.stringify({
            configured: true,
            walletType: 'WalletContractV5R1',
            matchesDepositReceiver: match
        }));

        if (!match) {
            console.error('❌ TON treasury wallet check FAILED: derived treasury wallet does not match TON_DEPOSIT_RECEIVER');
        } else {
            console.log('✅ TON treasury wallet check PASSED');
        }

        return { configured: true, match };
    } catch (error) {
        console.error('❌ TON treasury wallet check ERROR:', error.message);
        return { configured: true, match: false };
    }
}

async function getTelegramBotLaunchInfo() {
    try {
        const me = await callTelegramBotApi('getMe', {});
        return { username: me.username || null, id: me.id || null };
    } catch (error) {
        console.error('Failed to get Telegram bot launch info:', error.message);
        return { username: null, id: null };
    }
}

app.get('/api/telegram/launch-info', async (req, res) => {
    try {
        const info = await getTelegramBotLaunchInfo();
        res.json({
            ok: true,
            botUsername: info.username,
            menuUrl: info.username ? `https://t.me/${info.username}` : null
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

async function sendTelegramMiniAppLaunchMessage(chatId) {
    const webAppUrl = 'https://my-rocket-production-150d.up.railway.app/';
    await callTelegramBotApi('sendMessage', {
        chat_id: chatId,
        text: '🚀 افتح Rocket من الزر بالأسفل للدخول إلى اللعبة بحساب Telegram الخاص بك.',
        reply_markup: {
            inline_keyboard: [[{
                text: '🚀 فتح Rocket',
                web_app: { url: webAppUrl }
            }]]
        }
    });
}

async function ensureTelegramMiniAppMenuButton() {
    const webAppUrl = 'https://my-rocket-production-150d.up.railway.app/';
    try {
        await callTelegramBotApi('setChatMenuButton', {
            menu_button: {
                type: 'web_app',
                text: '🚀 Rocket',
                web_app: { url: webAppUrl }
            }
        });
        console.log('🚀 Telegram Mini App menu button configured');
    } catch (error) {
        console.error('Failed to configure Telegram Mini App menu button:', error.message);
    }
}

async function startServer(port = PORT) {
    try {
        // تهيئة قاعدة البيانات
        await initDatabase();
        await seedDatabase();
        await initializeLeaderboard();
        startLeaderboardCycleWorker();
        console.log('✅ Database initialized and seeded');

        await verifyTonTreasuryConfiguration();

        try {
            const businessConnection = await ensureRuntimeBusinessConnection();
            console.log('🔗 Telegram Business connection startup state:', JSON.stringify({
                configured: !!TELEGRAM_BUSINESS_CONNECTION_ID,
                discovered: !!businessConnection.id,
                canViewGiftsAndStars: businessConnection.canViewGiftsAndStars,
                isEnabled: businessConnection.isEnabled
            }));
        } catch (error) {
            console.error('Failed to initialize Telegram business connection:', error.message);
        }

        try {
            await ensureTelegramWebhookConfigured();
        } catch (error) {
            console.error('Failed to ensure Telegram webhook configuration:', error.message);
        }

        await ensureTelegramMiniAppMenuButton();
        const launchInfo = await getTelegramBotLaunchInfo();
        console.log('🤖 Telegram bot launch identity:', JSON.stringify({
            configured: !!launchInfo.username,
            username: launchInfo.username || null,
            menuUrlConfigured: !!launchInfo.username
        }));

        const latestRound = await get('SELECT MAX(round_number) AS round_number FROM rounds');
        const nextRoundNumber = Number(latestRound?.round_number || 0) + 1;
        await startRound(nextRoundNumber);

        // بدء حلقة اللعبة
        startGameLoop();
        console.log('🎮 Game loop started');
        startPvpGameLoop();
        startCollectibleReconciliationWorker();

        // Warm the Telegram Stellar Rocket catalog without ever blocking or modifying the game loop.
        // Failure here only disables the optional rocket-media feature.
        initializeTelegramRocketCatalog().catch(error => {
            console.error('🚀 Stellar Rocket MTProto initialization failed:', error.message);
        });

        // بدء السيرفر
        return await new Promise((resolve, reject) => {
            const server = app.listen(port, () => {
                console.log(`🚀 Server running on http://localhost:${server.address().port}`);
                console.log(`📊 Database: ${process.env.DATABASE_PATH || 'rocket.db'}`);
                console.log(`🤖 BOT_TOKEN: ${BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE' ? '⚠️ NOT SET' : '✅ SET'}`);
                resolve(server);
            });
            server.once('error', reject);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        throw error;
    }
}

if (require.main === module) {
    startServer().catch(error => {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    });

    // =========================================================
    // 7. التعامل مع إغلاق السيرفر
    // =========================================================
    const shutdown = () => {
        console.log('\n🛑 Shutting down server...');
        stopGameLoop();
        stopPvpGameLoop();
        stopLeaderboardCycleWorker();
        db.close(() => {
            console.log('✅ Database closed');
            process.exit(0);
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = {
    app,
    startServer,
    stopGameLoop,
    startRound,
    launchRound,
    processAutoCashouts,
    crashCurrentRound,
    getGameStateSnapshot,
    updateGameState,
    MAX_CRASH_MULTIPLIER,
    ENABLE_TEST_BALANCE,
    // Exported for tests only — real request handling never uses these directly.
    extractUniqueCollectibleIdentity,
    canonicalCollectibleSlug,
    extractBusinessConnectionIdFromUpdate,
    runCollectibleVerificationSweep,
    paginateCollectibleGifts,
    notifyCollectibleClients,
    registerCollectibleClient,
    unregisterCollectibleClient,
    startCollectibleReconciliationWorker,
    stopCollectibleReconciliationWorker,
    stopPvpGameLoop,
    getPvpStateSnapshot,
    resolveTelegramFilePath,
    streamTelegramFile
};