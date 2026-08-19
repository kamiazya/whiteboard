#!/usr/bin/env node
// Runtime gate for the self-contained widget build: loads dist/widget/
// canvas-viewer.html over file:// with full network interception and
// asserts (a) zero http(s) requests, (b) a rendered <svg> scene, and
// (c) the embedded font is ACTUALLY loaded (document.fonts.check +
// FontFace status), not silently falling back to a system font.
//
// Direct invocation requires Node's native TS support (stable since Node 24,
// this repo's pinned version) — no build step, no tsx loader flag needed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { findExternalResourceUrls } from '../src/widget/check-html.ts'
import { serializeSceneForScriptTag } from '../src/widget/embed-scene.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '..')
const builtHtmlPath = join(packageRoot, 'dist', 'widget', 'canvas-viewer.html')

// Plain ASCII text so the Basic-Latin glyphs in the embedded Roboto face are
// the ones exercised by document.fonts.check.
const SAMPLE_TEXT = 'Hello widget'
const JP_TEXT = '日本語ラベル'
const SAMPLE_SCENE = {
  nodes: [
    { id: 'text-1', type: 'text', x: 10, y: 10, width: 160, height: 25, text: SAMPLE_TEXT },
    // Non-Latin text exercises the browser-fallback glyph path (Roboto's
    // Latin-only vendored subset does not cover CJK) while the zero-network
    // assertion below confirms it never triggers a font fetch.
    //
    // NO system CJK font is required, and CI deliberately installs none. The
    // assertion below reads the SVG's textContent, which a <text> element
    // carries whether or not a glyph exists for it, and the only font-status
    // assertion is on the EMBEDDED Roboto face. Measured: with 887 faces
    // available and none of them `:lang=ja`, the whole smoke passes. Running
    // WITHOUT a fallback face is the stronger version of the zero-network
    // claim — it shows the widget fetches nothing even when the glyph is
    // genuinely unavailable. CI once apt-installed a CJK font for this and it
    // hung the job in three separate shapes; do not add it back.
    { id: 'text-jp', type: 'text', x: 10, y: 50, width: 200, height: 25, text: JP_TEXT },
  ],
  edges: [],
}

function fail(message) {
  console.error(`[widget-smoke] FAIL: ${message}`)
  process.exitCode = 1
}

async function main() {
  let html
  try {
    html = readFileSync(builtHtmlPath, 'utf8')
  } catch {
    fail(`expected a build at ${builtHtmlPath} — run "pnpm build:widget" first`)
    return
  }

  const staticExternalUrls = findExternalResourceUrls(html)
  if (staticExternalUrls.length > 0) {
    fail(`built HTML contains external resource URL(s): ${staticExternalUrls.join(', ')}`)
    return
  }

  const injectedHtml = html.replace(
    /(<script type="application\/json" data-whiteboard-scene>)(.*?)(<\/script>)/s,
    (_match, open, _placeholder, close) =>
      `${open}${serializeSceneForScriptTag(SAMPLE_SCENE)}${close}`,
  )
  if (injectedHtml === html) {
    fail('could not find the embedded-scene <script> slot to inject the sample scene into')
    return
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'whiteboard-widget-smoke-'))
  const tmpHtmlPath = join(tmpDir, 'canvas-viewer.html')
  writeFileSync(tmpHtmlPath, injectedHtml, 'utf8')

  const executablePath = process.env.WHITEBOARD_CHROME_PATH?.trim() || undefined
  let browser
  try {
    browser = await chromium.launch({ executablePath })
    const page = await browser.newPage()
    // Opt into the widget's smoke-only FontFace instrumentation BEFORE any
    // page script runs — the production widget leaves the hook unset.
    await page.addInitScript(() => {
      window.__WHITEBOARD_WIDGET_DEBUG__ = true
    })
    const networkRequests = []
    await page.route('http://**', (route) => {
      networkRequests.push(route.request().url())
      return route.abort()
    })
    await page.route('https://**', (route) => {
      networkRequests.push(route.request().url())
      return route.abort()
    })

    await page.goto(`file://${tmpHtmlPath}`)
    await page.waitForSelector('svg')

    // No embedding host peer (file:// top-level load: window.parent ===
    // window), so widget-entry's Refresh control must never be created —
    // asserting this here, rather than only via jsdom mocks, catches the
    // control leaking into the no-host document under the real bundle.
    const hasRefreshControl = await page.evaluate(
      () => document.querySelector('[data-testid="widget-refresh"]') !== null,
    )
    if (hasRefreshControl) {
      fail(
        'expected no Refresh control without an embedding host (file:// load has no parent frame)',
      )
    }

    // Same gate as Refresh: the sticky-note affordance must never appear
    // without an embedding host peer.
    const hasStickyNoteControl = await page.evaluate(
      () => document.querySelector('[data-testid="widget-sticky-note"]') !== null,
    )
    if (hasStickyNoteControl) {
      fail(
        'expected no sticky-note control without an embedding host (file:// load has no parent frame)',
      )
    }

    const fontCheck = await page.evaluate(async (text) => {
      await document.fonts.ready
      // window.__whiteboardWidgetFonts__ (see widget-entry.ts) is exactly
      // the FontFace instances this build registered.
      const ours = window.__whiteboardWidgetFonts__ ?? []
      return {
        checked: document.fonts.check('20px Roboto', text),
        registeredCount: ours.length,
        statuses: ours.map((f) => f.status),
      }
    }, SAMPLE_TEXT)

    if (networkRequests.length > 0) {
      fail(`expected zero network requests, saw: ${networkRequests.join(', ')}`)
    }
    if (!fontCheck.checked) {
      fail('document.fonts.check reported the Roboto family/text as not available')
    }
    if (fontCheck.registeredCount === 0) {
      fail('window.__whiteboardWidgetFonts__ was empty — widget-entry did not register any font')
    } else if (!fontCheck.statuses.every((s) => s === 'loaded')) {
      fail(
        `expected every widget-registered FontFace to be 'loaded', got: ${JSON.stringify(fontCheck.statuses)}`,
      )
    }

    // The JP text node's content actually reaches the DOM: canvas-render
    // emits a real <text> element (not a canvas raster), so this asserts on
    // the SVG's text content directly rather than scanning pixels.
    const svgContainsJpText = await page.evaluate(
      (jpText) => (document.querySelector('svg')?.textContent ?? '').includes(jpText),
      JP_TEXT,
    )
    if (!svgContainsJpText) {
      fail('expected the rendered SVG to contain the Japanese sample text')
    }

    // srcdoc hosting: MCP Apps hosts embed this widget via a sandboxed
    // srcdoc iframe (no allow-same-origin), where location.href is the
    // non-URL "about:srcdoc". A widget that assumes a real document URL
    // (e.g. `new URL('.', location.href)`) dies only under THIS hosting
    // mode — file:// and http(s) loads cannot catch it.
    const srcdocPage = await browser.newPage()
    const srcdocPageErrors = []
    srcdocPage.on('pageerror', (err) => {
      srcdocPageErrors.push(String(err))
    })
    const srcdocConsoleErrors = []
    srcdocPage.on('console', (msg) => {
      if (msg.type() === 'error') srcdocConsoleErrors.push(msg.text())
    })
    await srcdocPage.route('http://**', (route) => {
      networkRequests.push(route.request().url())
      return route.abort()
    })
    await srcdocPage.route('https://**', (route) => {
      networkRequests.push(route.request().url())
      return route.abort()
    })
    await srcdocPage.setContent('<!doctype html><body></body>')
    await srcdocPage.evaluate((widgetHtml) => {
      const iframe = document.createElement('iframe')
      iframe.setAttribute('sandbox', 'allow-scripts')
      iframe.srcdoc = widgetHtml
      document.body.appendChild(iframe)
    }, injectedHtml)
    // CI runners parse+execute the ~8.5 MB inline bundle noticeably slower
    // than the file:// pages above; give the sandboxed frame extra headroom.
    const srcdocDeadline = Date.now() + 30_000
    let srcdocSvgCount = 0
    while (Date.now() < srcdocDeadline) {
      // Any non-main frame is the widget frame — matching on
      // url() === 'about:srcdoc' is Chrome-build-dependent (chrome-stable
      // under CDP can report a sandboxed srcdoc frame's URL differently
      // than bundled Chromium).
      for (const frame of srcdocPage.frames()) {
        if (frame === srcdocPage.mainFrame()) continue
        srcdocSvgCount = await frame
          .evaluate(() => document.querySelectorAll('svg').length)
          .catch(() => 0)
        if (srcdocSvgCount > 0) break
      }
      if (srcdocSvgCount > 0) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (srcdocSvgCount === 0) {
      const frameUrls = srcdocPage
        .frames()
        .map((f) => f.url() || '(empty)')
        .join(', ')
      const diagnostics = [
        `frames: ${frameUrls}`,
        srcdocPageErrors.length ? `page errors: ${srcdocPageErrors.join(' | ')}` : '',
        srcdocConsoleErrors.length ? `console errors: ${srcdocConsoleErrors.join(' | ')}` : '',
      ]
        .filter(Boolean)
        .join('; ')
      fail(`widget did not render an svg under sandboxed srcdoc hosting (${diagnostics})`)
    }
    if (srcdocPageErrors.length > 0) {
      fail(`uncaught page error(s) under srcdoc hosting: ${srcdocPageErrors.join(' | ')}`)
    }

    // No real MCP Apps host answers the postMessage handshake in this
    // harness, so app.connect() loses the HOST_CONNECT_TIMEOUT_MS race —
    // Refresh and the sticky-note affordance must both stay absent here too,
    // the same as the file:// no-parent-frame load above.
    if (srcdocSvgCount > 0) {
      const widgetFrame = srcdocPage.frames().find((frame) => frame !== srcdocPage.mainFrame())
      const controlPresence = await widgetFrame
        ?.evaluate(() => ({
          refresh: document.querySelector('[data-testid="widget-refresh"]') !== null,
          stickyNote: document.querySelector('[data-testid="widget-sticky-note"]') !== null,
        }))
        .catch(() => undefined)
      if (controlPresence?.refresh) {
        fail('expected no Refresh control under sandboxed srcdoc hosting with no real host')
      }
      if (controlPresence?.stickyNote) {
        fail('expected no sticky-note control under sandboxed srcdoc hosting with no real host')
      }
    }

    if (process.exitCode !== 1) {
      console.log(
        '[widget-smoke] PASS: zero network requests, svg rendered, fonts loaded, JP text present, srcdoc hosting OK',
      )
    }
  } finally {
    // Guarded close + always-run cleanup: a launch failure must not strand
    // the temp dir, and a close failure must not skip it either.
    if (browser) {
      await browser.close().catch(() => {})
    }
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

await main()
