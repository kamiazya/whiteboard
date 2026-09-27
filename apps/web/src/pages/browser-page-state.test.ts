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
    const out = derivePageState({ snapshot: null, persistence: degraded })
    expect(out).toEqual({ kind: 'load-degraded', message: 'Save failed.' })
  })

  it('snapshot=null + persistence not degraded → loading', () => {
    expect(derivePageState({ snapshot: null, persistence: saved })).toEqual({ kind: 'loading' })
  })

  it('snapshot present → editing (regardless of persistence kind), and the persistence flows through unchanged', () => {
    for (const p of [saved, pending, saving, degraded]) {
      const out = derivePageState({ snapshot, persistence: p })
      expect(out.kind).toBe('editing')
      // Type-narrow check: editing carries snapshot + persistence verbatim.
      if (out.kind === 'editing') {
        expect(out.snapshot).toBe(snapshot)
        expect(out.persistence).toBe(p)
      }
    }
  })

  it('the cascade is exhaustive over the documented surface', () => {
    const kinds = new Set<string>()
    for (const snap of [null, snapshot]) {
      for (const p of [saved, pending, saving, degraded]) {
        kinds.add(derivePageState({ snapshot: snap, persistence: p }).kind)
      }
    }
    expect([...kinds].sort()).toEqual(['editing', 'load-degraded', 'loading'].sort())
  })
})
