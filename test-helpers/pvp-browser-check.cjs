'use strict';
// Optional browser regression: run preview-server.cjs first; requires Playwright + Chromium.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseUrl = process.env.PVP_PREVIEW_URL || 'http://127.0.0.1:3000';
const output = process.env.PVP_BROWSER_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-browser-check-'));
async function main() {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
  const reports = [];
  try {
    for (const [width, height] of [[390, 844], [360, 740], [375, 667], [360, 640], [430, 932]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://**/*', route => route.abort());
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#pvp-game:not(.hidden)'); await page.waitForSelector('.pvp-player');
      const inspect = () => page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { center: box('.pvp-wheel-center'), join: box('#pvp-join-main'), nav: box('.bottom-nav'), list: box('.pvp-players'), phase: pvpState.data.phase, rotation: pvpState.rotation, slices: pvpState.layout.length };
      });
      const first = await inspect(); await page.waitForTimeout(900); const last = await inspect();
      assert.equal(first.center.top, last.center.top); assert.equal(first.center.left, last.center.left);
      assert.ok(last.join.bottom <= last.nav.top); assert.ok(last.list.height >= 95);
      assert.equal(last.slices, 2); assert.ok(last.rotation > first.rotation); assert.equal(errors.length, 0);
      await page.screenshot({ path: path.join(output, width + 'x' + height + '.png') });
      await page.evaluate(() => showPage('home'));
      assert.equal(await page.evaluate(() => pvpState.active), false);
      assert.equal(await page.evaluate(() => pvpState.sse), null);
      reports.push({ width, height, first, last, errors }); await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(); await page.route('https://**/*', route => route.abort());
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#pvp-game:not(.hidden)');
    await page.waitForFunction(() => pvpState.data?.phase === 'COUNTDOWN' && pvpState.data.seconds >= 19, {}, { timeout: 45000 });
    const initialTimer = await page.locator('#pvp-countdown').textContent();
    await page.waitForTimeout(2100); assert.notEqual(await page.locator('#pvp-countdown').textContent(), initialTimer);
    await page.evaluate(() => pvpState.sse.onerror()); await page.waitForTimeout(1800);
    assert.equal(await page.evaluate(() => !!pvpState.pollTimer), true);
    await page.waitForTimeout(2700); assert.equal(await page.evaluate(() => !!pvpState.sse && !pvpState.pollTimer), true);
    await page.waitForFunction(() => pvpState.data?.phase === 'RESULT', {}, { timeout: 35000 });
    await page.waitForTimeout(2900);
    assert.ok(await page.evaluate(() => {
      const viewport = document.querySelector('#pvp-participant-strip').getBoundingClientRect();
      const middle = viewport.left + viewport.width / 2;
      const landed = [...document.querySelectorAll('#pvp-participant-track .pvp-participant')].find(card => {
        const b = card.getBoundingClientRect(); return b.left <= middle && b.right >= middle;
      });
      const winner = pvpState.data.participants.find(p => String(p.user_id) === String(pvpState.data.winnerUserId));
      return landed && winner && String(landed.dataset.participantId) === String(winner.id) &&
        document.querySelector('#pvp-participant-strip').classList.contains('settled');
    }));
    await context.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(reports, null, 2));
    console.log('PvP phone layout, center, countdown, fallback/reconnect and authoritative winner: PASS');
    console.log('Evidence:', output);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
