import { chromium } from 'playwright-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(root, p);
  if (!fp.startsWith(root) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;
const shots = path.join(root, 'tools', 'shots');
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto(base + '/index.html', { waitUntil: 'networkidle' });

// ---- Players ----
await page.click('.tab[data-tab=players]');
await page.click('text=Ersten Spieler anlegen');
await page.fill('#pName', 'Max');
await page.click('#pSave');
await page.click('.fab-add');
await page.fill('#pName', 'Lena');
await page.click('#pSave');
await page.click('.fab-add');
await page.fill('#pName', 'Tom');
await page.click('#pSave');
await page.screenshot({ path: path.join(shots, '1-players.png') });

// ---- Course ----
await page.click('.tab[data-tab=courses]');
await page.click('text=Ersten Kurs erstellen');
await page.fill('#cName', 'Bahn 1 – Über die Hütte');
await page.fill('#cStart', 'Terrasse');
await page.fill('#cEnd', 'Brunnen');
await page.fill('#cPar', '3');
await page.fill('#cElev', '+8 m');

// draw on the map: tap start, end, one obstacle
async function mapClick(fx, fy) {
  const w = await page.waitForSelector('#edMap .map-wrap');
  await w.scrollIntoViewIfNeeded();
  const b = await w.boundingBox();
  await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
  await page.waitForTimeout(120);
}
await mapClick(0.60, 0.55); // Start (bei der Hütte)
await mapClick(0.30, 0.75); // Ziel (untere Wiese)
await mapClick(0.46, 0.62); // Hindernis (Baum, default)
await page.screenshot({ path: path.join(shots, '2a-editor-map.png') });

await page.click('#obsTypes .type-opt[data-t=dach]');
await page.fill('#obsText', 'über das Hüttendach');
await page.click('#obsAdd');
await page.click('#obsTypes .type-opt[data-t=baum]');
await page.fill('#obsText', 'zwischen den Bäumen');
await page.click('#obsAdd');
await page.click('#cSave');

// second course
await page.click('.fab-add');
await page.fill('#cName', 'Bahn 2 – Steinschlag');
await page.fill('#cStart', 'Brunnen');
await page.fill('#cEnd', 'Solarpanel');
await page.fill('#cPar', '4');
await page.click('#obsTypes .type-opt[data-t=stein]');
await page.fill('#obsText', 'großen Stein berühren');
await page.click('#obsAdd');
await page.click('#cSave');
await page.screenshot({ path: path.join(shots, '2-courses.png') });

// ---- Map overview ----
await page.click('.tab[data-tab=map]');
await page.waitForTimeout(400);
const badges = await page.$$eval('.mk-badge', els => els.map(e => e.textContent.trim()));
const flags = await page.$$('.mk-flag');
console.log('MAP badges:', badges, '| start flags:', flags.length);
await page.screenshot({ path: path.join(shots, '5-map.png') });

// ---- Play ----
await page.click('.tab[data-tab=play]');
// increment strokes: Max +3, Lena +2, Tom +5 on course 1
const rows = await page.$$('[data-player]');
async function inc(rowIdx, times) {
  const btn = await rows[rowIdx].$('[data-act=inc]');
  for (let i = 0; i < times; i++) await btn.click();
}
await inc(0, 3); await inc(1, 2); await inc(2, 5);
await page.screenshot({ path: path.join(shots, '3-play.png') });

// go to next course and add
await page.click('text=Nächster Kurs');
const rows2 = await page.$$('[data-player]');
async function inc2(rowIdx, times) { const btn = await rows2[rowIdx].$('[data-act=inc]'); for (let i=0;i<times;i++) await btn.click(); }
await inc2(0, 4); await inc2(1, 6); await inc2(2, 3);

// ---- Leaderboard ----
await page.click('.tab[data-tab=leaderboard]');
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(shots, '4-leaderboard.png') });

// verify leaderboard numbers via DOM
const totals = await page.$$eval('.rank-total', els => els.map(e => e.textContent.trim()));
const names = await page.$$eval('.rank-name', els => els.map(e => e.textContent.trim()));
console.log('LEADERBOARD names:', names);
console.log('LEADERBOARD totals:', totals);
// Max=7, Lena=8, Tom=8 -> sorted Max(7), then Lena/Tom(8)

// reload to confirm persistence
await page.reload({ waitUntil: 'networkidle' });
const totals2 = await page.$$eval('.rank-total', els => els.map(e => e.textContent.trim())).catch(()=>[]);
console.log('AFTER RELOAD totals:', totals2);

console.log('ERRORS:', errors.length ? errors : 'none');

await browser.close();
server.close();
