import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The manifest (vite-pwa-options.ts) declares these exact files and sizes
// with purpose 'any maskable'. A regeneration (scripts/generate-pwa-icons.mjs)
// that writes the wrong dimensions would ship a manifest that lies to the
// installer — pin the PNG headers here.
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(new URL(path, import.meta.url))
  // PNG signature, then IHDR: width/height are big-endian u32 at 16/20.
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('PWA icons', () => {
  it('icon-192.png matches its manifest entry', () => {
    expect(pngSize('./public/icon-192.png')).toEqual({ width: 192, height: 192 })
  })

  it('icon-512.png matches its manifest entry', () => {
    expect(pngSize('./public/icon-512.png')).toEqual({ width: 512, height: 512 })
  })
})
