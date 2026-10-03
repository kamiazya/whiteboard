// @vitest-environment node
import { readFileSync } from 'node:fs'
import { viewportRequestParamsSchema } from '@kamiazya/whiteboard-daemon-client/sync-frames'
import { describe, expect, it } from 'vitest'

// A wire key the browser never reads is a silent no-op that the daemon still
// reports as delivered, so every key the contract publishes must be read off
// the payload by the one function that applies it. Scoped to that file rather
// than to apps/web/src: `zoom` is spelled everywhere in the editor and
// `animate` is a Tailwind class prefix, so a tree-wide scan finds a "reader"
// for a key nothing consults.
const READER = new URL('./viewport-request.ts', import.meta.url)

function codeOf(path: URL): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('viewport_request wire keys', () => {
  const keys = Object.keys(viewportRequestParamsSchema.shape)
  const code = codeOf(READER)

  it('scans a real key set', () => {
    // A key set far below what the contract holds means the schema moved or
    // the import resolved to something else, and the loop below checks nothing.
    expect(keys.length).toBeGreaterThanOrEqual(5)
    expect(code).toContain('payload.')
  })

  it.each(keys)('%s is read off the payload by applyViewportRequest', (key) => {
    expect(code).toMatch(new RegExp(`\\bpayload\\.${key}\\b`))
  })
})
