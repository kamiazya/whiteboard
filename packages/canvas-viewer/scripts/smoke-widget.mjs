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
import { serializeSceneForScriptTag } from '../src/widget/embed-scene.ts'

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
    {
      // Non-Latin text exercises the NOT-embedded glyph path: the bundle
      // ships only the Basic-Latin subset, so this must degrade to system
      // fallback glyphs while the fetch shim keeps the run at zero network
      // requests (unknown font files get a synthetic 404, never a fetch).
      id: 'text-jp',
      type: 'text',
      x: 10,
      y: 50,
      width: 200,
      height: 25,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 2,
      version: 1,
      versionNonce: 2,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      text: '日本語ラベル',
      fontSize: 20,
      fontFamily: 5,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      originalText: '日本語ラベル',
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

    // Non-Latin fallback actually RENDERS: load a second copy whose scene
    // contains only the Japanese text element and assert the canvas has a
    // meaningful number of dark pixels. Scanning the whole canvas avoids
    // scene->canvas coordinate math (zoom/scroll/devicePixelRatio); the
    // only dark ink possible in this scene is the JP text itself, so a
    // blank render (glyphs silently dropped) fails deterministically.
    const jpOnlyScene = {
      ...SAMPLE_SCENE,
      elements: SAMPLE_SCENE.elements.filter((el) => el.id === 'text-jp'),
    }
    const jpHtml = html.replace(
      /(<script type="application\/json" data-whiteboard-scene>)(.*?)(<\/script>)/s,
      (_match, open, _placeholder, close) =>
        `${open}${serializeSceneForScriptTag(jpOnlyScene)}${close}`,
    )
    const jpHtmlPath = join(tmpDir, 'canvas-viewer-jp.html')
    writeFileSync(jpHtmlPath, jpHtml, 'utf8')
    const jpPage = await browser.newPage()
    await jpPage.route('http://**', (route) => {
      networkRequests.push(route.request().url())
      return route.abort()
    })
    await jpPage.route('https://**', (route) => {
      networkRequests.push(route.request().url())
      return route.abort()
    })
    await jpPage.goto(`file://${jpHtmlPath}`)
    await jpPage.waitForSelector('canvas', { timeout: 10_000 })
    const jpDarkPixels = await jpPage.evaluate(async () => {
      await document.fonts.ready
      // Give Excalidraw one frame to paint after fonts settle.
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      let dark = 0
      for (const canvas of document.querySelectorAll('canvas')) {
        const ctx = canvas.getContext('2d')
        if (!ctx || canvas.width === 0 || canvas.height === 0) continue
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3] ?? 0
          if (alpha > 128 && (data[i] ?? 255) < 100) dark += 1
        }
      }
      return dark
    })
    if (jpDarkPixels < 50) {
      fail(
        `expected the Japanese-only scene to paint fallback glyphs (>=50 dark pixels), got ${jpDarkPixels}`,
      )
    }
    if (networkRequests.length > 0) {
      fail(`expected zero network requests after the JP render, saw: ${networkRequests.join(', ')}`)
    }

    if (process.exitCode !== 1) {
      console.log(
        '[widget-smoke] PASS: zero network requests, canvas rendered, fonts loaded, JP fallback painted',
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
