'use strict';
// Local-only preview harness. No live Telegram credentials, data or payments.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crazy-rocket-pvp-preview-'));
process.env.DATABASE_PATH = path.join(tempDir, 'preview.sqlite');
process.env.BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE';
process.env.NODE_ENV = 'test';
require('./no-network');
const express = require('express');
const database = require('../database');
// Access the existing loop in this local harness without exporting debug controls in production.
const filename = path.join(root, 'server.js');
const backend = new Module(filename, module);
backend.filename = filename;
backend.paths = Module._nodeModulePaths(root);
backend._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.__previewStartPvp = startPvpGameLoop; module.exports.__previewRefreshPvp = refreshPvpParticipants;\n', filename);
const preview = express();
const user = { id: 700000003, first_name: 'Preview', username: 'preview', photo_url: '/icon-180.png' };
function signedInitData() {
  const params = new URLSearchParams({ user: JSON.stringify(user), auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'local-pvp-preview' });
  const text = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(text).digest('hex'));
  return params.toString();
}
preview.get('/__preview__/telegram.js', (req, res) => {
  res.type('js').send('window.Telegram={WebApp:{initData:' + JSON.stringify(signedInitData()) + ',initDataUnsafe:{user:' + JSON.stringify(user) + '},ready(){},expand(){},onEvent(){},setHeaderColor(){},setBackgroundColor(){},contentSafeAreaInset:{top:0,bottom:0,left:0,right:0}}};');
});
preview.get(['/', '/index.html'], (req, res) => {
  let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  html = html.replace('https://telegram.org/js/telegram-web-app.js', '/__preview__/telegram.js');
  html = html.replace('document.addEventListener("DOMContentLoaded", bootstrapRocketApp, { once: true });', 'document.addEventListener("DOMContentLoaded", async function(){ await bootstrapRocketApp(); openPvpGame(); }, { once: true });');
  res.set('Cache-Control', 'no-store').type('html').send(html);
});
preview.use('/assets', express.static(path.join(root, 'assets')));
preview.get('/icon-180.png', (req, res) => res.sendFile(path.join(root, 'icon-180.png')));
preview.get('/health', (req, res) => res.json({ ok: true, mode: 'isolated-local-preview' }));
const allowed = ['/api/auth', '/api/balance', '/api/pvp/state', '/api/pvp-stream', '/api/pvp/join', '/api/collectibles', '/api/server-time'];
preview.use((req, res, next) => {
  if (allowed.includes(req.path)) return backend.exports.app(req, res, next);
  if (req.path.startsWith('/api/')) return res.json({ ok: true, collectibles: [], gifts: [], items: [], players: [], rounds: [], balance: 0 });
  res.status(404).end();
});
async function seedRound() {
  for (const [telegramId, name] of [[700000001, 'rocketbackpack'], [700000002, 'rocketplayer']]) {
    const row = await database.findOrCreateUser(telegramId, { username: name, first_name: name, avatar_url: '/icon-180.png' });
    await database.updateUserBalance(row.id, 100, 'add');
  }
  const first = await database.get('SELECT id FROM users WHERE telegram_id = ?', ['700000001']);
  const second = await database.get('SELECT id FROM users WHERE telegram_id = ?', ['700000002']);
  await database.joinPvpRound(first.id, 'TON', 4.09, null);
  await database.joinPvpRound(second.id, 'TON', .44, null);
  await backend.exports.__previewRefreshPvp();
}
async function main() {
  await database.initDatabase(); await database.seedDatabase();
  await backend.exports.__previewStartPvp();
  await seedRound();
  let lastRoundId = backend.exports.getPvpStateSnapshot().roundId;
  const reseed = setInterval(async () => {
    const state = backend.exports.getPvpStateSnapshot();
    if (state.roundId !== lastRoundId && ['WAITING', 'COUNTDOWN'].includes(state.phase)) {
      lastRoundId = state.roundId;
      try { await seedRound(); } catch (error) { process.stdout.write('Preview seed: ' + error.message + '\n'); }
    }
  }, 500);
  const listener = preview.listen(3000, '0.0.0.0', () => process.stdout.write('PVP_PREVIEW_READY http://0.0.0.0:3000 (temporary database, live backend code)\n'));
  function close() { clearInterval(reseed); backend.exports.stopPvpGameLoop(); listener.close(); database.db.close(); }
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
main().catch(error => { process.stdout.write(error.stack + '\n'); process.exitCode = 1; });
