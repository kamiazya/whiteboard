import { afterEach, describe, expect, it, vi } from 'vitest'
import { clear, clearIfMatches, load, STORAGE_KEY, save } from './reconnect-secret-store.js'

describe('reconnect-secret-store', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('round-trips a secret for its origin', () => {
    expect(save('http://localhost:3099', 'secret-1')).toBe(true)
    expect(load('http://localhost:3099')).toBe('secret-1')
  })

  it('canonicalizes a trailing slash / default port / case difference to the same origin', () => {
    save('http://LOCALHOST:3099/', 'secret-1')
    expect(load('http://localhost:3099')).toBe('secret-1')
  })

  it('rejects an input carrying userinfo, path, query, or hash and does not persist it', () => {
    expect(save('http://user:pass@localhost:3099', 'secret-1')).toBe(false)
    expect(save('http://localhost:3099/some/path', 'secret-1')).toBe(false)
    expect(save('http://localhost:3099?x=1', 'secret-1')).toBe(false)
    expect(save('http://localhost:3099#frag', 'secret-1')).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('rejects an empty secret and does not persist it', () => {
    expect(save('http://localhost:3099', '')).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('returns null when the stored origin does not match the requested origin', () => {
    save('http://localhost:3099', 'secret-1')
    expect(load('http://localhost:4000')).toBeNull()
  })

  it('returns null for corrupt JSON without throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not json{{{')
    expect(() => load('http://localhost:3099')).not.toThrow()
    expect(load('http://localhost:3099')).toBeNull()
  })

  it('returns null for a legacy/unknown shape', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: 'bar' }))
    expect(load('http://localhost:3099')).toBeNull()
  })

  it('save returns false without propagating when localStorage.setItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded')
    })
    expect(() => save('http://localhost:3099', 'secret-1')).not.toThrow()
    expect(save('http://localhost:3099', 'secret-1')).toBe(false)
    spy.mockRestore()
  })

  it('clearIfMatches only removes the record when the presented secret still matches', () => {
    save('http://localhost:3099', 'secret-1')
    clearIfMatches('http://localhost:3099', 'wrong-secret')
    expect(load('http://localhost:3099')).toBe('secret-1')

    clearIfMatches('http://localhost:3099', 'secret-1')
    expect(load('http://localhost:3099')).toBeNull()
  })

  it('clear removes the record unconditionally', () => {
    save('http://localhost:3099', 'secret-1')
    clear()
    expect(load('http://localhost:3099')).toBeNull()
  })
})
