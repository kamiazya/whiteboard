#!/usr/bin/env node
// Runtime gate for the self-contained widget build: loads dist/widget/
// canvas-viewer.html over file:// with full network interception and
// asserts (a) zero http(s) requests, (b) a rendered <canvas>, and
// (c) the embedded font is ACTUALLY loaded (document.fonts.check +
// FontFace status), not silently falling back to a system font. Zero
// network alone would not catch a font that failed to register — the
// canvas would still render, just with the wrong glyphs.
//
// Direct invocation requires Node's native TS support (stable since Node 24,
// this repo's pinned version) — no build step, no tsx loader flag needed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { findExternalResourceUrls } from '../src/widget/check-html.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '..')
const builtHtmlPath = join(packageRoot, 'dist', 'widget', 'canvas-viewer.html')

// Plain ASCII text so the Basic-Latin subset embedded in
// src/widget/font-assets.ts is the one exercised by document.fonts.check.
const SAMPLE_TEXT = 'Hello widget'
const SAMPLE_SCENE = {
  elements: [
    {
      id: 'text-1',
      type: 'text',
      x: 10,
      y: 10,
      width: 160,
      height: 25,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      text: SAMPLE_TEXT,
      fontSize: 20,
      fontFamily: 5, // FONT_FAMILY.Excalifont
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      originalText: SAMPLE_TEXT,
      lineHeight: 1.25,
    },
  ],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
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
    (_match, open, _placeholder, close) => `${open}${JSON.stringify(SAMPLE_SCENE)}${close}`,
  )
  if (injectedHtml === html) {
    fail('could not find the embedded-scene <script> slot to inject the sample scene into')
    return
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'whiteboard-widget-smoke-'))
  const tmpHtmlPath = join(tmpDir, 'canvas-viewer.html')
  writeFileSync(tmpHtmlPath, injectedHtml, 'utf8')

  const executablePath = process.env.WHITEBOARD_CHROME_PATH?.trim() || undefined
  const browser = await chromium.launch({ executablePath })
  try {
    const page = await browser.newPage()
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
    await page.waitForSelector('canvas', { timeout: 10_000 })

    const fontCheck = await page.evaluate(async (text) => {
      await document.fonts.ready
      // window.__whiteboardWidgetFonts__ (see widget-entry.ts) is exactly
      // the FontFace instances this build registered — document.fonts
      // alone is ambiguous because Excalidraw's own font manager also adds
      // an 'Excalifont'-family FontFace placeholder per remote variant it
      // knows about, unrelated to whether this build embedded it.
      const ours = window.__whiteboardWidgetFonts__ ?? []
      return {
        checked: document.fonts.check('20px Excalifont', text),
        registeredCount: ours.length,
        statuses: ours.map((f) => f.status),
      }
    }, SAMPLE_TEXT)

    if (networkRequests.length > 0) {
      fail(`expected zero network requests, saw: ${networkRequests.join(', ')}`)
    }
    if (!fontCheck.checked) {
      fail('document.fonts.check reported the Excalifont family/text as not available')
    }
    if (fontCheck.registeredCount === 0) {
      fail('window.__whiteboardWidgetFonts__ was empty — widget-entry did not register any font')
    } else if (!fontCheck.statuses.every((s) => s === 'loaded')) {
      fail(
        `expected every widget-registered FontFace to be 'loaded', got: ${JSON.stringify(fontCheck.statuses)}`,
      )
    }

    if (process.exitCode !== 1) {
      console.log('[widget-smoke] PASS: zero network requests, canvas rendered, fonts loaded')
    }
  } finally {
    await browser.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

await main()
