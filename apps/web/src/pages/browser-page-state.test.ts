// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BrowserPersistenceState } from '../lib/browser-persistence-state.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { derivePageState } from './browser-page-state.js'

const snapshot: DocumentSnapshot = {
  documentId: '0ADGKPSWZ258BEHMQTX0369CFJ',
  workspaceId: 'local',
  path: 'untitled',
  name: 'untitled',
  updatedAt: '2026-05-04T00:00:00.000Z',
  kind: 'spatial' as const,
}

const saved: BrowserPersistenceState = { kind: 'saved', lastSavedAt: null }
const pending: BrowserPersistenceState = { kind: 'pending', lastSavedAt: null }
const saving: BrowserPersistenceState = { kind: 'saving', lastSavedAt: null }
const degraded: BrowserPersistenceState = {
  kind: 'degraded',
  reason: 'save-failed',
  message: 'Save failed.',
  lastSavedAt: null,
}

describe('derivePageState', () => {
  it('snapshot=null + persistence=degraded → load-degraded carrying the persistence message verbatim (helper is the single render source)', () => {
    const out = derivePageState({ snapshot: null, persistence: degraded, cleanupCompleted: false })
    expect(out).toEqual({ kind: 'load-degraded', message: 'Save failed.' })
  })

  it('load-degraded wins over cleanup-completed: a degraded load means cleanup never ran successfully', () => {
    // Defence-in-depth — the controller never sets cleanupCompleted
    // while persistence is degraded (cleanup runs from the editor),
    // but if both flags somehow flipped on, the safer banner wins.
    expect(
      derivePageState({ snapshot: null, persistence: degraded, cleanupCompleted: true }),
    ).toEqual({ kind: 'load-degraded', message: 'Save failed.' })
  })

  it('snapshot=null + cleanupCompleted=true (and persistence not degraded) → cleanup-completed', () => {
    expect(derivePageState({ snapshot: null, persistence: saved, cleanupCompleted: true })).toEqual(
      { kind: 'cleanup-completed' },
    )
  })

  it('snapshot=null + cleanupCompleted=false + persistence not degraded → loading', () => {
    expect(
      derivePageState({ snapshot: null, persistence: saved, cleanupCompleted: false }),
    ).toEqual({ kind: 'loading' })
  })

  it('snapshot present → editing (regardless of persistence kind), and the persistence flows through unchanged', () => {
    for (const p of [saved, pending, saving, degraded]) {
      const out = derivePageState({ snapshot, persistence: p, cleanupCompleted: false })
      expect(out.kind).toBe('editing')
      // Type-narrow check: editing carries snapshot + persistence verbatim.
      if (out.kind === 'editing') {
        expect(out.snapshot).toBe(snapshot)
        expect(out.persistence).toBe(p)
      }
    }
  })

  it('cleanupCompleted=true does NOT override editing when a snapshot is still present', () => {
    // Sequencing: setSnapshot(null) and setCleanupCompleted(true)
    // are both called from the cleanup success branch but are not
    // batched against each other in older React versions. If a
    // render were to observe `snapshot != null && cleanupCompleted`,
    // the page must keep editing — falling into the completion view
    // with a still-rendered editor underneath would be confusing.
    const out = derivePageState({ snapshot, persistence: saved, cleanupCompleted: true })
    expect(out.kind).toBe('editing')
  })

  it('the cascade is exhaustive over the documented surface', () => {
    // Smoke check: every (snapshot × persistence-kind ×
    // cleanupCompleted) cell maps to exactly one of the four
    // documented kinds. A future field that's added to the input
    // shape and routed into a fifth kind without updating the
    // helper would fail TypeScript here.
    const kinds = new Set<string>()
    for (const snap of [null, snapshot]) {
      for (const p of [saved, pending, saving, degraded]) {
        for (const cleanup of [false, true]) {
          kinds.add(
            derivePageState({ snapshot: snap, persistence: p, cleanupCompleted: cleanup }).kind,
          )
        }
      }
    }
    expect([...kinds].sort()).toEqual(
      ['cleanup-completed', 'editing', 'load-degraded', 'loading'].sort(),
    )
  })
})
