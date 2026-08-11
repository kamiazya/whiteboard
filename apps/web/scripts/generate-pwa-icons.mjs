// Regenerates public/icon-192.png and public/icon-512.png from the logo
// mark (the boot-splash board + squiggle). Run from apps/web:
//
//   node scripts/generate-pwa-icons.mjs
//
// The manifest declares these icons `any maskable`, so the artwork keeps
// the mark inside the center safe zone (~80%) over a full-bleed background
// — a launcher may crop the tile to a circle or squircle.
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public')

// The signature squiggle alone, large, on a full-bleed ground. Unlike the
// favicon/splash it drops the board frame: at launcher size the frame only
// costs stroke weight and safe-zone space — the squiggle IS the mark.
// (Path bbox in its 88x66 source space: x 20-68, y ~27-45.)
const icon = (size) => {
  const scale = (size * 0.68) / 48
  const tx = size / 2 - 44 * scale
  const ty = size / 2 - 36 * scale
  return `<!DOCTYPE html><html><head><style>*{margin:0}</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#ffffff"/>
  <g transform="translate(${tx} ${ty}) scale(${scale})">
    <path d="M20 44 C 27 22, 37 22, 44 33 S 58 50, 68 25" fill="none" stroke="#4b5563" stroke-width="6" stroke-linecap="round"/>
  </g>
</svg></body></html>`
}

const browser = await chromium.launch()
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(icon(size))
  await page.screenshot({ path: resolve(publicDir, `icon-${size}.png`) })
  await page.close()
}
await browser.close()
console.log('wrote icon-192.png and icon-512.png')
