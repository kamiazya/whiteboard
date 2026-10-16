import { afterEach, describe, expect, it } from 'vitest'
import { isNotKeeping, type SessionHealth, sessionHealthOf } from './connection-state.js'
import {
  applyFavicon,
  browserFaviconStatus,
  daemonFaviconStatus,
  type FaviconStatus,
  projectRectsToBoard,
  resolveRectColor,
  STATIC_FAVICON_HREF,
} from './favicon.js'

describe('projectRectsToBoard', () => {
  it('returns no rects for an empty scene (favicon falls back to the logo squiggle)', () => {
    expect(projectRectsToBoard([])).toEqual([])
  })

  it('fits the scene bounding box inside the board with uniform scale', () => {
    const projected = projectRectsToBoard([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 900, y: 0, w: 100, h: 100 },
    ])
    expect(projected).toHaveLength(2)
    for (const r of projected) {
      expect(r.x).toBeGreaterThanOrEqual(4)
      expect(r.y).toBeGreaterThanOrEqual(7)
      expect(r.x + r.w).toBeLessThanOrEqual(28)
      expect(r.y + r.h).toBeLessThanOrEqual(25)
    }
    // Uniform scale: the two same-sized nodes stay the same projected size.
    expect(projected[0].w).toBeCloseTo(projected[1].w)
    expect(projected[0].h).toBeCloseTo(projected[1].h)
  })

  it('keeps every projected rect visibly sized (min clamp)', () => {
    const projected = projectRectsToBoard([
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 100000, y: 100000, w: 1, h: 1 },
    ])
    for (const r of projected) {
      expect(r.w).toBeGreaterThanOrEqual(1.4)
      expect(r.h).toBeGreaterThanOrEqual(1.4)
    }
  })

  it('caps the rendered rect count for huge scenes', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ x: i * 10, y: 0, w: 8, h: 8 }))
    expect(projectRectsToBoard(many).length).toBeLessThanOrEqual(16)
  })
})

describe('applyFavicon', () => {
  afterEach(() => {
    for (const l of document.head.querySelectorAll('link[rel="icon"]')) l.remove()
  })

  it('installs a favicon link and updates it in place', () => {
    applyFavicon('data:image/png;base64,AAA')
    const links = document.head.querySelectorAll('link[rel="icon"]')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe('data:image/png;base64,AAA')

    applyFavicon('data:image/png;base64,BBB')
    const again = document.head.querySelectorAll('link[rel="icon"]')
    expect(again).toHaveLength(1)
    expect(again[0]?.getAttribute('href')).toBe('data:image/png;base64,BBB')
  })

  it('restores the static favicon on null (unmount path)', () => {
    applyFavicon('data:image/png;base64,AAA')
    applyFavicon(null)
    const links = document.head.querySelectorAll('link[rel="icon"]')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe(STATIC_FAVICON_HREF)
  })
})

describe('resolveRectColor', () => {
  it('maps a JSON Canvas preset key to its palette stroke', () => {
    expect(resolveRectColor('1')).toBe('#dc2626')
    expect(resolveRectColor('4')).toBe('#059669')
  })

  it('passes a hex color through', () => {
    expect(resolveRectColor('#123abc')).toBe('#123abc')
  })

  it('falls back to the neutral gray for missing or unknown values', () => {
    expect(resolveRectColor(undefined)).toBe('#909090')
    expect(resolveRectColor('7')).toBe('#909090')
  })

  // An invalid fillStyle assignment is IGNORED by canvas, which would leak
  // the previous rect's color into this one — reject it here instead.
  it('rejects malformed hex values', () => {
    expect(resolveRectColor('#12345')).toBe('#909090')
    expect(resolveRectColor('#12345g')).toBe('#909090')
    expect(resolveRectColor('#')).toBe('#909090')
  })
})

describe('status mappings', () => {
  // A healthy keeper is QUIET — no dot — for the same reason the shell mark
  // draws none: the routine state asks nothing of a tab strip.
  // Every session health, so a new one cannot reach the tab unjudged.
  const DAEMON_EXPECTED = {
    synced: 'quiet',
    reconnecting: 'syncing',
    'sync-off': 'offline',
    'write-failed': 'unsaved',
  } as const satisfies Record<SessionHealth, FaviconStatus>
  const healths = Object.keys(DAEMON_EXPECTED) as SessionHealth[]

  it.each(healths)('daemon: the %s session reads as its tab status', (session) => {
    expect(daemonFaviconStatus(session)).toBe(DAEMON_EXPECTED[session])
  })

  it('daemon: a keeper that is not keeping never reads quiet or syncing', () => {
    const notKeeping = healths.filter((session) => isNotKeeping({ keeper: 'daemon', session }))
    expect(notKeeping.length).toBeGreaterThan(0)
    for (const session of notKeeping) {
      expect(['quiet', 'syncing']).not.toContain(daemonFaviconStatus(session))
    }
  })

  it('daemon: a connected session whose write failed reads unsaved', () => {
    const writeFailed = {
      kind: 'degraded',
      reason: 'write-failed',
      message: 'The daemon did not take this write',
      lastSavedAt: null,
    } as const
    expect(daemonFaviconStatus(sessionHealthOf(false, 'connected', writeFailed))).toBe('unsaved')
  })

  it('browser: the storage judgement maps one-to-one, ok being quiet', () => {
    expect(browserFaviconStatus('ok')).toBe('quiet')
    expect(browserFaviconStatus('stuck')).toBe('unsaved')
    expect(browserFaviconStatus('failed')).toBe('offline')
  })
})
