// Crop the uploaded aerial screenshot into map.jpg for the app.
// Uses headless Chromium (canvas) since no native image libs are installed.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) { console.error('usage: node make_map.mjs <screenshot.png>'); process.exit(1); }

const b64 = fs.readFileSync(SRC).toString('base64');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();

const result = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  // crop: full width, vertical band with the huts/meadow (skip status bar,
  // labels at very top and the search bar / buttons at the bottom)
  const sy = Math.round(H * 0.247);
  const sh = Math.round(H * 0.495);
  const targetW = 990; // downscale for reasonable file size
  const scale = targetW / W;
  const targetH = Math.round(sh * scale);
  const c = document.createElement('canvas');
  c.width = targetW; c.height = targetH;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, sy, W, sh, 0, 0, targetW, targetH);
  return { dataUrl: c.toDataURL('image/jpeg', 0.85), w: targetW, h: targetH, srcW: W, srcH: H };
}, b64);

const jpeg = Buffer.from(result.dataUrl.split(',')[1], 'base64');
fs.writeFileSync(path.join(root, 'map.jpg'), jpeg);
console.log(`map.jpg written: ${result.w}x${result.h} (${(jpeg.length/1024).toFixed(0)} KB), aspect=${(result.h/result.w).toFixed(4)}, source=${result.srcW}x${result.srcH}`);
await browser.close();
