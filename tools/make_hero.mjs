// Crop the DJI 360° panorama into a wide hero banner (hero.jpg).
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) { console.error('usage: node make_hero.mjs <panorama.jpg>'); process.exit(1); }

const b64 = fs.readFileSync(SRC).toString('base64');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();

const result = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/jpeg;base64,' + b64;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  // center strip with the huts and mountain horizon
  const sx = Math.round(W * 0.24), sw = Math.round(W * 0.52);
  const sy = Math.round(H * 0.26), sh = Math.round(H * 0.40);
  const targetW = 1200, scale = targetW / sw;
  const targetH = Math.round(sh * scale);
  const c = document.createElement('canvas');
  c.width = targetW; c.height = targetH;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
  return { dataUrl: c.toDataURL('image/jpeg', 0.82), w: targetW, h: targetH, srcW: W, srcH: H };
}, b64);

const jpeg = Buffer.from(result.dataUrl.split(',')[1], 'base64');
fs.writeFileSync(path.join(root, 'hero.jpg'), jpeg);
console.log(`hero.jpg written: ${result.w}x${result.h} (${(jpeg.length/1024).toFixed(0)} KB), source=${result.srcW}x${result.srcH}`);
await browser.close();
