'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateMultiplierAt } = require('../crashFair');

test('live multiplier uses elapsed server time with the same two-decimal rounding', () => {
    assert.equal(calculateMultiplierAt(1000, 1000), 1.00);
    assert.equal(calculateMultiplierAt(1000, 2000), 1.37);
    assert.equal(calculateMultiplierAt(1000, 2270), 1.47);
    assert.equal(calculateMultiplierAt(1000, 500, 1 / 2.7), 1.00);
    assert.equal(calculateMultiplierAt(1000, 2000, 0.5), 1.50);
    assert.throws(() => calculateMultiplierAt(NaN, 2000), RangeError);
});
