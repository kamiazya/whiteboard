#!/usr/bin/env node
// Runtime gate for the self-contained widget build: loads dist/widget/
// canvas-viewer.html over file:// with full network interception and
// asserts (a) zero http(s) requests for a plain render, (b) a rendered
// <svg> scene, and (c) the embedded font is ACTUALLY loaded
// (document.fonts.check + FontFace status), not silently falling back to a
// system font.
//
// A second scenario covers the ONE exception to (a) (ADR-0011's 2026-09-10
// note): a canvas_view result carrying a themed style and a `themeFont`
// fetches that family — exactly one request, only to the pinned catalogue
// origin. Both halves matter: a widget that fetches nothing there is a
// themed board drawn in the wrong hand, and a widget that fetches anything
// else has lost the property (a) exists to hold.
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
// The pinned catalogue origin (daemon-client's FONT_SOURCE_ORIGIN) and the
// path canvas_view would answer with for the family `visual.sketch` names.
// Served from the vendored Roboto bytes below, so the smoke stays offline —
// what is under test is the request and the registration, not the glyphs.
const YOMOGI_URL =
  'https://raw.githubusercontent.com/google/fonts/main/ofl/yomogi/Yomogi-Regular.ttf'
const VENDORED_TTF_PATH = join(packageRoot, 'assets', 'fonts', 'Roboto', 'Roboto-Regular.ttf')
const THEMED_SCENE = {
  nodes: [{ id: 'text-1', type: 'text', x: 10, y: 10, width: 160, height: 25, text: SAMPLE_TEXT }],
  edges: [],
  'x-whiteboard': { facets: { 'visual.theme/v0': { theme: 'visual.sketch' } } },
}

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

    // Same gate as Refresh: the comment affordance must never appear
    // without an embedding host peer.
    const hasStickyNoteControl = await page.evaluate(
      () => document.querySelector('[data-testid="widget-comment"]') !== null,
    )
    if (hasStickyNoteControl) {
      fail(
        'expected no comment control without an embedding host (file:// load has no parent frame)',
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

    // The exception to zero-network, in the built bundle. Its own page, so
    // the assertion above keeps meaning exactly what it did: no request at
    // all for a plain render.
    //
    // Served from a SYNTHETIC https origin that page.route fulfils, rather
    // than file:// like the pages above, and measured rather than assumed:
    // a cross-origin `fetch` from a file:// document never reaches
    // Playwright's interceptor at all (it fails in the browser first), so
    // routing it there would have counted zero requests whatever the widget
    // did — a green that means nothing. An https document is also the
    // honest shape: a real MCP Apps host serves this widget into a
    // sandboxed iframe, never off the filesystem.
    const WIDGET_ORIGIN = 'https://widget.smoke.invalid'
    const themedPage = await browser.newPage()
    await themedPage.addInitScript(() => {
      window.__WHITEBOARD_WIDGET_DEBUG__ = true
    })
    const themedRequests = []
    const fontBytes = readFileSync(VENDORED_TTF_PATH)
    // Registration order is load-bearing and measured: Playwright checks
    // route handlers in REVERSE registration order, so the catch-all has to
    // go first or it swallows the two specific ones. A single `https://**`
    // handler doing all three jobs was tried and does not work — once it has
    // fulfilled the navigation it stops matching the page's own later
    // requests, which reads exactly like a widget that fetched nothing.
    await themedPage.route('**/*', (route) => {
      themedRequests.push(route.request().url())
      return route.abort()
    })
    // The widget document itself is this harness's own hosting, not the
    // widget reaching out — served, and not counted.
    await themedPage.route(`${WIDGET_ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: injectedHtml }),
    )
    await themedPage.route(YOMOGI_URL, (route) => {
      themedRequests.push(route.request().url())
      // `access-control-allow-origin: *` is what the real catalogue origin
      // answers with; without it the response is unreadable to the widget
      // and the fetch fails for a reason that has nothing to do with it.
      return route.fulfill({
        status: 200,
        contentType: 'font/ttf',
        body: fontBytes,
        headers: { 'access-control-allow-origin': '*' },
      })
    })
    await themedPage.goto(`${WIDGET_ORIGIN}/`)
    await themedPage.waitForSelector('svg')

    // Delivered through the widget's own tool-result path (the debug hook
    // widget-entry exposes only under __WHITEBOARD_WIDGET_DEBUG__), because
    // no MCP Apps host answers the handshake in this harness.
    await themedPage.evaluate(
      (payload) => {
        window.__whiteboardWidgetToolResult__?.(payload)
      },
      {
        structuredContent: {
          workspaceId: 'ws-smoke',
          documentId: 'smoke/board',
          scene: THEMED_SCENE,
          style: 'document',
          themeFont: { family: 'Yomogi', url: YOMOGI_URL },
        },
      },
    )

    // NOT `document.fonts.check('12px Yomogi')`, which was tried and is
    // vacuous: per the CSS Font Loading spec a family the face set does not
    // hold is assumed to be a system font, so check() answers true for a
    // family nothing ever loaded. Measured — it passed against a build that
    // fetched nothing. The face set itself is the observation that can
    // refute the claim.
    let themedFontLoaded = false
    try {
      await themedPage.waitForFunction(
        () => [...document.fonts].some((f) => f.family === 'Yomogi' && f.status === 'loaded'),
        null,
        { timeout: 15_000 },
      )
      themedFontLoaded = true
    } catch {
      themedFontLoaded = false
    }
    if (!themedFontLoaded) {
      fail('the widget never registered a loaded Yomogi face from the themed tool-result')
    }
    if (themedRequests.length !== 1 || themedRequests[0] !== YOMOGI_URL) {
      fail(
        `expected exactly one request, to ${YOMOGI_URL}, saw: ${themedRequests.join(', ') || '(none)'}`,
      )
    }
    await themedPage.close()

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
    // CI runners parse+execute the 1.9 MB inline bundle noticeably slower
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
    // Refresh and the comment affordance must both stay absent here too,
    // the same as the file:// no-parent-frame load above.
    if (srcdocSvgCount > 0) {
      const widgetFrame = srcdocPage.frames().find((frame) => frame !== srcdocPage.mainFrame())
      const controlPresence = await widgetFrame
        ?.evaluate(() => ({
          refresh: document.querySelector('[data-testid="widget-refresh"]') !== null,
          comment: document.querySelector('[data-testid="widget-comment"]') !== null,
        }))
        .catch(() => undefined)
      if (controlPresence?.refresh) {
        fail('expected no Refresh control under sandboxed srcdoc hosting with no real host')
      }
      if (controlPresence?.comment) {
        fail('expected no comment control under sandboxed srcdoc hosting with no real host')
      }
    }

    if (process.exitCode !== 1) {
      console.log(
        '[widget-smoke] PASS: zero network requests, svg rendered, fonts loaded, JP text present, one themed font fetch from the catalogue origin, srcdoc hosting OK',
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
