'use strict';

const crypto = require('crypto');

const HOUSE_EDGE = 0.05;
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
    return Math.max(1, Math.floor(raw * 100) / 100);
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
