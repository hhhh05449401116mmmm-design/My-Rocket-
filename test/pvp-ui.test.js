'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const backend = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = html.indexOf('         var pvpState = {');
const end = html.indexOf('var pvpHistoryState =', start);
function sandbox(extra = {}) {
  const context = vm.createContext({ URL, console, setInterval, clearInterval, setTimeout, clearTimeout, ...extra });
  vm.runInContext(html.slice(start, end), context);
  return context;
}

test('PvP weighted percentages conserve real stake proportions', () => {
  const context = sandbox();
  const ps = [{ id: 1, betAmount: 999.99 }, { id: 2, betAmount: .01 }];
  assert.ok(Math.abs(context.pvpPercentage(ps[0], ps) + context.pvpPercentage(ps[1], ps) - 100) < 1e-10);
  assert.equal(context.pvpPercentage(ps[1], ps), .01 / 1000 * 100);
});

test('PvP player identity gets a consistent color across position changes', () => {
  const context = sandbox();
  assert.equal(context.pvpParticipantColor({ user_id: 25 }, 0), context.pvpParticipantColor({ user_id: 25 }, 7));
});

test('PvP percentages reflect current amounts, not stale join-time percentage', () => {
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

test('PvP countdown uses authoritative deadline, clamps to zero and shows LIVE', () => {
  const timer = { textContent: '' };
  const context = sandbox({ document: { getElementById: () => timer } });
  vm.runInContext("pvpState.data={phase:'COUNTDOWN',seconds:20,countdownEndsAt:Date.now()+12100};pvpState.serverOffset=0;pvpState.receivedAt=Date.now()", context);
  context.renderPvpCountdown(); assert.equal(timer.textContent, '00:13');
  vm.runInContext('pvpState.data.countdownEndsAt=Date.now()-1000', context);
  context.renderPvpCountdown(); assert.equal(timer.textContent, '00:00');
  vm.runInContext("pvpState.data.phase='LIVE'", context);
  context.renderPvpCountdown(); assert.equal(timer.textContent, 'LIVE');
});

test('PvP center and player-strip pointer are outside rotating bet carousel', () => {
  const pvp = html.slice(html.indexOf('<div id="pvp-game"'), html.indexOf('<div id="pvp-bet-modal"'));
  assert.match(pvp, /id="pvp-wheel-segments"[^>]*><\/div>\s*<\/div>\s*<div class="pvp-wheel-center">/);
  assert.match(pvp, /id="pvp-strip-pointer"/);
  assert.doesNotMatch(html.slice(start, end), /getPvpPreviewParticipants|preview-1|displayPs|totalPool:10/);
  assert.match(pvp, /linear-gradient\(100deg,#ff9f00,#ffd83e\)/);
});

test('PvP upper carousel shows TON or gift wagers and CRAZY ROCKET, never player avatars', () => {
  const wheel = html.slice(html.indexOf('function renderPvpWheel('), html.indexOf('function pvpParticipantCard('));
  assert.doesNotMatch(wheel, /p\.avatar|pvpAvatarMarkup|pvpName\(p\)/);
  assert.match(wheel, /gift \? pvpGiftImage\(p\) : TON_ICON_URL/);
  assert.match(wheel, /\['CRAZY', -10\], \['ROCKET', 22\]/);
  assert.match(wheel, /Math\.max\(10, participants\.length \+ 3\)/);
});

test('PvP upper carousel has equal speed in WAITING, COUNTDOWN, LIVE and RESULT', () => {
  const rotor = { style: {} }, context = sandbox({
    window: { matchMedia: () => ({ matches: false }) },
    document: { getElementById: id => id === 'pvp-wheel-segments' ? rotor : null },
    requestAnimationFrame: () => 1
  });
  for (const phase of ['WAITING', 'COUNTDOWN', 'LIVE', 'RESULT']) {
    vm.runInContext("pvpState.active=true;pvpState.rotation=0;pvpState.lastFrame=1000;pvpState.data={phase:'" + phase + "'};pvpState.resultAnimation=null", context);
    context.animatePvpWheel(1100); assert.equal(vm.runInContext('pvpState.rotation', context), 3.6);
  }
});

test('PvP roulette repetitions contain only real participants and approximate stake shares', () => {
  const context = sandbox(), ps = [{ id: 2, user_id: 102, betAmount: 9 }, { id: 1, user_id: 101, betAmount: 1 }];
  const deck = context.pvpStripDeck(ps);
  assert.equal(deck.length, 120);
  assert.ok(deck.every(p => ps.includes(p)));
  const large = deck.filter(p => p.id === 2).length;
  assert.ok(large >= 106 && large <= 108);
  assert.deepEqual(Array.from(context.pvpStripDeck([])), []);
});

test('PvP roulette includes all 75 real players even at extreme ratios, without changing their bets', () => {
  const context = sandbox(), ps = Array.from({ length: 75 }, (_, i) => ({ id: i + 1, betAmount: i === 0 ? 999999 : .1 }));
  const serialized = JSON.stringify(ps), deck = context.pvpStripDeck(ps);
  assert.equal(new Set(deck.map(p => p.id)).size, 75);
  assert.equal(JSON.stringify(ps), serialized);
});

test('PvP strip travels left and slows smoothly, with a whole-card server-winner landing', () => {
  const context = sandbox();
  assert.ok(context.pvpStripVelocity(1000) > context.pvpStripVelocity(8000));
  assert.ok(context.pvpStripVelocity(12000) > 0);
  for (const x of [0, 43, 301, 9700]) {
    const target = context.pvpStripResultTarget(x, 78, 200, 2600);
    assert.ok(target > x); assert.equal(target % 78, 0);
  }
  const result = html.slice(html.indexOf('function startPvpStripResult('), html.indexOf('function animatePvpWheel('));
  assert.match(result, /pvpState\.stripDeck\[slot\] = winner/);
  assert.doesNotMatch(result.replace(/\/\/[^\n]*/g, ''), /Math\.random|fetch\(|balance|payout/);
});

test('PvP collectible metadata mirrors server valuation without replacing general value', () => {
  assert.match(backend, /pvpBetValue: Number\(row\.collectible_market_value \?\? row\.value \?\? 0\)/);
  assert.match(backend, /pvpEligible: row\.ownership_verified === 1 && row\.ownership_status === 'OWNED'/);
  assert.match(html, /g\.pvpEligible === true/); assert.match(html, /gid=g\.pvpGiftUniqueId/);
});

test('PvP persists LIVE before the existing settlement and exposes strip timing', () => {
  const launch = backend.slice(backend.indexOf('async function launchPvpRound()'), backend.indexOf('async function settlePvpRound()'));
  assert.match(launch, /UPDATE pvp_rounds SET phase = \?, seconds_remaining = 0, started_at = \? WHERE id = \? AND phase = \?/);
  assert.ok(launch.indexOf("['LIVE', new Date(liveStartedAt).toISOString(), pvpState.roundId, 'COUNTDOWN']") < launch.indexOf("pvpState.phase = 'LIVE'"));
  assert.match(backend, /liveStartedAt: pvpState\.liveStartedAt/);
  assert.match(backend, /await restoreOrStartPvpRound\(\)/);
});

test('PvP realtime shutdown clears stream, polling, reconnect and animation', () => {
  const cleared = [], canceled = [], classes = []; let closed = false;
  const context = sandbox({ closePvpHistory: () => {}, clearInterval: x => cleared.push(x), clearTimeout: x => cleared.push(x), cancelAnimationFrame: x => canceled.push(x), document: { body: { classList: { remove: x => classes.push(x) } } } });
  context.closedStream = { close: () => { closed = true; } };
  vm.runInContext('pvpState.active=true;pvpState.timer=1;pvpState.pollTimer=2;pvpState.reconnectTimer=3;pvpState.frame=4;pvpState.sse=closedStream', context);
  context.stopPvpTimer();
  assert.deepEqual(cleared, [1, 2, 3]); assert.deepEqual(canceled, [4]); assert.equal(closed, true); assert.deepEqual(classes, ['pvp-open']);
});


test('PvP strip rerenders on LIVE transition even without participant changes', () => {
  assert.match(html, /const cardsKey = JSON.stringify\(ps\) \+ ':' \+ \(\['LIVE', 'RESULT'\]\.includes\(d.phase\) \? 'roulette' : 'list'\)/);
});


test('PvP waiting is not a countdown and the player sees WAITING', () => {
  const timer = { textContent: '' }, context = sandbox({document: {getElementById:()=>timer}});
  vm.runInContext("pvpState.data={phase:'WAITING',seconds:20,countdownEndsAt:null};pvpState.receivedAt=Date.now()", context);
  context.renderPvpCountdown(); assert.equal(timer.textContent,'WAITING');
});
test('PvP header uses history clock and removes duplicate internal back button', () => {
  const header=html.slice(html.indexOf('<div class="pvp-topbar">'),html.indexOf('<div class="pvp-stats">'));
  assert.doesNotMatch(header,/button class="pvp-back"/);
  assert.match(header,/onclick="openPvpHistory\(\)"/);assert.match(header,/<svg/);
  assert.match(html,/data-scope="all"/);assert.match(html,/data-scope="mine"/);
});
test('PvP phase transitions check database guards before mutating memory', () => {
  const launch=backend.slice(backend.indexOf('async function launchPvpRound()'),backend.indexOf('async function settlePvpRound()'));
  assert.match(launch,/transition.changes !== 1/);
  assert.ok(launch.indexOf('transition.changes !== 1')<launch.indexOf("pvpState.phase = 'LIVE'"));
  const hold=backend.slice(backend.indexOf('async function holdPvpRoundForPlayers()'),backend.indexOf('async function launchPvpRound()'));
  assert.match(hold,/COUNT\(DISTINCT user_id\)/);assert.match(hold,/< 2/);
});
test('Telegram native navigation uses one named listener and closes nested selectors without app close', () => {
  const nav=html.slice(html.indexOf('// Telegram owns the header'),html.indexOf('        function showPage(page)'));
  assert.match(nav,/button.offClick\(handleTelegramBack\); button.onClick\(handleTelegramBack\)/);
  assert.match(nav,/overlay === 'plinko-gift-modal'/);
  assert.match(nav,/closePvpHistory\(\)/);assert.match(nav,/closeLootBoxResult\(\)/);
  assert.doesNotMatch(nav,/WebApp.close\(/);
});
