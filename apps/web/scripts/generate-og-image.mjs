// Regenerates public/og-image.png (1200x630 large-summary card) — the
// image behind the og:image / twitter:image metas in index.html and the
// GitHub repo's social preview. Run from apps/web:
//
//   node scripts/generate-og-image.mjs
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public')

// The framed mark (a card is a document context, so the board frame earns
// its keep) with the blue spark — the AI's hand, the brand's one accent —
// above wordmark and tagline. System fonts, deterministic enough for a
// committed asset regenerated on one platform.
const html = `<!DOCTYPE html><html><head><style>
  * { margin: 0; }
  body {
    width: 1200px;
    height: 630px;
    background: #ffffff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 34px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .words { text-align: center; }
  h1 { font-size: 68px; font-weight: 650; color: #1c1c1c; letter-spacing: 0.01em; }
  p { margin-top: 10px; font-size: 28px; color: #6d6d6d; }
</style></head><body>
  <svg width="400" height="300" viewBox="0 0 88 66" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="84" height="62" rx="10" stroke="#9ca3af" stroke-opacity="0.6" stroke-width="2.6"/>
    <path d="M20 44 C 27 22, 37 22, 44 33 S 58 50, 68 25" stroke="#565656" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M73 8 L74.2 11.4 L77.6 12.6 L74.2 13.8 L73 17.2 L71.8 13.8 L68.4 12.6 L71.8 11.4 Z" fill="#3b6ecc"/>
  </svg>
  <div class="words">
    <h1>Whiteboard</h1>
    <p>Draw with your AI agent on a shared real-time canvas</p>
  </div>
</body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await page.setContent(html)
await page.screenshot({ path: resolve(publicDir, 'og-image.png') })
await browser.close()
console.log('wrote og-image.png')
