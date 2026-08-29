import { describe, expect, it } from 'vitest'
import { mergePersistence } from './merge-persistence.js'
import type { BrowserPersistenceState } from './use-browser-document-controller.js'

const saved = (at: string | null = null): BrowserPersistenceState => ({
  kind: 'saved',
  lastSavedAt: at,
})
const pending = (at: string | null = null): BrowserPersistenceState => ({
  kind: 'pending',
  lastSavedAt: at,
})
const saving = (at: string | null = null): BrowserPersistenceState => ({
  kind: 'saving',
  lastSavedAt: at,
})
const degraded = (at: string | null = null): BrowserPersistenceState => ({
  kind: 'degraded',
  reason: 'write-failed',
  message: 'The last write to this browser failed.',
  lastSavedAt: at,
})

/**
 * A markdown document has TWO writers — the controller (rename, spatial) and
 * the markdown body's own debounced save — and one indicator between them.
 *
 * The rule follows from what the indicator promises: it says "your work is
 * safe here". It may only say that when BOTH writers agree, because the one
 * that is behind is exactly the one holding unsaved work. Before this
 * existed, the chip showed the controller alone, which never moves for a body
 * edit — so it read `Saved` over text that had not been written.
 */
describe('mergePersistence', () => {
  it('is saved only when both writers are', () => {
    expect(mergePersistence(saved(), saved()).kind).toBe('saved')
  })

  it('reports the unsettled writer, whichever side it is on', () => {
    expect(mergePersistence(saved(), pending()).kind).toBe('pending')
    expect(mergePersistence(pending(), saved()).kind).toBe('pending')
    expect(mergePersistence(saved(), saving()).kind).toBe('saving')
    expect(mergePersistence(saving(), saved()).kind).toBe('saving')
  })

  /**
   * A failure outranks work still in flight: the pending write may yet land,
   * the failed one already did not, and that is the state a person needs to
   * act on.
   */
  it('lets a failure outrank a pending write', () => {
    expect(mergePersistence(degraded(), pending()).kind).toBe('degraded')
    expect(mergePersistence(pending(), degraded()).kind).toBe('degraded')
    expect(mergePersistence(degraded(), saving()).kind).toBe('degraded')
  })

  /**
   * `lastSavedAt` answers "when was anything last written for this document",
   * so the later of the two is the truthful answer regardless of which writer
   * is currently unsettled.
   */
  it('carries the later lastSavedAt through', () => {
    const earlier = '2026-01-01T00:00:00.000Z'
    const later = '2026-06-01T00:00:00.000Z'
    expect(mergePersistence(saved(earlier), pending(later)).lastSavedAt).toBe(later)
    expect(mergePersistence(saved(later), pending(earlier)).lastSavedAt).toBe(later)
    expect(mergePersistence(saved(later), pending(null)).lastSavedAt).toBe(later)
    expect(mergePersistence(saved(null), saved(null)).lastSavedAt).toBeNull()
  })

  it('keeps the degraded message rather than flattening it to a kind', () => {
    const merged = mergePersistence(saved(), degraded())
    expect(merged.kind === 'degraded' && merged.message).toBe(
      'The last write to this browser failed.',
    )
  })
})
