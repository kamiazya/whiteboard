// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { candidateBaseUrls, discoverDaemons, rememberKnownDaemon } from './daemon-discovery.js'
import type { DaemonProbeResult, ProbeDaemonOptions } from './daemon-probe.js'

const DETECTED = (id: string): DaemonProbeResult => ({ detected: true, instanceId: id })
const MISS: DaemonProbeResult = { detected: false, reason: 'refused' }

function probeMap(map: Record<string, DaemonProbeResult>) {
  return vi.fn(
    async (baseUrl: string, _options: ProbeDaemonOptions): Promise<DaemonProbeResult> => {
      return map[baseUrl] ?? MISS
    },
  )
}

describe('candidateBaseUrls', () => {
  it('names only what the user pointed at or previously reached', () => {
    // No port sweep. Scanning a fixed range guesses, and the guess is wrong
    // in both directions: it misses every daemon outside it (a dev worktree's
    // derived port, a packaged daemon whose first candidates were taken) while
    // firing probes at ports nobody asked about. An explicit port is the
    // primary way in; a remembered one is a port the user already named.
    const candidates = candidateBaseUrls({
      remembered: ['http://127.0.0.1:3105'],
      explicit: 'http://127.0.0.1:3646',
    })

    expect(candidates).toEqual(['http://127.0.0.1:3646', 'http://127.0.0.1:3105'])
  })

  it('leaves out a daemon the user disconnected from', () => {
    // Disconnecting has to survive a reload, so a dismissed daemon stays out
    // of the remembered list's contribution.
    const candidates = candidateBaseUrls({
      remembered: ['http://127.0.0.1:3099', 'http://127.0.0.1:3105'],
      dismissed: ['http://127.0.0.1:3099'],
    })

    expect(candidates).toEqual(['http://127.0.0.1:3105'])
  })

  it('re-admits a dismissed daemon once it is named explicitly', () => {
    // Naming a port by hand is an unambiguous request for that daemon, and
    // without this override a disconnect would be a one-way door.
    const candidates = candidateBaseUrls({
      remembered: [],
      dismissed: ['http://127.0.0.1:3646'],
      explicit: 'http://127.0.0.1:3646',
    })

    expect(candidates).toEqual(['http://127.0.0.1:3646'])
  })

  it('normalizes trailing slashes on remembered entries before deduplicating', () => {
    const candidates = candidateBaseUrls({
      remembered: ['http://127.0.0.1:3099/', 'http://127.0.0.1:3099'],
    })
    expect(candidates).toEqual(['http://127.0.0.1:3099'])
  })
})

describe('discoverDaemons', () => {
  it('returns every responding daemon with its baseUrl, in candidate order', async () => {
    const probeFn = probeMap({
      'http://127.0.0.1:3099': DETECTED('a'),
      'http://127.0.0.1:3101': DETECTED('b'),
    })
    const { found, failures } = await discoverDaemons({
      // Candidates listed outright: this case is about how discoverDaemons
      // fans out over them, not about where the list comes from.
      candidates: [3099, 3100, 3101, 3102].map((p) => `http://127.0.0.1:${p}`),
      probeFn,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      pageOriginScheme: 'http',
    })
    expect(found.map((f) => f.baseUrl)).toEqual(['http://127.0.0.1:3099', 'http://127.0.0.1:3101'])
    expect(found.map((f) => f.instanceId)).toEqual(['a', 'b'])
    expect(failures).toHaveLength(2)
  })

  it('deduplicates two baseUrls answered by the same daemon instance', async () => {
    // A remembered URL and a scanned port can name the same daemon.
    const probeFn = probeMap({
      'http://localhost:3099': DETECTED('same'),
      'http://127.0.0.1:3099': DETECTED('same'),
    })
    const { found } = await discoverDaemons({
      candidates: ['http://localhost:3099', 'http://127.0.0.1:3099'],
      probeFn,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      pageOriginScheme: 'http',
    })
    expect(found).toHaveLength(1)
    expect(found[0]?.baseUrl).toBe('http://localhost:3099')
  })

  it('returns empty when nothing responds', async () => {
    const { found } = await discoverDaemons({
      candidates: candidateBaseUrls({ remembered: ['http://127.0.0.1:3099'] }),
      probeFn: probeMap({}),
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      pageOriginScheme: 'http',
    })
    expect(found).toEqual([])
  })
})

describe('rememberKnownDaemon', () => {
  it('prepends the baseUrl, most recent first, deduplicated and capped', () => {
    expect(rememberKnownDaemon(['http://a', 'http://b'], 'http://b')).toEqual([
      'http://b',
      'http://a',
    ])
    const many = ['1', '2', '3', '4', '5'].map((n) => `http://127.0.0.1:310${n}`)
    const next = rememberKnownDaemon(many, 'http://127.0.0.1:3199')
    expect(next).toHaveLength(5)
    expect(next[0]).toBe('http://127.0.0.1:3199')
  })
})
