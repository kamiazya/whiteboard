// Smoke test for the actual jsdom/canvas/resvg pipeline. Other route tests
// mock the renderer to keep them fast; this file exists so a regression
// inside `headless-renderer.ts` itself surfaces in the unit-test suite.

import { describe, expect, it } from 'vitest'
import { renderSceneToPng } from './headless-renderer.js'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Sample the brightness of a 1x1 px corner using @napi-rs/canvas. Corner pixels
// are normally outside any element so they reflect the theme background.
async function cornerLuminance(png: Buffer): Promise<number> {
  const { createCanvas, loadImage } = (await import('@napi-rs/canvas')) as unknown as {
    createCanvas(w: number, h: number): {
      getContext(kind: '2d'): {
        drawImage(img: unknown, x: number, y: number): void
        getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }
      }
    }
    loadImage(buf: Buffer): Promise<{ width: number; height: number }>
  }
  const img = await loadImage(png)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(2, 2, 1, 1)
  // Rec. 709 luma. 0 = black, 255 = white.
  return 0.2126 * data[0] + 0.7152 * data[1] + 0.0722 * data[2]
}

const baseEl = (over: Record<string, unknown>) => ({
  angle: 0,
  strokeColor: '#1971c2',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...over,
})

describe('headless-renderer', () => {
  it('renders a rectangle scene to a real PNG with the expected magic header', async () => {
    const scene = {
      type: 'excalidraw' as const,
      version: 2,
      source: '@kamiazya/whiteboard-test',
      appState: { viewBackgroundColor: '#ffffff' },
      elements: [
        baseEl({
          id: 'rect-1',
          type: 'rectangle',
          x: 50,
          y: 50,
          width: 200,
          height: 100,
          backgroundColor: '#a5d8ff',
          roundness: { type: 3 },
        }),
      ],
    }
    const result = await renderSceneToPng(scene)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
    // Real PNG output, not just a stub buffer.
    expect(result.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
    // Sanity-check the byte size: a single rounded rect should produce more
    // than a few hundred bytes but well under 1 MB.
    expect(result.png.length).toBeGreaterThan(500)
    expect(result.png.length).toBeLessThan(1_000_000)
  })

  it('honours frameId by clipping out elements that do not belong to the frame', async () => {
    const frameId = 'frame-1'
    const scene = {
      type: 'excalidraw' as const,
      version: 2,
      source: '@kamiazya/whiteboard-test',
      appState: { viewBackgroundColor: '#ffffff' },
      elements: [
        baseEl({ id: frameId, type: 'frame', x: 100, y: 100, width: 300, height: 200, name: 'In' }),
        baseEl({
          id: 'inside',
          type: 'rectangle',
          x: 130,
          y: 140,
          width: 240,
          height: 80,
          backgroundColor: '#a5d8ff',
          fillStyle: 'solid',
          frameId,
          roundness: { type: 3 },
        }),
        baseEl({
          id: 'outside',
          type: 'rectangle',
          x: 800,
          y: 800,
          width: 200,
          height: 200,
          backgroundColor: '#fecaca',
          fillStyle: 'solid',
        }),
      ],
    }
    const wholeScene = await renderSceneToPng(scene)
    const onlyFrame = await renderSceneToPng(scene, { frameId })
    // The clipped render should be smaller than the full render because the
    // outside element extends to (1000, 1000); the rect is at (100, 100)-
    // (400, 300).
    expect(onlyFrame.width).toBeLessThan(wholeScene.width)
    expect(onlyFrame.height).toBeLessThan(wholeScene.height)
  })

  it('renders a dark canvas background when theme="dark"', async () => {
    const scene = {
      type: 'excalidraw' as const,
      version: 2,
      source: '@kamiazya/whiteboard-test',
      // Pick a viewBackgroundColor that the theme override should beat.
      appState: { viewBackgroundColor: '#ffffff' },
      elements: [
        baseEl({
          id: 'rect-light',
          type: 'rectangle',
          x: 50,
          y: 50,
          width: 200,
          height: 100,
          backgroundColor: '#a5d8ff',
          roundness: { type: 3 },
        }),
      ],
    }
    const light = await renderSceneToPng(scene, { theme: 'light' })
    const dark = await renderSceneToPng(scene, { theme: 'dark' })
    // Same scene rendered with two themes must not produce byte-identical PNGs.
    expect(dark.png.equals(light.png)).toBe(false)
    const lightLuma = await cornerLuminance(light.png)
    const darkLuma = await cornerLuminance(dark.png)
    expect(lightLuma).toBeGreaterThan(200)
    expect(darkLuma).toBeLessThan(80)
  })

  it('does not replace globalThis.fetch (would break DaemonClient.request, ensureDaemon ping, library tools)', async () => {
    // Pin the original Node fetch BEFORE forcing renderer init — anything
    // touching the renderer must not flip this reference, otherwise
    // process-wide HTTP calls start throwing "fetch is disabled".
    const originalFetch = globalThis.fetch
    expect(typeof originalFetch).toBe('function')

    // Force renderer init via the existing public entry. We do not need to
    // render anything for the bug surface; constructing the exporter is
    // enough to exercise the polyfill block.
    const { prewarmHeadlessExporter } = await import('./headless-renderer.js')
    await prewarmHeadlessExporter()

    expect(globalThis.fetch).toBe(originalFetch)
    // And the original is still callable as a real fetch (in particular
    // it does not throw the headless-renderer guard).
    await expect(globalThis.fetch('http://127.0.0.1:1/__never__').catch((e) => String(e))).resolves.not.toMatch(
      /fetch is disabled in headless-renderer/,
    )
  })
})
