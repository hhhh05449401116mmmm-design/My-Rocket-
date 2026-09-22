'use strict';

const crypto = require('crypto');

const HOUSE_EDGE = 0.05;
const MAX_CRASH_MULTIPLIER = 220.00;
const DEFAULT_CLIENT_SEED = 'my-rocket-public-v1';
const UINT52_SCALE = 2 ** 52;

function generateServerSeed() {
    return crypto.randomBytes(32).toString('hex');
}

function hashServerSeed(serverSeed) {
    return crypto.createHash('sha256').update(serverSeed, 'utf8').digest('hex');
}

function deriveUniform(serverSeed, clientSeed, nonce) {
    const message = `${clientSeed}:${nonce}`;
    const digest = crypto.createHmac('sha256', serverSeed)
        .update(message, 'utf8')
        .digest();
    const value = digest.readBigUInt64BE(0) >> 12n;
    return Number(value) / UINT52_SCALE;
}

function calculateCrashAt(uniform) {
    if (!Number.isFinite(uniform) || uniform < 0 || uniform >= 1) {
        throw new RangeError('Uniform value must be in [0, 1)');
    }

    const raw = (1 - HOUSE_EDGE) / (1 - uniform);
    const capped = Math.max(1, Math.floor(raw * 100) / 100);

    // When raw exceeds the cap, the old Math.min(220, capped) would collapse
    // the entire tail [220, +inf) into exactly 220.00 — an artificial probability
    // spike where ~0.43% of all rounds land on a single value.
    //
    // Instead, remap the tail into (219.00, 220.00) using the asymptotic
    // transform  MAX - MAX/raw  which maps [MAX, +inf) monotonically to
    // [MAX-1, MAX). This spreads the tail probability across 100 discrete
    // buckets (219.00..219.99) instead of collapsing it into one.
    //
    // - All values with raw < 220 are unchanged (identical to original formula).
    // - House edge for any target < 219 is preserved exactly.
    // - 220.00 is never produced (approached asymptotically as uniform → 1).
    // - The transform is deterministic and verifiable.
    if (capped >= MAX_CRASH_MULTIPLIER) {
        const tailCrashAt = MAX_CRASH_MULTIPLIER - MAX_CRASH_MULTIPLIER / raw;
        return Math.max(1, Math.floor(tailCrashAt * 100) / 100);
    }

    return capped;
}

function calculateCrashAtFromSeed(serverSeed, clientSeed, nonce) {
    return calculateCrashAt(deriveUniform(serverSeed, clientSeed, nonce));
}

function shouldAutoCashout(target, multiplier, crashAt) {
    return Number.isFinite(target)
        && Number.isFinite(multiplier)
        && Number.isFinite(crashAt)
        && target > 1
        && target <= multiplier
        && target <= crashAt;
}

function createFairRound(nonce, clientSeed = DEFAULT_CLIENT_SEED) {
    const serverSeed = generateServerSeed();
    return {
        nonce,
        clientSeed,
        serverSeed,
        serverSeedHash: hashServerSeed(serverSeed),
        crashAt: calculateCrashAtFromSeed(serverSeed, clientSeed, nonce)
    };
}

function verifyFairRound(serverSeed, serverSeedHash, clientSeed, nonce, crashAt) {
    return hashServerSeed(serverSeed) === serverSeedHash
        && calculateCrashAtFromSeed(serverSeed, clientSeed, nonce) === crashAt;
}

module.exports = {
    HOUSE_EDGE,
    MAX_CRASH_MULTIPLIER,
    DEFAULT_CLIENT_SEED,
    generateServerSeed,
    hashServerSeed,
    deriveUniform,
    calculateCrashAt,
    calculateCrashAtFromSeed,
    shouldAutoCashout,
    createFairRound,
    verifyFairRound
};
