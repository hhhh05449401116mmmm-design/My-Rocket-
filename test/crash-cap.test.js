'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');

const fair = require('../crashFair');

test('no crash result exceeds 220x cap', () => {
    for (let nonce = 1; nonce <= 100000; nonce++) {
        const round = fair.createFairRound(nonce);
        assert.ok(round.crashAt <= 220.00, `crashAt ${round.crashAt} exceeds 220 cap (nonce ${nonce})`);
        assert.ok(round.crashAt > 0, `crashAt must be positive (nonce ${nonce})`);
    }
    assert.equal(fair.MAX_CRASH_MULTIPLIER, 220.00);
});

test('220x is rare — no artificial spike', () => {
    let count220 = 0;
    const samples = 50000;
    for (let nonce = 1; nonce <= samples; nonce++) {
        const round = fair.createFairRound(nonce);
        if (round.crashAt === 220.00) count220++;
    }
    const rate = count220 / samples;
    // With tail remapping, 220.00 is never produced — zero spike.
    assert.equal(rate, 0, `220x rate ${rate.toFixed(6)} must be exactly 0 — no artificial spike`);
});

test('no artificial spike at any high-multiplier bucket near 220', () => {
    // Count how many results fall in narrow buckets near 220
    const buckets = {};
    const samples = 500000;
    for (let nonce = 1; nonce <= samples; nonce++) {
        const round = fair.createFairRound(nonce);
        if (round.crashAt >= 219.0 && round.crashAt <= 220.0) {
            const bucket = Math.floor(round.crashAt * 10) / 10;
            buckets[bucket.toFixed(1)] = (buckets[bucket.toFixed(1)] || 0) + 1;
        }
    }
    const vals = Object.values(buckets);
    if (vals.length >= 2) {
        const max = Math.max(...vals);
        const min = Math.min(...vals);
        // No single 0.1-wide bucket should dominate others by >100x
        // (original spike had 220.00 with ~43000 vs ~1-4 for neighbors)
        assert.ok(max / Math.max(min, 1) < 100,
            `Extreme bucket ratio ${max}/${min} suggests a spike: ${JSON.stringify(buckets)}`);
    }
});

test('provably-fair verification still passes for capped results', () => {
    const round = fair.createFairRound(42, 'test-client');
    const isValid = fair.verifyFairRound(
        round.serverSeed,
        round.serverSeedHash,
        'test-client',
        42,
        round.crashAt
    );
    assert.equal(isValid, true, 'verification must pass for the computed result');
});

test('existing normal crash results still work below 220x', () => {
    for (let nonce = 1; nonce <= 10000; nonce++) {
        const round = fair.createFairRound(nonce);
        assert.ok(round.crashAt >= 1.00, `crashAt ${round.crashAt} should be >= 1.00`);
        assert.ok(round.crashAt <= 220.00, `crashAt ${round.crashAt} should be <= 220.00`);
    }
});

test('high multipliers remain rare', () => {
    const samples = 500000;
    let count219Plus = 0;
    let count200Plus = 0;
    let count100Plus = 0;
    for (let nonce = 1; nonce <= samples; nonce++) {
        const round = fair.createFairRound(nonce);
        if (round.crashAt >= 219.0) count219Plus++;
        if (round.crashAt >= 200.0) count200Plus++;
        if (round.crashAt >= 100.0) count100Plus++;
    }
    // Theoretical P(>=219) = 0.95/219 ≈ 0.00434, P(>=200) = 0.95/200 = 0.00475
    assert.ok(count219Plus / samples > 0.003, `>=219 rate ${count219Plus/samples} too low`);
    assert.ok(count219Plus / samples < 0.006, `>=219 rate ${count219Plus/samples} too high`);
    assert.ok(count200Plus / samples > 0.003, `>=200 rate ${count200Plus/samples} too low`);
    assert.ok(count100Plus / samples > 0.008, `>=100 rate ${count100Plus/samples} too low`);
});

test('deterministic same seed produces same result', () => {
    const serverSeed = 'a'.repeat(64);
    const first = fair.calculateCrashAtFromSeed(serverSeed, 'client-seed', 7);
    const second = fair.calculateCrashAtFromSeed(serverSeed, 'client-seed', 7);
    assert.equal(first, second);
    assert.notEqual(first, fair.calculateCrashAtFromSeed(serverSeed, 'other-client-seed', 7));
    assert.notEqual(first, fair.calculateCrashAtFromSeed(serverSeed, 'client-seed', 8));
    assert.equal(
        fair.verifyFairRound(serverSeed, fair.hashServerSeed(serverSeed), 'client-seed', 7, first),
        true
    );
});

test('distribution is continuous near the cap (no wall)', () => {
    // Sample results near the cap and verify they're spread out, not all at one value
    const nearCap = [];
    const samples = 2000000;
    for (let nonce = 1; nonce <= samples; nonce++) {
        const round = fair.createFairRound(nonce);
        if (round.crashAt >= 219.0) nearCap.push(round.crashAt);
    }
    // Should have a reasonable spread, not all 219.00
    const unique219 = new Set(nearCap.map(v => v.toFixed(2)));
    assert.ok(unique219.size > 10,
        `Expected spread across many values near cap, got ${unique219.size} unique: ${[...unique219].sort().slice(0, 20)}`);
    const twentyOneNinety = nearCap.filter(v => v.toFixed(2) === '219.00').length;
    const twentyOneNinetyFive = nearCap.filter(v => v.toFixed(2) === '219.99').length;
    // No single value should capture > 50% of near-cap results
    assert.ok(twentyOneNinety < nearCap.length * 0.5, `219.00 has ${twentyOneNinety}/${nearCap.length} — spike`);
});

test('house edge remains approximately 5%', () => {
    // The house edge is: for any auto-cashout target T,
    // E[return per unit bet] = T * P(crash >= T) ≈ 0.95 (1 - HE)
    // The tail remap preserves this for all targets < 219.
    const samples = 20000;
    const targets = [2, 5, 25, 30, 50];
    const returns = targets.map(target => {
        let reached = 0;
        for (let nonce = 1; nonce <= samples; nonce++) {
            const round = fair.createFairRound(nonce);
            if (round.crashAt >= target) reached++;
        }
        return { target, value: target * reached / samples };
    });
    assert.ok(returns[0].value > 0.93 && returns[0].value < 0.97, JSON.stringify(returns));
    assert.ok(returns[2].value > 0.75 && returns[2].value < 1.10, JSON.stringify(returns));
    assert.ok(returns[3].value > 0.70 && returns[3].value < 1.10, JSON.stringify(returns));
    assert.ok(returns[4].value > 0.65 && returns[4].value < 1.15, JSON.stringify(returns));
});

test('verifyFairRound rejects tampering', () => {
    const round = fair.createFairRound(99, 'test-client');
    assert.equal(fair.verifyFairRound(
        round.serverSeed,
        round.serverSeedHash,
        'test-client',
        99,
        round.crashAt
    ), true);

    assert.equal(fair.verifyFairRound(
        round.serverSeed,
        round.serverSeedHash,
        'test-client',
        99,
        round.crashAt + 0.01
    ), false);

    assert.equal(fair.verifyFairRound(
        round.serverSeed,
        round.serverSeedHash,
        'wrong-client',
        99,
        round.crashAt
    ), false);
});