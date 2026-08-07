import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPairingGrantStore } from './pairing-grant-store.js'

let dir: string | null = null
function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'pairing-grants-'))
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('pairing grant store', () => {
  it('persists a grant and lists its origin', () => {
    const store = createPairingGrantStore(tempDir())
    const grant = store.addGrant('https://latest.kamiazya-whiteboard.pages.dev')
    expect(grant.origin).toBe('https://latest.kamiazya-whiteboard.pages.dev')
    expect(store.origins()).toEqual(['https://latest.kamiazya-whiteboard.pages.dev'])

    // A fresh store instance over the same dir sees the persisted grant.
    const reloaded = createPairingGrantStore(dir as string)
    expect(reloaded.origins()).toEqual(['https://latest.kamiazya-whiteboard.pages.dev'])
  })

  it('normalizes to the URL origin and deduplicates', () => {
    const store = createPairingGrantStore(tempDir())
    store.addGrant('https://Example.COM/some/path?q=1')
    store.addGrant('https://example.com')
    expect(store.origins()).toEqual(['https://example.com'])
  })

  it('rejects non-http(s) origins', () => {
    const store = createPairingGrantStore(tempDir())
    expect(() => store.addGrant('javascript:alert(1)')).toThrow()
    expect(() => store.addGrant('not a url')).toThrow()
    expect(store.origins()).toEqual([])
  })

  it('origins() returns a NEW array instance per mutation generation', () => {
    // The array-identity pattern cache in web-origin-allowlist.ts depends
    // on this: an in-place append would serve stale compiled patterns.
    const store = createPairingGrantStore(tempDir())
    const before = store.origins()
    expect(store.origins()).toBe(before) // stable while unchanged
    store.addGrant('https://example.com')
    const after = store.origins()
    expect(after).not.toBe(before)
  })

  it('revoke removes the grant and its origin', () => {
    const store = createPairingGrantStore(tempDir())
    const grant = store.addGrant('https://example.com')
    expect(store.revoke(grant.grantId)).toBe(true)
    expect(store.origins()).toEqual([])
    expect(store.revoke('missing')).toBe(false)
  })

  it('degrades a corrupt file to an empty store instead of throwing', () => {
    const dirPath = tempDir()
    writeFileSync(join(dirPath, 'pairing-grants.json'), '{not json')
    const store = createPairingGrantStore(dirPath)
    expect(store.origins()).toEqual([])
    // And it can still write after the corrupt load.
    store.addGrant('https://example.com')
    expect(
      JSON.parse(readFileSync(join(dirPath, 'pairing-grants.json'), 'utf8')).grants,
    ).toHaveLength(1)
  })
})
