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
