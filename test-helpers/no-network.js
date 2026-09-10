'use strict';

// TEST-ONLY: guarantees the suite never performs real Telegram API/network calls, and keeps the
// server's verbose diagnostic logging off the test runner's IPC channel.
// Lives outside test/ so node --test does not auto-discover it as a test file.
// Must be required BEFORE ../server so the production module picks up the stubbed token.
const https = require('node:https');

// The production Telegram client short-circuits on this placeholder and never opens a socket.
process.env.BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE';

const realHttpsRequest = https.request;

// Hard guard: if any code path still tries to reach Telegram, fail loudly instead of
// silently making a real request whose late response would also corrupt the test runner IPC.
https.request = function guardedRequest(options, ...rest) {
    const host = typeof options === 'string'
        ? options
        : (options && (options.hostname || options.host)) || '';
    if (String(host).includes('api.telegram.org')) {
        throw new Error('Blocked real Telegram API call during tests');
    }
    return realHttpsRequest.call(this, options, ...rest);
};

// The server's production diagnostics are intentionally verbose; piping all of it through
// node --test's IPC channel corrupts the stream ("Unable to deserialize cloned data").
// Silencing is test-only and does not alter any production code path or assertion.
console.log = () => {};
console.warn = () => {};
console.error = () => {};

module.exports = { realHttpsRequest };
