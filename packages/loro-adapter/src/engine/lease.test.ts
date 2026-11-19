import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createCrdtEngine } from './engine.js'
import {
  exportSnapshot,
  exportUpdateSince,
  importBytes,
  ownedLease,
  read,
  readNow,
  versionOf,
  WriteRefusedError,
  withLease,
  write,
} from './lease.js'

const body = (text: string) => [{ op: 'writeMarkdownBody' as const, args: { body: text } }]
const BODY = { query: 'markdownBody' as const }
const text = z.string()

function leased(peer = '1') {
  const engine = createCrdtEngine()
  return { engine, lease: ownedLease(engine, engine.open({ peer }).handle) }
}

describe('a lease over an engine handle', () => {
  it('closes an owned handle on release, once', () => {
    const { engine, lease } = leased()
    const close = vi.spyOn(engine, 'close')
    lease.release()
    lease.release()
    expect(close).toHaveBeenCalledTimes(1)
    expect(() => versionOf(lease)).toThrow(/not open/)
  })

  it('releases a handle the engine already lost without throwing', () => {
    const { engine, lease } = leased()
    engine.close({ handle: lease.handle })
    expect(() => lease.release()).not.toThrow()
  })

  it('releases when the work returns, rejects or throws', async () => {
    const outcomes = [
      () => 'done',
      () => Promise.reject(new Error('later')),
      () => {
        throw new Error('now')
      },
    ]
    for (const work of outcomes) {
      const { engine, lease } = leased()
      const close = vi.spyOn(engine, 'close')
      await withLease(lease, work).catch(() => undefined)
      expect(close).toHaveBeenCalledTimes(1)
    }
  })
})

describe('the host kit over a lease', () => {
  it('writes, reads in both forms, and answers a version a keeper can store', async () => {
    const { lease } = leased()
    write(lease, body('hello'))
    expect(await read(lease, BODY, text)).toBe('hello')
    expect(readNow(lease, BODY, text)).toBe('hello')
    const version = versionOf(lease)
    expect(version.entries.length).toBeGreaterThan(0)
    expect(version.frontiers.length).toBeGreaterThan(0)
    expect(version.encoded.byteLength).toBeGreaterThan(0)
  })

  it('exports a snapshot a second replica opens, and the updates since a version', async () => {
    const { lease } = leased('1')
    write(lease, body('one'))
    const snapshot = exportSnapshot(lease)
    const since = versionOf(lease).encoded
    write(lease, body('one two'))
    const update = exportUpdateSince(lease, since)
    const whole = exportUpdateSince(lease, null)
    expect(update.byteLength).toBeGreaterThan(0)
    expect(whole.byteLength).toBeGreaterThan(update.byteLength)

    const other = leased('2')
    importBytes(other.lease, snapshot, 'none')
    expect(readNow(other.lease, BODY, text)).toBe('one')
    importBytes(other.lease, update, 'none')
    expect(readNow(other.lease, BODY, text)).toBe('one two')
  })

  it('answers a refused import as the engine does, which is not an error', () => {
    const { lease } = leased()
    const peer = new LoroDoc()
    peer.getText('body').insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1))
    peer.commit()
    const bytes = peer.export({ mode: 'update' })
    expect(importBytes(lease, bytes, 'text')).toMatchObject({ outcome: 'refused' })
    expect(readNow(lease, BODY, text)).toBe('')
    expect(importBytes(lease, bytes, 'none').outcome).toBe('applied')
  })

  it('throws a typed error on a refused write, or hands the refusal back when asked', async () => {
    const { lease } = leased()
    write(lease, body('kept'))
    const tooLong = body('y'.repeat(MARKDOWN_MAX_CHARS + 1))
    expect(() => write(lease, tooLong)).toThrow(WriteRefusedError)
    try {
      write(lease, tooLong)
    } catch (error) {
      expect((error as WriteRefusedError).breach.shape).toBe('run')
    }
    expect(write(lease, tooLong, { refusal: 'return' })).toMatchObject({ outcome: 'refused' })
    expect(await read(lease, BODY, text)).toBe('kept')
  })

  it('applies a write the host names unjudged, where an unnamed write is refused', () => {
    const { lease } = leased()
    const tooLong = body('y'.repeat(MARKDOWN_MAX_CHARS + 1))
    expect(write(lease, tooLong, { refusal: 'return' })).toMatchObject({ outcome: 'refused' })
    expect(write(lease, tooLong, { judge: 'none' }).outcome).toBe('applied')
    expect(readNow(lease, BODY, text)).toHaveLength(MARKDOWN_MAX_CHARS + 1)
  })

  it('refuses a read the answer of which does not fit the shape asked for', () => {
    const { lease } = leased()
    write(lease, body('hello'))
    expect(() => readNow(lease, BODY, z.number())).toThrow()
  })
})
