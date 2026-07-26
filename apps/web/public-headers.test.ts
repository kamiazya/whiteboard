import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const headersText = readFileSync(resolve(__dirname, 'public/_headers'), 'utf8')

// A minimal per-path-block parser: Cloudflare Pages `_headers` groups
// `Key: Value` lines under a `/path` line until the next path or EOF.
function parseHeaderBlocks(text: string): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>()
  let currentPath: string | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('/')) {
      currentPath = line
      blocks.set(currentPath, new Map())
      continue
    }
    if (currentPath === null) continue
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    blocks.get(currentPath)?.set(key, value)
  }
  return blocks
}

describe('public/_headers', () => {
  const blocks = parseHeaderBlocks(headersText)

  it('serves sw.js with a cache policy that forces revalidation', () => {
    const swHeaders = blocks.get('/sw.js')
    expect(swHeaders).toBeDefined()
    const cacheControl = swHeaders?.get('Cache-Control') ?? ''
    expect(/no-cache|max-age=0/.test(cacheControl)).toBe(true)
  })

  it('serves the web manifest with a sane cache policy and content type', () => {
    const manifestHeaders = blocks.get('/manifest.webmanifest')
    expect(manifestHeaders).toBeDefined()
    expect(manifestHeaders?.get('Content-Type')).toMatch(/manifest\+json/)
  })

  it('permits worker-src in the CSP so the service worker can load under it', () => {
    const globalHeaders = blocks.get('/*')
    const csp = globalHeaders?.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("worker-src 'self'")
  })

  it('scopes font-src to exactly self and data: — Excalidraw subsets fonts as data: URLs, and default-src alone blocks them', () => {
    const globalHeaders = blocks.get('/*')
    const csp = globalHeaders?.get('Content-Security-Policy') ?? ''
    const match = csp.match(/font-src ([^;]+)/)
    expect(match).not.toBeNull()
    const sources = new Set((match?.[1] ?? '').trim().split(/\s+/))
    expect(sources).toEqual(new Set(["'self'", 'data:']))
  })
})
