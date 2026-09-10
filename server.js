// =========================================================
// server.js - السيرفر الرئيسي المتكامل
// متوافق مع database.js ومع الـ Frontend القادم
// =========================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
require('dotenv').config();
const {
    DEFAULT_CLIENT_SEED,
    createFairRound,
    shouldAutoCashout
} = require('./crashFair');

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
    getUserBalance,
    updateUserBalance,
    getUserGifts,
    getGiftById,
    addGiftToUser,
    updateGiftStatus,
    getUserCollectibles,
    createOrGetImportIntent,
    getLatestImportIntentForUser,
    getPendingIntentByTelegramSenderId,
    isCollectibleAlreadyCredited,
    creditVerifiedCollectible,
    savePersistedBusinessConnection,
    getPersistedBusinessConnection,
    hasProcessedWebhookUpdate,
    markWebhookUpdateProcessed,
    getCollectibleByUniqueId,
    placeGiftBet,
    cashoutGiftBet,
    placeTonBet,
    cashoutTonBet,
    openLootbox,
    createDeposit,
    saveDepositBoc,
    creditVerifiedDeposit,
    updateDepositStatus,
    updateUserStats,
    createNotification,
    getNotifications,
    createRoundRecord,
    getRoundByNumber,
    updateRoundState,
    getActiveBetsForRound,
    getRoundPlayers,
    cashoutBet,
    crashRound
} = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================
// Middleware
// =========================================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// =========================================================
// 1. المصادقة والتحقق من Telegram
// =========================================================
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TON_DEPOSIT_RECEIVER = process.env.TON_DEPOSIT_RECEIVER || '';
const TONCENTER_API_URL = process.env.TONCENTER_API_URL || 'https://toncenter.com/api/v2';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';
// Phase 3B: server-only config for the managed Telegram business account that receives collectibles.
// Never exposed to the frontend. Real verification only runs once this is configured on the Telegram side.
const TELEGRAM_BUSINESS_CONNECTION_ID = process.env.TELEGRAM_BUSINESS_CONNECTION_ID || '';
const ADMIN_TELEGRAM_ID = '7385640899';
// Optional but recommended: Telegram's official secret_token mechanism for webhook authenticity.
// Never logged. When unset, the webhook still works but cannot verify the caller is really Telegram.
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

// In-memory only (does not survive a restart): populated by /telegram-webhook once a real
// business_connection update arrives. No database migration performed for this yet.
let runtimeBusinessConnection = {
    id: null,
    businessUserId: null,
    canViewGiftsAndStars: false,
    isEnabled: false,
    updatedAt: null
};

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

// يجلب الهدايا المملوكة لحساب اللعبة التجاري على Telegram عبر الـ Business API الرسمي فقط.
async function fetchBusinessAccountGifts() {
    const connectionId = TELEGRAM_BUSINESS_CONNECTION_ID || runtimeBusinessConnection.id;
    if (!connectionId) {
        throw new Error('TELEGRAM_BUSINESS_CONNECTION_ID is not configured');
    }
    const result = await callTelegramBotApi('getBusinessAccountGifts', {
        business_connection_id: connectionId
    });
    return Array.isArray(result?.gifts) ? result.gifts : [];
}

// يستخرج الهوية الفريدة الرسمية لهدية Telegram Collectible فقط (يتجاهل النجوم/الهدايا العادية).
function extractUniqueCollectibleIdentity(ownedGift) {
    const uniqueGift = ownedGift?.gift;
    if (!ownedGift || ownedGift.type !== 'unique' || !uniqueGift) return null;
    if (!uniqueGift.name || !Number.isFinite(uniqueGift.number)) return null;

    // Raw Telegram file_id — NOT a browser-usable URL. Resolved on-demand via the
    // /api/collectible-media proxy, never sent to the frontend directly.
    const stickerFileId = uniqueGift.model?.sticker?.file_id || uniqueGift.model?.sticker?.thumbnail?.file_id || null;

    return {
        uniqueCollectibleId: `${uniqueGift.name}-${uniqueGift.number}`,
        telegramGiftInstanceId: String(ownedGift.owned_gift_id || ''),
        collectibleNumber: uniqueGift.number,
        senderTelegramId: ownedGift.sender_user?.id || null,
        telegramGiftModel: {
            telegramGiftId: uniqueGift.base_name || uniqueGift.name,
            name: uniqueGift.model?.name || uniqueGift.base_name || uniqueGift.name,
            slug: `${uniqueGift.name}-${uniqueGift.number}`,
            imageUrl: null, // real media is resolved server-side through the media proxy only
            collection: uniqueGift.backdrop?.name || null,
            rarity: 'common',
            value: 0,
            totalSupply: 0
        },
        verifiedMetadata: JSON.stringify({
            name: uniqueGift.name,
            number: uniqueGift.number,
            model: uniqueGift.model?.name || null,
            symbol: uniqueGift.symbol?.name || null,
            backdrop: uniqueGift.backdrop?.name || null,
            stickerFileId
        }),
        stickerFileId
    };
}

// مسح دوري يطابق الهدايا الواردة الحقيقية بأصحاب intents المعلّقة عبر sender_user.id فقط (لا تخمين).
// fetchGiftsFn قابل للحقن للاختبارات فقط (افتراضيًا يستخدم استدعاء Telegram الحقيقي).
async function runCollectibleVerificationSweep(fetchGiftsFn = fetchBusinessAccountGifts) {
    const connectionId = TELEGRAM_BUSINESS_CONNECTION_ID || runtimeBusinessConnection.id;
    if (!connectionId) {
        return { configured: false, credited: 0, unmatched: 0 };
    }
    const ownedGifts = await fetchGiftsFn();
    let credited = 0;
    let unmatched = 0;

    for (const ownedGift of ownedGifts) {
        const identity = extractUniqueCollectibleIdentity(ownedGift);
        if (!identity) continue;

        const alreadyCredited = await isCollectibleAlreadyCredited(identity.uniqueCollectibleId, identity.telegramGiftInstanceId);
        if (alreadyCredited) continue;

        if (!identity.senderTelegramId) { unmatched++; continue; }

        const user = await get('SELECT * FROM users WHERE telegram_id = ?', [String(identity.senderTelegramId)]);
        if (!user) { unmatched++; continue; }

        const intent = await getPendingIntentByTelegramSenderId(identity.senderTelegramId);

        await creditVerifiedCollectible({
            intentId: intent ? intent.id : null,
            userId: user.id,
            telegramGiftModel: identity.telegramGiftModel,
            uniqueCollectibleId: identity.uniqueCollectibleId,
            telegramGiftInstanceId: identity.telegramGiftInstanceId,
            collectibleNumber: identity.collectibleNumber,
            verifiedMetadata: identity.verifiedMetadata,
            stickerFileId: identity.stickerFileId
        });
        credited++;
    }

    return { configured: true, credited, unmatched };
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

// ===== Telegram Business Connection webhook (Phase 3B) =====
// Receives ONLY the official business_connection update; ignores every other Telegram update type.
// Never invents/hardcodes a connection id — it only stores whatever Telegram itself sends.
app.post('/telegram-webhook', async (req, res) => {
    // Official Telegram secret_token check (set via setWebhook secret_token). If configured on our
    // side but the header is missing/wrong, reject before doing anything else — never processed.
    if (TELEGRAM_WEBHOOK_SECRET) {
        const providedSecret = req.headers['x-telegram-bot-api-secret-token'] || '';
        const expected = Buffer.from(TELEGRAM_WEBHOOK_SECRET);
        const provided = Buffer.from(String(providedSecret));
        const isValid = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
        if (!isValid) {
            res.status(401).end();
            return;
        }
    }

    res.status(200).json({ ok: true }); // Telegram requires a fast 200 regardless of internal handling.

    try {
        const update = req.body || {};

        // Idempotency: Telegram may redeliver the same update_id on timeout/retry.
        if (Number.isFinite(update.update_id)) {
            const alreadyProcessed = await hasProcessedWebhookUpdate(update.update_id);
            if (alreadyProcessed) return;
            await markWebhookUpdateProcessed(update.update_id);
        }

        const connection = update.business_connection;
        if (!connection) {
            const updateType = Object.keys(update).find(key => key !== 'update_id') || 'unknown';
            console.log(`ℹ️ Telegram webhook: ignored unrelated update type "${updateType}"`);
            return;
        }

        const canViewGiftsAndStars = !!connection.rights?.can_view_gifts_and_stars;
        runtimeBusinessConnection = {
            id: connection.id || null,
            businessUserId: connection.user?.id || null,
            canViewGiftsAndStars,
            isEnabled: !!connection.is_enabled,
            updatedAt: new Date().toISOString()
        };

        // Persist across restarts — public connection metadata only, never a secret.
        await savePersistedBusinessConnection({
            connectionId: runtimeBusinessConnection.id,
            businessUserId: runtimeBusinessConnection.businessUserId,
            canViewGiftsAndStars: runtimeBusinessConnection.canViewGiftsAndStars,
            isEnabled: runtimeBusinessConnection.isEnabled
        });

        // Never log BOT_TOKEN, secrets, or the raw update payload — presence/flags only.
        console.log('🔗 Telegram business_connection update:', JSON.stringify({
            updateType: 'business_connection',
            hasConnectionId: !!runtimeBusinessConnection.id,
            businessUserId: runtimeBusinessConnection.businessUserId,
            canViewGiftsAndStars: runtimeBusinessConnection.canViewGiftsAndStars,
            isEnabled: runtimeBusinessConnection.isEnabled
        }));

        if (!canViewGiftsAndStars) {
            console.warn('⚠️ Business connection is missing can_view_gifts_and_stars — collectible verification cannot use it yet.');
        }
    } catch (error) {
        console.error('Telegram webhook handling error:', error.message);
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
    currentGameState.players = rows.map(row => ({
        id: `${row.bet_type}:${row.bet_id}`,
        name: buildPlayerDisplayName(row.first_name, row.last_name),
        amount: row.amount,
        status: row.status,
        multiplier: row.multiplier
    }));
}

async function startRound(roundNumber) {
    if (roundTransitionTimer) clearTimeout(roundTransitionTimer);
    roundTransitionTimer = null;
    const fairRound = createFairRound(roundNumber, DEFAULT_CLIENT_SEED);
    await createRoundRecord(fairRound);
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
    console.log(`🔐 Round ${roundNumber} committed: ${fairRound.serverSeedHash}`);
}

async function launchRound() {
    if (currentGameState.phase !== 'COUNTDOWN') return;
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
// 5. API Routes
// =========================================================

// ===== 5.1 المصادقة =====
app.post('/api/auth', async (req, res) => {
    try {
        const { initData } = req.body;
        
        if (!initData) {
            return res.status(400).json({ ok: false, error: 'initData required' });
        }

        if (!verifyTelegramData(initData)) {
            return res.status(401).json({ ok: false, error: 'Invalid Telegram data' });
        }

        const params = new URLSearchParams(initData);
        const userData = JSON.parse(params.get('user'));
        
        const user = await findOrCreateUser(userData.id, {
            username: userData.username,
            first_name: userData.first_name,
            last_name: userData.last_name,
            avatar_url: userData.photo_url
        });

        // تحديث initData في قاعدة البيانات
        await run('UPDATE users SET init_data = ? WHERE id = ?', [initData, user.id]);

        res.json({ 
            ok: true, 
            user: {
                id: user.id,
                telegram_id: user.telegram_id,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                avatar_url: user.avatar_url,
                balance: user.balance
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

// ===== 5.3 جلب هدايا المستخدم =====
app.get('/api/gifts', authenticate, async (req, res) => {
    try {
        const gifts = await getUserGifts(req.user.id);
        res.json({ ok: true, gifts });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.3.1 جلب مقتنيات Telegram الحقيقية الموثّقة فقط (Phase 3A/3B) =====
app.get('/api/collectibles', authenticate, async (req, res) => {
    try {
        try {
            await runCollectibleVerificationSweep();
        } catch (sweepErr) {
            // Sweep failure logged silently so user can still view already verified collectibles
            console.error('Sweep error on GET /api/collectibles:', sweepErr.message);
        }

        const rows = await getUserCollectibles(req.user.id);
        const collectibles = rows
            .filter(row => row.ownership_verified === 1 && row.unique_collectible_id)
            .map(row => {
                let hasStickerMedia = false;
                try {
                    const metadata = row.verified_metadata ? JSON.parse(row.verified_metadata) : null;
                    hasStickerMedia = !!(metadata && metadata.stickerFileId);
                } catch { /* malformed metadata simply means no media available */ }

                return {
                    id: row.unique_collectible_id,
                    userGiftId: row.user_gift_id,
                    name: row.name,
                    imageUrl: hasStickerMedia
                        ? `${req.protocol}://${req.get('host')}/api/collectible-media/${encodeURIComponent(row.unique_collectible_id)}`
                        : null,
                    collectibleNumber: row.collectible_number,
                    rarity: row.rarity,
                    value: row.value,
                    status: row.ownership_status,
                    verifiedMetadata: row.verified_metadata,
                    receivedAt: row.received_at
                };
            });
        res.json({ ok: true, collectibles });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.3.1.1 وسيط وسائط المقتنى الحقيقي (Phase 3B) — لا يقبل أي file_id من العميل إطلاقًا =====
// المُدخل الوحيد المقبول هو unique_collectible_id (نفس المعرّف العلني المستخدم في الرهان)،
// ويُتحقق أنه ينتمي فعلًا لقطعة verified في قاعدتنا قبل أي اتصال بـ Telegram. لا يُكشف BOT_TOKEN أبداً.
app.get('/api/collectible-media/:uniqueCollectibleId', async (req, res) => {
    try {
        const collectible = await getCollectibleByUniqueId(req.params.uniqueCollectibleId);
        if (!collectible || collectible.ownership_verified !== 1) {
            res.status(404).end();
            return;
        }

        let stickerFileId = collectible.telegram_thumbnail_file_id || null;
        if (!stickerFileId) {
            try {
                const metadata = collectible.verified_metadata ? JSON.parse(collectible.verified_metadata) : null;
                stickerFileId = metadata ? metadata.stickerFileId : null;
            } catch { /* malformed metadata → no media */ }
        }

        if (!stickerFileId) {
            res.status(404).end();
            return;
        }

        const filePath = await resolveTelegramFilePath(stickerFileId);
        await streamTelegramFile(filePath, res);
    } catch (error) {
        console.error('collectible-media error:', error.message);
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

// ===== 5.3.4 حالة اتصال Business (محمي/إداري فقط) — لا يكشف قيمة business_connection_id أبداً =====
app.get('/api/admin/business-connection-status', authenticate, async (req, res) => {
    if (req.user.telegram_id !== ADMIN_TELEGRAM_ID) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
    }
    res.json({
        ok: true,
        envConfigured: !!TELEGRAM_BUSINESS_CONNECTION_ID,
        runtimeDiscovered: !!runtimeBusinessConnection.id,
        businessUserId: runtimeBusinessConnection.businessUserId,
        canViewGiftsAndStars: runtimeBusinessConnection.canViewGiftsAndStars,
        isEnabled: runtimeBusinessConnection.isEnabled,
        updatedAt: runtimeBusinessConnection.updatedAt
    });
});

// ===== 5.3.5 إعداد Telegram webhook (محمي/إداري فقط) — لا يكشف BOT_TOKEN أبداً =====
const TELEGRAM_WEBHOOK_URL = 'https://my-rocket-production.up.railway.app/telegram-webhook';

app.post('/api/admin/setup-telegram-webhook', authenticate, async (req, res) => {
    if (req.user.telegram_id !== ADMIN_TELEGRAM_ID) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
    }
    try {
        const payload = { url: TELEGRAM_WEBHOOK_URL };
        if (TELEGRAM_WEBHOOK_SECRET) payload.secret_token = TELEGRAM_WEBHOOK_SECRET;
        await callTelegramBotApi('setWebhook', payload);
        res.json({ ok: true, success: true, url: TELEGRAM_WEBHOOK_URL, secretConfigured: !!TELEGRAM_WEBHOOK_SECRET });
    } catch (error) {
        // callTelegramBotApi never includes BOT_TOKEN in its error messages.
        res.status(400).json({ ok: false, success: false, error: error.message });
    }
});

app.get('/api/admin/telegram-webhook-status', authenticate, async (req, res) => {
    if (req.user.telegram_id !== ADMIN_TELEGRAM_ID) {
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
        const balance = await getUserBalance(req.user.id);
        res.json({ ok: true, balance });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ===== 5.5 الرهان بالهدية =====
app.post('/api/bet/gift', authenticate, async (req, res) => {
    try {
        const { giftId, autoCashoutTarget } = req.body;
        
        if (!giftId) {
            return res.status(400).json({ ok: false, error: 'giftId required' });
        }

        // التحقق من أن الجولة في مرحلة COUNTDOWN
        if (currentGameState.phase !== 'COUNTDOWN') {
            return res.status(400).json({ ok: false, error: 'Betting only allowed during COUNTDOWN' });
        }

        const roundId = currentGameState.roundId;
        const result = await placeGiftBet(req.user.id, giftId, roundId, autoCashoutTarget);
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
        
        // إنشاء إشعار
        await createNotification(
            req.user.id,
            'BET_WON',
            `🎉 You cashed out! ${result.payout.toFixed(2)} TON from gift`,
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

// ===== 5.7 الرهان بـ TON =====
app.post('/api/bet/ton', authenticate, async (req, res) => {
    try {
        const { amount, autoCashoutTarget } = req.body;
        const normalizedAmount = Number(String(amount ?? '').trim().replace(',', '.'));
        
        if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0.1) {
            return res.status(400).json({ ok: false, error: 'Invalid amount' });
        }

        // التحقق من أن الجولة في مرحلة COUNTDOWN
        if (currentGameState.phase !== 'COUNTDOWN') {
            return res.status(400).json({ ok: false, error: 'Betting only allowed during COUNTDOWN' });
        }

        const roundId = currentGameState.roundId;
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

// ===== 5.8 سحب TON (Cash Out) =====
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

// ===== 5.9 فتح صندوق الحظ =====
app.post('/api/lootbox/open', authenticate, async (req, res) => {
    try {
        const { boxId } = req.body;
        
        if (!boxId) {
            return res.status(400).json({ ok: false, error: 'boxId required' });
        }

        const result = await openLootbox(req.user.id, boxId);
        
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
app.get('/api/stats', authenticate, async (req, res) => {
    try {
        const stats = await get('SELECT * FROM user_stats WHERE user_id = ?', [req.user.id]);
        res.json({ ok: true, stats: stats || { total_rounds: 0, total_wins: 0, total_losses: 0 } });
    } catch (error) {
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
async function startServer(port = PORT) {
    try {
        // تهيئة قاعدة البيانات
        await initDatabase();
        await seedDatabase();
        console.log('✅ Database initialized and seeded');

        // استعادة حالة Telegram Business Connection المحفوظة (إن وُجدت) بعد إعادة تشغيل السيرفر.
        try {
            const persisted = await getPersistedBusinessConnection();
            if (persisted && persisted.connection_id) {
                runtimeBusinessConnection = {
                    id: persisted.connection_id,
                    businessUserId: persisted.business_user_id,
                    canViewGiftsAndStars: !!persisted.can_view_gifts_and_stars,
                    isEnabled: !!persisted.is_enabled,
                    updatedAt: persisted.updated_at
                };
                console.log('🔗 Restored persisted Telegram business connection state from database.');
            }
        } catch (error) {
            console.error('Failed to restore persisted business connection:', error.message);
        }

        const latestRound = await get('SELECT MAX(round_number) AS round_number FROM rounds');
        const nextRoundNumber = Number(latestRound?.round_number || 0) + 1;
        await startRound(nextRoundNumber);

        // بدء حلقة اللعبة
        startGameLoop();
        console.log('🎮 Game loop started');
        startCollectibleReconciliationWorker();

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
    // Exported for tests only — real request handling never uses these directly.
    extractUniqueCollectibleIdentity,
    runCollectibleVerificationSweep,
    startCollectibleReconciliationWorker,
    stopCollectibleReconciliationWorker
};
