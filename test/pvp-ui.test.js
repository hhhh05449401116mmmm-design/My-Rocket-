'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const backend = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = html.indexOf('         var pvpState = {');
const end = html.indexOf('function openPvpBetModal(){', start);
function sandbox(extra = {}) {
  const context = vm.createContext({ URL, console, setInterval, clearInterval, setTimeout, clearTimeout, ...extra });
  vm.runInContext(html.slice(start, end), context);
  return context;
}

test('PvP weighted slices conserve 360 degrees and do not inflate small bets', () => {
  const context = sandbox();
  const participants = [{ id: 1, betAmount: 999.99 }, { id: 2, betAmount: .01 }];
  const result = context.pvpWheelSlices(participants);
  assert.ok(Math.abs(result[0].span + result[1].span - 360) < 1e-10);
  assert.ok(Math.abs(result[1].span - .0036) < 1e-10);
  assert.equal(result[0].start, 0);
  assert.equal(result[1].end, 360);
});

test('PvP 75 participants keep exact weights without overlap', () => {
  const context = sandbox();
  const ps = Array.from({ length: 75 }, (_, i) => ({ id: i + 1, betAmount: i + 1 }));
  const result = context.pvpWheelSlices(ps);
  assert.ok(Math.abs(result.at(-1).end - 360) < 1e-8);
  for (let i = 1; i < result.length; i++) assert.equal(result[i].start, result[i - 1].end);
});

test('PvP player identity gets a consistent color across position changes', () => {
  const context = sandbox();
  assert.equal(context.pvpParticipantColor({ user_id: 25 }, 0), context.pvpParticipantColor({ user_id: 25 }, 7));
});

test('PvP percentages reflect current bet amounts, not stale join-time percentage', () => {
  const context = sandbox();
  const ps = [{ betAmount: 1, participationPercent: 100 }, { betAmount: 3, participationPercent: 75 }];
  assert.equal(context.pvpPercentage(ps[0], ps), 25);
  assert.equal(context.pvpPercentage(ps[1], ps), 75);
});

test('PvP image URLs reject unsafe protocols and use controlled fallbacks', () => {
  const context = sandbox();
  assert.equal(context.pvpSafeImage('javascript:alert(1)', '/assets/gift-icon.svg'), '/assets/gift-icon.svg');
  assert.equal(context.pvpSafeImage('/assets/ton-icon.svg'), '/assets/ton-icon.svg');
  assert.equal(context.pvpSafeImage('//attacker.test/a.png'), '');
});

test('PvP countdown uses authoritative deadline and clamps to zero', () => {
  const timer = { textContent: '' };
  const context = sandbox({ document: { getElementById: () => timer } });
  vm.runInContext("pvpState.data={phase:'COUNTDOWN',seconds:20,countdownEndsAt:Date.now()+12100};pvpState.serverOffset=0;pvpState.receivedAt=Date.now()", context);
  context.renderPvpCountdown();
  assert.equal(timer.textContent, '00:13');
  vm.runInContext('pvpState.data.countdownEndsAt=Date.now()-1000', context);
  context.renderPvpCountdown(); assert.equal(timer.textContent, '00:00');
});

test('PvP center is outside rotating wheel and no production fake participants remain', () => {
  const pvp = html.slice(html.indexOf('<div id="pvp-game"'), html.indexOf('<div id="pvp-bet-modal"'));
  assert.match(pvp, /id="pvp-wheel-segments"[^>]*><\/div>\s*<\/div>\s*<div class="pvp-wheel-center">/);
  assert.doesNotMatch(html.slice(start, end), /getPvpPreviewParticipants|preview-1|displayPs|totalPool:10/);
  assert.match(pvp, /linear-gradient\(100deg,#ff9f00,#ffd83e\)/);
});

test('PvP collectible metadata mirrors server valuation without replacing general value', () => {
  assert.match(backend, /pvpBetValue: Number\(row\.collectible_market_value \?\? row\.value \?\? 0\)/);
  assert.match(backend, /pvpEligible: row\.ownership_verified === 1 && row\.ownership_status === 'OWNED'/);
  assert.match(html, /g\.pvpEligible === true/);
  assert.match(html, /gid=g\.pvpGiftUniqueId/);
});

test('PvP persists LIVE before handing the round to the existing settlement', () => {
  const launch = backend.slice(backend.indexOf('async function launchPvpRound()'), backend.indexOf('async function settlePvpRound()'));
  assert.match(launch, /UPDATE pvp_rounds SET phase = \?, seconds_remaining = 0 WHERE id = \? AND phase = \?/);
  assert.ok(launch.indexOf("['LIVE', pvpState.roundId, 'COUNTDOWN']") < launch.indexOf("pvpState.phase = 'LIVE'"));
});

test('PvP full sector preserves exact logical endpoints and winner midpoint avoids decorative separators', () => {
  assert.match(html, /shape\(slice\.start, slice\.end/);
  assert.match(html, /if \(count % 2 === 0\) count\+\+/);
});

test('PvP realtime shutdown clears stream, polling, reconnect and animation', () => {
  const cleared = [], canceled = [], classes = [];
  let closed = false;
  const context = sandbox({ clearInterval: x => cleared.push(x), clearTimeout: x => cleared.push(x), cancelAnimationFrame: x => canceled.push(x), document: { body: { classList: { remove: x => classes.push(x) } } } });
  context.closedStream = { close: () => { closed = true; } };
  vm.runInContext('pvpState.active=true;pvpState.timer=1;pvpState.pollTimer=2;pvpState.reconnectTimer=3;pvpState.frame=4;pvpState.sse=closedStream', context);
  context.stopPvpTimer();
  assert.deepEqual(cleared, [1, 2, 3]); assert.deepEqual(canceled, [4]); assert.equal(closed, true); assert.deepEqual(classes, ['pvp-open']);
});
